import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "PageMask",
    template: "%s · PageMask",
  },
  description:
    "Edicao de video em lote para paginas tematicas do Instagram: um template, o lote inteiro editado e publicado.",
  // Sem landing ainda: nada disso deve entrar em indice de busca.
  robots: { index: false, follow: false },
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
