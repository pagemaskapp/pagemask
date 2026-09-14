import type { Metadata } from "next";

import { FormularioRecuperar } from "@/app/(auth)/recuperar-senha/formulario";

export const metadata: Metadata = { title: "Esqueci minha senha" };

export default function RecuperarSenha() {
  return <FormularioRecuperar />;
}
