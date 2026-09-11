import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

import { requireServerEnv } from "@/lib/env/server";

/**
 * O token do Instagram em repouso (docs/PLANO.md, "Segurança" §3).
 *
 * AES-256-GCM, chave em `TOKEN_ENC_KEY` (32 bytes em base64, validada em
 * `lib/env/server.ts`), **IV novo a cada gravação**. GCM com IV repetido não
 * degrada um pouco: repetir o par (chave, IV) entrega o keystream e, pior,
 * permite forjar autenticação para aquela chave. Por isso o IV nunca vem de
 * contador nem de hash do conteúdo — só de `randomBytes`.
 *
 * O DADO ASSOCIADO (AAD) É O `ig_user_id`
 * =======================================
 *
 * GCM autentica o texto cifrado; o AAD estende essa autenticação a um dado que
 * NÃO é cifrado. Aqui ele amarra o token à conta dona dele.
 *
 * Sem AAD, alguém com escrita no banco (e sem a chave) poderia copiar
 * `token_cipher`/`token_iv`/`token_tag` da linha da conta A para a linha da
 * conta B. A decifragem daria certo — é o mesmo texto, a mesma chave — e o
 * servidor publicaria no perfil A achando que era o B. Com o `ig_user_id` como
 * AAD, a troca faz a verificação da tag falhar e `decifrar` lança.
 *
 * Consequência prática: quem cifra e quem decifra precisam passar o MESMO
 * `ig_user_id`. É por isso que `ig_accounts_para_renovar` (migration 0018) traz
 * essa coluna junto com o token.
 */

const ALGORITMO: CipherGCMTypes = "aes-256-gcm";

/** 96 bits é o tamanho para o qual o GCM foi especificado e otimizado. */
const BYTES_DO_IV = 12;

/**
 * A versão da chave que este código usa para CIFRAR. A coluna `key_version` em
 * `ig_accounts` guarda com qual versão cada linha foi cifrada, para uma rotação
 * futura poder decifrar o que ficou para trás sem downtime (RUNBOOK).
 */
export const VERSAO_DA_CHAVE = 1;

export type TokenCifrado = {
  cipherHex: string;
  ivHex: string;
  tagHex: string;
  keyVersion: number;
};

function chave(): Buffer {
  // `requireServerEnv` já garante presença; o schema do zod já garante os 32
  // bytes. Aqui só se decodifica.
  return Buffer.from(requireServerEnv("TOKEN_ENC_KEY"), "base64");
}

export function cifrar(texto: string, igUserId: string): TokenCifrado {
  const iv = randomBytes(BYTES_DO_IV);
  const cifra = createCipheriv(ALGORITMO, chave(), iv);
  cifra.setAAD(Buffer.from(igUserId, "utf8"));

  const cipher = Buffer.concat([
    cifra.update(texto, "utf8"),
    cifra.final(),
  ]);

  return {
    cipherHex: cipher.toString("hex"),
    ivHex: iv.toString("hex"),
    tagHex: cifra.getAuthTag().toString("hex"),
    keyVersion: VERSAO_DA_CHAVE,
  };
}

/**
 * Lança quando a tag não confere — ou seja, quando o texto cifrado foi
 * adulterado, quando a chave mudou, ou quando o `ig_user_id` não é o da linha.
 *
 * A mensagem **não** carrega nada do conteúdo. Um erro de decifragem que
 * imprimisse bytes do token seria exatamente o vazamento que o resto do arquivo
 * existe para evitar.
 */
export function decifrar(guardado: TokenCifrado, igUserId: string): string {
  try {
    const decifra = createDecipheriv(
      ALGORITMO,
      chave(),
      Buffer.from(guardado.ivHex, "hex"),
    );
    decifra.setAAD(Buffer.from(igUserId, "utf8"));
    decifra.setAuthTag(Buffer.from(guardado.tagHex, "hex"));

    return Buffer.concat([
      decifra.update(Buffer.from(guardado.cipherHex, "hex")),
      decifra.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "nao foi possivel decifrar o token desta conta " +
        `(key_version=${guardado.keyVersion})`,
    );
  }
}
