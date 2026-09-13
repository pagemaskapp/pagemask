import type { MetadataRoute } from "next";

import { publicEnv } from "@/lib/env/public";

/**
 * `/sitemap.xml` — as quatro páginas alcançáveis sem sessão.
 *
 * Escrito à mão, e não varrido do sistema de arquivos, de propósito: a lista
 * de rotas do Next inclui `/app/*`, `/api/*` e as telas de recado, e uma
 * varredura automática publicaria todas elas. Quatro linhas mantidas à mão
 * erram menos do que um filtro que precisa acertar o que excluir.
 *
 * As páginas legais entram porque o App Review da Meta exige que a política de
 * privacidade e a exclusão de dados sejam URLs públicas e encontráveis — não
 * só alcançáveis por quem já tem o endereço.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv.NEXT_PUBLIC_APP_URL;
  const url = (caminho: string) => new URL(caminho, base).toString();

  return [
    { url: url("/"), changeFrequency: "weekly", priority: 1 },
    { url: url("/termos"), changeFrequency: "yearly", priority: 0.3 },
    { url: url("/privacidade"), changeFrequency: "yearly", priority: 0.3 },
    { url: url("/exclusao-de-dados"), changeFrequency: "yearly", priority: 0.3 },
  ];
}
