import Link from "next/link";

/**
 * O topo da landing.
 *
 * O POSICIONAMENTO É VERIFICAÇÃO, NÃO VOLUME. Editor em lote não é
 * diferencial: os concorrentes já brigam por "mil vídeos por mês", e ganhar
 * essa briga é ganhar a briga do preço. O que ninguém oferece é a segunda
 * metade — a prova, por vídeo, de que a edição fez o que devia. Por isso a
 * frase de abertura fala do vídeo conferido, e o volume aparece só depois,
 * como consequência.
 *
 * O número "sete" é o único da seção, e ele é verificável: são as sete
 * checagens de `worker/src/validate.py`, listadas uma a uma mais abaixo na
 * própria página.
 */
export function Hero({ logado }: { logado: boolean }) {
  return (
    <section className="relative isolate overflow-hidden bg-slate-950 text-slate-100">
      {/*
        Brilho de fundo. `aria-hidden` e sem texto: é decoração, e um leitor
        de tela não tem o que fazer com ela.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60rem_40rem_at_70%_-10%,rgba(16,185,129,0.22),transparent)]"
      />

      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
        <p className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium tracking-wide text-emerald-300 uppercase">
          Edição em lote para páginas do Instagram
        </p>

        <h1 className="font-heading mt-6 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-balance text-white sm:text-5xl lg:text-6xl">
          O lote inteiro editado. Cada vídeo{" "}
          <span className="text-emerald-400">conferido</span> antes de sair.
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-300">
          Você sobe a pasta de vídeos e define o template uma vez. O PageMask
          troca o perfil antigo pelo seu e devolve o lote pronto — com sete
          checagens automáticas por vídeo que medem se o perfil antigo foi
          coberto e se a imagem original continua intacta.
        </p>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
          {logado ? (
            <Link
              href="/app/projetos"
              className="inline-flex items-center justify-center rounded-lg bg-emerald-400 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-emerald-300"
            >
              Ir para os seus projetos
            </Link>
          ) : (
            <Link
              href="/cadastrar"
              className="inline-flex items-center justify-center rounded-lg bg-emerald-400 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-emerald-300"
            >
              Criar conta
            </Link>
          )}
          <a
            href="#verificacao"
            className="inline-flex items-center justify-center rounded-lg border border-white/20 px-6 py-3 text-base font-medium text-slate-100 transition-colors hover:border-white/40 hover:bg-white/5"
          >
            Ver o antes e depois
          </a>
        </div>

        <p className="mt-5 text-sm text-slate-400">
          {logado
            ? "Sua conta já está ativa."
            : "Criar conta não pede cartão. A assinatura só entra quando você escolhe um plano."}
        </p>
      </div>
    </section>
  );
}
