import Link from "next/link";

import { ENCARREGADO } from "@/lib/legal/encarregado";
import { estaLogado } from "@/lib/landing/visitante";

/**
 * A moldura da landing: barra de topo e rodapé.
 *
 * Separado de `(publico)` (que é coluna estreita para texto legal longo) e de
 * `(auth)` (coluna estreita para formulário). Aqui é página de largura cheia,
 * com faixas escuras nas pontas.
 *
 * O CTA DO TOPO MUDA COM A SESSÃO. Quem já tem conta e cai na landing — vem
 * de um link salvo, de uma busca, do rodapé de um e-mail — não precisa ver
 * "Criar conta". `estaLogado()` é memoizado por requisição, então a página
 * inteira paga uma leitura só.
 */

const ANCORAS = [
  { href: "/#como-funciona", texto: "Como funciona" },
  { href: "/#verificacao", texto: "Verificação" },
  { href: "/#planos", texto: "Planos" },
  { href: "/#perguntas", texto: "Perguntas" },
];

export default async function LayoutMarketing({
  children,
}: {
  children: React.ReactNode;
}) {
  const logado = await estaLogado();

  return (
    <div className="flex flex-1 flex-col">
      {/*
        Pular para o conteúdo. Invisível até receber foco pelo teclado — é o
        "bypass block" que quem navega sem mouse usa para não atravessar a
        navegação inteira a cada página.
      */}
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-emerald-400 focus:px-4 focus:py-2 focus:font-medium focus:text-slate-950"
      >
        Pular para o conteúdo
      </a>

      <header className="border-b border-white/10 bg-slate-950 text-slate-100">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link
            href="/"
            className="font-heading text-lg font-semibold tracking-tight text-white"
          >
            Page<span className="text-emerald-400">Mask</span>
          </Link>

          <nav
            aria-label="Seções da página"
            className="hidden items-center gap-6 text-sm md:flex"
          >
            {ANCORAS.map((ancora) => (
              <a
                key={ancora.href}
                href={ancora.href}
                className="text-slate-300 transition-colors hover:text-white"
              >
                {ancora.texto}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2 text-sm">
            {logado ? (
              <Link
                href="/app/projetos"
                className="rounded-lg bg-emerald-400 px-4 py-2 font-medium text-slate-950 transition-colors hover:bg-emerald-300"
              >
                Ir para o app
              </Link>
            ) : (
              <>
                <Link
                  href="/entrar"
                  className="hidden rounded-lg px-3 py-2 text-slate-300 transition-colors hover:text-white sm:inline-block"
                >
                  Entrar
                </Link>
                <Link
                  href="/cadastrar"
                  className="rounded-lg bg-emerald-400 px-4 py-2 font-medium text-slate-950 transition-colors hover:bg-emerald-300"
                >
                  Criar conta
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/*
        `tabIndex={-1}` no alvo do "pular para o conteúdo": sem ele, o navegador
        move só a âncora do documento, e a próxima tabulação volta para o link
        seguinte do CABEÇALHO — ou seja, o atalho não pula nada. `<main>` não é
        focável por padrão, e -1 o torna focável por script sem entrar na ordem
        de tabulação.
      */}
      <main id="conteudo" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>

      <footer className="bg-slate-950 text-slate-300">
        <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <p className="font-heading text-lg font-semibold tracking-tight text-white">
                Page<span className="text-emerald-400">Mask</span>
              </p>
              <p className="mt-3 max-w-sm text-sm text-slate-400">
                Edição de vídeo em lote para páginas temáticas do Instagram.
                Você sobe a pasta, define o template uma vez e recebe o lote
                editado e conferido.
              </p>
            </div>

            {/*
              Rótulo diferente do `<nav>` do topo de propósito: dois landmarks
              de navegação com o mesmo nome acessível são indistinguíveis na
              lista de marcos de um leitor de tela (regra `landmark-unique` do
              axe) — a pessoa ouve "navegação, Seções da página" duas vezes e
              não sabe qual é qual.
            */}
            <nav aria-label="Seções da página, no rodapé">
              <h2 className="text-sm font-semibold text-white">Produto</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {ANCORAS.map((ancora) => (
                  <li key={ancora.href}>
                    <a
                      href={ancora.href}
                      className="text-slate-400 transition-colors hover:text-white"
                    >
                      {ancora.texto}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            <nav aria-label="Informações legais">
              <h2 className="text-sm font-semibold text-white">Legal</h2>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <Link
                    href="/termos"
                    className="text-slate-400 transition-colors hover:text-white"
                  >
                    Termos de uso
                  </Link>
                </li>
                <li>
                  <Link
                    href="/privacidade"
                    className="text-slate-400 transition-colors hover:text-white"
                  >
                    Política de privacidade
                  </Link>
                </li>
                <li>
                  <Link
                    href="/exclusao-de-dados"
                    className="text-slate-400 transition-colors hover:text-white"
                  >
                    Exclusão de dados
                  </Link>
                </li>
              </ul>
            </nav>
          </div>

          {/*
            O Encarregado no rodapé é exigência da Resolução ANPD 18/2024 —
            nome e contato "em local de destaque no site", não uma linha no
            fim de uma política que ninguém abriu. Mesma decisão do layout de
            `(publico)` e do `RodapeLegal`.
          */}
          <div className="mt-12 flex flex-col gap-2 border-t border-white/10 pt-6 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Encarregado de dados (DPO): {ENCARREGADO.nome} —{" "}
              <a
                href={`mailto:${ENCARREGADO.email}`}
                className="text-emerald-400 underline underline-offset-4 hover:text-emerald-300"
              >
                {ENCARREGADO.email}
              </a>
            </p>
            <p>PageMask</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
