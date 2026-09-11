import type { Metadata } from "next";

import { PaginaEmConstrucao } from "@/components/app/pagina-em-construcao";
import { exigirUsuario } from "@/lib/auth/sessao";

export const metadata: Metadata = { title: "Projetos" };

export default async function Projetos() {
  await exigirUsuario("/app/projetos");

  return (
    <PaginaEmConstrucao
      titulo="Projetos"
      descricao="Uma pasta de vídeos por projeto, com o template aplicado ao lote."
      fase="Fase 2"
    />
  );
}
