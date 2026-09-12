"use client";

import { useActionState } from "react";
import { RotateCcwIcon } from "lucide-react";

import { tentarDeNovo } from "@/app/app/agenda/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/** O botão "Tentar de novo" de uma publicação com falha. */
export function TentarDeNovo({ agendamento }: { agendamento: string }) {
  const [estado, acao] = useActionState(tentarDeNovo, INICIAL);

  return (
    <form action={acao} className="flex flex-col items-end gap-2">
      <input type="hidden" name="agendamento" value={agendamento} />
      <BotaoEnvio variant="outline" carregando="Reenviando…">
        <RotateCcwIcon />
        Tentar de novo
      </BotaoEnvio>
      {estado.erro || estado.aviso ? (
        <div className="w-full">
          <CampoMensagem erro={estado.erro} aviso={estado.aviso} />
        </div>
      ) : null}
    </form>
  );
}
