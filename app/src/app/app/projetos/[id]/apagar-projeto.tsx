"use client";

import { useActionState, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { apagarProjeto } from "@/app/app/projetos/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * Apagar o projeto inteiro.
 *
 * Existe por causa do limite de plano: sem uma saída, quem cria três projetos
 * no Partida fica preso, e a mensagem de "limite atingido" mandaria fazer algo
 * que a tela não oferece.
 */
export function ApagarProjeto({ projeto, nome }: { projeto: string; nome: string }) {
  const [estado, acao] = useActionState(apagarProjeto, INICIAL);
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        <Trash2Icon />
        Apagar projeto
      </Button>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-md">
          <form action={acao}>
            <input type="hidden" name="projeto" value={projeto} />

            <DialogHeader>
              <DialogTitle>Apagar “{nome}”?</DialogTitle>
              <DialogDescription>
                Todos os vídeos deste projeto serão apagados do armazenamento
                junto com ele. Não dá para desfazer. A cota dos vídeos que ainda
                não foram processados volta para o seu plano.
              </DialogDescription>
            </DialogHeader>

            <div className="my-4">
              <CampoMensagem erro={estado.erro} />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAberto(false)}>
                Cancelar
              </Button>
              <BotaoEnvio carregando="Apagando…" variant="destructive">
                Apagar projeto
              </BotaoEnvio>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
