import Link from "next/link";

import { InfoIcon } from "lucide-react";

/**
 * A faixa de "publicação automática em breve" (Fase 11).
 *
 * O App Review da Meta ainda não saiu, e sem ele o produto **não publica** em
 * nome de ninguém: a permissão `instagram_content_publish` só vale para quem
 * tem papel no app enquanto ele está em desenvolvimento. O produto inteiro
 * funciona — envio, template, render, verificação, download — menos o último
 * passo.
 *
 * A faixa fica dentro do app e não na landing porque são audiências
 * diferentes: na landing a informação é "isto ainda não existe" e vive junto
 * do argumento de venda (`components/landing/como-funciona.tsx`); aqui é "o
 * botão que você está procurando ainda não está aí", e precisa aparecer onde a
 * pessoa está procurando.
 *
 * DE PROPÓSITO SEM BOTÃO DE FECHAR. Fechar exigiria guardar a escolha em algum
 * lugar — e o estado de uma faixa que vai sumir sozinha quando a aprovação
 * sair não vale uma coluna no banco nem um componente de cliente numa árvore
 * que hoje é toda de servidor. Quando a Meta aprovar, o arquivo sai.
 */
export function FaixaAppReview() {
  return (
    <div
      role="status"
      className="border-primary/30 bg-primary/10 text-foreground border-b px-4 py-2.5 text-sm sm:px-8"
    >
      <p className="mx-auto flex max-w-5xl items-start gap-2 leading-relaxed">
        <InfoIcon
          aria-hidden="true"
          className="text-primary mt-0.5 size-4 shrink-0"
        />
        <span>
          <strong className="font-medium">
            Publicação automática no Instagram em breve.
          </strong>{" "}
          O aplicativo está em análise na Meta. Enquanto isso, seus vídeos
          editados ficam disponíveis para download — individualmente ou no{" "}
          <Link
            href="/app/projetos"
            className="text-primary underline underline-offset-4"
          >
            ZIP do lote
          </Link>
          .
        </span>
      </p>
    </div>
  );
}
