"use client";

import { useActionState, useState } from "react";
import { PlusIcon } from "lucide-react";

import { criarTemplate } from "@/app/app/templates/acoes";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * "Novo template".
 *
 * O template nasce com o modelo padrão e vai direto para o editor: pedir as
 * dezenas de escolhas do template num modal seria um formulário que ninguém
 * preenche sem ver o resultado. O modal pergunta só o nome, que é o que a
 * lista precisa para existir.
 */
export function NovoTemplate() {
  const [estado, acao] = useActionState(criarTemplate, INICIAL);
  const [aberto, setAberto] = useState(false);

  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon />
          Novo template
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form action={acao}>
          <DialogHeader>
            <DialogTitle>Novo template</DialogTitle>
            <DialogDescription>
              Ele começa com o modelo padrão. Tudo é ajustável no editor, com
              prévia.
            </DialogDescription>
          </DialogHeader>

          <div className="my-5">
            <CampoMensagem erro={estado.erro} />
            <Label htmlFor="nome">Nome do template</Label>
            <Input
              id="nome"
              name="nome"
              maxLength={60}
              required
              autoFocus
              defaultValue={estado.nome}
              placeholder="Humor diário"
              className="mt-2"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
            <BotaoEnvio carregando="Criando…">Criar template</BotaoEnvio>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
