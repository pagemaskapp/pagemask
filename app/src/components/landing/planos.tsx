import Link from "next/link";

import { IconeCerto } from "@/components/landing/icones";
import type { PlanoDaLanding } from "@/lib/landing/visitante";

/**
 * Os planos, com os preços que estão na tabela `plans`.
 *
 * **Nada aqui é constante de código.** Preço, cota, contas do Instagram,
 * projetos e tamanho máximo por arquivo saem do banco, como manda o CLAUDE.md
 * ("Limites por plano saem da tabela `plans`"). Uma promoção no banco aparece
 * na landing sem deploy; e, mais importante, a landing nunca anuncia um número
 * diferente do que o produto cobra.
 *
 * PARA ONDE VAI O BOTÃO. Checkout da Stripe exige conta — a assinatura é
 * criada contra um `customer` vinculado ao usuário. Então o visitante vai para
 * `/cadastrar` carregando `?proximo=/app/planos?plano=<slug>`, e é `/app/planos`
 * que abre o checkout, com as travas dela (conferência de origem, sessão,
 * limite de taxa, "já tem assinatura viva"). O slug viaja junto para a escolha
 * feita aqui não se perder no caminho.
 */

const dinheiro = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
});
const numero = new Intl.NumberFormat("pt-BR");

/** O destino do botão de um plano, já com o `?proximo=` montado. */
function destino(slug: string, logado: boolean): string {
  const alvo = `/app/planos?plano=${encodeURIComponent(slug)}`;
  return logado ? alvo : `/cadastrar?proximo=${encodeURIComponent(alvo)}`;
}

export function Planos({
  planos,
  logado,
}: {
  planos: PlanoDaLanding[];
  logado: boolean;
}) {
  return (
    <section
      id="planos"
      aria-labelledby="planos-titulo"
      className="border-b border-border bg-background"
    >
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <h2
          id="planos-titulo"
          className="font-heading max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        >
          Planos
        </h2>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg">
          Mensal, sem fidelidade. A cota de vídeos, as contas do Instagram e o
          número de projetos vêm do plano — e você troca de plano quando quiser.
        </p>

        {planos.length === 0 ? (
          /*
            Banco fora do ar ou catálogo vazio. Mostrar cartão com preço
            inventado seria mentir; sumir com a seção deixaria a âncora do menu
            apontando para o nada. Então a seção fica, sem número, e o caminho
            para falar com a gente continua aberto.
          */
          <p className="border-border text-muted-foreground mt-10 rounded-xl border border-dashed px-5 py-8 text-center">
            Os preços não puderam ser carregados agora. Recarregue a página em
            instantes ou escreva para{" "}
            <a
              href="mailto:contato@pagemask.com.br"
              className="text-primary underline underline-offset-4"
            >
              contato@pagemask.com.br
            </a>
            .
          </p>
        ) : (
          <ul className="mt-12 grid gap-6 md:grid-cols-3">
            {planos.map((plano, indice) => {
              // O do meio é o destaque. Posição no catálogo, não preço: quem
              // ordena a vitrine é o `sort_order` da tabela.
              const destaque = planos.length === 3 && indice === 1;

              return (
                <li
                  key={plano.slug}
                  className={
                    destaque
                      ? "ring-primary bg-card relative flex flex-col rounded-xl p-6 ring-2"
                      : "ring-foreground/10 bg-card flex flex-col rounded-xl p-6 ring-1"
                  }
                >
                  <h3 className="font-heading text-lg font-semibold">
                    {plano.name}
                  </h3>

                  <p className="mt-3">
                    <span className="font-heading text-3xl font-semibold">
                      {dinheiro.format(plano.price_cents / 100)}
                    </span>{" "}
                    <span className="text-muted-foreground text-sm">
                      por mês
                    </span>
                  </p>

                  <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                    {[
                      `${numero.format(plano.videos_month)} vídeos por mês`,
                      `${numero.format(plano.ig_accounts)} contas do Instagram`,
                      `${numero.format(plano.projects)} projetos`,
                      `${numero.format(plano.max_mb)} MB por arquivo`,
                    ].map((linha) => (
                      <li key={linha} className="flex items-start gap-2">
                        <IconeCerto className="text-primary mt-0.5 size-4 shrink-0" />
                        <span>{linha}</span>
                      </li>
                    ))}
                  </ul>

                  <Link
                    href={destino(plano.slug, logado)}
                    className={
                      destaque
                        ? "bg-primary text-primary-foreground hover:bg-primary/80 mt-8 inline-flex h-11 items-center justify-center rounded-lg px-5 font-medium transition-colors"
                        : "border-border hover:bg-muted mt-8 inline-flex h-11 items-center justify-center rounded-lg border px-5 font-medium transition-colors"
                    }
                  >
                    {logado ? "Assinar" : "Começar"}
                    <span className="sr-only"> o plano {plano.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-muted-foreground mt-8 text-sm leading-relaxed">
          O pagamento é processado pela Stripe — o PageMask não recebe nem
          guarda o número do seu cartão. Troca de plano, faturas e cancelamento
          ficam no portal da Stripe, em português.
        </p>
      </div>
    </section>
  );
}
