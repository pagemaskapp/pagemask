import "server-only";

import type Stripe from "stripe";

import { stripe } from "@/lib/stripe/cliente";
import { planoDoPrice } from "@/lib/stripe/planos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A tradução de um evento da Stripe para o que o banco precisa saber.
 *
 * Esta camada existe porque a forma dos objetos da Stripe é instável e a do
 * nosso banco não é. Duas mudanças da API atual (`2026-08-26.dahlia`) explicam
 * por que ela não pode ser um punhado de `payload ->> 'campo'` dentro do SQL:
 *
 *   · `Subscription` perdeu `current_period_start`/`current_period_end` no
 *     topo. Os dois vivem em `items.data[].current_period_*`, um por item.
 *   · `Invoice` perdeu `subscription` e `payment_intent`. A assinatura está em
 *     `parent.subscription_details.subscription`.
 *
 * Código escrito de memória para a API antiga **compila** — os campos somem do
 * tipo, mas quem os lê de um `Stripe.Event.Data.Object` não recebe erro — e
 * devolve `undefined` em produção. O efeito é um webhook que responde 200,
 * grava o evento como tratado e não muda nada. Daí a leitura estar num lugar
 * só, com nome, e com o caminho novo escrito à mão.
 */

/** Os tipos que mudam algo aqui. O resto recebe 200 e vai para o lixo. */
export const TIPOS_TRATADOS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export type TipoTratado = (typeof TIPOS_TRATADOS)[number];

export function ehTipoTratado(tipo: string): tipo is TipoTratado {
  return (TIPOS_TRATADOS as readonly string[]).includes(tipo);
}

/** O que `apply_stripe_event` recebe. Nomes iguais aos parâmetros do RPC. */
export type IntencaoDeCobranca = {
  userId: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
  priceId: string | null;
  planSlug: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
  cancelAt: string | null;
  canceledAt: string | null;
  paymentState: "ok" | "processando" | "falhou" | null;
  resetQuota: boolean;
};

