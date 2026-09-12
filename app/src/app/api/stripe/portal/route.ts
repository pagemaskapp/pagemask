import { ipDoCabecalho, registrarAuditoria } from "@/lib/auditoria";
import { usuarioDaApi } from "@/lib/auth/api";
import { irParaStripe, origemConfere, voltarCom } from "@/lib/cobranca/porta";
import { publicEnv } from "@/lib/env/public";
import { getServerEnv } from "@/lib/env/server";
import { consumirBalde } from "@/lib/rate-limit/balde";
import { stripe, stripeConfigurada } from "@/lib/stripe/cliente";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `POST /api/stripe/portal` — o Billing Portal da Stripe.
 *
 * É por aqui que se troca de plano, se atualiza o cartão, se baixa a fatura e
 * se cancela. **Nada disso é reimplementado no PageMask de propósito**: cada
 * uma dessas telas é um formulário que mexe em dinheiro, com regra fiscal e
 * exigência de PCI atrás. O portal já as tem prontas, em português, e o que
 * acontece nele volta para cá pelos mesmos webhooks — não existe caminho de
 * mudança de plano que escape do `apply_stripe_event`.
 *
 * O `customer` **não vem do corpo**. Ele é lido de `profiles` pela sessão, o
 * que torna impossível pedir o portal de outra pessoa: não há campo para isso.
 */
export async function POST(requisicao: Request) {
  if (!origemConfere(requisicao)) {
    return voltarCom("/app/conta", "origem-invalida");
  }

  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  if (!stripeConfigurada()) {
    console.error("[stripe/portal] STRIPE_SECRET_KEY ausente neste ambiente");
    return voltarCom("/app/conta", "cobranca-indisponivel");
  }

  const limite = await consumirBalde({
    bucket: `stripe-portal:${usuario.id}`,
    limite: 20,
    janela: "1 hour",
    rotulo: "stripe-portal",
  });
  if (!limite.permitido) {
    return voltarCom("/app/conta", "muitas-tentativas");
  }

  const supabase = createAdminClient();
  const { data: perfil, error } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", usuario.id)
    .maybeSingle();

  if (error) {
    console.error("[stripe/portal] não foi possível ler o perfil", {
      codigo: error.code,
      mensagem: error.message,
    });
    return voltarCom("/app/conta", "cobranca-indisponivel");
  }

  // Sem cliente na Stripe é porque nunca houve checkout. Criar um aqui só para
  // abrir um portal vazio seria gerar cliente sem assinatura na conta da
  // Stripe a cada clique curioso; o lugar certo é a página de planos.
  if (!perfil?.stripe_customer_id) {
    return voltarCom("/app/planos", "sem-assinatura");
  }

  try {
    const configuracao = getServerEnv().STRIPE_PORTAL_CONFIGURATION_ID;
    const portal = await stripe().billingPortal.sessions.create({
      customer: perfil.stripe_customer_id,
      return_url: new URL("/app/conta", publicEnv.NEXT_PUBLIC_APP_URL).toString(),
      locale: "pt-BR",
      // Sem a variável, vale a configuração padrão do Dashboard. Com ela, vale
      // a que o `npm run stripe:sync` monta — que é a única que sabe listar os
      // três planos para troca, porque é ela que acabou de criar os Prices.
      ...(configuracao ? { configuration: configuracao } : {}),
    });

    await registrarAuditoria({
      userId: usuario.id,
      actor: "user",
      action: "billing.portal_opened",
      target: null,
      ip: ipDoCabecalho(requisicao.headers),
    });

    return irParaStripe(portal.url);
  } catch (erro) {
    console.error("[stripe/portal] não foi possível abrir o portal", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return voltarCom("/app/conta", "portal-indisponivel");
  }
}
