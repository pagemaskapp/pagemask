/**
 * Descobre o papel de uma chave de API do Supabase.
 *
 * Existem dois formatos em circulação:
 *
 *   · **Novo** — `sb_publishable_…` e `sb_secret_…`. O papel está no prefixo.
 *   · **Legado** — JWT. A `anon` e a `service_role` são as duas `eyJ…` e
 *     indistinguíveis por prefixo; o papel só aparece no claim `role` do
 *     payload. Descontinuado pelo Supabase no fim de 2026.
 *
 * Enquanto o projeto não tiver as chaves novas, é este arquivo que impede a
 * troca silenciosa mais cara possível: colar a `service_role` — que **ignora
 * RLS** — numa variável `NEXT_PUBLIC_*` e publicá-la no bundle do navegador.
 *
 * Sem dependência de Node: roda no servidor, no navegador e no runtime do
 * proxy. Não valida assinatura — não é autenticação, é triagem de configuração
 * (a assinatura quem confere é o Supabase).
 */

export type KeyRole = "anon" | "service_role" | "publishable" | "secret";

/** Decodifica o payload de um JWT sem verificar a assinatura. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;

  try {
    // base64url -> base64, com o padding que o JWT omite.
    const base64 = partes[1].replaceAll("-", "+").replaceAll("_", "/");
    const comPadding = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const json = atob(comPadding);
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Devolve o papel da chave, ou `null` se o valor não for uma chave do Supabase
 * reconhecível. Nunca lança e nunca devolve nada derivado do segredo em si.
 */
export function supabaseKeyRole(valor: string): KeyRole | null {
  if (valor.startsWith("sb_publishable_")) return "publishable";

  // A chave secreta nova é reconhecida pela negativa — qualquer `sb_…` que não
  // seja publishable — em vez de comparar com o prefixo dela escrito por
  // extenso.
  //
  // O motivo não é elegância: este arquivo é importado por `@/lib/env/public`
  // e portanto **entra no bundle do cliente**. Escrever o prefixo da chave
  // secreta aqui faria o próprio código do PageMask reprovar na varredura de
  // `.next/static`, que procura exatamente essa sequência. Já aconteceu uma vez.
  if (valor.startsWith("sb_")) return "secret";

  if (!valor.startsWith("eyJ")) return null;

  const payload = decodeJwtPayload(valor);
  if (!payload) return null;

  const role = payload.role;
  if (role === "anon" || role === "service_role") return role;

  return null;
}

/** Papéis que podem ser expostos ao navegador. */
export function isPublicRole(role: KeyRole | null): boolean {
  return role === "anon" || role === "publishable";
}

/** Papéis que ignoram RLS e só podem existir no servidor e no worker. */
export function isPrivilegedRole(role: KeyRole | null): boolean {
  return role === "service_role" || role === "secret";
}
