import type { Metadata } from "next";

import { PaginaEmConstrucao } from "@/components/app/pagina-em-construcao";
import { exigirUsuario } from "@/lib/auth/sessao";

export const metadata: Metadata = { title: "Conectores" };

export default async function Conectores() {
  await exigirUsuario("/app/conectores");

  return (
    <PaginaEmConstrucao
      titulo="Conectores"
      descricao="As contas do Instagram em que o PageMask publica por você."
      fase="Fase 4"
    />
  );
}
