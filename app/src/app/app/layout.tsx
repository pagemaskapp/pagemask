import type { Metadata } from "next";
import Link from "next/link";

import { BarraLateral } from "@/components/app/barra-lateral";
import { FaixaAppReview } from "@/components/app/faixa-app-review";
import { MenuUsuario } from "@/components/app/menu-usuario";
import { exigirUsuario } from "@/lib/auth/sessao";

/**
 * Nada sob `/app/*` entra em indice de busca.
 *
 * O layout raiz passou a liberar a indexacao na Fase 11, para a landing e as
 * paginas legais aparecerem na busca. Aqui a excecao e explicita: sao telas de
 * conta, e o rastreador nem chega a ve-las (o proxy manda visitante para
 * `/entrar`) — mas `noindex` e a rede que nao depende do proxy estar certo.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Layout de tudo que exige sessão.
 *
 * `exigirUsuario()` roda aqui, no servidor, antes de qualquer filho renderizar.
 * O proxy já teria barrado o visitante — esta é a segunda checagem, e é a que
 * de fato protege: se o `matcher` do proxy falhar, o layout continua exigindo
 * sessão. Cada página filha também confere a sua, porque um layout não é
 * garantia de que a rota passou por ele em toda situação.
 */
export default async function LayoutApp({
  children,
}: {
  children: React.ReactNode;
}) {
  const usuario = await exigirUsuario();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-card sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b px-4">
        <Link
          href="/app/projetos"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Page<span className="text-primary">Mask</span>
        </Link>
        <MenuUsuario email={usuario.email ?? "sua conta"} />
      </header>

      <FaixaAppReview />

      <div className="flex flex-1">
        <aside className="bg-card hidden w-56 shrink-0 border-r sm:block">
          <BarraLateral />
        </aside>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">{children}</main>
      </div>

      {/* Em telas estreitas a barra lateral vira uma faixa no rodapé, em vez
          de sumir: as seis seções são a navegação inteira do produto. */}
      <div className="bg-card border-t sm:hidden">
        <BarraLateral />
      </div>
    </div>
  );
}
