import { PASSOS } from "@/lib/landing/conteudo";

/**
 * Os três passos.
 *
 * Lista ordenada de verdade (`<ol>`), e não três cartões soltos: a ordem é o
 * conteúdo. Quem lê por leitor de tela ouve "item 2 de 3" e sabe onde está.
 *
 * O numeral fica em `aria-hidden` porque a `<ol>` já anuncia a posição — sem
 * isso, o item vira "2 2 Defina o template uma vez".
 */
export function ComoFunciona() {
  return (
    <section
      id="como-funciona"
      aria-labelledby="como-funciona-titulo"
      className="border-b border-border bg-background"
    >
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <h2
          id="como-funciona-titulo"
          className="font-heading max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        >
          Três passos, e o lote sai pronto
        </h2>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg">
          A configuração acontece uma vez. Depois dela, enviar um lote novo é
          arrastar a pasta.
        </p>

        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {PASSOS.map((passo, indice) => (
            <li
              key={passo.titulo}
              className="bg-card ring-foreground/10 rounded-xl p-6 ring-1"
            >
              <span
                aria-hidden="true"
                className="bg-primary/15 text-primary font-heading flex size-10 items-center justify-center rounded-full text-lg font-semibold"
              >
                {indice + 1}
              </span>
              <h3 className="font-heading mt-5 text-lg font-semibold">
                {passo.titulo}
              </h3>
              <p className="text-muted-foreground mt-2 leading-relaxed">
                {passo.texto}
              </p>
            </li>
          ))}
        </ol>

        {/*
          A faixa de App Review vive aqui também, e não só dentro do app: um
          visitante que lê "publica no Instagram" na landing e descobre depois
          de assinar que ainda não publica tem motivo para pedir o dinheiro de
          volta — com razão.
        */}
        <p className="border-primary/30 bg-primary/5 text-muted-foreground mt-8 rounded-xl border px-5 py-4 text-sm leading-relaxed">
          <strong className="text-foreground font-medium">
            Publicação automática no Instagram: em análise na Meta.
          </strong>{" "}
          A conexão de conta já existe no produto, mas a publicação em nome da
          sua página só é liberada depois que a Meta aprovar o aplicativo. Até
          lá, o lote editado desce em ZIP e você publica como já publica hoje.
        </p>
      </div>
    </section>
  );
}
