import type Stripe from "stripe";
import { z } from "zod";

import { ipDoCabecalho, registrarAuditoria } from "@/lib/auditoria";
import { usuarioDaApi } from "@/lib/auth/api";
import { estadoDaCobranca } from "@/lib/cobranca/estado";
import { campos, irParaStripe, origemConfere, voltarCom } from "@/lib/cobranca/porta";
import { publicEnv } from "@/lib/env/public";
import { consumirBalde } from "@/lib/rate-limit/balde";
import { pixHabilitado, stripe, stripeConfigurada } from "@/lib/stripe/cliente";
import { clienteDoUsuario } from "@/lib/stripe/cliente-do-usuario";
import { priceDoPlano } from "@/lib/stripe/planos";

/**
 * `POST /api/stripe/checkout` — abre a Checkout Session e manda o navegador
 * para lá.
 *
 * **O CLIENTE ESCOLHE O PLANO, NÃO O PREÇO.** O corpo tem um campo só, `plano`,
 * e ele é um slug do nosso catálogo. O `price_…` sai de `plans.stripe_price_id`
 * no servidor. É o cross-check de segurança da fase — "alterar o `price_id` no
 * cliente antes do checkout → servidor usa o do plano escolhido" — e ele não
 * passa por validação: passa porque **não existe campo de preço na
 * requisição**. Um `price` a mais no corpo é descartado pelo zod, e mesmo que
 * chegasse não há código que o leia.
 *
 * Formulário de verdade (`<form method="post">`), não `fetch`: sem JavaScript o
 * botão de assinar continua funcionando. A defesa contra POST de outro site é o
 * `SameSite=Lax` do cookie, reforçada pela conferência de `Origin`.
 */

const Pedido = z.object({
  // O `min`/`max` e o formato existem para o valor não virar chave de consulta
  // arbitrária. Qual slug existe de verdade quem responde é a tabela.
  plano: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Plano inválido."),
});

