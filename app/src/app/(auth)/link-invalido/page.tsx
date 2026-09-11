import type { Metadata } from "next";
import Link from "next/link";
import { LinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Link inválido" };

export default function LinkInvalido() {
  return (
    <div className="text-center">
      <LinkIcon className="text-muted-foreground mx-auto mb-4 size-10" />
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Esse link não vale mais
      </h1>
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        Links de acesso e de confirmação valem uma vez só e expiram. Também não
        funcionam se abertos em um navegador diferente daquele em que foram
        pedidos.
      </p>
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        Peça um novo na tela de login — leva alguns segundos.
      </p>
      <Button asChild className="mt-6 w-full">
        <Link href="/entrar">Voltar para o login</Link>
      </Button>
    </div>
  );
}
