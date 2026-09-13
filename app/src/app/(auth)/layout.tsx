import type { Metadata } from "next";
import Link from "next/link";

import { RodapeLegal } from "@/components/legal/rodape-legal";

/**
 * Tela de entrada nao entra em indice de busca.
 *
 * Nao e segredo — qualquer um chega em `/entrar` — mas indexar formulario
 * de login tira da busca a pagina que deveria aparecer (a landing) e poe
 * no lugar dela uma tela sem conteudo. O layout raiz passou a liberar a
 * indexacao na Fase 11; a excecao mora aqui e em `/app`.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function LayoutAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <Link
        href="/"
        className="font-heading mb-8 text-2xl font-semibold tracking-tight"
      >
        Page<span className="text-primary">Mask</span>
      </Link>
      {/*
        `main` e não `div`: sem um marco principal, quem navega por leitor de
        tela não tem como pular direto para o formulário — e estas telas são
        quase só formulário. O layout de `/app/*` já tem o dele.
      */}
      <main className="w-full max-w-sm">{children}</main>

      <RodapeLegal className="mt-12" />
    </div>
  );
}
