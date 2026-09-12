import "server-only";

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import { bucketR2, createR2Client } from "@/lib/r2/cliente";
import { LeitorEmBlocos } from "@/lib/video/leitor";

export type CabecalhoDoObjeto = {
  bytes: number;
  tipo: string | null;
  /**
   * Impressão digital do conteúdo no momento em que foi lido.
   *
   * Existe por causa de uma janela real: a URL pré-assinada de `PUT` vale 15
   * minutos e a sondagem acontece no meio desse intervalo. Nada impede que o
   * mesmo objeto seja regravado DEPOIS da sondagem, com outros bytes do mesmo
   * tamanho e do mesmo tipo — e aí o `probe` guardado no banco descreve um
   * arquivo que não está mais lá.
   *
   * Guardar o ETag junto transforma isso em algo detectável: a Fase 3 confere
   * o ETag antes de baixar, e se não bater o arquivo trocou depois de aprovado.
   * Não é o que impede a troca — quem decide de fato continua sendo o
   * `ffprobe` do worker —, é o que a torna visível.
   */
  etag: string | null;
};

/**
 * Tamanho e `Content-Type` do objeto, ou `null` se ele não existe.
 *
 * É por aqui que a confirmação de upload descobre o tamanho REAL. O número que
 * o navegador manda na confirmação não serve para nada além de conversa: quem
 * decide quanta quota foi consumida e o que vai para `jobs.bytes_in` é o
 * bucket, que viu o arquivo chegar.
 */
export async function cabecalhoDoObjeto(
  chave: string,
  cliente: S3Client = createR2Client(),
): Promise<CabecalhoDoObjeto | null> {
  try {
    const saida = await cliente.send(
      new HeadObjectCommand({ Bucket: bucketR2(), Key: chave }),
    );
    return {
      bytes: Number(saida.ContentLength ?? 0),
      tipo: saida.ContentType ?? null,
      etag: saida.ETag ?? null,
    };
  } catch (erro) {
    if (ehObjetoAusente(erro)) return null;
    throw erro;
  }
}

export async function apagarObjeto(
  chave: string,
  cliente: S3Client = createR2Client(),
): Promise<void> {
  await cliente.send(new DeleteObjectCommand({ Bucket: bucketR2(), Key: chave }));
}

/**
 * Grava um texto curto no bucket, do SERVIDOR.
 *
 * Hoje só a legenda editada passa por aqui, e a escolha de gravar pelo servidor
 * em vez de assinar um `PUT` para o navegador é o ponto todo: o texto é
 * higienizado por `lib/legenda/srt.ts` no caminho, e o que chega ao bucket é o
 * que este processo escreveu — nunca os bytes que o cliente mandou. A chave do
 * SRT é entrada de um render; deixar o navegador escrever nela diretamente
 * seria dar a ele uma porta para dentro do pipeline.
 *
 * `Buffer.byteLength` em vez do tamanho da string: `ContentLength` é em bytes e
 * legenda em português tem acento, então os dois números são diferentes.
 */
export async function gravarTexto(
  chave: string,
  conteudo: string,
  tipo: string,
  cliente: S3Client = createR2Client(),
): Promise<void> {
  const corpo = Buffer.from(conteudo, "utf8");
  await cliente.send(
    new PutObjectCommand({
      Bucket: bucketR2(),
      Key: chave,
      Body: corpo,
      ContentLength: corpo.byteLength,
      ContentType: tipo,
    }),
  );
}

/** Teto por chamada de `DeleteObjects` no protocolo S3. */
const POR_LOTE = 1000;

/**
 * Apaga vários objetos de uma vez.
 *
 * Apagar um projeto com centenas de vídeos por chamadas individuais seriam
 * centenas de viagens de rede dentro de uma função com poucos segundos de vida
 * — ela terminaria no meio, deixando metade dos arquivos para trás sem nada
 * registrando o que sobrou.
 *
 * Objeto que não some fica órfão e o lifecycle de 30 dias o recolhe; por isso
 * a falha é registrada e não interrompe. A linha do banco já se foi — o que se
 * perde aqui é espaço, e temporário.
 */
export async function apagarObjetos(
  chaves: string[],
  cliente: S3Client = createR2Client(),
): Promise<void> {
  for (let inicio = 0; inicio < chaves.length; inicio += POR_LOTE) {
    const lote = chaves.slice(inicio, inicio + POR_LOTE);
    const saida = await cliente.send(
      new DeleteObjectsCommand({
        Bucket: bucketR2(),
        Delete: { Objects: lote.map((Key) => ({ Key })), Quiet: true },
      }),
    );

    if (saida.Errors?.length) {
      console.error("[r2] objetos que nao foram apagados", {
        quantos: saida.Errors.length,
        primeiroCodigo: saida.Errors[0]?.Code,
      });
    }
  }
}

/**
 * Leitor de cabeçalho apontado para um objeto do R2.
 *
 * Cada bloco vira um `GetObject` com `Range`, que é a peça que torna a sondagem
 * viável: um vídeo de 500 MB é decidido baixando algumas dezenas de KB. Sem
 * `Range` seria preciso trazer o arquivo inteiro para dentro da função da
 * Vercel — o que não caberia em memória nem em tempo.
 */
export function leitorDoObjeto(
  chave: string,
  bytes: number,
  cliente: S3Client = createR2Client(),
): LeitorEmBlocos {
  return new LeitorEmBlocos(bytes, async (inicio, fim) => {
    const saida = await cliente.send(
      new GetObjectCommand({
        Bucket: bucketR2(),
        Key: chave,
        Range: `bytes=${inicio}-${fim}`,
      }),
    );
    if (!saida.Body) return Buffer.alloc(0);
    return Buffer.from(await saida.Body.transformToByteArray());
  });
}

/**
 * O erro é "esse objeto não existe"?
 *
 * O `HeadObject` não devolve corpo, então o SDK não tem de onde tirar o
 * `NoSuchKey` que o `GetObject` traz — o que chega é um `NotFound` com 404.
 * Olhar as duas coisas, mais o código HTTP, cobre o R2 e o S3.
 */
function ehObjetoAusente(erro: unknown): boolean {
  if (typeof erro !== "object" || erro === null) return false;

  const nome = (erro as { name?: string }).name;
  if (nome === "NotFound" || nome === "NoSuchKey") return true;

  const status = (erro as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return status === 404;
}
