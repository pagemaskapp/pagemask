import type { Metadata } from "next";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { estadoDaCobranca, motivoDaSuspensao } from "@/lib/cobranca/estado";
import { avisoDaCobranca } from "@/lib/cobranca/avisos";
import { exigirUsuario } from "@/lib/auth/sessao";
import { planosAssinaveis } from "@/lib/stripe/planos";
import { stripeConfigurada } from "@/lib/stripe/cliente";

export const metadata: Metadata = { title: "Planos" };

const dinheiro = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const numero = new Intl.NumberFormat("pt-BR");

/**
 * `/app/planos` — escolher, trocar e retomar plano.
 *
 * É o destino de toda mensagem de "mude de plano" do produto, e por isso ela
 * tem endereço próprio em vez de morar dentro de `/app/conta`: o texto de um
 * bloqueio de cota precisa apontar para um lugar, e "role a página de conta até
 * o terceiro cartão" não é um lugar.
 *
 * **Assinar é um `<form method="post">`, não um `fetch`.** Sem JavaScript o
 * botão continua funcionando — é a mesma escolha do "Sair" da página de conta.
 * O redirecionamento para `checkout.stripe.com` acontece no servidor, com 303,
 * e é por isso que a CSP precisa listar o domínio da Stripe em `form-action`
 * (ver `lib/security-headers.ts`): sem isso o Chrome bloqueia o destino do POST
 * **sem erro visível na tela**.
 */
export default async function Planos({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string; cobranca?: string; plano?: string }>;
}) {
  const usuario = await exigirUsuario("/app/planos");
  const [estado, planos, parametros] = await Promise.all([
    estadoDaCobranca(usuario.id),
    planosAssinaveis(),
    searchParams,
  ]);

  const aviso = avisoDaCobranca(parametros.aviso, parametros.cobranca);
  const suspensao = motivoDaSuspensao(estado);

  // `?plano=<slug>` é a escolha feita na landing, que chega aqui pelo
  // `?proximo=` do cadastro. Serve só para destacar o cartão — quem decide
  // qual plano é assinado continua sendo o campo do formulário, conferido em
  // `/api/stripe/checkout` contra a tabela. Slug desconhecido não casa com
  // cartão nenhum e some sem erro, que é o certo: veio da URL.
  const escolhido = parametros.plano;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Planos
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A cota de vídeos, as contas do Instagram e o número de projetos saem do
          plano. Você pode trocar ou cancelar quando quiser.
        </p>
      </div>

      {aviso ? (
        <Alert variant={aviso.tom === "erro" ? "destructive" : "default"}>
          <AlertTitle>{aviso.titulo}</AlertTitle>
          <AlertDescription>{aviso.detalhe}</AlertDescription>
        </Alert>
      ) : null}

      {suspensao ? (
        <Alert>
          <AlertTitle>Conta sem assinatura ativa</AlertTitle>
          <AlertDescription>{suspensao}</AlertDescription>
        </Alert>
      ) : null}

      {estado.isenta ? (
        <Alert>
          <AlertTitle>Acesso liberado sem cobrança</AlertTitle>
          <AlertDescription>
            Esta conta está marcada como isenta (piloto ou uso interno). Os
            limites do plano {estado.plano?.name ?? estado.planSlug} continuam
            valendo, mas nada é cobrado.
          </AlertDescription>
        </Alert>
      ) : null}

      {/*
        Sem Stripe configurada não há como assinar, e mostrar três botões que
        levam a um erro é pior que não mostrar botão. Acontece em ambiente de
        desenvolvimento sem as chaves, e é exatamente onde alguém precisa ler o
        motivo em vez de caçá-lo no log.
      */}
      {!stripeConfigurada() ? (
        <Alert variant="destructive">
          <AlertTitle>Cobrança não configurada neste ambiente</AlertTitle>
          <AlertDescription>
            Falta a chave da Stripe no servidor. Nenhum plano pode ser assinado
            até que ela exista.
          </AlertDescription>
        </Alert>
      ) : null}

      {planos.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nenhum plano disponível agora</CardTitle>
            <CardDescription>
              Os planos existem no catálogo mas ainda não têm preço na Stripe
              neste ambiente. Recarregue em instantes — se continuar assim,
              escreva para o suporte.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {planos.map((plano) => {
            const atual = estado.ativa && estado.planSlug === plano.slug;
            const destacado = !atual && escolhido === plano.slug;

            return (
              <Card
                key={plano.slug}
                className={
                  atual || destacado ? "border-primary ring-primary/20 ring-2" : ""
                }
              >
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    {plano.name}
                    {atual ? (
                      <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">
                        seu plano
                      </span>
                    ) : null}
                    {destacado ? (
                      <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">
                        você escolheu
                      </span>
                    ) : null}
                  </CardTitle>
                  <CardDescription>
                    <span className="text-foreground text-2xl font-semibold">
                      {dinheiro.format(plano.price_cents / 100)}
                    </span>{" "}
                    por mês
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <ul className="space-y-2 text-sm">
                    {[
                      `${numero.format(plano.videos_month)} vídeos por mês`,
                      `${plano.ig_accounts} contas do Instagram`,
                      `${plano.projects} projetos`,
                      `${plano.max_mb} MB por vídeo`,
                    ].map((linha) => (
                      <li key={linha} className="flex items-start gap-2">
                        <CheckIcon className="text-primary mt-0.5 size-4 shrink-0" />
                        <span>{linha}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>

                <CardFooter>
                  {/*
                    Quem já tem assinatura viva troca de plano NO PORTAL, não
                    por um checkout novo. Um segundo checkout criaria uma
                    segunda assinatura para a mesma pessoa — duas cobranças
                    mensais e um `subscriptions` (que é `unique (user_id)`)
                    guardando só uma delas.
                  */}
                  {estado.ativa && !estado.isenta ? (
                    <form action="/api/stripe/portal" method="post" className="w-full">
                      <Button
                        type="submit"
                        className="w-full"
                        variant={atual ? "outline" : "default"}
                        disabled={!stripeConfigurada()}
                      >
                        {atual ? "Gerenciar assinatura" : `Mudar para ${plano.name}`}
                        <ExternalLinkIcon />
                      </Button>
                    </form>
                  ) : (
                    <form
                      action="/api/stripe/checkout"
                      method="post"
                      className="w-full"
                    >
                      <input type="hidden" name="plano" value={plano.slug} />
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={!stripeConfigurada()}
                      >
                        Assinar {plano.name}
                      </Button>
                    </form>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-muted-foreground text-sm">
        O pagamento é processado pela Stripe; o PageMask não recebe nem guarda o
        número do seu cartão. A troca de plano, a atualização da forma de
        pagamento, as faturas e o cancelamento ficam no portal da Stripe, em
        português.
      </p>
    </div>
  );
}
