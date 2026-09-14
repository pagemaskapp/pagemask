"use client";

import { useActionState } from "react";
import Link from "next/link";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { CampoSenha } from "@/components/auth/campo-senha";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { entrarComSenha } from "@/app/(auth)/acoes";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * Login com e-mail e senha — o único caminho.
 *
 * Havia aqui uma segunda aba, o link de acesso (`signInWithOtp`), servida por
 * `?modo=link`. Ela saiu: dois caminhos de entrada para o mesmo lugar dobram a
 * superfície a defender (dois baldes de limite, duas respostas neutras a
 * calibrar) e confundem quem só quer entrar. Quem esqueceu a senha tem
 * `/recuperar-senha`, que resolve o problema de verdade em vez de contorná-lo
 * com um login sem senha.
 */
export function FormularioEntrar({
  proximo,
  mensagem,
}: {
  proximo: string;
  /** Recado que já vem da URL, como o resultado de um "Sair". */
  mensagem?: EstadoFormulario;
}) {
  const [estado, acao] = useActionState(entrarComSenha, INICIAL);

  // A mensagem da URL vale só até o formulário responder. Depois do primeiro
  // envio quem manda é a resposta da action — senão um "Você saiu da sua conta"
  // ficaria pendurado por cima do erro de login seguinte.
  const exibido = estado.erro || estado.aviso ? estado : (mensagem ?? estado);

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Entrar
      </h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Acesse sua conta do PageMask.
      </p>

      <CampoMensagem
        erro={exibido.erro}
        aviso={exibido.aviso}
        acao={exibido.acao}
      />

      <form action={acao} className="space-y-4">
        <input type="hidden" name="proximo" value={proximo} />

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
          autoComplete="current-password"
        />

        <BotaoEnvio carregando="Entrando…" className="w-full">
          Entrar
        </BotaoEnvio>
      </form>

      <p className="mt-4 text-center text-sm">
        <Link
          href="/recuperar-senha"
          className="text-muted-foreground hover:text-foreground underline underline-offset-4"
        >
          Esqueci minha senha
        </Link>
      </p>

      <p className="text-muted-foreground mt-6 text-center text-sm">
        Ainda não tem conta?{" "}
        <Link
          href={`/cadastrar?proximo=${encodeURIComponent(proximo)}`}
          className="text-primary font-medium underline underline-offset-4"
        >
          Criar conta
        </Link>
      </p>
    </div>
  );
}
