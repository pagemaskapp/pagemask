import "server-only";

import { unstable_rethrow } from "next/navigation";

import { SessaoIndisponivelError, usuarioAtual } from "@/lib/auth/sessao";
import { createClient } from "@/lib/supabase/server";

/**
 * As duas leituras que a landing faz — e as duas falham em silêncio de
 * propósito.
 *
 * A landing é a única página do produto que precisa continuar de pé com o
 * Supabase fora do ar. Em `/app/*` a decisão certa diante de um 5xx é parar e
 * dizer que não deu (`/indisponivel`), porque o que vem depois é dado de
 * usuário. Aqui não vem: quem chega é visitante, e uma página de vendas que
 * devolve 500 porque o banco piscou perde a visita inteira.
 */

/**
 * Está logado?
 *
 * Serve só para adaptar o CTA — "Criar conta" vira "Ir para o app". Não
 * protege nada, e por isso o `false` do ramo de falha é seguro: o pior que
 * acontece é um visitante logado ver o botão de cadastro, clicar, e o proxy
 * mandá-lo para o app de qualquer jeito (é o ramo `SO_PARA_VISITANTE`).
 *
 * Quem não tem cookie de sessão não gera viagem nenhuma ao Supabase: o
 * `getUser()` do @supabase/ssr responde na hora quando não há sessão no cookie.
 */
export async function estaLogado(): Promise<boolean> {
  try {
    return (await usuarioAtual()) !== null;
  } catch (erro) {
    if (erro instanceof SessaoIndisponivelError) return false;
    throw erro;
  }
}

/**
 * Os planos que a landing mostra: os ativos do catálogo, na ordem dele.
 *
 * **Com a chave `anon`, não com a `service_role`.** `catalogoDePlanos()`, do
 * módulo da Stripe, lê com a chave secreta de propósito — o webhook precisa
 * traduzir `price_id → slug` até para um plano recém-desativado. A landing não
 * precisa de nada disso: a RLS de `plans` é `to anon, authenticated using
 * (active)`, que devolve exatamente as linhas que esta página mostra. Passar
 * pela chave que ignora a RLS para ler o que a RLS já liberaria é privilégio a
 * troco de nada, na rota mais exposta do produto.
 *
 * As colunas são listadas uma a uma pelo mesmo motivo: `select("*")` traria
 * `stripe_price_id` para dentro do processo que renderiza a página pública, e
 * ele não tem o que fazer ali.
 *
 * O BOTÃO NÃO ABRE CHECKOUT DIRETO, e isso é decisão, não limitação: checkout
 * exige conta, porque a assinatura é criada contra um `customer` da Stripe
 * vinculado ao usuário. O caminho é cadastro → `/app/planos`, que é onde
 * `/api/stripe/checkout` é chamada com todas as travas dela.
 */
export type PlanoDaLanding = {
  slug: string;
  name: string;
  price_cents: number;
  videos_month: number;
  ig_accounts: number;
  projects: number;
  max_mb: number;
};

export async function planosDaLanding(): Promise<PlanoDaLanding[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("plans")
      .select("slug, name, price_cents, videos_month, ig_accounts, projects, max_mb")
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return data ?? [];
  } catch (erro) {
    // `unstable_rethrow` PRIMEIRO, sempre, e não é formalidade.
    //
    // `createClient()` lê `cookies()`, e no build o Next sinaliza isso
    // lançando um `DynamicServerError` — é assim que ele descobre que a rota é
    // dinâmica. Um `catch` largo engole esse sinal, e a rota volta a ser
    // candidata a prerender: a landing seria congelada no build **com a lista
    // de planos vazia**, servindo para sempre a mensagem de "não foi possível
    // carregar os preços". Apareceu no log do build exatamente assim, com a
    // frase do Next dentro do nosso `console.error`, antes desta linha existir.
    //
    // A mesma função cobre `redirect()` e `notFound()`, pelo mesmo motivo:
    // são controle de fluxo do framework, não erro nosso.
    unstable_rethrow(erro);

    console.error("[landing] não foi possível ler os planos", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return [];
  }
}
