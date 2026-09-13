import Link from "next/link";

import { ENCARREGADO } from "@/lib/legal/encarregado";

/**
 * Layout das páginas públicas exigidas pelo App Review da Meta e pela LGPD:
 * `/privacidade`, `/termos`, `/exclusao-de-dados` e `/conta-excluida`.
 *
 * Fora de `/app/*` (não exige sessão) e fora de `(auth)` (que é uma coluna
 * estreita para formulário). Texto longo pede largura de leitura.
 *
 * O ENCARREGADO NO RODAPÉ É EXIGÊNCIA, NÃO CORTESIA
 * =================================================
 *
 * A Resolução ANPD 18/2024 pede nome e contato do Encarregado "em local de
 * destaque" no site — e diz, com todas as letras, que uma linha perdida dentro
 * de um PDF não cumpre isso. Ele já abre a página de privacidade; aqui ele
 * aparece em toda página pública, que é o que faz dele algo encontrável por
 * quem chegou procurando a quem reclamar, e não por quem já foi ler a política
 * inteira.
 */
export default function LayoutPublico({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="bg-card flex h-14 items-center justify-between border-b px-6">
        <Link href="/" className="font-heading text-lg font-semibold tracking-tight">
          Page<span className="text-primary">Mask</span>
        </Link>
        <nav
          aria-label="Páginas públicas"
          className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm"
        >
          <Link href="/privacidade" className="text-muted-foreground hover:text-foreground">
            Privacidade
          </Link>
          <Link href="/termos" className="text-muted-foreground hover:text-foreground">
            Termos
          </Link>
          <Link
            href="/exclusao-de-dados"
            className="text-muted-foreground hover:text-foreground"
          >
            Exclusão de dados
          </Link>
          <Link href="/entrar" className="text-primary font-medium">
            Entrar
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">{children}</main>

      <footer className="text-muted-foreground border-t px-6 py-6 text-center text-xs">
        <p>PageMask · Edição de vídeo em lote para páginas do Instagram</p>
        <p className="mt-2">
          Encarregado de dados (DPO): {ENCARREGADO.nome} —{" "}
          <a
            href={`mailto:${ENCARREGADO.email}`}
            className="text-primary underline underline-offset-4"
          >
            {ENCARREGADO.email}
          </a>
        </p>
        <p className="mt-1">
          <Link href="/privacidade#exclusao" className="underline underline-offset-4">
            Como excluir seus dados
          </Link>
        </p>
      </footer>
    </div>
  );
}
