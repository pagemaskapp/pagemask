import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import type { Plan } from "@/lib/supabase/database.types";

/**
 * O estado de cobrança de um usuário, do jeito que a tela precisa dele.
 *
 * **Isto é a leitura, não a decisão.** Quem decide de verdade é o banco:
 * `assinatura_ativa()` na política de `schedules`, e `assinatura_ativa_de()`
 * dentro de `register_upload_job` e `enqueue_project` (migration 0022). O que
 * se lê aqui serve para a interface avisar antes, com uma frase que diz o que
 * falta — nunca como a única tranca. Uma checagem que só existe no que a tela
 * mostra é uma checagem que um `fetch` no console ignora.
 *
 * Os estados possíveis, e o que cada um significa para quem está olhando:
 *
 *   `isenta`      conta de piloto ou interna (`profiles.billing_exempt`)
 *   `ativa`       ver `daAcesso`, logo abaixo
 *   `suspensa`    o resto — inclusive nunca ter assinado
 */
export type PagamentoDaAssinatura = "nenhum" | "ok" | "processando" | "falhou";

export type EstadoDaCobranca = {
  /** Pode consumir: enviar vídeo, processar lote, agendar publicação. */
  ativa: boolean;
  /**
   * Não foi possível LER o estado (migration não aplicada, `grant` faltando,
   * Postgres fora do ar). Diferente de `ativa: false`, e a diferença é a que
   * importa:
   *
   *   `ativa: false`        sabemos que a conta não tem assinatura → "escolha
   *                         um plano"
   *   `indisponivel: true`  não sabemos nada → "tente de novo em instantes"
   *
   * Sem essa distinção, uma falha de consulta virava "você não tem assinatura"
   * para um cliente pagante: a tela de envio fechava, a rota de upload
   * respondia 402 — e, o pior, o guarda de "já tem assinatura" do checkout via
   * campo livre e deixava abrir uma SEGUNDA assinatura na Stripe para quem já
   * pagava a primeira. `subscriptions` é `unique (user_id)`, então a primeira
   * passaria a cobrar sem aparecer em tela nenhuma.
   */
  indisponivel: boolean;
  isenta: boolean;
  /** O `status` da Stripe, cru. `null` para quem nunca assinou. */
  status: string | null;
  pagamento: PagamentoDaAssinatura;
  plano: Plan | null;
  /** O slug gravado no perfil — o plano atual, ou o último, se suspensa. */
  planSlug: string;
  videosUsados: number;
  videosLimite: number;
  /** Nunca negativo: quem baixou de plano pode estar acima do teto novo. */
  restantes: number;
  fimDoPeriodo: Date | null;
  cancelaNoFimDoPeriodo: boolean;
  temClienteNaStripe: boolean;
};

/**
 * O espelho exato de `assinatura_ativa()` (migration 0022). Se um dos dois
 * mudar, o outro tem que mudar no mesmo commit — a divergência aqui é do tipo
 * que não quebra nada e mente: a tela libera e o banco recusa, ou pior, a tela
 * bloqueia o que o banco liberaria.
 */
const STATUS_QUE_DAO_ACESSO = new Set(["active", "trialing", "past_due"]);

function daAcesso(
  status: string | null,
  pagamento: PagamentoDaAssinatura,
): boolean {
  if (status === null) return false;
  if (STATUS_QUE_DAO_ACESSO.has(status)) return true;
  // Pix Automático: `incomplete` com o débito em curso (`processando`) ou já
  // pago (`ok`). Os dois porque `payment_state` vem da família de eventos de
  // FATURA e `status` da de ASSINATURA: um `invoice.paid` que chega antes do
  // `customer.subscription.updated` deixa a linha em `incomplete` + `ok`, e sem
  // o `ok` aqui esse intervalo trancava justo quem acabou de pagar.
  //
  // Não é acesso de graça: `ok` e `processando` só saem de `invoice.paid` ou de
  // uma sessão de checkout concluída. A linha que `register_upload_job` cria
  // sozinha nasce `incomplete` + `nenhum` e continua sem acesso.
  return (
    status === "incomplete" &&
    (pagamento === "processando" || pagamento === "ok")
  );
}

