"use client";

import { useActionState } from "react";
import Link from "next/link";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { CampoSenha } from "@/components/auth/campo-senha";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cadastrar } from "@/app/(auth)/acoes";
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
          <Label htmlFor="nome">Nome</Label>
          <Input
            id="nome"
            name="nome"
            type="text"
            autoComplete="name"
            required
            maxLength={120}
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

        <CampoSenha
          id="senha"
          name="senha"
          label="Senha"
          autoComplete="new-password"
          minLength={TAMANHO_MINIMO_SENHA}
          ajuda={
            <>
              Pelo menos {TAMANHO_MINIMO_SENHA} caracteres. Uma frase que só
              você saberia funciona melhor que uma palavra com símbolos.
            </>
          }
        />

        {/*
          Sem `minLength` na confirmação: o navegador reclamaria "use pelo menos
          10 caracteres" no meio da digitação, antes de a pessoa terminar de
          repetir a senha — e o que interessa aqui não é o tamanho, é a
          igualdade, conferida no servidor junto com o resto.
        */}
        <CampoSenha
          id="confirmacao"
          name="confirmacao"
          label="Confirmar senha"
          autoComplete="new-password"
        />

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
