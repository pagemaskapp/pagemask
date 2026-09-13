import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2Icon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ENCARREGADO } from "@/lib/legal/encarregado";
import { normalizarCodigo } from "@/lib/meta/codigo";

export const metadata: Metadata = {
  title: "Conta excluída",
  // Fora do índice: é uma página de confirmação, não conteúdo. O `noindex` do
  // layout raiz já vale; esta linha existe para que ninguém o remova por
  // engano junto com o de `/privacidade`, que é a exceção deliberada.
  robots: { index: false, follow: false },
};

/**
 * Para onde a exclusão de conta manda o navegador depois de terminar.
 *
 * Pública porque, a esta altura, a sessão acabou de deixar de existir — e
 * mostrar isto dentro de `/app/*` significaria pedir login para ver a
 * confirmação de que a conta não existe mais.
 *
 * O código é normalizado antes de aparecer, pela mesma razão de
 * `/exclusao-de-dados`: nada que venha da URL é impresso na tela sem passar por
 * `normalizarCodigo`, que só deixa passar `ABCD-EFGH-JKMN`. Sem isso, um link
 * preparado por terceiro estampa o texto que quiser numa página do PageMask,
 * com a credibilidade do domínio junto.
 */
export default async function ContaExcluida({
  searchParams,
}: PageProps<"/conta-excluida">) {
  const params = await searchParams;
  const codigo = normalizarCodigo(
    typeof params.code === "string" ? params.code : null,
  );

  return (
    <article className="space-y-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Sua conta foi excluída
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Obrigado por ter usado o PageMask.
        </p>
      </header>

      <Alert>
        <CheckCircle2Icon />
        <AlertTitle>Está feito</AlertTitle>
        <AlertDescription>
          <span>
            Os vídeos saíram do armazenamento, as contas do Instagram foram
            desconectadas e a autorização devolvida à Meta, e seu cadastro e
            login foram apagados. Os registros de auditoria continuam, sem nada
            que ligue àquilo a você.
          </span>
        </AlertDescription>
      </Alert>

      {codigo ? (
        <section className="space-y-3 text-sm leading-relaxed">
          <p>
            Código da solicitação:{" "}
            <strong className="font-mono tracking-wide">{codigo}</strong>
          </p>
          <p className="text-muted-foreground">
            Guarde-o. Ele é o que permite consultar o registro desta exclusão em{" "}
            <Link
              href={`/exclusao-de-dados?code=${encodeURIComponent(codigo)}`}
              className="text-primary underline underline-offset-4"
            >
              /exclusao-de-dados
            </Link>{" "}
            — e é a única coisa que sobrou ligada a ela, porque o resto foi
            apagado.
          </p>
        </section>
      ) : null}

      <section className="space-y-3 text-sm leading-relaxed">
        <p>
          Se você tinha assinatura ativa, confira na Stripe que ela foi
          cancelada: excluir a conta aqui não interrompe uma cobrança recorrente
          lá. Qualquer dúvida sobre esta exclusão vai para o Encarregado de
          dados,{" "}
          <a
            href={`mailto:${ENCARREGADO.email}`}
            className="text-primary underline underline-offset-4"
          >
            {ENCARREGADO.email}
          </a>
          .
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/">Voltar ao início</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/cadastrar">Criar outra conta</Link>
        </Button>
      </div>
    </article>
  );
}
