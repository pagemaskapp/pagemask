"use client";

import { useActionState } from "react";
import Link from "next/link";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { entrarComSenha, enviarLinkDeAcesso } from "@/app/(auth)/acoes";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

export type ModoEntrada = "senha" | "link";

/**
 * O modo vem da URL (`?modo=link`), nao de estado do componente, e as abas sao
 * links de verdade.
 *
 * Com estado no cliente, o formulario de link de acesso **nao existia no
 * HTML** — so era montado depois que o React hidratava. Quem estivesse sem
 * JavaScript ficava com uma aba que nao abre e sem o segundo caminho de login,
 * que o plano pede. Como link, o servidor ja entrega o formulario certo.
 */
export function FormularioEntrar({
  proximo,
  modo,
  mensagem,
}: {
  proximo: string;
  modo: ModoEntrada;
  /** Recado que já vem da URL, como o resultado de um "Sair". */
  mensagem?: EstadoFormulario;
}) {
  const [estadoSenha, acaoSenha] = useActionState(entrarComSenha, INICIAL);
  const [estadoLink, acaoLink] = useActionState(enviarLinkDeAcesso, INICIAL);

  const doFormulario = modo === "senha" ? estadoSenha : estadoLink;
  // A mensagem da URL vale só até o formulário responder. Depois do primeiro
  // envio quem manda é a resposta da action — senão um "Você saiu da sua conta"
  // ficaria pendurado por cima do erro de login seguinte.
  const estado =
    doFormulario.erro || doFormulario.aviso ? doFormulario : (mensagem ?? doFormulario);
  const abaPara = (m: ModoEntrada) =>
    `/entrar?modo=${m}&proximo=${encodeURIComponent(proximo)}`;

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Entrar
      </h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Acesse sua conta do PageMask.
      </p>

      <nav
        aria-label="Como entrar"
        className="bg-muted mb-6 grid grid-cols-2 gap-1 rounded-lg p-1"
      >
        {(
          [
            ["senha", "E-mail e senha"],
            ["link", "Link de acesso"],
          ] as const
        ).map(([valor, rotulo]) => (
          <Link
            key={valor}
            href={abaPara(valor)}
            replace
            aria-current={modo === valor ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-center text-sm font-medium transition-colors ${
              modo === valor
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {rotulo}
          </Link>
        ))}
      </nav>

      <CampoMensagem
        erro={estado.erro}
        aviso={estado.aviso}
        acao={estado.acao}
      />

      {modo === "senha" ? (
        <form action={acaoSenha} className="space-y-4">
          <input type="hidden" name="proximo" value={proximo} />

          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={estadoSenha.email}
              placeholder="voce@exemplo.com.br"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="senha">Senha</Label>
            <Input
              id="senha"
              name="senha"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <BotaoEnvio carregando="Entrando…" className="w-full">
            Entrar
          </BotaoEnvio>
        </form>
      ) : (
        <form action={acaoLink} className="space-y-4">
          <input type="hidden" name="proximo" value={proximo} />

          <div className="space-y-2">
            <Label htmlFor="email-link">E-mail</Label>
            <Input
              id="email-link"
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={estadoLink.email}
              placeholder="voce@exemplo.com.br"
            />
            <p className="text-muted-foreground text-xs">
              Enviamos um link que entra na sua conta sem senha. Ele vale uma
              vez só e expira em 1 hora.
            </p>
          </div>

          <BotaoEnvio carregando="Enviando…" className="w-full">
            Enviar link de acesso
          </BotaoEnvio>
        </form>
      )}

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
