import Link from "next/link";
import { CreditCardIcon, ExternalLinkIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { stripeConfigurada } from "@/lib/stripe/cliente";
import type { EstadoDaCobranca } from "@/lib/cobranca/estado";
import { frasesDaCota, motivoDaSuspensao } from "@/lib/cobranca/estado";

const dinheiro = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const numero = new Intl.NumberFormat("pt-BR");
const data = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeZone: "America/Sao_Paulo",
});

/**
 * O cartão de plano e uso da página de conta.
 *
 * Componente de servidor sem estado: tudo que ele mostra vem do `estado` que a
 * página já leu. Está num arquivo próprio porque `/app/conta/page.tsx` passou a
 * ter dois assuntos grandes (identidade e cobrança) e o segundo cresce a cada
 * fase.
 *
 * A REGRA DE HONESTIDADE DESTA TELA, herdada do que já existia aqui: **nunca
 * mostrar número que não foi possível ler**. Uma barra em 0% vinda de uma
 * consulta que falhou é a leitura mais tranquilizadora possível de um dado que
 * ninguém tem — e foi assim que uma migration não aplicada passou dias
 * escondida.
 */
export function Assinatura({
  estado,
  usoIndisponivel,
}: {
  estado: EstadoDaCobranca;
  usoIndisponivel: boolean;
}) {
  const suspensao = motivoDaSuspensao(estado);
  const cota = frasesDaCota(estado);
  const temBarra = !usoIndisponivel && estado.videosLimite > 0;
  const percentual = temBarra
    ? Math.min(100, (estado.videosUsados / estado.videosLimite) * 100)
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Plano {estado.plano?.name ?? estado.planSlug}
        </CardTitle>
        <CardDescription>
          {estado.plano
            ? `${dinheiro.format(estado.plano.price_cents / 100)} por mês · ${numero.format(estado.plano.videos_month)} vídeos, ${estado.plano.ig_accounts} contas do Instagram, ${estado.plano.projects} projetos`
            : "Não conseguimos carregar os detalhes do seu plano agora. Recarregue em instantes — se continuar assim, escreva para o suporte."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {suspensao ? (
          <Alert>
            <AlertTitle>Sem assinatura ativa</AlertTitle>
            <AlertDescription>{suspensao}</AlertDescription>
          </Alert>
        ) : null}

        {/*
          Pix Automático: a Stripe notifica o cliente três dias antes do débito
          e mantém a assinatura `active` nesse intervalo. Então `processando`
          não é problema — é o normal de quem paga por Pix, e a tela precisa
          dizer isso, senão a pessoa vê "processando" e acha que falhou.
        */}
        {estado.pagamento === "processando" ? (
          <Alert>
            <AlertTitle>Cobrança em processamento</AlertTitle>
            <AlertDescription>
              A autorização já está valendo e seu acesso continua normal. Com
              Pix, o banco avisa você três dias antes de cada débito.
            </AlertDescription>
          </Alert>
        ) : null}

        {estado.pagamento === "falhou" && estado.ativa ? (
          <Alert variant="destructive">
            <AlertTitle>A última cobrança não passou</AlertTitle>
            <AlertDescription>
              Seu acesso continua por enquanto e vamos tentar de novo. Atualize a
              forma de pagamento no portal para não perder o acesso.
            </AlertDescription>
          </Alert>
        ) : null}

        {estado.cancelaNoFimDoPeriodo && estado.fimDoPeriodo ? (
          <Alert>
            <AlertTitle>Assinatura cancelada</AlertTitle>
            <AlertDescription>
              Seu acesso vale até {data.format(estado.fimDoPeriodo)}. Depois
              dessa data a conta fica sem assinatura — seus arquivos prontos
              continuam disponíveis para baixar. Você pode desfazer o
              cancelamento no portal antes disso.
            </AlertDescription>
          </Alert>
        ) : null}

        {usoIndisponivel ? (
          <p className="text-muted-foreground text-sm">
            Não conseguimos carregar seu uso do mês agora. Recarregue em
            instantes — preferimos não mostrar número nenhum a mostrar um número
            que pode estar errado.
          </p>
        ) : (
          <>
            <div>
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">Uso do período</span>
                <span className="font-medium">
                  {estado.videosLimite > 0
                    ? `${numero.format(estado.videosUsados)} de ${numero.format(estado.videosLimite)} vídeos`
                    : `${numero.format(estado.videosUsados)} vídeos`}
                </span>
              </div>
              {temBarra ? (
                <div
                  role="progressbar"
                  aria-valuenow={estado.videosUsados}
                  aria-valuemin={0}
                  aria-valuemax={estado.videosLimite}
                  aria-label="Vídeos usados no período"
                  className="bg-muted h-2 w-full overflow-hidden rounded-full"
                >
                  <div
                    className="bg-primary h-full rounded-full transition-[width]"
                    style={{ width: `${percentual}%` }}
                  />
                </div>
              ) : null}
              <p className="text-muted-foreground mt-2 text-sm">{cota.mensagem}</p>
            </div>

            <p className="text-muted-foreground text-sm">
              {estado.isenta
                ? "Esta conta é isenta de cobrança (piloto ou uso interno). O contador zera junto com o ciclo do plano."
                : estado.fimDoPeriodo && !estado.cancelaNoFimDoPeriodo
                  ? `O contador zera em ${data.format(estado.fimDoPeriodo)}, quando o próximo pagamento for confirmado.`
                  : "O contador zera a cada pagamento confirmado do seu plano."}
            </p>
          </>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          {/*
            Formulário de verdade, como o "Sair" logo abaixo nesta mesma página:
            funciona sem JavaScript. O 303 do servidor leva direto ao portal da
            Stripe.
          */}
          {estado.temClienteNaStripe ? (
            <form action="/api/stripe/portal" method="post">
              <Button type="submit" variant="outline" disabled={!stripeConfigurada()}>
                <CreditCardIcon />
                Gerenciar cobrança
                <ExternalLinkIcon />
              </Button>
            </form>
          ) : null}

          <Button asChild variant={estado.ativa ? "outline" : "default"}>
            <Link href="/app/planos">
              {estado.ativa ? "Ver planos" : "Escolher um plano"}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
