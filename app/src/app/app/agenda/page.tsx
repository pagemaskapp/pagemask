import type { Metadata } from "next";

import { PaginaEmConstrucao } from "@/components/app/pagina-em-construcao";
import { exigirUsuario } from "@/lib/auth/sessao";

export const metadata: Metadata = { title: "Agenda" };

export default async function Agenda() {
  await exigirUsuario("/app/agenda");

  return (
    <PaginaEmConstrucao
      titulo="Agenda"
      descricao="O que está agendado para publicar, e o que já foi."
      fase="Fase 5"
    />
  );
}
