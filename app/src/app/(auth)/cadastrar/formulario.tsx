"use client";

import { useActionState } from "react";
import Link from "next/link";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cadastrar,
} from "@/app/(auth)/acoes";
import {
  TAMANHO_MINIMO_SENHA,
  type EstadoFormulario,
} from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

export function FormularioCadastrar({ proximo }: { proximo: string }) {
  const [estado, acao] = useActionState(cadastrar, INICIAL);

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Criar conta
      </h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Leva menos de um minuto.
      </p>

      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />

      <form action={acao} className="space-y-4">
        <input type="hidden" name="proximo" value={proximo} />

        <div className="space-y-2">
          <Label htmlFor="nome">
            Nome{" "}
            <span className="text-muted-foreground font-normal">
              (opcional)
            </span>
          </Label>
          <Input
            id="nome"
            name="nome"
            type="text"
            autoComplete="name"
            defaultValue={estado.nome}
            placeholder="Como podemos te chamar"
          />
        </div>

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

        <div className="space-y-2">
          <Label htmlFor="senha">Senha</Label>
          <Input
            id="senha"
            name="senha"
            type="password"
            autoComplete="new-password"
            required
            minLength={TAMANHO_MINIMO_SENHA}
            aria-describedby="ajuda-senha"
          />
          <p id="ajuda-senha" className="text-muted-foreground text-xs">
            Pelo menos {TAMANHO_MINIMO_SENHA} caracteres. Uma frase que só você
            saberia funciona melhor que uma palavra com símbolos.
          </p>
        </div>

        <BotaoEnvio carregando="Criando conta…" className="w-full">
          Criar conta
        </BotaoEnvio>
      </form>

      <p className="text-muted-foreground mt-6 text-center text-sm">
        Já tem conta?{" "}
        <Link
          href={`/entrar?proximo=${encodeURIComponent(proximo)}`}
          className="text-primary font-medium underline underline-offset-4"
        >
          Entrar
        </Link>
      </p>
    </div>
  );
}
