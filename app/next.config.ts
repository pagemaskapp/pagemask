import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

import {
  buildCsp,
  staticSecurityHeaders,
} from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Nome e versao do servidor nao ajudam ninguem alem de quem varre alvo.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...staticSecurityHeaders,
          // CSP sem nonce: vale para asset estatico e route handler, onde nao
          // existe script inline nenhum. Nas respostas de documento o
          // `src/proxy.ts` sobrescreve com a versao que carrega o nonce da
          // requisicao — sem ela a hidratacao do Next quebraria.
          { key: "Content-Security-Policy", value: buildCsp() },
        ],
      },
    ];
  },
};

/**
 * O empacotamento do Sentry (Fase 10, PLANO §7).
 *
 * `withSentryConfig` faz tres coisas no BUILD, nenhuma delas em tempo de
 * execucao: instrumenta o bundle do servidor, injeta o modulo de cliente do
 * SDK e, quando ha credencial, sobe os source maps.
 *
 * SOURCE MAP SO COM CREDENCIAL, E NUNCA SERVIDO
 * =============================================
 *
 * Sem `SENTRY_AUTH_TOKEN` o plugin nao sobe nada — e e o estado do CI e do
 * desenvolvimento, onde a credencial nao existe. Com ela, o mapa vai para o
 * Sentry e `deleteSourcemapsAfterUpload` o APAGA do `.next` antes do deploy:
 * source map publicado no dominio entrega o codigo do servidor legivel a quem
 * pedir, e o unico lugar onde ele precisa existir e no painel de erros.
 *
 * `telemetry: false`: o plugin manda estatisticas de build para o Sentry por
 * padrao. Nao ha motivo para o processo de build falar com terceiro alem do
 * upload que foi pedido.
 *
 * `tunnelRoute` NAO esta ligado de proposito. Ele criaria uma rota no nosso
 * dominio que repassa os eventos para o Sentry — o jeito recomendado de
 * escapar de bloqueador de anuncio. O preco e um endpoint que aceita corpo de
 * qualquer visitante e o encaminha para fora, dentro do mesmo dominio que
 * guarda a sessao; a alternativa aqui foi autorizar a origem de ingestao na
 * CSP (`lib/security-headers.ts`), que resolve o bloqueio do navegador sem
 * abrir um repassador. Quem for reativar isto: e uma decisao de superficie de
 * ataque, nao de conveniencia.
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  // `disableLogger` ficou de fora: ele esta depreciado no SDK 10 e o
  // substituto (`webpack.treeshake.removeDebugLogging`) nao vale nada aqui,
  // porque o Next 16 compila com Turbopack. O que ele removeria e o log de
  // depuracao do proprio SDK, que ja esta desligado por `debug: false` em
  // `lib/observabilidade/sentry-comum.ts`.
});
