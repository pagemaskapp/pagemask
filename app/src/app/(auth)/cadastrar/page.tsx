import type { Metadata } from "next";

import { FormularioCadastrar } from "@/app/(auth)/cadastrar/formulario";
import { destinoSeguro } from "@/lib/auth/destino";

export const metadata: Metadata = { title: "Criar conta" };

export default async function Cadastrar({
  searchParams,
}: PageProps<"/cadastrar">) {
  const params = await searchParams;
  return <FormularioCadastrar proximo={destinoSeguro(params.proximo)} />;
}
