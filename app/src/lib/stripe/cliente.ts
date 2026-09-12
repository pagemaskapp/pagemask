import "server-only";

import Stripe from "stripe";

import { getServerEnv, requireServerEnv } from "@/lib/env/server";

/**
 * O cliente da Stripe. **Só servidor** — `server-only` na primeira linha é o
 * que faz o build falhar se um componente de cliente importar isto, direta ou
 * indiretamente, e é a trava que impede `STRIPE_SECRET_KEY` de entrar no bundle
 * (PLANO §3).
 *
 * A VERSÃO DA API É FIXADA NO CÓDIGO, não herdada do painel. A conta tem uma
 * versão padrão que muda quando alguém clica em "upgrade" no Dashboard — e um
 * clique lá não pode alterar a forma dos objetos que este código lê. Fixando
 * aqui, atualizar a API passa a ser o que deveria ser: editar esta linha, subir
 * o SDK e ler o changelog.
 *
 * `2026-08-26.dahlia` é a versão que o `stripe@22.6.2` fixa (o valor sai de
 * `node_modules/stripe/cjs/apiVersion.js`). Não é detalhe cosmético: nela
 *
 *   · `Subscription` **não tem mais** `current_period_start`/`current_period_end`
 *     no topo — os dois vivem em `items.data[].current_period_*`;
 *   · `Invoice` **não tem mais** `subscription` nem `payment_intent` — a
 *     assinatura está em `parent.subscription_details.subscription`.
 *
 * Código escrito de memória para a API antiga compila (os campos vêm de um
 * `Stripe.Event.Data.Object` frouxo) e devolve `undefined` em produção.
 * `@/lib/stripe/eventos` lê pelos caminhos novos, de propósito.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

let cliente: Stripe | null = null;

export function stripe(): Stripe {
  if (cliente) return cliente;

  cliente = new Stripe(requireServerEnv("STRIPE_SECRET_KEY"), {
    apiVersion: STRIPE_API_VERSION,
    // Aparece no log de requisições do Dashboard. Quando duas coisas escrevem
    // na mesma conta (o app e o `scripts/stripe-sync.mjs`), é isto que diz qual
    // delas fez a chamada que se está investigando.
    appInfo: { name: "PageMask", url: "https://pagemask.com.br" },
    // Três tentativas para falha de rede e 5xx. O SDK só repete o que é seguro
    // repetir e usa chave de idempotência própria nos POSTs, então isto não
    // cria assinatura em dobro.
    maxNetworkRetries: 3,
    timeout: 20_000,
  });

  return cliente;
}

/** A Stripe está configurada neste ambiente? */
export function stripeConfigurada(): boolean {
  return Boolean(getServerEnv().STRIPE_SECRET_KEY);
}

/**
 * Pix Automático entra no checkout?
 *
 * Desligado por padrão. No Brasil o Pix da Stripe é liberado por solicitação
 * ao suporte, e `payment_method_types: ["card", "pix"]` numa conta sem a
 * liberação **não cai para o cartão**: a criação da sessão falha inteira, e o
 * cliente não consegue assinar de jeito nenhum.
 */
export function pixHabilitado(): boolean {
  return getServerEnv().STRIPE_PIX_ENABLED === true;
}
