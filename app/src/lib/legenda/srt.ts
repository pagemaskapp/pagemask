/**
 * O SRT, do lado do servidor: ler, higienizar, escrever.
 *
 * ESTE ARQUIVO É UM ESPELHO, e o original está em
 * `worker/src/servico/legenda.py`. A mesma relação de `lib/template/esquema.ts`
 * com o `molde.py`, e pela mesma razão — as duas validações defendem coisas
 * diferentes:
 *
 *   · aqui é a porta de ESCRITA. O texto que o usuário salva na tela é gravado
 *     no R2, e o que for gravado ali é o que o render vai usar. Higienizar na
 *     entrada é o que impede que o bucket guarde um arquivo hostil — inclusive
 *     para o caso de alguém ler aquele objeto por outro caminho um dia;
 *   · lá é a porta de DESENHO. O worker higieniza de novo tudo que lê, venha do
 *     modelo de transcrição ou do R2, porque é ele quem monta o ASS.
 *
 * Se um dos dois tiver um furo, o outro continua de pé. É por isso que o worker
 * NÃO confia neste arquivo, e não deve passar a confiar.
 *
 * MUDANÇA AQUI É MUDANÇA NOS DOIS LADOS. Uma regra que só exista de um lado
 * produz o pior tipo de defeito: o texto salva, a tela mostra certo, e o vídeo
 * sai diferente do que a pessoa leu.
 */

/** Os mesmos tetos de `legenda.py`. */
export const MAX_FALAS = 2_000;
export const MAX_LINHAS_POR_FALA = 2;
export const MAX_CARACTERES_POR_LINHA = 42;
export const MAX_BYTES_DO_SRT = 512 * 1024;

/**
 * O que sai do texto de vez.
 *
 * `{`, `}` e a barra invertida são sintaxe de ASS; `<` e `>` são sintaxe de
 * HTML, que o decodificador de SRT do FFmpeg converte em tags de override. O
 * resto são invisíveis: controles C0/C1 (sem `\t` e `\n`, que são espaço e
 * quebra de linha), largura zero, marcas de direção e a BOM.
 *
 * Escritos como escape unicode de propósito, pela mesma razão de
 * `lib/r2/chaves.ts`: um caractere de controle literal no fonte some em
 * revisão e em diff — que é justamente o que o torna útil para atacar.
 *
 * REMOVER, E NÃO ESCAPAR. Escapar exigiria acertar a regra de dois
 * interpretadores e manter o acerto a cada versão dos dois; remover encerra a
 * questão, e o preço é um caractere que não aparece em legenda de fala.
 */
const PROIBIDOS =
  /[{}<>\\\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

const TEMPO = /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/g;

export type Fala = {
  /** Segundos. */
  inicio: number;
  fim: number;
  linhas: string[];
};

export class SrtInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "SrtInvalidoError";
  }
}

/** O texto de uma fala, pronto para ser desenhado. Nunca sintaxe. */
export function higienizar(texto: string): string[] {
  const limpo = texto
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(PROIBIDOS, "");

  const linhas: string[] = [];
  for (const bruta of limpo.split("\n")) {
    const normal = bruta.split(/\s+/).filter(Boolean).join(" ");
    if (normal) linhas.push(...quebrar(normal, MAX_CARACTERES_POR_LINHA));
  }

  if (linhas.length <= MAX_LINHAS_POR_FALA) return linhas;

  // O corte é por LINHA, e não por caractere, porque o teto de linhas é o que
  // mantém válida a conta de altura que o worker faz para a legenda caber na
  // faixa de vídeo. Uma fala de cinco linhas viraria um bloco alto demais.
  const cortadas = linhas.slice(0, MAX_LINHAS_POR_FALA);
  cortadas[cortadas.length - 1] = comReticencias(
    cortadas[cortadas.length - 1]!,
    MAX_CARACTERES_POR_LINHA,
  );
  return cortadas;
}

