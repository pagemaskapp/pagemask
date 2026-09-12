#!/usr/bin/env node
/**
 * Espelha a tabela `plans` na Stripe e grava os ids de volta.
 *
 *   node scripts/stripe-sync.mjs            # mostra o que faria
 *   node scripts/stripe-sync.mjs --aplicar  # cria/atualiza de verdade
 *
 * POR QUE UM SCRIPT E NÃO UM CLIQUE NO DASHBOARD
 * ==============================================
 *
 * `plans` é a fonte de verdade do produto (CLAUDE.md: "limites por plano saem
 * da tabela `plans`, nunca de constante no código"). A Stripe é o cobrador. Se
 * os preços nascerem clicados no painel, existem duas fontes de verdade e nada
 * as reconcilia — e o dia em que elas divergirem é o dia em que alguém paga
 * R$ 97 por um plano que entrega a cota de R$ 239.
 *
 * O script vai numa direção só: banco → Stripe. Ele nunca altera `price_cents`
 * a partir do que achar na Stripe.
 *
 * PREÇO NÃO SE EDITA NA STRIPE — CRIA-SE OUTRO
 * ============================================
 *
 * `unit_amount` de um Price é imutável, por desenho da Stripe: assinaturas
 * existentes apontam para ele, e mudá-lo mudaria retroativamente o que os
 * clientes atuais pagam. Então mudar de preço é criar um Price novo, desativar
 * o antigo e gravar o novo em `plans.stripe_price_id`. Quem já assina continua
 * no Price antigo (e por isso ele é desativado, não apagado: `planoDoPrice`
 * ainda precisa traduzi-lo para o slug quando um webhook chegar).
 *
 * O QUE ELE ESCREVE NO BANCO
 * ==========================
 *
 * `plans.stripe_product_id` e `plans.stripe_price_id`. Nada mais. E os dois são
 * DIFERENTES em teste e em produção — por isso não são commitados numa migration
 * de seed: rodar o script é passo de ambiente, como criar o bucket do R2.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const raiz = path.resolve(import.meta.dirname, "..");

const aplicar = process.argv.includes("--aplicar");

// ---------------------------------------------------------------------------
// .env.local — lido à mão, porque este script roda fora do Next
// ---------------------------------------------------------------------------
// Um parser mínimo de propósito: só `CHAVE=valor`, comentário com `#`, aspas
// opcionais. Não expande variável, não roda shell. Tudo que ele lê são segredos,
// e um parser esperto aqui seria superfície de ataque para ganhar nada.
function carregarEnv(arquivo) {
  let texto;
  try {
    texto = readFileSync(arquivo, "utf8");
  } catch {
    return {};
  }

  const saida = {};
  for (const linha of texto.split(/\r?\n/)) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith("#")) continue;
    const igual = limpa.indexOf("=");
    if (igual <= 0) continue;
    const chave = limpa.slice(0, igual).trim();
    let valor = limpa.slice(igual + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (valor !== "") saida[chave] = valor;
  }
  return saida;
}

const env = { ...carregarEnv(path.join(raiz, ".env.local")), ...process.env };

function exigir(nome) {
  const valor = env[nome];
  if (!valor) {
    console.error(
      `\n✖ ${nome} não está definida. Preencha app/.env.local (veja .env.example).\n`,
    );
    process.exit(1);
  }
  return valor;
}

const SUPABASE_URL = exigir("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE = exigir("SUPABASE_SERVICE_ROLE_KEY");
const STRIPE_KEY = exigir("STRIPE_SECRET_KEY");

if (!STRIPE_KEY.startsWith("sk_") && !STRIPE_KEY.startsWith("rk_")) {
  console.error("\n✖ STRIPE_SECRET_KEY precisa ser `sk_…` ou `rk_…`.\n");
  process.exit(1);
}

const modo = STRIPE_KEY.startsWith("sk_live_") || STRIPE_KEY.startsWith("rk_live_")
  ? "PRODUÇÃO"
  : "teste";

const Stripe = require("stripe");
// A mesma versão fixada em `src/lib/stripe/cliente.ts`. Duas cópias do valor é
// ruim, mas a alternativa era este script importar TypeScript.
const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2026-08-26.dahlia" });

// ---------------------------------------------------------------------------
// PostgREST direto, sem o SDK: são duas consultas
// ---------------------------------------------------------------------------
async function rest(caminho, opcoes = {}) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opcoes.headers ?? {}),
    },
  });

  const corpo = await resposta.text();
  if (!resposta.ok) {
    throw new Error(`PostgREST ${resposta.status}: ${corpo}`);
  }
  return corpo ? JSON.parse(corpo) : null;
}

const dinheiro = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

async function main() {
  console.log(`\nStripe: modo ${modo}`);
  console.log(aplicar ? "Aplicando.\n" : "Simulação (use --aplicar para valer).\n");

  const planos = await rest("plans?select=*&order=sort_order.asc");
  if (!planos?.length) {
    console.error("✖ Nenhuma linha em `plans`. Rode a migration 0002 primeiro.");
    process.exit(1);
  }

  const priceIds = [];

  for (const plano of planos) {
    const rotulo = `${plano.slug} (${plano.name}, ${dinheiro.format(plano.price_cents / 100)}/mês)`;

    // --- Product ---------------------------------------------------------
    let productId = plano.stripe_product_id ?? null;
    if (productId) {
      // Confere que o Product ainda existe: apagado no painel, o `create` de
      // Price abaixo falharia com um erro que não diz isso.
      try {
        const atual = await stripe.products.retrieve(productId);
        if (atual.deleted) productId = null;
      } catch {
        console.log(`  · ${plano.slug}: product ${productId} não existe mais`);
        productId = null;
      }
    }

    if (!productId) {
      if (aplicar) {
        const criado = await stripe.products.create(
          {
            name: `PageMask ${plano.name}`,
            description:
              `${plano.videos_month} vídeos por mês · ${plano.ig_accounts} contas ` +
              `do Instagram · ${plano.projects} projetos · ${plano.max_mb} MB por vídeo`,
            metadata: { plano: plano.slug, produto: "pagemask" },
          },
          // Product por slug: rodar o script duas vezes seguidas não cria dois.
          { idempotencyKey: `pagemask:product:${plano.slug}` },
        );
        productId = criado.id;
        console.log(`  + product ${productId} — ${rotulo}`);
      } else {
        console.log(`  + criaria product — ${rotulo}`);
      }
    } else if (aplicar) {
      await stripe.products.update(productId, {
        name: `PageMask ${plano.name}`,
        description:
          `${plano.videos_month} vídeos por mês · ${plano.ig_accounts} contas ` +
          `do Instagram · ${plano.projects} projetos · ${plano.max_mb} MB por vídeo`,
        metadata: { plano: plano.slug, produto: "pagemask" },
      });
      console.log(`  = product ${productId} — ${rotulo}`);
    }

    // --- Price -----------------------------------------------------------
    // Só serve o Price que casa EXATAMENTE: mesmo produto, mesmo valor em
    // centavos, BRL, mensal e ativo. Qualquer diferença exige um Price novo,
    // porque `unit_amount` é imutável.
    let priceId = null;
    if (productId) {
      const existentes = aplicar || plano.stripe_product_id
        ? await stripe.prices.list({ product: productId, active: true, limit: 100 })
        : { data: [] };

      const casado = existentes.data.find(
        (p) =>
          p.unit_amount === plano.price_cents &&
          p.currency === "brl" &&
          p.recurring?.interval === "month" &&
          p.recurring?.interval_count === 1,
      );
      priceId = casado?.id ?? null;

      if (!priceId) {
        if (aplicar) {
          const criado = await stripe.prices.create(
            {
              product: productId,
              // Centavos inteiros, direto da tabela. Nenhuma divisão no
              // caminho: `unit_amount` É centavos (CLAUDE.md, "Dinheiro").
              unit_amount: plano.price_cents,
              currency: "brl",
              recurring: { interval: "month", interval_count: 1 },
              // `lookup_key` dá um nome estável ao preço vigente; com
              // `transfer_lookup_key` ele migra para o Price novo quando o
              // valor muda, e o antigo fica sem chave.
              lookup_key: `pagemask_${plano.slug}`,
              transfer_lookup_key: true,
              metadata: { plano: plano.slug, centavos: String(plano.price_cents) },
            },
            {
              idempotencyKey: `pagemask:price:${plano.slug}:${plano.price_cents}`,
            },
          );
          priceId = criado.id;
          console.log(`  + price ${priceId} — ${rotulo}`);

          // Desativa o Price anterior, se havia outro. Não apaga: quem já
          // assina continua apontando para ele, e `planoDoPrice` precisa
          // traduzi-lo quando um webhook daquela assinatura chegar.
          if (plano.stripe_price_id && plano.stripe_price_id !== priceId) {
            await stripe.prices.update(plano.stripe_price_id, { active: false });
            console.log(`  - price ${plano.stripe_price_id} desativado (valor mudou)`);
          }
        } else {
          console.log(`  + criaria price — ${rotulo}`);
        }
      } else {
        console.log(`  = price ${priceId} — ${rotulo}`);
      }
    }

    if (priceId) priceIds.push(priceId);

    // --- de volta para o banco ------------------------------------------
    if (aplicar && productId && priceId) {
      if (
        plano.stripe_product_id !== productId ||
        plano.stripe_price_id !== priceId
      ) {
        await rest(`plans?slug=eq.${encodeURIComponent(plano.slug)}`, {
          method: "PATCH",
          body: JSON.stringify({
            stripe_product_id: productId,
            stripe_price_id: priceId,
          }),
        });
        console.log(`  → plans.${plano.slug} atualizado`);
      }
    }
  }

  // --- Billing Portal ----------------------------------------------------
  // A configuração é o que permite trocar de plano DENTRO do portal. Sem ela o
  // portal só deixa cancelar e atualizar cartão, e a promessa de "trocar de
  // plano" da tela de planos fica sem caminho.
  if (aplicar && priceIds.length > 0) {
    const produtos = [];
    for (const plano of planos) {
      const recarregado = await rest(
        `plans?slug=eq.${encodeURIComponent(plano.slug)}&select=stripe_product_id,stripe_price_id`,
      );
      const linha = recarregado?.[0];
      if (linha?.stripe_product_id && linha?.stripe_price_id) {
        produtos.push({
          product: linha.stripe_product_id,
          prices: [linha.stripe_price_id],
          // DESLIGADO, e o padrão da Stripe é LIGADO. Sem isto o cliente muda a
          // quantidade no portal e assina "5 × Ritmo" — paga cinco vezes e
          // recebe os limites de um, porque `plans` é por plano e não por
          // assento, e o webhook lê `items.data[0].price.id` sem olhar
          // `quantity`. Ninguém ganha acesso de graça; o estrago é uma cobrança
          // cinco vezes maior que o cliente não pediu.
          adjustable_quantity: { enabled: false },
        });
      }
    }

    // ATUALIZA a que existe, em vez de criar outra a cada execução. Criar era
    // errado nos dois sentidos: acumulava configurações órfãs na conta, e —
    // pior — a que está no `STRIPE_PORTAL_CONFIGURATION_ID` do ambiente
    // continuava apontando para o Price ANTIGO depois de uma mudança de preço.
    // O portal do cliente seguia oferecendo um preço que o script acabou de
    // desativar, e a troca de plano falhava lá dentro.
    //
    // A que existe é achada por `metadata.produto = pagemask`; a variável de
    // ambiente tem prioridade, porque é ela que o app de fato usa.
    const corpoDaConfiguracao = {
      business_profile: {
        privacy_policy_url: `${env.NEXT_PUBLIC_APP_URL ?? "https://pagemask.com.br"}/privacidade`,
        terms_of_service_url: `${env.NEXT_PUBLIC_APP_URL ?? "https://pagemask.com.br"}/termos`,
      },
      features: {
        customer_update: { enabled: true, allowed_updates: ["email", "tax_id"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          products: produtos,
          // `always_invoice` na troca: o proporcional é cobrado na hora, e não
          // guardado para a fatura seguinte. É o que mantém `invoice.paid` como
          // o sinal de "o cliente pagou o que devia neste ciclo".
          proration_behavior: "always_invoice",
        },
        subscription_cancel: {
          enabled: true,
          // No FIM DO PERÍODO, nunca imediato: é o que o PLANO pede
          // ("cancelar rebaixa no fim do período"). Cancelar na hora tiraria
          // acesso de um mês já pago.
          mode: "at_period_end",
          cancellation_reason: {
            enabled: true,
            options: [
              "too_expensive",
              "missing_features",
              "switched_service",
              "unused",
              "other",
            ],
          },
        },
      },
      metadata: { produto: "pagemask" },
    };

    let existente = null;
    if (env.STRIPE_PORTAL_CONFIGURATION_ID) {
      try {
        const atual = await stripe.billingPortal.configurations.retrieve(
          env.STRIPE_PORTAL_CONFIGURATION_ID,
        );
        if (atual.active) existente = atual.id;
      } catch {
        console.log(
          `  · STRIPE_PORTAL_CONFIGURATION_ID=${env.STRIPE_PORTAL_CONFIGURATION_ID} nao existe mais`,
        );
      }
    }

    if (!existente) {
      const lista = await stripe.billingPortal.configurations.list({
        active: true,
        limit: 100,
      });
      existente =
        lista.data.find((c) => c.metadata?.produto === "pagemask")?.id ?? null;
    }

    const configuracao = existente
      ? await stripe.billingPortal.configurations.update(
          existente,
          corpoDaConfiguracao,
        )
      : await stripe.billingPortal.configurations.create(corpoDaConfiguracao);

    console.log(
      `\n  ${existente ? "=" : "+"} configuração do portal ${configuracao.id}`,
    );
    if (!existente || env.STRIPE_PORTAL_CONFIGURATION_ID !== configuracao.id) {
      console.log("\nPonha esta linha em app/.env.local (e na Vercel):");
      console.log(`  STRIPE_PORTAL_CONFIGURATION_ID=${configuracao.id}`);
    }
  }

  console.log(
    aplicar
      ? "\n✔ Pronto.\n"
      : "\n✔ Simulação concluída. Rode com --aplicar para valer.\n",
  );
}

main().catch((erro) => {
  console.error("\n✖", erro instanceof Error ? erro.message : erro, "\n");
  process.exit(1);
});
