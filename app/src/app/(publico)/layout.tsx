import Link from "next/link";

/**
 * Layout das páginas públicas exigidas pelo App Review da Meta e pela LGPD:
 * `/privacidade` e `/exclusao-de-dados`.
 *
 * Fora de `/app/*` (não exige sessão) e fora de `(auth)` (que é uma coluna
 * estreita para formulário). Texto longo pede largura de leitura.
 */
export default function LayoutPublico({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="bg-card flex h-14 items-center justify-between border-b px-6">
        <Link href="/" className="font-heading text-lg font-semibold tracking-tight">
          Page<span className="text-primary">Mask</span>
        </Link>
        <nav aria-label="Páginas públicas" className="flex items-center gap-5 text-sm">
          <Link href="/privacidade" className="text-muted-foreground hover:text-foreground">
            Privacidade
          </Link>
          <Link href="/exclusao-de-dados" className="text-muted-foreground hover:text-foreground">
            Exclusão de dados
          </Link>
          <Link href="/entrar" className="text-primary font-medium">
            Entrar
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">{children}</main>

      <footer className="text-muted-foreground border-t px-6 py-6 text-center text-xs">
        PageMask · Edição de vídeo em lote para páginas do Instagram
      </footer>
    </div>
  );
}
