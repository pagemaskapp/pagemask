import { randomUUID } from "node:crypto";

import type { Container } from "@/lib/video/codecs";

/**
 * A chave do objeto no R2: `{user_id}/{project_id}/{uuid}.{ext}` (PLANO §4).
 *
 * O nome do arquivo que o usuário enviou **não entra aqui**, e essa é a decisão
 * inteira deste arquivo. Nome de arquivo é entrada não confiável: ele chega com
 * `../`, com barra invertida, com caractere de controle, com 4 KB de comprimento
 * e com `%2e%2e%2f` — e chave de objeto é, para efeito prático, um caminho. Um
 * nome que atravessa diretório vira objeto gravado fora do prefixo do dono, e o
 * prefixo do dono é o que separa os arquivos de dois clientes.
 *
 * Higienizar o nome seria uma corrida sem fim contra codificações. Trocá-lo por
 * um UUID acaba com a corrida: a chave é gerada pelo servidor, sempre com a
 * mesma forma, e o nome original vive em `jobs.filename`, como dado.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Só as três partes exatas, nada de segmento a mais. */
const FORMATO_DA_CHAVE = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(mp4|mov|webm|mkv)$`);

export function montarChaveDeEntrada(
  userId: string,
  projectId: string,
  extensao: Container,
): string {
  return `${userId}/${projectId}/${randomUUID()}.${extensao}`;
}

/**
 * A chave é deste usuário, neste projeto, e tem a forma que o servidor gera?
 *
 * Checada de novo na confirmação do upload, porque entre pedir a assinatura e
 * confirmar existe uma requisição do cliente — e o que o cliente manda de volta
 * é entrada não confiável como qualquer outra. Sem esta conferência, bastaria
 * trocar a chave na segunda chamada para gravar em `jobs` uma linha apontando
 * para o vídeo de outra pessoa. A mesma regra está escrita também na
 * `register_upload_job` (migration 0007): duas camadas, de propósito.
 */
export function chaveDoUsuario(
  chave: string,
  userId: string,
  projectId: string,
): boolean {
  if (!FORMATO_DA_CHAVE.test(chave)) return false;
  return chave.startsWith(`${userId}/${projectId}/`);
}

/**
 * A chave de um asset do usuário: `{user_id}/assets/{uuid}.{png|jpg}`.
 *
 * Segmento literal `assets` no meio, e ele não é enfeite: é o que torna a
 * chave de uma imagem de cabeçalho impossível de confundir com a de um vídeo
 * (`{uuid}/{uuid}/{uuid}.mp4`) por qualquer regra que olhe a forma da chave —
 * e as duas conferências abaixo olham a forma da chave.
 *
 * O nome do arquivo enviado continua fora, pela razão explicada acima: nome de
 * arquivo é entrada não confiável e chave de objeto é, na prática, um caminho.
 */
const FORMATO_DO_ASSET = new RegExp(`^${UUID}/assets/${UUID}\\.(png|jpg)$`);

export type ExtensaoDeImagem = "png" | "jpg";

export function montarChaveDeAsset(
  userId: string,
  extensao: ExtensaoDeImagem,
): string {
  return `${userId}/assets/${randomUUID()}.${extensao}`;
}

export function chaveDeAssetDoUsuario(chave: string, userId: string): boolean {
  if (!FORMATO_DO_ASSET.test(chave)) return false;
  return chave.startsWith(`${userId}/assets/`);
}

/**
 * Escritos como escape unicode de propósito, pela mesma razão de
 * `lib/auth/destino.ts`: um caractere de controle literal no fonte é invisível
 * em revisão e em diff — que é justamente o que o torna útil para atacar.
 *
 * São os C0 e o DEL, os C1, e as marcas de direção de texto (U+202A–U+202E,
 * U+2066–U+2069) — estas últimas o truque clássico de fazer um `laudo.exe`
 * aparecer na tela como `laudo.txt`.
 */
const INVISIVEIS =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Nome de arquivo pronto para guardar e mostrar.
 *
 * Ele nunca vira caminho — a chave do R2 é gerada à parte —, então o trabalho
 * aqui é outro: tirar o que estraga a exibição e o que engana o olho, e caber
 * no que a coluna aceita.
 */
export function nomeExibivel(bruto: string): string {
  const limpo = bruto
    .normalize("NFC")
    .replace(INVISIVEIS, "")
    .replace(/[/\\]/g, "-")
    .trim();

  if (limpo === "") return "video";
  return limpo.length > 255 ? limpo.slice(0, 255) : limpo;
}
