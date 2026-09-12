"use client";

import { useFormStatus } from "react-dom";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Botão que se desabilita enquanto a action roda.
 *
 * Serve de proteção e de resposta ao usuário: sem isso, dois cliques rápidos
 * viram duas tentativas de login — e duas tentativas contra o limite de 10.
 */
export function BotaoEnvio({
  children,
  carregando,
  variant,
  size,
  className,
}: {
  children: React.ReactNode;
  carregando: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      disabled={pending}
      variant={variant}
      size={size}
      className={className}
    >
      {pending ? (
        <>
          <Loader2Icon className="animate-spin" />
          {carregando}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