export type Traducao =
  | { intencao: IntencaoDeCobranca }
  /** Nada a fazer, e isso não é falha: responder 200 e seguir. */
  | { ignorar: string }
  /**
   * Não foi possível decidir de quem é o evento. **Não** é 200: a Stripe tem
   * que reentregar, porque a causa mais provável é ordem de chegada — o evento
   * da assinatura passou na frente do `checkout.session.completed` que ainda ia
   * ligar o cliente ao usuário.
   */
  | { semDono: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(segundos: number | null | undefined): string | null {
  // A Stripe manda segundos; o banco é `timestamptz` em UTC (CLAUDE.md).
  // `0` é um valor que a Stripe não usa para data, e tratá-lo como 1970 seria
  // gravar um período que faz a guarda de cota achar que o ciclo virou.
  if (typeof segundos !== "number" || segundos <= 0) return null;
  return new Date(segundos * 1000).toISOString();
}

function idDe(valor: string | { id: string } | null | undefined): string | null {
  if (!valor) return null;
  return typeof valor === "string" ? valor : valor.id;
}

/**
 * O dono do evento.
 *
 * Três fontes, nesta ordem, e a ordem é por confiabilidade:
 *
 *   1. **metadata que nós mesmos gravamos** (`subscription_data.metadata.user_id`
 *      no checkout, e `client_reference_id` na sessão). Chega junto com o
 *      evento, não custa viagem e é o caminho normal.
 *   2. **`profiles.stripe_customer_id`** — o vínculo que o primeiro webhook
 *      gravou. Cobre assinatura criada pelo Dashboard, sem metadata nenhuma.
 *   3. **`customer.metadata.user_id` na Stripe** — uma chamada de rede, só
 *      quando as duas primeiras falham. É a rede de segurança para o caso de o
 *      vínculo do banco ter sido perdido (restore de backup, conta recriada).
 *
 * Nenhuma delas aceita palpite: o valor precisa ser um uuid e precisa existir
 * em `profiles`. Um `metadata.user_id` inventado não vira acesso para ninguém
 * — mas só quem tem a nossa chave secreta consegue escrever metadata, então o
 * cenário é erro de operação, não ataque.
 */
async function resolverDono(entradas: {
  metadata?: Stripe.Metadata | null;
  clientReferenceId?: string | null;
  customerId: string | null;
}): Promise<string | null> {
  const supabase = createAdminClient();

  const candidatos = [
    entradas.metadata?.user_id,
    entradas.clientReferenceId,
  ].filter((v): v is string => typeof v === "string" && UUID.test(v));

  for (const candidato of candidatos) {
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", candidato)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  if (entradas.customerId) {
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", entradas.customerId)
      .maybeSingle();
    if (data?.id) return data.id;

    // Última tentativa, e a única que custa rede.
    try {
      const cliente = await stripe().customers.retrieve(entradas.customerId);
      if (!cliente.deleted) {
        const doMeta = cliente.metadata?.user_id;
        if (typeof doMeta === "string" && UUID.test(doMeta)) {
          const { data: perfil } = await supabase
            .from("profiles")
            .select("id")
            .eq("id", doMeta)
            .maybeSingle();
          if (perfil?.id) return perfil.id;
        }
      }
    } catch (erro) {
      console.error("[stripe] não foi possível ler o cliente", {
        mensagem: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  return null;
}

/** O item que define o plano: o primeiro recorrente da assinatura. */
function itemPrincipal(
  assinatura: Stripe.Subscription,
): Stripe.SubscriptionItem | null {
  const itens = assinatura.items?.data ?? [];
  return itens.find((i) => i.price?.recurring) ?? itens[0] ?? null;
}

async function daAssinatura(
  assinatura: Stripe.Subscription,
  tipo: TipoTratado,
): Promise<Traducao> {
  const customerId = idDe(assinatura.customer);
  const dono = await resolverDono({
    metadata: assinatura.metadata,
    customerId,
  });
  if (!dono) {
    return {
      semDono: `assinatura ${assinatura.id} sem usuário (customer ${customerId ?? "?"})`,
    };
  }

  const item = itemPrincipal(assinatura);
  const priceId = item?.price?.id ?? null;
  const planSlug = await planoDoPrice(priceId);

  // `deleted` é terminal: a Stripe manda o objeto com `status: "canceled"`,
  // mas quem confia no campo em vez do tipo do evento fica à mercê de um
  // `updated` fora de ordem devolvendo acesso. Aqui o status é cravado.
  const status =
    tipo === "customer.subscription.deleted" ? "canceled" : assinatura.status;

  return {
    intencao: {
      userId: dono,
      customerId,
      subscriptionId: assinatura.id,
      status,
      priceId,
      planSlug,
      periodStart: iso(item?.current_period_start),
      periodEnd: iso(item?.current_period_end),
      cancelAtPeriodEnd: assinatura.cancel_at_period_end ?? null,
      cancelAt: iso(assinatura.cancel_at),
      canceledAt: iso(assinatura.canceled_at),
      paymentState: null,
      // Assinatura viva com período novo: zera a cota. É o caminho que salva o
      // Pix Automático, cuja fatura só é paga no ciclo + 3 dias — sem isto o
      // cliente passaria três dias de cada mês com a cota do mês anterior,
      // estando em dia. A guarda contra zerar duas vezes é
      // `quota_period_start`, no banco.
      resetQuota: status === "active" || status === "trialing",
    },
  };
}

export async function traduzirEvento(evento: Stripe.Event): Promise<Traducao> {
  if (!ehTipoTratado(evento.type)) {
    return { ignorar: `tipo não tratado: ${evento.type}` };
  }

  switch (evento.type) {
    case "checkout.session.completed": {
      const sessao = evento.data.object as Stripe.Checkout.Session;

      if (sessao.mode !== "subscription") {
        return { ignorar: `sessão em modo ${sessao.mode}` };
      }

      const subscriptionId = idDe(sessao.subscription);
      if (!subscriptionId) {
        return { ignorar: `sessão ${sessao.id} sem assinatura` };
      }

      // A assinatura é BUSCADA, não lida do payload — o payload da sessão traz
      // só o id. Buscar tem um efeito colateral bem-vindo: o estado que se
      // grava é o de agora, não o do instante do evento, então uma entrega
      // atrasada não reescreve o banco com um retrato velho.
      const assinatura = await stripe().subscriptions.retrieve(subscriptionId);
      const traducao = await daAssinatura(assinatura, evento.type);
      if (!("intencao" in traducao)) {
        // Aqui o `client_reference_id` da sessão ainda pode salvar: é a única
        // fonte de dono que existe antes de qualquer vínculo estar gravado.
        const dono = await resolverDono({
          metadata: assinatura.metadata,
          clientReferenceId: sessao.client_reference_id,
          customerId: idDe(sessao.customer),
        });
        if (!dono) return traducao;

        const item = itemPrincipal(assinatura);
        const priceId = item?.price?.id ?? null;
        return {
          intencao: {
            userId: dono,
            customerId: idDe(sessao.customer) ?? idDe(assinatura.customer),
            subscriptionId: assinatura.id,
            status: assinatura.status,
            priceId,
            planSlug: await planoDoPrice(priceId),
            periodStart: iso(item?.current_period_start),
            periodEnd: iso(item?.current_period_end),
            cancelAtPeriodEnd: assinatura.cancel_at_period_end ?? null,
            cancelAt: iso(assinatura.cancel_at),
            canceledAt: iso(assinatura.canceled_at),
            paymentState: estadoDoPagamentoDaSessao(sessao),
            resetQuota:
              assinatura.status === "active" || assinatura.status === "trialing",
          },
        };
      }

      return {
        intencao: {
          ...traducao.intencao,
          customerId: idDe(sessao.customer) ?? traducao.intencao.customerId,
          paymentState: estadoDoPagamentoDaSessao(sessao),
        },
      };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return daAssinatura(evento.data.object as Stripe.Subscription, evento.type);

    case "invoice.paid":
    case "invoice.payment_failed": {
      const fatura = evento.data.object as Stripe.Invoice;
      const detalhes = fatura.parent?.subscription_details ?? null;
      const subscriptionId = idDe(detalhes?.subscription);

      if (!subscriptionId) {
        // Fatura solta (cobrança manual, one-off). Não mexe em assinatura.
        return { ignorar: `fatura ${fatura.id ?? "?"} sem assinatura` };
      }

      const customerId = idDe(fatura.customer);
      const dono = await resolverDono({
        metadata: detalhes?.metadata,
        customerId,
      });
      if (!dono) {
        return {
          semDono: `fatura ${fatura.id ?? "?"} sem usuário (customer ${customerId ?? "?"})`,
        };
      }

      // O período do SERVIÇO vem da linha, não de `period_start`/`period_end`
      // da fatura — esses dois delimitam "quando um invoice item pode entrar
      // nesta fatura", e numa fatura de ciclo eles colapsam no mesmo instante.
      // Ler o campo errado aqui faria a guarda de cota nunca disparar.
      const linha = fatura.lines?.data?.find((l) => l.period) ?? null;

      // Só ciclo e criação zeram a cota. `subscription_update` é a fatura de
      // proporcional de uma troca de plano no meio do mês: zerar ali
      // transformaria "trocar de plano" em botão de cota infinita.
      const zera =
        evento.type === "invoice.paid" &&
        (fatura.billing_reason === "subscription_cycle" ||
          fatura.billing_reason === "subscription_create");

      return {
        intencao: {
          userId: dono,
          customerId,
          subscriptionId,
          // Fatura não decide status de assinatura: quem decide é a própria
          // assinatura. Deixar nulo é o que mantém as duas famílias de evento
          // sem disputar `last_event_at` (ver a migration 0022).
          status: null,
          priceId: null,
          planSlug: null,
          periodStart: zera ? iso(linha?.period?.start) : null,
          periodEnd: null,
          cancelAtPeriodEnd: null,
          cancelAt: null,
          canceledAt: null,
          paymentState: evento.type === "invoice.paid" ? "ok" : "falhou",
          resetQuota: zera,
        },
      };
    }
  }
}

/**
 * O estado de pagamento de uma sessão recém-concluída.
 *
 * Com cartão a sessão fecha paga. Com Pix Automático ela fecha com o mandato
 * autorizado e o débito ainda em curso, e `payment_status` diz `unpaid` — que
 * **não** é falha: é o intervalo da notificação prévia, e a Stripe mantém a
 * assinatura `active` durante ele (docs.stripe.com/payments/pix/pix-automatico,
 * "Pre-debit notifications"). Rebaixar aqui seria cortar quem acabou de
 * assinar; por isso `processando` é um estado próprio e não um sinônimo de
 * `falhou`.
 *
 * `no_payment_required` também é `ok`: é a sessão de teste grátis, em que não há
 * nada para debitar. Tratá-la como `processando` inventaria uma cobrança em
 * curso que não existe, e a tela mostraria "seu banco avisa três dias antes" a
 * quem não colocou Pix nenhum.
 */
function estadoDoPagamentoDaSessao(
  sessao: Stripe.Checkout.Session,
): "ok" | "processando" {
  return sessao.payment_status === "paid" ||
    sessao.payment_status === "no_payment_required"
    ? "ok"
    : "processando";
}
