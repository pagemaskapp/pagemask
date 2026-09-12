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

  // O upload vai do navegador DIRETO para o R2 (PLANO §4), e `connect-src` e
  // quem autoriza isso. Sem o R2 aqui o `PUT` nem sai: o navegador o bloqueia
  // antes, e o erro que aparece e um `Failed to fetch` sem relacao aparente com
  // CSP. **Medido** — foi assim que este bloqueio apareceu.
  //
  // O curinga `*.r2.cloudflarestorage.com` existe por causa do build: o
  // `R2_ENDPOINT` e segredo de servidor e o CI compila sem segredo nenhum
  // (`lib/env/server.ts` e preguicoso de proposito). Se a politica dependesse
  // so dele, a build de producao sairia com uma CSP que bloqueia o upload — e
  // sairia em silencio, sem nada quebrando no build.
  //
  // A origem exata entra JUNTO quando estiver disponivel, e e o que cobre R2
  // atras de dominio proprio e o repassador local dos testes.
  const r2Host = (() => {
    const url = process.env.R2_ENDPOINT;
    if (!url) return "";
    try {
      const origem = new URL(url).origin;
      return origem.endsWith(".r2.cloudflarestorage.com") ? "" : origem;
    } catch {
      return "";
    }
  })();

  // As duas listas abaixo compartilham o R2 de proposito. `connect-src`
  // autoriza o `PUT` do upload; `img-src` autoriza o `<img>` da previa do
  // editor e da miniatura do cabecalho (Fase 6), que sao URLs pre-assinadas do
  // MESMO bucket. Esquecer a segunda bloqueia a imagem sem erro visivel: o
  // navegador simplesmente nao carrega, e a tela mostra um quadro vazio.
  const r2Sources = ["https://*.r2.cloudflarestorage.com", r2Host].filter(Boolean);

  const connectSrc = [
    "'self'",
    supabaseHost,
    supabaseHost ? supabaseHost.replace(/^https:/, "wss:") : "",
    ...r2Sources,
    isDev ? "ws:" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // A foto de perfil da conta conectada (Fase 4) vem do CDN da Meta, que
    // atende pelos dois domínios e alterna entre eles sem aviso: a mesma conta
    // devolve `scontent.cdninstagram.com` numa hora e `scontent.*.fbcdn.net` na
    // outra. Com só um deles a foto some para parte dos clientes, e some em
    // silêncio — o navegador bloqueia e não há erro na tela.
    [
      "img-src 'self' data: blob:",
      "https://*.cdninstagram.com https://*.fbcdn.net",
      ...r2Sources,
    ].join(" "),
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
    // Fora do desenvolvimento. Em produção tudo é https e a diretiva é rede de
    // segurança contra um `http://` esquecido em algum lugar. Em `localhost`
    // ela é só dano: **medido** no Chrome, a navegação depois do login vira
    // `https://localhost:3000` e falha com `ERR_SSL_PROTOCOL_ERROR` algumas
    // vezes antes de o navegador desistir e usar http — o login funciona, mas
    // o console fica cheio de erro de TLS que não tem nada a ver com o bug que
    // a pessoa está caçando.
    isDev ? null : "upgrade-insecure-requests",
  ]
    .filter(Boolean)
    .join("; ");
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
