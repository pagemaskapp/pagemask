import type { NextConfig } from "next";

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

export default nextConfig;
