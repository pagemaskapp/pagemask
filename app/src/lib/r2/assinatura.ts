import "server-only";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { bucketR2, createR2Client } from "@/lib/r2/cliente";

/** 15 minutos (PLANO §4). Tempo de subir o arquivo, não mais que isso. */
export const VALIDADE_DE_ENVIO_S = 15 * 60;

/** 2 horas para baixar o resultado: cabe uma sessão de trabalho. */
export const VALIDADE_DE_DOWNLOAD_S = 2 * 60 * 60;

export type UrlDeEnvio = {
  url: string;
  /** O que o navegador é OBRIGADO a mandar. Fora disso, o R2 devolve 403. */
  cabecalhos: Record<string, string>;
  expira_em: string;
};

/**
 * URL pré-assinada de PUT, com tipo e tamanho travados na assinatura.
 *
 * O ponto inteiro está em `signableHeaders`. Uma URL pré-assinada comum
 * autoriza "gravar nesta chave" e nada mais — quem a tivesse poderia gravar
 * 40 GB de qualquer coisa ali, e o limite de tamanho do plano seria só um
 * número bonito na tela. Colocando `content-length` e `content-type` entre os
 * cabeçalhos ASSINADOS, os dois viram parte do que o R2 confere:
 *
 *   · mandar mais bytes do que o assinado → 403, sem gravar nada;
 *   · mandar outro `Content-Type` → 403, e é isto que fecha o
 *     `Content-Type: text/html` do cross-check da fase.
 *
 * O navegador não precisa (nem pode) escrever `Content-Length` à mão: ele o
 * calcula sozinho a partir do corpo. Bater com o assinado é, portanto, o mesmo
 * que o arquivo ter exatamente o tamanho que foi declarado ao pedir a URL.
 *
 * **`If-None-Match: *` é o que torna a URL de uso único**, e sem ele havia uma
 * janela real. Uma URL pré-assinada vale até expirar e não se invalida ao ser
 * usada: dava para enviar um H.264 legítimo, deixar a sondagem aprovar e
 * gravar o `probe` como prova, e então **regravar a mesma chave** com outro
 * conteúdo de mesmo tamanho e mesmo tipo. O banco passava a atestar um arquivo
 * que não estava mais lá.
 *
 * Com a escrita condicional, o R2 só aceita o PUT se a chave ainda não
 * existir. **Medido contra o R2:** primeiro PUT 200, o mesmo PUT de novo 412
 * `PreconditionFailed`, e sem o cabeçalho 403 (a assinatura não confere). Como
 * a chave é um UUID novo a cada pedido de assinatura, não há como obter uma
 * segunda autorização para a mesma chave.
 *
 * O `If-None-Match` precisa estar em `AllowedHeaders` do CORS do bucket —
 * `scripts/r2-cors.mjs` já o inclui. Sem isso o navegador nem tenta o envio.
 */
export async function assinarEnvio(opcoes: {
  chave: string;
  tipo: string;
  bytes: number;
}): Promise<UrlDeEnvio> {
  const cliente = createR2Client();

  const url = await getSignedUrl(
    cliente,
    new PutObjectCommand({
      Bucket: bucketR2(),
      Key: opcoes.chave,
      ContentType: opcoes.tipo,
      ContentLength: opcoes.bytes,
      IfNoneMatch: "*",
    }),
    {
      expiresIn: VALIDADE_DE_ENVIO_S,
      signableHeaders: new Set(["content-type", "content-length", "if-none-match"]),
    },
  );

  return {
    url,
    cabecalhos: { "Content-Type": opcoes.tipo, "If-None-Match": "*" },
    expira_em: new Date(Date.now() + VALIDADE_DE_ENVIO_S * 1000).toISOString(),
  };
}

/**
 * URL pré-assinada de GET para o usuário baixar o vídeo pronto.
 *
 * `ResponseContentDisposition` faz duas coisas. A visível é devolver o arquivo
 * com o nome que o usuário reconhece, em vez do UUID da chave. A que importa é
 * `attachment`: sem ela o navegador RENDERIZA o que vier conforme o
 * `Content-Type` gravado no objeto — e um arquivo que conseguisse ser gravado
 * como HTML viraria script executando no domínio do R2. Com `attachment`, o
 * conteúdo é baixado, nunca interpretado.
 *
 * O nome vai entre aspas e sem aspa nem controle dentro, porque ele é do
 * usuário: sem isso, um nome com `"` fecha o campo e injeta cabeçalho.
 */
export async function assinarDownload(opcoes: {
  chave: string;
  nomeParaSalvar: string;
}): Promise<string> {
  const cliente = createR2Client();
  const nome = nomeParaCabecalho(opcoes.nomeParaSalvar);

  return getSignedUrl(
    cliente,
    new GetObjectCommand({
      Bucket: bucketR2(),
      Key: opcoes.chave,
      ResponseContentDisposition: `attachment; filename="${nome}"; filename*=UTF-8''${encodeURIComponent(opcoes.nomeParaSalvar)}`,
    }),
    { expiresIn: VALIDADE_DE_DOWNLOAD_S },
  );
}

/**
 * Versão ASCII do nome, para o `filename=` simples do `Content-Disposition`.
 *
 * O `filename*=UTF-8''…` ao lado é quem carrega o nome de verdade, com acento;
 * este aqui é o reserva para cliente antigo, e por isso pode ser conservador.
 */
function nomeParaCabecalho(nome: string): string {
  const ascii = nome
    .normalize("NFD")
    // Tira os diacríticos separados pelo NFD: "ç" vira "c", "ã" vira "a".
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();

  return ascii === "" ? "video" : ascii.slice(0, 120);
}
