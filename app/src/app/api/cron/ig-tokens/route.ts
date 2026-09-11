import { NextResponse } from "next/server";

import { cronAutorizado } from "@/lib/cron/autorizacao";
import { enviarEmail } from "@/lib/email/enviar";
import { publicEnv } from "@/lib/env/public";
import { ehCedoParaRenovar, ErroDaMeta, renovarToken } from "@/lib/ig/api";
import { cifrar, decifrar } from "@/lib/ig/cripto";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `GET /api/cron/ig-tokens` — renova os tokens que estão perto de vencer.
 *
 * Um token longo do Instagram vale 60 dias e morre de vez se passar esse prazo
 * sem renovação. Renovar com 10 dias de folga (PLANO, Fase 4) dá margem para
 * dez execuções diárias falharem em sequência antes de alguém perder a conexão.
 *
 * POR QUE O LAÇO É SEQUENCIAL
 * ===========================
 *
 * A cota de OAuth da Meta é contada **por app**, não por conta. Disparar tudo
 * em paralelo num dia de muitas renovações é o jeito mais rápido de o app
 * inteiro tomar um bloqueio temporário — e aí nenhuma renova. Em série, com
 * poucas dezenas de contas por dia, o custo é de segundos.
 *
 * O CRON NÃO DECIDE POR "É O DIA?"
 * ================================
 *
 * A rota pode ser chamada quantas vezes for. O que define trabalho é o estado
 * do banco (`token_expires_at < now() + 10 dias`), não o calendário — então uma
 * execução perdida é recuperada sozinha na seguinte, e duas execuções no mesmo
 * dia não fazem mal. É o mesmo princípio da fila da Fase 3.
 *
 * É essa mesma propriedade que sustenta o ORÇAMENTO DE TEMPO abaixo: parar no
 * meio da lista não perde trabalho, só o adia.
 */

/**
 * Teto da plataforma para esta invocação. O orçamento interno termina antes,
 * para a resposta com o resumo ainda sair — uma execução morta no meio não
 * deixa registro nenhum de quantas contas foram tratadas.
 */
export const maxDuration = 300;

const ORCAMENTO_MS = 240_000;

