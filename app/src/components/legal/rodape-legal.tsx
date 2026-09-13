import Link from "next/link";

import { ENCARREGADO } from "@/lib/legal/encarregado";

/**
 * A linha legal que precisa existir em toda tela alcançável sem login.
 *
 * Duas exigências, uma peça:
 *
 *   · ANPD 18/2024 — nome e contato do Encarregado em local de destaque no
 *     site. "Destaque" não é a última seção de uma política que ninguém abriu:
 *     é estar visível de onde a pessoa está;
 *   · App Review da Meta — as URLs de política de privacidade, termos e
 *     exclusão de dados precisam ser encontráveis a partir do site, não só
 *     digitadas direto na barra de endereço.
 *
 * O layout de `(publico)` tem o seu próprio rodapé, mais completo; este é para
 * a raiz e para as telas de entrada, que não passam por aquele layout.
 */
export function RodapeLegal({ className = "" }: { className?: string }) {
  return (
    <footer
      className={`text-muted-foreground text-center text-xs ${className}`.trim()}
    >
      <nav aria-label="Informações legais" className="flex justify-center gap-4">
        <Link href="/privacidade" className="hover:text-foreground">
          Privacidade
        </Link>
        <Link href="/termos" className="hover:text-foreground">
          Termos
        </Link>
        <Link href="/exclusao-de-dados" className="hover:text-foreground">
          Exclusão de dados
        </Link>
      </nav>
      <p className="mt-2">
        Encarregado de dados: {ENCARREGADO.nome} —{" "}
        <a
          href={`mailto:${ENCARREGADO.email}`}
          className="underline underline-offset-4"
        >
          {ENCARREGADO.email}
        </a>
      </p>
    </footer>
  );
}
