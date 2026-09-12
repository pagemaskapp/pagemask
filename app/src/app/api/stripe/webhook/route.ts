import type Stripe from "stripe";
import { NextResponse } from "next/server";

import { requireServerEnv } from "@/lib/env/server";
import { stripe } from "@/lib/stripe/cliente";
import { ehTipoTratado, traduzirEvento } from "@/lib/stripe/eventos";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * `POST /api/stripe/webhook` — a única porta pela qual a cobrança muda de
 * estado (PLANO §5).
 *
 * Nada nesta rota confia no corpo antes de `constructEvent`. E `constructEvent`
 * precisa dos **bytes exatos** que a Stripe assinou: `await requisicao.text()`,
 * nunca `.json()`. Um `JSON.parse` seguido de `JSON.stringify` reordena chaves
 * e muda o escape de acento — a assinatura passa a não bater e todo evento
 * legítimo vira 400. É o erro clássico desta integração.
 *
 * A ORDEM É: assinar, traduzir, gravar-e-aplicar. O insert em `webhook_events`
 * acontece dentro de `apply_stripe_event`, na mesma transação da mudança de
 * estado, e é o `unique (event_id)` que garante a idempotência — reentrega do
 * mesmo evento não tem efeito nenhum (cross-check da fase).
 *
 * QUANDO ESTA ROTA DEVOLVE 5xx, E POR QUÊ ISSO IMPORTA. A Stripe reentrega o
 * que não responde 2xx, com espaçamento crescente, por até três dias. Então:
 *
 *   · evento cujo dono não dá para resolver → **500**, de propósito. A causa
 *     provável é ordem de chegada (o `customer.subscription.created` passou na
 *     frente do `checkout.session.completed` que ia ligar o cliente ao
 *     usuário), e a reentrega resolve sozinha em segundos.
 *   · evento que não nos interessa → **200**. Reentregar não mudaria nada.
 *   · falha nossa (banco fora, RPC quebrada) → **500**. É o que faz o evento
 *     voltar depois que o problema for resolvido.
 */
export async function POST(requisicao: Request) {
  const assinatura = requisicao.headers.get("stripe-signature");
  if (!assinatura) return resposta(400, "assinatura ausente");

  const bruto = await requisicao.text();

  let evento: Stripe.Event;
  try {
    evento = stripe().webhooks.constructEvent(
      bruto,
      assinatura,
      requireServerEnv("STRIPE_WEBHOOK_SECRET"),
    );
  } catch (erro) {
    // Assinatura inválida, segredo errado, corpo adulterado, `timestamp` fora
    // da janela de tolerância: todos caem aqui, e nenhum grava coisa alguma.
    // A mensagem NÃO vai para a resposta — dizer "segredo não confere" a quem
    // está tentando adivinhar é dar-lhe o retorno que ele quer.
    console.warn("[stripe/webhook] assinatura inválida", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return resposta(400, "assinatura inválida");
  }

  if (!ehTipoTratado(evento.type)) {
    return resposta(200, "ignorado", { tipo: evento.type });
  }

  let traducao;
  try {
    traducao = await traduzirEvento(evento);
  } catch (erro) {
    console.error("[stripe/webhook] não foi possível traduzir", {
      evento: evento.id,
      tipo: evento.type,
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return resposta(500, "indisponível");
  }

  if ("ignorar" in traducao) {
    return resposta(200, "ignorado", { tipo: evento.type, motivo: traducao.ignorar });
  }

  if ("semDono" in traducao) {
    console.warn("[stripe/webhook] evento sem dono; pedindo reentrega", {
      evento: evento.id,
      tipo: evento.type,
      motivo: traducao.semDono,
    });
    return resposta(500, "sem dono");
  }

  const i = traducao.intencao;
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("apply_stripe_event", {
    p_event_id: evento.id,
    p_type: evento.type,
    p_created: new Date(evento.created * 1000).toISOString(),
    p_payload: semDadosPessoais(bruto),
    p_user_id: i.userId,
    p_customer_id: i.customerId,
    p_subscription_id: i.subscriptionId,
    p_status: i.status,
    p_price_id: i.priceId,
    p_plan_slug: i.planSlug,
    p_period_start: i.periodStart,
    p_period_end: i.periodEnd,
    p_cancel_at_period_end: i.cancelAtPeriodEnd,
    p_cancel_at: i.cancelAt,
    p_canceled_at: i.canceledAt,
    p_payment_state: i.paymentState,
    p_reset_quota: i.resetQuota,
  });

  if (error) {
    console.error("[stripe/webhook] apply_stripe_event falhou", {
      evento: evento.id,
      tipo: evento.type,
      codigo: error.code,
      mensagem: error.message,
    });
    return resposta(500, "indisponível");
  }

  // Log estruturado (PLANO §7). Sem e-mail, sem token, sem `cus_`/`sub_` —
  // identificador de cobrança é dado pessoal indireto e não precisa estar aqui
  // para ninguém investigar nada: o `evento` já leva ao objeto no Dashboard.
  console.log(
    JSON.stringify({
      escopo: "stripe/webhook",
      evento: evento.id,
      tipo: evento.type,
      resultado: data,
      plano: i.planSlug,
      status: i.status,
    }),
  );

  return resposta(200, String(data));
}

/**
 * O payload que fica guardado em `webhook_events`, sem os dados pessoais.
 *
 * O payload cru serve a duas coisas: auditoria e reprocessar à mão um evento que
 * deu errado. Nenhuma das duas precisa de nome, e-mail, endereço ou CPF — e o
 * `tax_id_collection` que o Pix exige faz a Checkout Session voltar com
 * exatamente isso dentro de `customer_details`.
 *
 * `webhook_events` não tem `user_id`, então não cai na cascata de exclusão de
 * `auth.users`: o que entra aqui sobrevive à conta apagada e fica fora do
 * caminho de exportação e de exclusão da LGPD (PLANO §8). Guardar menos é mais
 * barato que consertar depois — a rotina de exclusão da Fase 10 ainda precisa
 * saber desta tabela, mas com a redação ela deixa de guardar dado de titular.
 *
 * O que sobra é o que identifica o evento e a cobrança (`id`, `type`,
 * `created`, `cus_…`, `sub_…`, `price_…`, valores, status) — nada disso é
 * segredo, e o número do cartão nunca chega a existir do nosso lado.
 *
 * `bruto` e não `evento`: é o mesmo conteúdo, e o texto já está em memória.
 * `JSON.stringify(evento)` traria de volta os campos não-JSON que o SDK pendura
 * no objeto (`lastResponse`).
 */
const CAMPOS_PESSOAIS = [
  "customer_details",
  "customer_address",
  "customer_email",
  "customer_name",
  "customer_phone",
  "customer_tax_ids",
  "shipping_details",
  "billing_details",
] as const;

export function semDadosPessoais(bruto: string): Json {
  const evento: unknown = JSON.parse(bruto);
  if (typeof evento !== "object" || evento === null) return evento as Json;

  const objeto = (evento as { data?: { object?: unknown } }).data?.object;
  if (typeof objeto === "object" && objeto !== null) {
    for (const campo of CAMPOS_PESSOAIS) {
      if (campo in objeto) {
        (objeto as Record<string, unknown>)[campo] = "[removido]";
      }
    }
  }

  return evento as Json;
}

function resposta(
  status: number,
  resultado: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { resultado, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
