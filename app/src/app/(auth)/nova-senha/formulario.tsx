"use client";

import { useActionState } from "react";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { CampoSenha } from "@/components/auth/campo-senha";
import { definirNovaSenha } from "@/app/(auth)/acoes";
import {
  TAMANHO_MINIMO_SENHA,
  type EstadoFormulario,
} from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

export function FormularioNovaSenha() {
  const [estado, acao] = useActionState(definirNovaSenha, INICIAL);

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Criar uma senha nova
      </h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Escolha a senha que você vai usar daqui em diante.
      </p>

      <CampoMensagem erro={estado.erro} aviso={estado.aviso} acao={estado.acao} />

      <form action={acao} className="space-y-4">
        <CampoSenha
          id="senha"
          name="senha"
          label="Nova senha"
          autoComplete="new-password"
          minLength={TAMANHO_MINIMO_SENHA}
          ajuda={
            <>
              Pelo menos {TAMANHO_MINIMO_SENHA} caracteres. Uma frase que só
              você saberia funciona melhor que uma palavra com símbolos.
            </>
          }
        />

        <CampoSenha
          id="confirmacao"
          name="confirmacao"
          label="Confirmar nova senha"
          autoComplete="new-password"
        />

        <BotaoEnvio carregando="Salvando…" className="w-full">
          Salvar senha
        </BotaoEnvio>
      </form>
    </div>
  );
}
