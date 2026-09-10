import { NextResponse, type NextRequest } from "next/server";

import { buildCsp } from "@/lib/security-headers";

/**
 * `proxy.ts` e o antigo `middleware.ts` (renomeado no Next 16).
 *
 * Hoje ele faz uma coisa so: gerar um nonce por requisicao e escrever a CSP
 * com ele. O Next le a CSP do cabecalho da requisicao, extrai o `'nonce-…'` e
 * aplica o mesmo nonce em todo script que emite — inclusive nos inline de
 * hidratacao. Sem isso, `script-src 'self'` derrubaria a pagina inteira.
 *
 * Na Fase 1 entram aqui tambem o refresh de sessao do Supabase e o rate limit
 * por IP das rotas de auth (PLANO §1).
 */
export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Documentos e route handlers. Fora: asset estatico, otimizacao de imagem e
  // favicon, que ja recebem a CSP estatica do next.config e nao tem script
  // inline nenhum.
  //
  // A documentacao do Next sugere excluir tambem os prefetch. Nao aqui: um
  // pedido com `Purpose: prefetch` devolve documento HTML completo, e sem
  // passar por este proxy ele sai com a CSP sem nonce — o navegador guarda
  // esse documento e, na navegacao seguinte, bloqueia todo script da pagina.
  // Gerar um nonce a mais por prefetch e barato; servir uma pagina que nao
  // hidrata, nao.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
