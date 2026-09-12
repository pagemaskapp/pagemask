/**
 * O que o arquivo É, lido dos bytes dele.
 *
 * Extensão e `Content-Type` são DECLARAÇÕES de quem envia, e as duas são
 * trocáveis num `fetch` de três linhas. Um `.html` renomeado para `.png`
 * atravessa qualquer conferência baseada em nome — e é exatamente o que o
 * cross-check da fase manda tentar.
 *
 * O que ele faria, se passasse: o PNG do cabeçalho é servido ao navegador por
 * URL pré-assinada do R2. Um arquivo gravado como HTML e servido com
 * `Content-Type: text/html` executa script no domínio do R2, com acesso ao que
 * aquele domínio guardar. A assinatura de bytes fecha isso na entrada, e o
 * `Content-Type` travado na assinatura do PUT (`lib/r2/assinatura.ts`) fecha
 * de novo na saída.
 *
 * Também sai daqui a GEOMETRIA, e ela importa por outro motivo: quem abre esta
 * imagem depois é o Pillow, dentro do worker. Um PNG de 30.000 × 30.000 pesa
 * poucos KB comprimido e vira quase 4 GB descomprimido — uma bomba de
 * descompressão que derruba o container inteiro, não só o job. Recusar aqui é
 * mais barato do que descobrir lá.
 */

export type Imagem = {
  tipo: "image/png" | "image/jpeg";
  extensao: "png" | "jpg";
  largura: number;
  altura: number;
};

export type Veredito =
  | { ok: true; imagem: Imagem }
  | { ok: false; motivo: string };

/** Quanto do começo do arquivo basta para decidir. */
export const BYTES_PARA_DECIDIR = 64 * 1024;

/** 8000 × 8000 já é quatro vezes a altura do canvas. Acima disso é bomba. */
const LADO_MAXIMO = 8000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const NAO_E_IMAGEM =
  "Este arquivo não é um PNG nem um JPG de verdade — o conteúdo dele não " +
  "confere com a extensão. Exporte a imagem de novo e envie.";

export function identificar(inicio: Buffer): Veredito {
  if (inicio.length >= 8 && inicio.subarray(0, 8).equals(PNG)) {
    return comGeometria("image/png", "png", dimensoesPng(inicio));
  }

  // JPEG: `FF D8 FF` é o SOI seguido do primeiro marcador. Os dois primeiros
  // bytes sozinhos aceitariam arquivo truncado ou forjado com sorte.
  if (inicio.length >= 3 && inicio[0] === 0xff && inicio[1] === 0xd8 && inicio[2] === 0xff) {
    return comGeometria("image/jpeg", "jpg", dimensoesJpeg(inicio));
  }

  return { ok: false, motivo: NAO_E_IMAGEM };
}

function comGeometria(
  tipo: Imagem["tipo"],
  extensao: Imagem["extensao"],
  dimensoes: { largura: number; altura: number } | null,
): Veredito {
  if (!dimensoes) {
    return {
      ok: false,
      motivo:
        "Não conseguimos ler as dimensões desta imagem. Exporte-a de novo, " +
        "sem recursos avançados, e envie.",
    };
  }

  const { largura, altura } = dimensoes;
  if (largura < 1 || altura < 1) return { ok: false, motivo: NAO_E_IMAGEM };

  if (largura > LADO_MAXIMO || altura > LADO_MAXIMO) {
    return {
      ok: false,
      motivo:
        `Esta imagem tem ${largura}×${altura} pixels e o limite é ` +
        `${LADO_MAXIMO}×${LADO_MAXIMO}. Reduza o tamanho e envie de novo.`,
    };
  }

  return { ok: true, imagem: { tipo, extensao, largura, altura } };
}

/**
 * O IHDR do PNG é obrigatoriamente o primeiro bloco, logo depois da assinatura:
 * 4 bytes de tamanho, 4 do nome `IHDR`, e então largura e altura em big-endian.
 */
function dimensoesPng(inicio: Buffer): { largura: number; altura: number } | null {
  if (inicio.length < 24) return null;
  if (inicio.subarray(12, 16).toString("latin1") !== "IHDR") return null;

  return {
    largura: inicio.readUInt32BE(16),
    altura: inicio.readUInt32BE(20),
  };
}

/**
 * No JPEG a geometria mora num marcador `SOFn`, e ele pode estar depois de
 * vários outros (EXIF, ICC, comentários). Daí o caminhar de marcador em
 * marcador, pulando cada um pelo tamanho declarado.
 *
 * `SOF4` (0xC4, tabelas de Huffman), `SOF8` (0xC8, reservado) e `SOF12`
 * (0xCC, definição aritmética) **não** são quadros, apesar de caírem na faixa
 * 0xC0–0xCF: tratá-los como quadro leria dois bytes quaisquer como altura.
 */
function dimensoesJpeg(inicio: Buffer): { largura: number; altura: number } | null {
  let i = 2;

  while (i + 3 < inicio.length) {
    if (inicio[i] !== 0xff) {
      // Byte de preenchimento entre marcadores é legítimo; qualquer outra
      // coisa significa que perdemos o passo e não dá para confiar no resto.
      i += 1;
      continue;
    }

    const marcador = inicio[i + 1];
    if (marcador === 0xff) {
      i += 1;
      continue;
    }

    // SOI/EOI e os RSTn não têm campo de tamanho.
    if (marcador === 0xd8 || marcador === 0xd9 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      i += 2;
      continue;
    }

    const tamanho = inicio.readUInt16BE(i + 2);
    if (tamanho < 2) return null;

    const quadro =
      marcador >= 0xc0 &&
      marcador <= 0xcf &&
      marcador !== 0xc4 &&
      marcador !== 0xc8 &&
      marcador !== 0xcc;

    if (quadro) {
      // [tamanho:2][precisão:1][altura:2][largura:2]
      if (i + 9 >= inicio.length) return null;
      return {
        altura: inicio.readUInt16BE(i + 5),
        largura: inicio.readUInt16BE(i + 7),
      };
    }

    // `SOS` (0xDA) inicia os dados comprimidos: daqui para a frente não há
    // mais marcador de cabeçalho para achar.
    if (marcador === 0xda) return null;

    i += 2 + tamanho;
  }

  return null;
}
