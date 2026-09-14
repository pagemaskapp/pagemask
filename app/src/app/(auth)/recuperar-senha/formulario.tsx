"use client";

import { useActionState } from "react";
import Link from "next/link";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recuperarSenha } from "@/app/(auth)/acoes";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

export function FormularioRecuperar() {
  const [estado, acao] = useActionState(recuperarSenha, INICIAL);

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Esqueci minha senha
      </h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Informe o e-mail da sua conta e enviamos um link para você criar uma
        senha nova.
      </p>

      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />

      <form action={acao} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={estado.email}
            placeholder="voce@exemplo.com.br"
          />
        </div>

        <BotaoEnvio carregando="Enviando…" className="w-full">
          Enviar link de recuperação
        </BotaoEnvio>
      </form>

      <p className="text-muted-foreground mt-6 text-center text-sm">
        Lembrou a senha?{" "}
        <Link
          href="/entrar"
          className="text-primary font-medium underline underline-offset-4"
        >
          Entrar
        </Link>
      </p>
    </div>
  );
}
