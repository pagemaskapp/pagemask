"use client";

import { useActionState } from "react";
import { PlayIcon } from "lucide-react";

import { processarLote } from "@/app/app/projetos/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * "Processar lote" — manda para a fila tudo que está `Enviado` no projeto.
 *
 * Sem confirmação de propósito: a ação é reversível na prática (o vídeo é
 * processado e continua lá) e não apaga nada. Pedir confirmação para o botão
 * principal da tela só ensina o usuário a clicar em "Sim" sem ler.
 *
 * O botão some quando não há nada `uploaded`. Deixá-lo visível e sem efeito
 * faria o usuário clicar e receber "nenhum vídeo novo para processar", que é
 * uma resposta correta para uma pergunta que ele não devia ter podido fazer.
 */
export function ProcessarLote({
  projeto,
  quantos,
}: {
  projeto: string;
  quantos: number;
}) {
  const [estado, acao] = useActionState(processarLote, INICIAL);

  const mensagem =
    estado.erro || estado.aviso ? (
      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />
    ) : null;

  // Sumir com o botão **sem** a mensagem era o comportamento errado, e ele
  // acontecia justo no caminho de sucesso: a action responde "3 vídeos
  // entraram na fila", o `revalidatePath` redesenha a página, `quantos` vira 0
  // — e um `return null` aqui levava a confirmação junto. O usuário clicava e
  // o botão simplesmente desaparecia, sem nada dizendo que deu certo.
  if (quantos === 0) return mensagem;

  return (
    <form action={acao} className="flex flex-col items-end gap-2">
      <input type="hidden" name="projeto" value={projeto} />

      <BotaoEnvio carregando="Enviando para a fila…">
        <PlayIcon />
        {quantos === 1 ? "Processar 1 vídeo" : `Processar ${quantos} vídeos`}
      </BotaoEnvio>

      {mensagem}
    </form>
  );
}
