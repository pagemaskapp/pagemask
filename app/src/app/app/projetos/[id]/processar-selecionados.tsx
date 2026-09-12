"use client";

import { useActionState } from "react";
import { PlayIcon } from "lucide-react";

import { processarLote } from "@/app/app/projetos/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Button } from "@/components/ui/button";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * "Processar os selecionados" — a mesma ação do botão do cabeçalho, com uma
 * lista de ids junto.
 *
 * A barra só existe quando há seleção. Ela não substitui o botão de cima:
 * aquele é "o projeto inteiro", este é "estes aqui". Ter os dois é o que faz
 * "aplicar ao projeto inteiro ou a itens selecionados" caber numa tela sem um
 * modo de seleção separado, onde a pessoa entra e sai.
 *
 * Os `<input type="hidden">` são a lista que vai no `formData`. O servidor a
 * trata como entrada não confiável: `enqueue_project` só move o que for do
 * mesmo projeto, do mesmo dono e ainda estiver em `uploaded`.
 */
export function ProcessarSelecionados({
  projeto,
  selecionados,
  aoLimpar,
}: {
  projeto: string;
  selecionados: string[];
  aoLimpar: () => void;
}) {
  const [estado, acao] = useActionState(processarLote, INICIAL);

  if (selecionados.length === 0) {
    return estado.erro || estado.aviso ? (
      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />
    ) : null;
  }

  return (
    <form action={acao} className="mb-3">
      <input type="hidden" name="projeto" value={projeto} />
      {selecionados.map((id) => (
        <input key={id} type="hidden" name="video" value={id} />
      ))}

      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />

      <div className="bg-accent/50 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5">
        <p className="text-sm font-medium">
          {selecionados.length === 1
            ? "1 vídeo selecionado"
            : `${selecionados.length} vídeos selecionados`}
        </p>

        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={aoLimpar}>
            Limpar seleção
          </Button>
          <BotaoEnvio carregando="Enviando para a fila…">
            <PlayIcon />
            Processar selecionados
          </BotaoEnvio>
        </div>
      </div>
    </form>
  );
}
