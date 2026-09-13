import Link from "next/link";

import { RodapeLegal } from "@/components/legal/rodape-legal";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-md text-center">
        <h1 className="font-heading text-4xl font-semibold tracking-tight">
          Page<span className="text-primary">Mask</span>
        </h1>
        <p className="text-muted-foreground mt-3 text-base text-balance">
          Uma pasta de vídeos, um padrão visual, o lote inteiro editado e
          publicado.
        </p>
        <Button asChild className="mt-8" size="lg">
          <Link href="/entrar">Entrar</Link>
        </Button>

        <RodapeLegal className="mt-16" />
      </div>
    </main>
  );
}
