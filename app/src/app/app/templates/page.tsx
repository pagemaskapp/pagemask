import type { Metadata } from "next";

import { PaginaEmConstrucao } from "@/components/app/pagina-em-construcao";
import { exigirUsuario } from "@/lib/auth/sessao";

export const metadata: Metadata = { title: "Templates" };

export default async function Templates() {
  await exigirUsuario("/app/templates");

  return (
    <PaginaEmConstrucao
      titulo="Templates"
      descricao="O padrão visual aplicado aos vídeos: cabeçalho, logo e tipografia."
      fase="Fase 6"
    />
  );
}
