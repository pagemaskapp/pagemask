import Link from "next/link";

/**
 * O fecho.
 *
 * Uma promessa só, e pequena o suficiente para ser cumprida na primeira
 * sessão: o primeiro lote. Nada de "transforme sua página" — quem chegou até
 * aqui já leu o argumento e o que falta é o próximo passo, não mais retórica.
 */
export function ChamadaFinal({ logado }: { logado: boolean }) {
  return (
    <section
      aria-labelledby="chamada-final-titulo"
      className="relative isolate overflow-hidden bg-slate-950 text-slate-100"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50rem_30rem_at_50%_120%,rgba(16,185,129,0.2),transparent)]"
      />

      <div className="mx-auto w-full max-w-3xl px-5 py-20 text-center sm:px-8 sm:py-24">
        <h2
          id="chamada-final-titulo"
          className="font-heading text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl"
        >
          Comece pelo primeiro lote
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-slate-300">
          Crie a conta, monte um projeto e suba os vídeos. Você vê o relatório
          do primeiro lote antes de decidir qualquer coisa sobre o segundo.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href={logado ? "/app/projetos" : "/cadastrar"}
            className="inline-flex items-center justify-center rounded-lg bg-emerald-400 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-emerald-300"
          >
            {logado ? "Ir para os seus projetos" : "Criar conta"}
          </Link>
          <a
            href="#planos"
            className="inline-flex items-center justify-center rounded-lg border border-white/20 px-6 py-3 text-base font-medium text-slate-100 transition-colors hover:border-white/40 hover:bg-white/5"
          >
            Rever os planos
          </a>
        </div>
      </div>
    </section>
  );
}
