import Link from "next/link";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Entrar" };

/**
 * Rota reservada. O cadastro e o login com Supabase Auth entram na Fase 1
 * (docs/PLANO.md). Ate la a pagina existe so para que o link da home nao
 * aponte para lugar nenhum.
 */
export default function Entrar() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Entrar
        </h1>
        <p className="text-muted-foreground mt-3 text-sm text-balance">
          O acesso à conta ainda não está no ar.
        </p>
        <Link
          href="/"
          className="text-primary mt-8 inline-block text-sm underline underline-offset-4"
        >
          Voltar ao início
        </Link>
      </div>
    </main>
  );
}
