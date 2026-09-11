/**
 * A lista fechada de `docs/PLANO.md` §4, escrita uma vez só.
 *
 * > container `mp4|mov|webm|mkv`, vídeo `h264|hevc|vp9|av1`, áudio
 * > `aac|mp3|opus|vorbis|pcm_*`. Qualquer outro codec → `rejected`.
 *
 * Lista fechada, e não lista de bloqueio: o que não está aqui é recusado, sem
 * exceção. É o contrário do instinto ("barrar os formatos perigosos"), e é o
 * único jeito que funciona — a lista de codecs que o FFmpeg aceita passa de
 * quatrocentos, e a próxima falha de decoder exótico vai estar num que ninguém
 * lembrava de bloquear. O CVE-2026-8461 era no MagicYUV; poucos sabiam que o
 * MagicYUV existia.
 *
 * Este arquivo não importa nada e não tem `server-only`: é a mesma lista para o
 * servidor, para a mensagem que o navegador mostra e — na Fase 3 — para o
 * `ffprobe` do worker conferir de novo, do lado de lá.
 */

export const CONTAINERS = ["mp4", "mov", "webm", "mkv"] as const;
export type Container = (typeof CONTAINERS)[number];

export const VIDEO_PERMITIDO = ["h264", "hevc", "vp9", "av1"] as const;

export const AUDIO_PERMITIDO = ["aac", "mp3", "opus", "vorbis"] as const;

/** `pcm_*` é família inteira: `pcm_s16le`, `pcm_s24be`, `pcm_f32le`… */
const PREFIXO_PCM = "pcm_";

export function videoPermitido(codec: string | null): boolean {
  return codec !== null && (VIDEO_PERMITIDO as readonly string[]).includes(codec);
}

export function audioPermitido(codec: string | null): boolean {
  if (codec === null) return false;
  if (codec.startsWith(PREFIXO_PCM)) return true;
  return (AUDIO_PERMITIDO as readonly string[]).includes(codec);
}

/**
 * Extensões aceitas e o `Content-Type` que cada uma pode declarar.
 *
 * O `Content-Type` entra na ASSINATURA da URL pré-assinada (PLANO §4), então
 * ele não é decoração: o navegador tem que mandar exatamente o que foi
 * assinado, e o R2 recusa se não bater. Fixá-lo aqui é o que impede alguém de
 * pedir assinatura para `text/html` e transformar o bucket em hospedagem de
 * página — que seria XSS no domínio de quem baixasse o arquivo.
 *
 * Vários navegadores mandam `Content-Type` vazio ou errado para `.mkv` e
 * `.mov`. Por isso quem escolhe o tipo é o SERVIDOR, a partir da extensão, e o
 * que o navegador disse é ignorado. A lista continua fechada; ela só deixou de
 * depender do palpite do sistema operacional de quem envia.
 */
export const TIPO_POR_EXTENSAO: Record<Container, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

/**
 * Extensão do nome do arquivo, se for uma das quatro. `null` para o resto.
 *
 * Só olha o que vem depois do último ponto e exige que o resto do nome não
 * esteja vazio: `.mp4` sozinho não é nome de arquivo, é extensão solta.
 */
export function extensaoAceita(nome: string): Container | null {
  const ponto = nome.lastIndexOf(".");
  if (ponto <= 0 || ponto === nome.length - 1) return null;

  const ext = nome.slice(ponto + 1).toLowerCase();
  return (CONTAINERS as readonly string[]).includes(ext)
    ? (ext as Container)
    : null;
}

/** O que a tela diz quando o arquivo não é de um dos formatos aceitos. */
export const FORMATOS_EM_TEXTO = "MP4, MOV, WebM ou MKV";
