import Link from "next/link";

import { ENCARREGADO } from "@/lib/legal/encarregado";

/**
 * Layout das páginas públicas exigidas pelo App Review da Meta e pela LGPD:
 * `/privacidade`, `/termos`, `/exclusao-de-dados` e `/conta-excluida`.
 *
 * Fora de `/app/*` (não exige sessão) e fora de `(auth)` (que é uma coluna
 * estreita para formulário). Texto longo pede largura de leitura.
 *
 * A MOLDURA É A MESMA DA LANDING (Fase 11). Barra escura em cima, rodapé
 * escuro embaixo, o texto no meio com as cores do tema. Não é enfeite: estas
 * páginas são o destino dos links do rodapé da landing, e cair num cabeçalho
 * de outra cor é o tipo de detalhe que faz a pessoa conferir a barra de
 * endereço para ver se ainda está no mesmo site. Isso vale dobrado para uma
 * política de privacidade.
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
      <header className="border-b border-white/10 bg-slate-950 text-slate-100">
        <div className="mx-auto flex min-h-16 w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-2">
          <Link
            href="/"
            className="font-heading py-1.5 text-lg font-semibold tracking-tight text-white"
          >
            Page<span className="text-emerald-400">Mask</span>
          </Link>
          <nav
            aria-label="Páginas públicas"
            className="flex flex-wrap items-center gap-x-4 text-sm"
          >
            {/*
              `py-1.5` em todo link, e não só espaçamento entre eles: um link
              de 16 px de altura é alvo de toque menor que o mínimo de 24×24
              px do WCAG 2.2 (2.5.8) — foi o que o Lighthouse reprovou aqui.
              O texto continua do mesmo tamanho; o que cresce é a área
              clicável.
            */}
            <Link href="/privacidade" className="py-1.5 text-slate-300 hover:text-white">
              Privacidade
            </Link>
            <Link href="/termos" className="py-1.5 text-slate-300 hover:text-white">
              Termos
            </Link>
            <Link
              href="/exclusao-de-dados"
              className="py-1.5 text-slate-300 hover:text-white"
            >
              Exclusão de dados
            </Link>
            <Link href="/entrar" className="py-1.5 font-medium text-emerald-400">
              Entrar
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">{children}</main>

      <footer className="bg-slate-950 px-6 py-8 text-center text-xs text-slate-400">
        <p>PageMask · Edição de vídeo em lote para páginas do Instagram</p>
        <p className="mt-3">
          Encarregado de dados (DPO): {ENCARREGADO.nome} —{" "}
          <a
            href={`mailto:${ENCARREGADO.email}`}
            className="inline-block py-1.5 text-emerald-400 underline underline-offset-4 hover:text-emerald-300"
          >
            {ENCARREGADO.email}
          </a>
        </p>
        <p>
          <Link
            href="/privacidade#exclusao"
            className="inline-block py-1.5 underline underline-offset-4 hover:text-slate-200"
          >
            Como excluir seus dados
          </Link>
        </p>
      </footer>
    </div>
  );
}