export async function GET(requisicao: Request) {
  if (!cronAutorizado(requisicao)) {
    return NextResponse.json(
      { erro: "não autorizado" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const comecou = Date.now();
  const url = new URL(requisicao.url);
  const dias = inteiroDaQuery(url.searchParams.get("dias"), 10, 1, 60);

  const supabase = createAdminClient();
  const { data: contas, error } = await supabase.rpc("ig_accounts_para_renovar", {
    p_dias: dias,
  });

  if (error) {
    console.error("[cron/ig] não foi possível listar as contas", {
      codigo: error.code,
      mensagem: error.message,
    });
    return NextResponse.json(
      { erro: "falha ao consultar as contas" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const resumo = {
    candidatas: contas?.length ?? 0,
    renovadas: 0,
    cedo: 0,
    falhas: 0,
    /** Não tratadas porque o tempo acabou. A próxima execução as pega. */
    adiadas: 0,
  };

  const lista = contas ?? [];
  for (let i = 0; i < lista.length; i += 1) {
    if (Date.now() - comecou > ORCAMENTO_MS) {
      resumo.adiadas = lista.length - i;
      console.warn("[cron/ig] orçamento de tempo esgotado", {
        tratadas: i,
        adiadas: resumo.adiadas,
      });
      break;
    }

    const conta = lista[i];
    const inicio = Date.now();

    try {
      const atual = decifrar(
        {
          cipherHex: conta.cipher_hex,
          ivHex: conta.iv_hex,
          tagHex: conta.tag_hex,
          keyVersion: conta.key_version,
        },
        conta.ig_user_id,
      );

      const novo = await renovarToken(atual);
      const cifrado = cifrar(novo.accessToken, conta.ig_user_id);

      const { error: erroDaGravacao } = await supabase.rpc("refresh_ig_token", {
        p_account_id: conta.id,
        p_cipher_hex: cifrado.cipherHex,
        p_iv_hex: cifrado.ivHex,
        p_tag_hex: cifrado.tagHex,
        p_expires_at: novo.expiraEm.toISOString(),
        p_key_version: cifrado.keyVersion,
      });
      if (erroDaGravacao) throw erroDaGravacao;

      resumo.renovadas += 1;
      // Log em JSON com conta, etapa, duração e resultado — o mesmo formato do
      // worker (PLANO §7). O token não aparece; o `@` sim, porque é ele que
      // permite achar a conta no suporte.
      console.log(
        JSON.stringify({
          escopo: "cron/ig",
          conta: conta.id,
          username: conta.username,
          etapa: "renovar",
          resultado: "ok",
          expira_em: novo.expiraEm.toISOString(),
          ms: Date.now() - inicio,
        }),
      );
      continue;
    } catch (erro) {
      if (ehCedoParaRenovar(erro)) {
        // A Meta exige 24 h de vida antes da primeira renovação. Um token
        // recém-criado que já nasce perto do limite (não acontece com 60 dias,
        // mas acontece em teste) cai aqui. Não é falha da conta.
        resumo.cedo += 1;
        console.log(
          JSON.stringify({
            escopo: "cron/ig",
            conta: conta.id,
            etapa: "renovar",
            resultado: "cedo-demais",
            ms: Date.now() - inicio,
          }),
        );
        continue;
      }

      resumo.falhas += 1;
      console.error(
        JSON.stringify({
          escopo: "cron/ig",
          conta: conta.id,
          username: conta.username,
          etapa: "renovar",
          resultado: "falha",
          mensagem: erro instanceof Error ? erro.message : String(erro),
          ms: Date.now() - inicio,
        }),
      );

      // NEM TODA FALHA É "RECONECTE SUA CONTA".
      //
      // Um timeout de rede, um DNS que oscilou, um 5xx da Meta: nada disso diz
      // que a autorização morreu. Marcar `needs_reconnect` aí seria pedir ao
      // cliente que refizesse, na mão, um trabalho que provavelmente daria
      // certo sozinho na execução de amanhã.
      //
      // O que a marca significa é "a Meta recusou este token" — e isso só se
      // sabe quando ela de fato respondeu. Um erro nosso (não conseguimos
      // decifrar, o banco recusou a gravação) também não é assunto do cliente.
      if (erro instanceof ErroDaMeta && erro.origem === "meta") {
        await marcarEAvisar(supabase, conta.id, conta.user_id, conta.username);
      }
    }
  }

  return NextResponse.json(resumo, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Marca `needs_reconnect` e avisa o dono — **uma vez só**.
 *
 * A ORDEM IMPORTA: marca primeiro, avisa depois. O estado no banco é o que faz
 * a tela mostrar "precisa reconectar" e o que impede a Fase 5 de tentar
 * publicar com um token morto. O e-mail é cortesia — e ele pode falhar (sem
 * provedor configurado, provedor fora do ar) sem que isso desfaça a marcação.
 *
 * `mark_ig_needs_reconnect` devolve `true` só quando ESTA chamada mudou o
 * estado. Como a conta continua na lista do cron depois de marcada (para poder
 * se recuperar sozinha), sem essa distinção o cliente receberia o mesmo e-mail
 * todo dia até reconectar.
 */
async function marcarEAvisar(
  supabase: ReturnType<typeof createAdminClient>,
  contaId: string,
  userId: string,
  username: string,
): Promise<void> {
  const { data: marcouAgora, error } = await supabase.rpc(
    "mark_ig_needs_reconnect",
    { p_account_id: contaId },
  );

  if (error) {
    console.error("[cron/ig] não foi possível marcar needs_reconnect", {
      conta: contaId,
      codigo: error.code,
      mensagem: error.message,
    });
    return;
  }

  if (marcouAgora !== true) return; // já estava marcada; o aviso já saiu antes.

  const { error: erroDaAuditoria } = await supabase.from("audit_log").insert({
    user_id: userId,
    actor: "system",
    action: "ig.needs_reconnect",
    target: contaId,
    meta: { username },
  });
  if (erroDaAuditoria) {
    console.error("[cron/ig] auditoria não registrada", {
      acao: "ig.needs_reconnect",
      codigo: erroDaAuditoria.code,
      mensagem: erroDaAuditoria.message,
    });
  }

  // O e-mail do usuário vive em `auth.users`, que só a chave secreta lê. Ele
  // NÃO é gravado em `audit_log` nem em log nenhum (PLANO §7: nunca token nem
  // e-mail em breadcrumb).
  const { data, error: erroDoUsuario } =
    await supabase.auth.admin.getUserById(userId);
  const email = data?.user?.email;

  if (erroDoUsuario || !email) {
    console.warn("[cron/ig] sem e-mail para avisar", { conta: contaId });
    return;
  }

  await enviarEmail({
    para: email,
    assunto: `Reconecte o Instagram @${username} no PageMask`,
    texto:
      `Olá!\n\n` +
      `Não conseguimos renovar o acesso do PageMask à conta @${username} do ` +
      `Instagram. Enquanto isso não for resolvido, as publicações dessa conta ` +
      `ficam paradas.\n\n` +
      `Para resolver, entre no PageMask, abra Conectores e clique em ` +
      `Reconectar na conta @${username}:\n` +
      `${publicEnv.NEXT_PUBLIC_APP_URL}/app/conectores\n\n` +
      `Leva menos de um minuto.\n\n` +
      `Equipe PageMask`,
  });
}

function inteiroDaQuery(
  valor: string | null,
  padrao: number,
  minimo: number,
  maximo: number,
): number {
  if (!valor) return padrao;
  const n = Number.parseInt(valor, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(maximo, Math.max(minimo, n));
}
