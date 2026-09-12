import "server-only";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { bucketR2, createR2Client } from "@/lib/r2/cliente";

/** 15 minutos (PLANO §4). Tempo de subir o arquivo, não mais que isso. */
export const VALIDADE_DE_ENVIO_S = 15 * 60;

/**
 * 15 minutos para baixar o resultado (PLANO, Fase 7).
 *
 * Era de 2 horas na Fase 2, e encurtar foi deliberado: a URL assinada é uma
 * CREDENCIAL ao portador — quem a tiver baixa o vídeo, sem sessão, sem cookie
 * e sem deixar rastro na nossa aplicação. Ela vaza pelo caminho comum de toda
 * URL: histórico do navegador, `Referer`, a mensagem em que alguém a colou.
 * Duas horas de janela para isso não compram nada, porque o download começa em
 * segundos e o navegador já tem o arquivo — o que se perde ao encurtar é
 * apenas a chance de reaproveitar um link velho, que é justamente o que não se
 * quer.
 *
 * Quinze minutos cobrem com folga um arquivo grande em conexão doméstica:
 * **o prazo vale para INICIAR o download**, não para terminá-lo. Uma
 * transferência já em andamento não é interrompida quando a assinatura vence.
 *
 * O download da Meta (Fase 5) continua em 2 h e está em outro lugar
 * (`worker`): lá quem baixa é um servidor da Meta, minutos depois de o
 * container ser criado, e encurtar aquele prazo produz o erro `9004`.
 */
export const VALIDADE_DE_DOWNLOAD_S = 15 * 60;

/** O mesmo prazo do vídeo avulso, pela mesma razão, agora para o ZIP do lote. */
export const VALIDADE_DE_ZIP_S = VALIDADE_DE_DOWNLOAD_S;

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
  /**
   * Sobrescreve o prazo padrão, sempre para MENOS na prática: o ZIP passa
   * aqui o que falta do `expires_at` dele quando esse resto for menor que os
   * 15 minutos. Assinar além do prazo do objeto deixaria um link vivo para um
   * arquivo que o expurgo já apagou.
   */
  validadeS?: number;
  /** `application/zip` no pacote; no vídeo o padrão do objeto já serve. */
  tipo?: string;
}): Promise<string> {
  const cliente = createR2Client();
  const nome = nomeParaCabecalho(opcoes.nomeParaSalvar);
  const validade = Math.max(
    1,
    Math.floor(
      Math.min(opcoes.validadeS ?? VALIDADE_DE_DOWNLOAD_S, VALIDADE_DE_DOWNLOAD_S),
    ),
  );

  return getSignedUrl(
    cliente,
    new GetObjectCommand({
      Bucket: bucketR2(),
      Key: opcoes.chave,
      ...(opcoes.tipo ? { ResponseContentType: opcoes.tipo } : {}),
      ResponseContentDisposition: `attachment; filename="${nome}"; filename*=UTF-8''${encodeURIComponent(opcoes.nomeParaSalvar)}`,
    }),
    { expiresIn: validade },
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

/** Uma hora — o mesmo prazo de vida da prévia no R2 (migration 0020). */
export const VALIDADE_DE_PREVIA_S = 60 * 60;

/** 15 minutos para a miniatura do cabeçalho: dá para editar sem recarregar. */
export const VALIDADE_DE_IMAGEM_S = 15 * 60;

/** 10 minutos para carregar o SRT no editor de legenda: tempo de abrir a tela. */
export const VALIDADE_DE_LEGENDA_S = 10 * 60;

/**
 * URL pré-assinada de GET para o SRT que o editor de legenda carrega.
 *
 * O navegador busca o texto DIRETO do R2, sem passar pela função da Vercel. O
 * ganho não é performance: é não trafegar o arquivo do usuário por mais um
 * lugar do que o necessário.
 *
 * `attachment`, e não `inline`, apesar de o consumidor ser um `fetch()` — que
 * ignora `Content-Disposition`. Ele existe para o caso em que a URL **não** é
 * consumida por `fetch`: colada na barra de endereço, aberta de um histórico,
 * seguida por um bot. Com `attachment` o conteúdo é baixado; com `inline` ele
 * seria renderizado pelo navegador no domínio do R2, e o conteúdo é texto que
 * veio de um editor do usuário.
 *
 * `ResponseContentType` impõe `text/plain` por cima do que estiver gravado no
 * objeto — a mesma tranca de `assinarImagem`, pela mesma razão.
 *
 * A GRAVAÇÃO NÃO TEM EQUIVALENTE AQUI, e isso é deliberado: salvar passa pelo
 * servidor (`PUT /api/videos/[id]/legenda`), que higieniza o texto antes de
 * gravar. Uma URL pré-assinada de PUT deixaria o navegador escrever bytes
 * arbitrários na chave do SRT — e aquele arquivo é entrada de um render.
 */
export async function assinarLegenda(opcoes: {
  chave: string;
  validadeS?: number;
}): Promise<string> {
  const cliente = createR2Client();

  return getSignedUrl(
    cliente,
    new GetObjectCommand({
      Bucket: bucketR2(),
      Key: opcoes.chave,
      ResponseContentType: "text/plain; charset=utf-8",
      ResponseContentDisposition: "attachment",
    }),
    {
      expiresIn: Math.max(
        1,
        Math.floor(
          Math.min(opcoes.validadeS ?? VALIDADE_DE_LEGENDA_S, VALIDADE_DE_LEGENDA_S),
        ),
      ),
    },
  );
}

/**
 * URL pré-assinada de GET para uma imagem que o navegador vai DESENHAR.
 *
 * Ela é diferente de `assinarDownload` num ponto que decide segurança:
 * `attachment` lá, `inline` aqui. Um `<img src>` não funciona com
 * `attachment` — o navegador baixaria o arquivo em vez de mostrá-lo —, e é
 * justamente por isso que `inline` só pode existir onde o tipo é imposto pelo
 * servidor.
 *
 * `ResponseContentType` é o que impõe. Ele SOBRESCREVE o `Content-Type`
 * gravado no objeto, então mesmo que alguma coisa tivesse sido gravada no
 * bucket com outro tipo, o que o navegador recebe é `image/png` ou
 * `image/jpeg` — nunca `text/html`. Somado à conferência de assinatura de
 * bytes na entrada (`lib/imagem/assinatura.ts`), são duas trancas na mesma
 * porta, cada uma suficiente sozinha.
 */
export async function assinarImagem(opcoes: {
  chave: string;
  tipo: "image/png" | "image/jpeg";
  validadeS: number;
}): Promise<string> {
  const cliente = createR2Client();

  return getSignedUrl(
    cliente,
    new GetObjectCommand({
      Bucket: bucketR2(),
      Key: opcoes.chave,
      ResponseContentType: opcoes.tipo,
      ResponseContentDisposition: "inline",
    }),
    { expiresIn: Math.max(1, Math.floor(opcoes.validadeS)) },
  );
}
