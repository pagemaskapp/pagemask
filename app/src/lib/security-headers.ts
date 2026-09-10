/**
 * Fonte unica dos cabecalhos de seguranca (docs/PLANO.md, "Seguranca" §6).
 *
 * Importado por `next.config.ts` (que aplica os cabecalhos estaticos a toda
 * resposta) e por `src/proxy.ts` (que troca a CSP pela versao com nonce nas
 * respostas de documento). Nao pode importar nada de Node nem do React: o
 * carregador do next.config e o runtime edge do proxy leem os dois.
 */

const supabaseHost = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
})();

/**
 * Monta a CSP.
 *
 * Com `nonce`, `script-src` fica em `'self' 'nonce-…' 'strict-dynamic'` — o
 * Next injeta o mesmo nonce nos scripts que ele proprio emite, inclusive nos
 * inline de hidratacao. Sem `nonce` (respostas que nao sao documento: asset
 * estatico, route handler), a politica e mais fechada ainda: nenhum inline
 * passa. Em nenhum dos dois casos existe `'unsafe-inline'` em `script-src`.
 *
 * `style-src` mantem `'unsafe-inline'`: o Next emite `<style>` de CSS-in-JS e
 * atributos `style` sem nonce, e um nonce em `style-src` derruba a estilizacao
 * inteira. Injecao de CSS e um risco bem menor que injecao de script — e essa
 * e a escolha registrada aqui para nao ser refeita a cada fase.
 */
export function buildCsp(nonce?: string): string {
  const isDev = process.env.NODE_ENV === "development";

  const scriptSrc = [
    "'self'",
    nonce ? `'nonce-${nonce}'` : null,
    nonce ? "'strict-dynamic'" : null,
    // React usa `eval` no dev para reconstruir stack de erro do servidor.
    // Producao nao precisa.
    isDev ? "'unsafe-eval'" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const connectSrc = [
    "'self'",
    supabaseHost,
    supabaseHost ? supabaseHost.replace(/^https:/, "wss:") : "",
    isDev ? "ws:" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.cdninstagram.com",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Cabecalhos que nao dependem da requisicao. Aplicados a tudo pelo next.config.
 */
export const staticSecurityHeaders: { key: string; value: string }[] = [
  {
    // 2 anos, subdominios inclusos, elegivel a lista de preload.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Nega tudo que o PageMask nao usa. Camera e microfone entram aqui se um
    // dia houver gravacao no navegador.
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=(self)",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=(self)",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  },
  // Redundante com `frame-ancestors 'none'`, mantido para navegador antigo.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];
