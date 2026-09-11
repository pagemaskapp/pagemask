"use client";

import { useActionState } from "react";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reenviarConfirmacao } from "@/app/(auth)/acoes";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

export function FormularioReenviar({
  email,
  proximo,
}: {
  email: string;
  proximo: string;
}) {
  const [estado, acao] = useActionState(reenviarConfirmacao, INICIAL);

  return (
    <>
      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />
      <form action={acao} className="space-y-3 text-left">
        <input type="hidden" name="proximo" value={proximo} />
        <div className="space-y-2">
          <Label htmlFor="email-reenvio">E-mail</Label>
          <Input
            id="email-reenvio"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={estado.email ?? email}
          />
        </div>
        <BotaoEnvio carregando="Enviando…" variant="outline" className="w-full">
          Enviar outro e-mail
        </BotaoEnvio>
      </form>
    </>
  );
}