export async function POST(requisicao: Request) {
  if (!origemConfere(requisicao)) {
    return voltarCom("/app/planos", "origem-invalida");
  }

  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  if (!stripeConfigurada()) {
    console.error("[stripe/checkout] STRIPE_SECRET_KEY ausente neste ambiente");
    return voltarCom("/app/planos", "cobranca-indisponivel");
  }

  // Abrir checkout custa duas chamadas à Stripe. Vinte por hora é folgado para
  // quem está decidindo entre três planos e apertado para um laço.
  const limite = await consumirBalde({
    bucket: `stripe-checkout:${usuario.id}`,
    limite: 20,
    janela: "1 hour",
    rotulo: "stripe-checkout",
  });
  if (!limite.permitido) {
    return voltarCom("/app/planos", "muitas-tentativas");
  }

  // JÁ TEM ASSINATURA VIVA? ENTÃO ISTO NÃO É UM CHECKOUT, É UMA TROCA DE PLANO.
  //
  // A tela de planos já manda quem tem assinatura para o portal, mas a tela não
  // é a tranca: um POST direto nesta rota criaria uma SEGUNDA assinatura para a
  // mesma pessoa. O estrago é dos caros — duas cobranças mensais na Stripe e
  // uma linha só no nosso banco (`subscriptions` é `unique (user_id)`), ou seja,
  // a primeira assinatura passa a cobrar sem aparecer em lugar nenhum.
  //
  // `isenta` não entra na conta: conta de piloto pode assinar de verdade quando
  // quiser, e é justamente assim que ela deixa de ser piloto.
  //
  // O guarda FECHA quando não dá para ler o estado. É o único jeito de ele não
  // ser inútil: com o estado ilegível, `ativa` é falso e um checkout novo
  // passaria — criando a segunda assinatura exatamente na hora em que o banco
  // não consegue dizer que já existe uma.
  const cobranca = await estadoDaCobranca(usuario.id);
  if (cobranca.indisponivel) {
    console.error("[stripe/checkout] estado de cobrança ilegível; recusando");
    return voltarCom("/app/planos", "cobranca-indisponivel");
  }
  if (cobranca.ativa && !cobranca.isenta) {
    return voltarCom("/app/conta", "ja-tem-assinatura");
  }

  const pedido = Pedido.safeParse(await campos(requisicao));
  if (!pedido.success) return voltarCom("/app/planos", "plano-invalido");

  const plano = await priceDoPlano(pedido.data.plano);
  if (!plano) {
    // As três causas são nossas, não do usuário: slug que não existe, plano
    // desativado, ou `npm run stripe:sync` que nunca rodou neste ambiente.
    console.error("[stripe/checkout] plano sem price na Stripe", {
      slug: pedido.data.plano,
    });
    return voltarCom("/app/planos", "plano-indisponivel");
  }

  try {
    const customer = await clienteDoUsuario(usuario);
    const parametros = montarSessao({
      customer,
      userId: usuario.id,
      priceId: plano.stripe_price_id,
      planoSlug: plano.slug,
      planoNome: plano.name,
      precoCentavos: plano.price_cents,
    });

    const criada = await stripe().checkout.sessions.create(parametros);

    if (!criada.url) {
      console.error("[stripe/checkout] sessão criada sem URL", { id: criada.id });
      return voltarCom("/app/planos", "cobranca-indisponivel");
    }

    await registrarAuditoria({
      userId: usuario.id,
      actor: "user",
      action: "billing.checkout_opened",
      target: plano.slug,
      meta: { pix: pixHabilitado() },
      ip: ipDoCabecalho(requisicao.headers),
    });

    return irParaStripe(criada.url);
  } catch (erro) {
    console.error("[stripe/checkout] não foi possível abrir o checkout", {
      slug: plano.slug,
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return voltarCom("/app/planos", "cobranca-indisponivel");
  }
}

/**
 * Os parâmetros da sessão.
 *
 * `payment_method_types` é uma lista **explícita**, e não a seleção automática
 * do painel. Duas razões: o PLANO manda ("cartão sempre; Pix só se
 * `STRIPE_PIX_ENABLED=true`"), e a seleção automática é configurada por clique
 * no Dashboard — um clique errado lá mudaria as formas de pagamento do produto
 * sem passar por revisão nenhuma.
 *
 * PIX AUTOMÁTICO, QUANDO LIGADO. O mandato é o que o cliente autoriza no app do
 * banco, e ele tem teto: `amount` é o máximo que pode ser cobrado num ciclo
 * (padrão da Stripe: 400 BRL). Passar o preço exato do plano parece a coisa
 * certa e é a errada — no primeiro reajuste, ou numa troca para um plano mais
 * caro, a cobrança recorrente falharia e o cliente teria que voltar ao app do
 * banco para autorizar de novo. Por isso o teto é o preço com folga, calculado
 * abaixo.
 *
 * `tax_id_collection` entra junto com o Pix porque o fluxo brasileiro pede CPF
 * ou CNPJ na autorização do mandato.
 */
function montarSessao(dados: {
  customer: string;
  userId: string;
  priceId: string;
  planoSlug: string;
  planoNome: string;
  precoCentavos: number;
}): Stripe.Checkout.SessionCreateParams {
  const base = new URL(publicEnv.NEXT_PUBLIC_APP_URL);

  const parametros: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer: dados.customer,
    // Terceira fonte de dono do webhook, e a única que existe antes de
    // qualquer vínculo estar gravado (ver `@/lib/stripe/eventos`).
    client_reference_id: dados.userId,
    line_items: [{ price: dados.priceId, quantity: 1 }],
    payment_method_types: pixHabilitado() ? ["card", "pix"] : ["card"],
    subscription_data: {
      metadata: { user_id: dados.userId, plano: dados.planoSlug },
    },
    metadata: { user_id: dados.userId, plano: dados.planoSlug },
    locale: "pt-BR",
    // `{CHECKOUT_SESSION_ID}` é substituído pela Stripe. A tela de retorno NÃO
    // libera nada com base nele: quem libera é o webhook. Ele serve para a
    // página dizer "estamos confirmando" em vez de mostrar o estado antigo,
    // que é o que o usuário veria se voltasse antes de o evento chegar.
    success_url: new URL(
      "/app/conta?cobranca=ok&sessao={CHECKOUT_SESSION_ID}",
      base,
    ).toString(),
    cancel_url: new URL("/app/planos?cobranca=cancelado", base).toString(),
  };

  if (pixHabilitado()) {
    parametros.tax_id_collection = { enabled: true };
    parametros.payment_method_options = {
      pix: {
        mandate_options: {
          // O nome que aparece no app do banco do cliente.
          reference: `PageMask ${dados.planoNome}`,
          amount: tetoDoMandato(dados.precoCentavos),
          amount_type: "maximum",
          payment_schedule: "monthly",
        },
      },
    };
  }

  return parametros;
}

/**
 * O teto do mandato do Pix: o preço do plano mais 30%, arredondado para cima
 * na dezena de reais.
 *
 * A folga cobre reajuste, imposto e a troca para um plano mais caro sem
 * obrigar o cliente a voltar ao app do banco. Não é folga infinita de
 * propósito: o valor aparece para a pessoa na hora de autorizar, e um número
 * muito acima do que ela vai pagar derruba a conversão (é o alerta da própria
 * documentação da Stripe).
 *
 * Centavos inteiros do começo ao fim (CLAUDE.md, "Dinheiro"). `Math.ceil` sobre
 * inteiros, sem float no meio: `precoCentavos * 13` é inteiro, e a divisão só
 * acontece dentro do `ceil`.
 */
export function tetoDoMandato(precoCentavos: number): number {
  const comFolga = Math.ceil((precoCentavos * 13) / 10);
  const dezReais = 1000;
  return Math.ceil(comFolga / dezReais) * dezReais;
}
