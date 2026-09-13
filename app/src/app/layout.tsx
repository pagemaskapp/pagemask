import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";

import { publicEnv } from "@/lib/env/public";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  // SEM PRELOAD. A mono aparece em pouca coisa e nunca acima da dobra: as
  // linhas do relatorio de validacao na landing, e numero em tabela dentro do
  // app. Com `preload` o navegador busca esse arquivo (~24 KB) no caminho
  // critico de TODA pagina, competindo com a fonte de texto — que e a que
  // decide quando o conteudo aparece. Sem ele, a mono e buscada quando algo
  // que a usa entra em cena.
  preload: false,
});

export const metadata: Metadata = {
  // URL base de toda URL relativa de metadado (canonical, Open Graph). Sem
  // ela o Next resolve contra `localhost` no build e o cartao de link do
  // produto aponta para a maquina de quem compilou.
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: "PageMask",
    template: "%s · PageMask",
  },
  description:
    "Edicao de video em lote para paginas tematicas do Instagram: um template, o lote inteiro editado e conferido.",
  // INDEXACAO LIGADA A PARTIR DA FASE 11, E SO ONDE DEVE.
  //
  // Ate aqui o produto inteiro era `noindex`, porque nao havia pagina publica
  // que valesse a pena indexar. Agora ha quatro (`/`, `/termos`,
  // `/privacidade`, `/exclusao-de-dados`) e o padrao se inverte: o layout raiz
  // libera, e quem PRECISA ficar fora do indice diz isso no proprio layout —
  // `(auth)` e `/app/*`, os dois com `robots: { index: false }`.
  //
  // O `robots.ts` ao lado repete a mesma lista para o rastreador. Os dois
  // existem de proposito: o `robots.txt` pede para nao VISITAR, a meta tag
  // manda nao INDEXAR, e um rastreador que ignore o primeiro ainda le a
  // segunda.
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0fdf4" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // O nonce da CSP e aplicado durante a renderizacao, a partir do cabecalho da
  // requisicao — e pagina estatica nao tem requisicao. Sem `connection()` o
  // HTML sai prerenderizado sem nonce nenhum e, como a politica usa
  // `strict-dynamic`, o navegador bloqueia TODOS os scripts do Next.
  // O PageMask e um painel autenticado: nao ha nada de valor para cachear
  // estaticamente aqui. A landing da Fase 11 entra com CSP propria.
  await connection();

  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
