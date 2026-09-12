"use client";

import { useActionState, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { apagarTemplate } from "@/app/app/templates/acoes";
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

export function ApagarTemplate({
  template,
  nome,
}: {
  template: string;
  nome: string;
}) {
  const [estado, acao] = useActionState(apagarTemplate, INICIAL);
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        <Trash2Icon />
        Apagar
      </Button>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-md">
          <form action={acao}>
            <input type="hidden" name="template" value={template} />

            <DialogHeader>
              <DialogTitle>Apagar “{nome}”?</DialogTitle>
              <DialogDescription>
                Os projetos que usam este template voltam ao modelo padrão. Os
                vídeos já processados não mudam: eles guardam uma cópia do
                template usada na hora do processamento.
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
                Apagar template
              </BotaoEnvio>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