function quebrar(texto: string, largura: number): string[] {
  const linhas: string[] = [];
  let atual = "";

  for (let palavra of texto.split(" ")) {
    while (palavra.length > largura) {
      if (atual) {
        linhas.push(atual);
        atual = "";
      }
      linhas.push(palavra.slice(0, largura));
      palavra = palavra.slice(largura);
    }

    if (!atual) atual = palavra;
    else if (atual.length + 1 + palavra.length <= largura) atual = `${atual} ${palavra}`;
    else {
      linhas.push(atual);
      atual = palavra;
    }
  }

  if (atual) linhas.push(atual);
  return linhas;
}

function comReticencias(linha: string, largura: number): string {
  if (linha.length + 1 <= largura) return `${linha}…`;
  return `${linha.slice(0, Math.max(0, largura - 1)).trimEnd()}…`;
}

/**
 * O SRT conferido e higienizado.
 *
 * Tolerante no FORMATO e intransigente no CONTEÚDO, que é a combinação que o
 * caso pede: o arquivo volta de um `<textarea>`, onde a numeração fica furada e
 * a quebra de linha é o que o navegador mandar — nada disso é motivo para
 * recusar o trabalho de quem corrigiu uma palavra. O que não passa é sintaxe.
 */
export function lerSrt(bruto: string, duracaoS?: number): Fala[] {
  const texto = bruto.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const falas: Fala[] = [];
  let anteriorFim = 0;

  for (const bloco of texto.split(/\n{2,}/)) {
    let linhas = bloco.split("\n").filter((l) => l.trim() !== "");
    if (linhas.length === 0) continue;

    // O número de sequência é opcional: ele é redundante (a ordem é a do
    // arquivo) e some ou repete em qualquer edição manual. É reescrito ao
    // gravar.
    if (!linhas[0]!.includes("-->") && linhas.length > 1) linhas = linhas.slice(1);
    if (linhas.length === 0 || !linhas[0]!.includes("-->")) continue;

    TEMPO.lastIndex = 0;
    const tempos = [...linhas[0]!.matchAll(TEMPO)];
    if (tempos.length < 2) continue;

    let inicio = emSegundos(tempos[0]!);
    let fim = emSegundos(tempos[1]!);
    const conteudo = higienizar(linhas.slice(1).join("\n"));
    if (conteudo.length === 0) continue;

    if (duracaoS && duracaoS > 0) {
      inicio = Math.min(inicio, duracaoS);
      fim = Math.min(fim, duracaoS);
    }

    // Ordem e sobreposição não são erro do usuário, são ruído de edição — e o
    // libass desenharia duas falas ao mesmo tempo, uma por cima da outra.
    inicio = Math.max(inicio, anteriorFim);
    if (fim <= inicio) fim = inicio + 0.4;
    anteriorFim = fim;

    falas.push({ inicio, fim, linhas: conteudo });
    if (falas.length >= MAX_FALAS) break;
  }

  if (falas.length === 0) {
    throw new SrtInvalidoError(
      "Esta legenda não tem nenhuma fala legível. Confira o texto e salve de novo.",
    );
  }

  return falas;
}

function emSegundos(casado: RegExpMatchArray): number {
  const [, h, m, s, ms] = casado;
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms!.padEnd(3, "0")) / 1000
  );
}

/** O SRT canônico: numeração refeita, vírgula no milissegundo, `\n` puro. */
export function escreverSrt(falas: Fala[]): string {
  return falas
    .map(
      (fala, indice) =>
        `${indice + 1}\n${emTexto(fala.inicio)} --> ${emTexto(fala.fim)}\n` +
        `${fala.linhas.join("\n")}\n`,
    )
    .join("\n");
}

function emTexto(segundos: number): string {
  const total = Math.max(0, segundos);
  const inteiro = Math.floor(total);
  let ms = Math.round((total - inteiro) * 1000);
  let s = inteiro % 60;
  let m = Math.floor(inteiro / 60) % 60;
  let h = Math.floor(inteiro / 3600);

  // O arredondamento pode estourar o último milissegundo do segundo.
  if (ms >= 1000) {
    ms = 0;
    s += 1;
  }
  if (s >= 60) {
    s = 0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    h += 1;
  }

  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(h)}:${dois(m)}:${dois(s)},${String(ms).padStart(3, "0")}`;
}
