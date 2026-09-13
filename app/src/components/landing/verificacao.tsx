import Image from "next/image";
import { IconeCerto, IconeErrado } from "@/components/landing/icones";
import { nomeDaChecagem, PROVA } from "@/lib/landing/prova";

/**
 * A prova visual: antes, depois e o relatório de validação.
 *
 * É a seção que carrega o posicionamento. Todo mundo edita em lote; o que
 * ninguém entrega é a medida que diz se a edição funcionou naquele vídeo.
 *
 * NADA AQUI É ILUSTRAÇÃO. As duas imagens são quadros do mesmo segundo do
 * mesmo vídeo, antes e depois, e as sete linhas do relatório são a saída
 * literal de `worker/src/validate.py` sobre esse render (ver
 * `lib/landing/prova.ts` para o que é sintético e o que é real). Se alguém
 * mexer no worker e a cobertura piorar, o número piora aqui junto — a landing
 * não tem número próprio para esconder atrás.
 */

// As medidas reais dos arquivos que `scripts/gerar-prova-visual.py` escreve.
// Precisam bater com o arquivo: sao elas que reservam o espaco antes de a
// imagem chegar, e um valor errado aqui reaparece como salto de layout (CLS).
const LARGURA = 540;
const ALTURA = 758;

/**
 * `unoptimized`, e nao e descuido.
 *
 * As duas imagens ja saem do gerador no tamanho em que sao exibidas e em WebP
 * (~12 KB cada). Mandar isso pelo `/_next/image` so acrescenta uma ida ao
 * servidor por imagem — **medido**: o otimizador devolveu 14,5 KB para uma
 * origem de 11 KB, porque nao ha o que reduzir num arquivo que ja esta no
 * ponto. Com `unoptimized` o `<img>` aponta direto para `public/`, com cache
 * de asset estatico.
 *
 * O componente fica (em vez de um `<img>` cru) pelo que ele faz de util aqui:
 * `width`/`height` obrigatorios, que reservam o espaco e evitam o salto de
 * layout, e `loading="lazy"` por padrao — as imagens estao abaixo da dobra.
 */
const DIRETO = true;

