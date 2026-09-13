import type { MetadataRoute } from "next";

import { publicEnv } from "@/lib/env/public";

/**
 * `/robots.txt`.
 *
 * A LISTA DIZ "NÃO VISITE", E A META TAG DIZ "NÃO INDEXE". Os dois existem, e
 * não é redundância: `robots.txt` pede ao rastreador que nem busque a URL;
 * `robots: { index: false }` (nos layouts de `(auth)` e `/app`) instrui a não
 * indexar o que for buscado assim mesmo. Rastreador que ignore um ainda esbarra
 * no outro.
 *
 * NENHUM DOS DOIS É CONTROLE DE ACESSO. O que protege `/app/*` é a sessão —
 * `proxy.ts` e `exigirUsuario` em cada server component. Este arquivo é sinal
 * para buscador educado, e um `Disallow` é também um mapa do que existe: por
 * isso a lista é de prefixos curtos, sem enumerar rota interna nenhuma.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/app/", // painel: exige sessão
          "/api/", // rotas de dados; nenhuma serve conteúdo de leitura
          "/auth/", // confirmação de e-mail, com token de uso único na URL
          "/entrar",
          "/cadastrar",
          "/conta-excluida", // tela de recado depois da exclusão
          "/indisponivel",
          "/link-invalido",
          "/confirme-seu-email",
        ],
      },
    ],
    sitemap: new URL("/sitemap.xml", publicEnv.NEXT_PUBLIC_APP_URL).toString(),
  };
}
