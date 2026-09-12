import "server-only";

import { cache } from "react";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Plan } from "@/lib/supabase/database.types";

/**
 * A ponte entre `plans` (nosso catálogo) e os Prices da Stripe.
 *
 * **O `price_id` NUNCA vem do cliente.** Ele chega ao checkout por aqui: o
 * navegador manda um slug (`partida` | `ritmo` | `escala`), este módulo o
 * traduz no `stripe_price_id` que está gravado na tabela, e é esse que vai para
 * a Checkout Session. É o cross-check de segurança da fase — "alterar o
 * `price_id` no cliente antes do checkout → servidor usa o do plano escolhido"
 * — e ele passa não por validação, mas porque **não existe campo de preço na
 * requisição**. Um `price` a mais no corpo é descartado pelo zod antes de
 * qualquer coisa olhá-lo.
 *
 * A leitura é com a chave secreta de propósito: a RLS de `plans` é
 * `using (active)`, e o webhook precisa traduzir `price_id → slug` também para
 * um plano que acabou de ser desativado — senão um cliente que ainda paga o
 * plano antigo perde o plano no primeiro evento depois da desativação.
 */
export type PlanoCobravel = Plan & { stripe_price_id: string };

export const catalogoDePlanos = cache(async (): Promise<Plan[]> => {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("plans")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return data ?? [];
});

/** Os planos que o cliente pode assinar: ativos e com Price na Stripe. */
export async function planosAssinaveis(): Promise<PlanoCobravel[]> {
  const todos = await catalogoDePlanos();
  return todos.filter(
    (p): p is PlanoCobravel =>
      p.active && typeof p.stripe_price_id === "string" && p.stripe_price_id !== "",
  );
}

/**
 * O Price da Stripe para um slug, ou `null`.
 *
 * `null` tem três causas, e as três são configuração nossa, não erro do
 * usuário: slug que não existe, plano desativado, ou `npm run stripe:sync`
 * que nunca rodou neste ambiente. Quem chama responde com uma mensagem de
 * indisponibilidade, nunca "plano inválido" — o plano está no nosso site.
 */
export async function priceDoPlano(slug: string): Promise<PlanoCobravel | null> {
  const assinaveis = await planosAssinaveis();
  return assinaveis.find((p) => p.slug === slug) ?? null;
}

/**
 * O slug para um `price_id` — o caminho de volta, usado pelo webhook.
 *
 * Sem filtro de `active`: ver o comentário do topo. Um plano desativado
 * continua sendo o plano de quem já assina.
 */
export async function planoDoPrice(priceId: string | null): Promise<string | null> {
  if (!priceId) return null;
  const todos = await catalogoDePlanos();
  return todos.find((p) => p.stripe_price_id === priceId)?.slug ?? null;
}
