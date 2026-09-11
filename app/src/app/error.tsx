"use client";

import { useEffect } from "react";
import { AlertTriangleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Fronteira de erro do app.
 *
 * Cobre o que quebra ao renderizar uma página, não a falha de sessão: essa é
 * tratada por redirect para `/indisponivel`, porque `error.tsx` **não** captura
 * o que o `layout.tsx` de um segmento lança durante o SSR — verificado em dev e
 * em produção, sai a tela genérica do Next com 500.
 *
 * Também não vale filtrar por `error.name` aqui: em produção o Next substitui
 * nome e mensagem de erro de servidor por um genérico antes de mandar para o
 * cliente, deixando só o `digest`. Qualquer ramo baseado no nome seria código
 * morto que parece vivo.
 *
 * Nada de stack trace na tela (PLANO §6). O detalhe vai para o log agora, e
 * para o Sentry na Fase 10 — onde o `digest` é o que liga esta tela ao erro
 * real do servidor.
 */
export default function ErroApp({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] erro de renderização", { digest: error.digest });
  }, [error]);

  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <AlertTriangleIcon className="text-muted-foreground mx-auto mb-4 size-10" />
      <h1 className="font-heading text-xl font-semibold tracking-tight">
        Algo deu errado
      </h1>
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        Tente de novo. Se continuar, escreva para o suporte e diga o que estava
        fazendo — ajuda muito se puder incluir o código abaixo.
      </p>
      {error.digest ? (
        <p className="text-muted-foreground mt-3 font-mono text-xs">
          {error.digest}
        </p>
      ) : null}
      <Button onClick={reset} className="mt-6">
        Tentar de novo
      </Button>
    </main>
  );
}
