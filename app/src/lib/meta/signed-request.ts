import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { requireServerEnv } from "@/lib/env/server";

/**
 * O `signed_request` dos callbacks da Meta (PLANO §5).
 *
 * Formato, conferido na documentação do Data Deletion Request Callback em
 * 11/09/2026: `<assinatura>.<payload>`, os dois em base64url, assinatura =
 * HMAC-SHA256 do payload (a string base64url, não o JSON) com o app secret.
 * O payload traz `algorithm`, `issued_at`, `user_id` e, às vezes, `expires`.
 *
 * Para um app do Instagram (Business Login), o secret é o **Instagram app
 * secret** — o mesmo `IG_APP_SECRET` do OAuth — e o `user_id` é o id do
 * usuário no escopo do app, o mesmo `ig_user_id` que a troca do `code`
 * devolve e que `ig_accounts` guarda. É por ele que a conta é encontrada.
 *
 * Quem chama recebe `null` para TUDO que não seja íntegro — assinatura errada,
 * base64 quebrado, JSON sem `user_id`, algoritmo desconhecido. A rota responde
 * 400 sem dizer qual das condições falhou: a diferença é informação útil para
 * quem está sondando, e nenhuma delas é o caso de uso legítimo.
 */
export type PedidoAssinado = {
  userId: string;
  algorithm: string;
  issuedAt: number | null;
  expires: number | null;
  /** SHA-256 do `signed_request` inteiro: a chave de idempotência do evento. */
  hash: string;
};

export function lerSignedRequest(valor: unknown): PedidoAssinado | null {
  if (typeof valor !== "string" || valor.length < 3 || valor.length > 8192) {
    return null;
  }

  const corte = valor.indexOf(".");
  if (corte <= 0 || corte === valor.length - 1) return null;

  const assinaturaB64 = valor.slice(0, corte);
  const payloadB64 = valor.slice(corte + 1);

  const recebida = Buffer.from(assinaturaB64, "base64url");
  const esperada = createHmac("sha256", requireServerEnv("IG_APP_SECRET"))
    .update(payloadB64)
    .digest();

  // Tamanho conferido antes porque `timingSafeEqual` exige buffers iguais; o
  // tamanho não é segredo (é sempre o do SHA-256).
  if (recebida.length !== esperada.length) return null;
  if (!timingSafeEqual(recebida, esperada)) return null;

  let dados: unknown;
  try {
    dados = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof dados !== "object" || dados === null) return null;

  const { algorithm, user_id, issued_at, expires } = dados as Record<
    string,
    unknown
  >;

  if (
    typeof algorithm !== "string" ||
    algorithm.toUpperCase() !== "HMAC-SHA256"
  ) {
    return null;
  }

  const userId =
    typeof user_id === "string"
      ? user_id
      : typeof user_id === "number" && Number.isFinite(user_id)
        ? String(user_id)
        : null;
  if (!userId || userId.length === 0 || userId.length > 64) return null;
  // O id de usuário da Meta é numérico. Qualquer outra coisa não é um id.
  if (!/^\d+$/.test(userId)) return null;

  const numero = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const expiresEm = numero(expires);
  if (expiresEm !== null && expiresEm * 1000 < Date.now()) return null;

  return {
    userId,
    algorithm,
    issuedAt: numero(issued_at),
    expires: expiresEm,
    hash: createHash("sha256").update(valor).digest("hex"),
  };
}

/**
 * O corpo do callback: `application/x-www-form-urlencoded` com
 * `signed_request`. Também aceita JSON com o mesmo campo, para o teste manual
 * do RUNBOOK não precisar montar um form.
 */
export async function signedRequestDoCorpo(
  requisicao: Request,
): Promise<unknown> {
  const tipo = (requisicao.headers.get("content-type") ?? "").toLowerCase();

  try {
    if (
      tipo.startsWith("application/x-www-form-urlencoded") ||
      tipo.startsWith("multipart/form-data")
    ) {
      const form = await requisicao.formData();
      return form.get("signed_request");
    }
    if (tipo.startsWith("application/json")) {
      const json = (await requisicao.json()) as Record<string, unknown> | null;
      return json?.signed_request;
    }
  } catch {
    return null;
  }
  return null;
}