export const estadoDaCobranca = cache(
  async (userId: string): Promise<EstadoDaCobranca> => {
    const supabase = await createClient();

    const [perfil, assinatura] = await Promise.all([
      supabase
        .from("profiles")
        .select("plan_slug, billing_exempt, stripe_customer_id, plans(*)")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("subscriptions")
        .select(
          "status, payment_state, videos_used, current_period_end, cancel_at_period_end",
        )
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

    // Erro aqui é configuração (migration não aplicada, `grant` faltando), não
    // um usuário sem plano. Deixar subir seria derrubar a tela inteira; engolir
    // em silêncio foi o que já escondeu uma migration não aplicada por dias
    // (ver o comentário em `/app/conta`). Aparece no log e a tela mostra o que
    // sabe.
    let indisponivel = false;
    for (const [origem, erro] of [
      ["profiles", perfil.error],
      ["subscriptions", assinatura.error],
    ] as const) {
      if (erro) {
        indisponivel = true;
        console.error("[cobranca] consulta falhou", {
          origem,
          codigo: erro.code,
          mensagem: erro.message,
        });
      }
    }

    // Perfil ausente sem erro também é "não sei": `handle_new_user` cria a
    // linha no cadastro, então perfil que não veio é consulta que não chegou ao
    // dono — não uma pessoa sem perfil.
    if (!perfil.data) indisponivel = true;

    const plano = (perfil.data?.plans as Plan | null | undefined) ?? null;
    const isenta = perfil.data?.billing_exempt === true;
    const status = assinatura.data?.status ?? null;
    const pagamento =
      (assinatura.data?.payment_state as PagamentoDaAssinatura | undefined) ??
      "nenhum";
    const videosUsados = assinatura.data?.videos_used ?? 0;
    const videosLimite = plano?.videos_month ?? 0;

    return {
      // Estado ilegível NÃO dá acesso — a decisão real é do banco, e inventar
      // um "sim" aqui só faria a tela prometer o que a RPC vai negar. Mas
      // também não é tratado como "não tem plano": quem lê `ativa` junto com
      // `indisponivel` sabe a diferença, e as três chamadas que barram alguém
      // (upload, checkout, agenda) olham as duas.
      ativa: !indisponivel && (isenta || daAcesso(status, pagamento)),
      indisponivel,
      isenta,
      status,
      pagamento,
      plano,
      planSlug: perfil.data?.plan_slug ?? "partida",
      videosUsados,
      videosLimite,
      restantes: Math.max(0, videosLimite - videosUsados),
      fimDoPeriodo: assinatura.data?.current_period_end
        ? new Date(assinatura.data.current_period_end)
        : null,
      cancelaNoFimDoPeriodo: assinatura.data?.cancel_at_period_end === true,
      temClienteNaStripe: Boolean(perfil.data?.stripe_customer_id),
    };
  },
);

/**
 * A frase de "sua conta está suspensa", num lugar só.
 *
 * Uma frase e não várias porque ela aparece em quatro telas (envio, projeto,
 * agenda, conta) e precisa dizer exatamente a mesma coisa nas quatro: quem lê
 * duas versões diferentes do mesmo bloqueio acha que são dois problemas.
 */
export function motivoDaSuspensao(estado: EstadoDaCobranca): string {
  if (estado.ativa) return "";

  if (estado.indisponivel) {
    return (
      "Não conseguimos conferir sua assinatura agora. Tente de novo em " +
      "instantes — nada mudou no seu plano."
    );
  }

  switch (estado.status) {
    case null:
    case "incomplete":
      // `incomplete` COM pagamento em curso não chega aqui: `daAcesso` o trata
      // como ativo. Quem chega é quem abandonou o checkout no meio, ou a linha
      // que `register_upload_job` criou antes de existir qualquer assinatura.
      return (
        "Sua conta ainda não tem assinatura ativa. Escolha um plano para " +
        "enviar e processar vídeos — o que já está pronto continua disponível " +
        "para baixar."
      );
    case "incomplete_expired":
      return (
        "O pagamento da sua assinatura não foi concluído a tempo e ela " +
        "expirou. Escolha um plano para voltar a enviar e processar vídeos."
      );
    case "unpaid":
      return (
        "Não conseguimos receber o pagamento da sua assinatura depois de " +
        "várias tentativas. Atualize a forma de pagamento para voltar a " +
        "enviar e processar vídeos."
      );
    default:
      return (
        "Sua assinatura foi encerrada. Escolha um plano para voltar a enviar " +
        "e processar vídeos — o que já está pronto continua disponível para " +
        "baixar."
      );
  }
}

/**
 * A frase de cota, com o número que falta e o convite para mudar de plano.
 *
 * `pedidos` é quantos vídeos a pessoa está tentando adicionar agora. Com zero,
 * a frase é o estado atual; com um número, ela é o veredito sobre a tentativa
 * — que é o que o PLANO pede na Fase 8 ("dizendo quanto falta e oferecendo
 * upgrade").
 */
export function frasesDaCota(
  estado: EstadoDaCobranca,
  pedidos = 0,
): { cabe: boolean; mensagem: string } {
  const { videosUsados, videosLimite, restantes, plano } = estado;
  const nome = plano?.name ?? estado.planSlug;
  const numero = new Intl.NumberFormat("pt-BR");

  if (estado.indisponivel || videosLimite <= 0) {
    return {
      cabe: false,
      mensagem:
        "Não conseguimos ler o limite do seu plano agora. Recarregue a " +
        "página em instantes.",
    };
  }

  if (videosUsados + pedidos <= videosLimite) {
    return {
      cabe: true,
      mensagem: `${numero.format(restantes)} de ${numero.format(videosLimite)} vídeos ainda cabem no plano ${nome} neste período.`,
    };
  }

  const faltam = videosUsados + pedidos - videosLimite;
  const sobre =
    pedidos > 0
      ? `Você tentou usar ${numero.format(pedidos)} ${pedidos === 1 ? "vídeo" : "vídeos"} e ` +
        `já usou ${numero.format(videosUsados)} de ${numero.format(videosLimite)} no plano ${nome}.`
      : `Você já usou ${numero.format(videosUsados)} de ${numero.format(videosLimite)} vídeos do plano ${nome}.`;

  return {
    cabe: false,
    mensagem:
      `${sobre} ${faltam === 1 ? "Falta 1 vaga" : `Faltam ${numero.format(faltam)} vagas`} — ` +
      "remova vídeos que ainda não foram processados ou mude de plano em Planos.",
  };
}
