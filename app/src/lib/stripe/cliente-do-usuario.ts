import "server-only";

import type { User } from "@supabase/supabase-js";

import { stripe } from "@/lib/stripe/cliente";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O `cus_…` do usuário, criado na primeira vez.
 *
 * DOIS CLIENTES PARA A MESMA PESSOA É O ESTRAGO QUE ESTA FUNÇÃO EVITA: um deles
 * fica com a assinatura e o outro com o vínculo no nosso banco, e o webhook
 * passa a não achar o dono de nada. Três defesas, em camadas:
 *
 *   1. `profiles.stripe_customer_id` é lido antes de qualquer criação;
 *   2. a criação leva `idempotencyKey` derivada do `user_id` — dois cliques
 *      simultâneos no botão de assinar devolvem o MESMO cliente da Stripe, não
 *      dois;
 *   3. a gravação é condicional (`is null`). Quem perder a corrida descarta o
 *      que criou e passa a usar o que já está gravado.
 *
 * `metadata.user_id` vai junto porque é a terceira fonte de dono do webhook
 * (ver `@/lib/stripe/eventos`): se um dia o vínculo do banco se perder, é por
 * ela que o evento volta a encontrar a pessoa.
 */
export async function clienteDoUsuario(usuario: User): Promise<string> {
  const supabase = createAdminClient();

  const { data: perfil, error } = await supabase
    .from("profiles")
    .select("stripe_customer_id, name")
    .eq("id", usuario.id)
    .maybeSingle();

  if (error) throw error;
  if (perfil?.stripe_customer_id) return perfil.stripe_customer_id;

  const criado = await stripe().customers.create(
    {
      email: usuario.email ?? undefined,
      name: perfil?.name ?? undefined,
      metadata: { user_id: usuario.id, produto: "pagemask" },
    },
    { idempotencyKey: `pagemask:customer:${usuario.id}` },
  );

  const { data: gravado } = await supabase
    .from("profiles")
    .update({ stripe_customer_id: criado.id })
    .eq("id", usuario.id)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id")
    .maybeSingle();

  if (gravado?.stripe_customer_id) return gravado.stripe_customer_id;

  // Perdemos a corrida: outra requisição gravou primeiro. O cliente que
  // acabamos de criar fica órfão na Stripe, sem assinatura e sem cobrança — o
  // preço de nunca dividir uma pessoa em dois clientes.
  const { data: agora } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", usuario.id)
    .maybeSingle();

  if (agora?.stripe_customer_id) return agora.stripe_customer_id;

  throw new Error(
    `Não foi possível vincular o cliente da Stripe ao usuário ${usuario.id}.`,
  );
}