export function Verificacao() {
  const { checks, media, layout, elapsed_s: segundos } = PROVA;
  const alturaDoHeaderAntigo = layout.old_header_bottom - layout.old_header_top + 1;
  const aprovadas = checks.filter((check) => check.ok).length;

  // Lido do relatorio, nunca escrito a mao: se um dia um pixel escapar, o
  // numero que aparece aqui e o numero que escapou.
  const vazamento = checks.find(
    (check) => check.name === "vazamento_do_header_antigo",
  )?.metrics.leaked_px;

  return (
    <section
      id="verificacao"
      aria-labelledby="verificacao-titulo"
      className="border-b border-border bg-card"
    >
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <h2
          id="verificacao-titulo"
          className="font-heading max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        >
          A verificação é o produto
        </h2>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg leading-relaxed">
          Volume qualquer script faz. O que decide se o vídeo pode ir ao ar são
          outras duas perguntas: o perfil antigo sumiu mesmo, e a imagem
          original continua inteira? O PageMask responde às duas com medida, e
          anexa a medida ao vídeo.
        </p>

        {/*
          Duas colunas IGUAIS, e nao `grid-cols-[auto_1fr]`.
          `auto` parecia o certo e nao era: ele dimensiona pelo conteudo
          intrinseco, e o conteudo aqui sao dois `<img>` de 540 px de largura
          natural — a coluna passava de 1000 px, a secao ficava com milhares de
          pixels de altura e o relatorio era espremido numa tira na borda.
          Metade e metade tambem e o que a prova pede: o que ela mostra e a
          troca do @ no topo do quadro, e isso precisa ser LEGIVEL.
        */}
        <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-14">
          <div className="mx-auto flex w-full max-w-md gap-4 sm:gap-6 lg:mx-0">
            <figure className="min-w-0 flex-1">
              <Image
                src="/prova/antes.webp"
                alt="Quadro do vídeo de origem: no topo, o perfil da página antiga, com avatar, o nome @perfil.antigo e a frase de chamada dela; abaixo, a faixa com a imagem do vídeo."
                width={LARGURA}
                height={ALTURA}
                unoptimized={DIRETO}
                className="ring-foreground/15 w-full rounded-xl ring-1"
              />
              <figcaption className="text-muted-foreground mt-3 text-sm">
                <span className="text-foreground font-medium">Antes</span> · o
                arquivo como ele chega
              </figcaption>
            </figure>

            <figure className="min-w-0 flex-1">
              <Image
                src="/prova/depois.webp"
                alt="O mesmo quadro depois do processamento: o perfil antigo deu lugar ao perfil @suapagina e à frase configurada no template; a faixa com a imagem do vídeo continua idêntica."
                width={LARGURA}
                height={ALTURA}
                unoptimized={DIRETO}
                className="ring-primary/40 w-full rounded-xl ring-2"
              />
              <figcaption className="text-muted-foreground mt-3 text-sm">
                <span className="text-foreground font-medium">Depois</span> · o
                que sai do render
              </figcaption>
            </figure>
          </div>

          <div className="min-w-0">
            <div className="bg-background ring-foreground/10 overflow-hidden rounded-xl ring-1">
              <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
                <h3 className="font-heading font-semibold">
                  Relatório de validação
                </h3>
                <span className="bg-primary/15 text-accent-foreground dark:text-primary rounded-full px-3 py-1 text-xs font-medium">
                  {aprovadas} de {checks.length} aprovadas
                </span>
              </div>

              <ul className="divide-border divide-y">
                {checks.map((check) => (
                  <li key={check.name} className="flex gap-3 px-5 py-3.5">
                    {/*
                      O icone segue `check.ok`, e nao a suposicao de que tudo
                      passou. O gerador so atualiza o relatorio quando o
                      pipeline aprova — mas a pagina que MOSTRA o relatorio nao
                      pode ser a peca que assume isso.
                    */}
                    {check.ok ? (
                      <IconeCerto className="text-primary mt-0.5 size-4 shrink-0" />
                    ) : (
                      <IconeErrado className="text-destructive mt-0.5 size-4 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {nomeDaChecagem(check.name)}
                      </p>
                      {/*
                        `detail` vem do worker em texto corrido e com número
                        junto — é a linha que o operador lê no log. Em fonte
                        monoespaçada porque é isso mesmo que ela é: saída de
                        ferramenta, não copy.
                      */}
                      <p className="text-muted-foreground mt-1 font-mono text-xs leading-relaxed break-words">
                        {check.detail}
                      </p>
                    </div>
                    <span className="sr-only">
                      {check.ok ? "Aprovada" : "Reprovada"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <dl className="mt-6 grid gap-4 sm:grid-cols-3">
              <div className="bg-background ring-foreground/10 rounded-xl px-4 py-3 ring-1">
                <dt className="text-muted-foreground text-xs">
                  Perfil antigo coberto
                </dt>
                <dd className="font-heading mt-1 text-xl font-semibold">
                  {alturaDoHeaderAntigo} px
                </dd>
              </div>
              {typeof vazamento === "number" ? (
                <div className="bg-background ring-foreground/10 rounded-xl px-4 py-3 ring-1">
                  <dt className="text-muted-foreground text-xs">
                    Pixels que escaparam
                  </dt>
                  <dd className="font-heading mt-1 text-xl font-semibold">
                    {vazamento.toLocaleString("pt-BR")}
                  </dd>
                </div>
              ) : null}
              <div className="bg-background ring-foreground/10 rounded-xl px-4 py-3 ring-1">
                <dt className="text-muted-foreground text-xs">
                  {media.duration.toLocaleString("pt-BR")} s de vídeo em
                </dt>
                <dd className="font-heading mt-1 text-xl font-semibold">
                  {segundos.toLocaleString("pt-BR")} s
                </dd>
              </div>
            </dl>

            <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
              O vídeo acima foi feito para esta página — material de página de
              terceiro não entra aqui sem autorização. O que ele atravessou é o
              pipeline de produção, sem atalho: mesma detecção de layout, mesmo
              FFmpeg, mesma validação. Os resultados acima são a saída literal
              dessa execução, e o comando que a reproduz está no repositório.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
