"use client";

import { useActionState, useState } from "react";
import { PlusIcon } from "lucide-react";

import { criarProjeto } from "@/app/app/projetos/acoes";
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
 * "Novo projeto".
 *
 * O botão fica desabilitado quando o plano já está no teto, com o motivo no
 * `title` e no texto ao lado — em vez de abrir o modal, aceitar o nome e só
 * então dizer que não cabia. Mas a ação no servidor confere de novo, porque um
 * botão desabilitado é sugestão de interface, não regra: a `create_project`
 * conta os projetos com a linha do perfil travada, e é ela quem decide.
 */
export function NovoProjeto({ cabe }: { cabe: boolean }) {
  const [estado, acao] = useActionState(criarProjeto, INICIAL);
  const [aberto, setAberto] = useState(false);

  // Não há nada para fechar o modal na mão: no sucesso a action redireciona
  // para o projeto novo e a página inteira é trocada; no erro ele precisa
  // continuar aberto, com a mensagem e o nome que a pessoa já digitou.

  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button disabled={!cabe} title={cabe ? undefined : MOTIVO}>
          <PlusIcon />
          Novo projeto
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form action={acao}>
          <DialogHeader>
            <DialogTitle>Novo projeto</DialogTitle>
            <DialogDescription>
              Um projeto é uma pasta de vídeos que compartilham o mesmo template.
            </DialogDescription>
          </DialogHeader>

          <div className="my-5">
            <CampoMensagem erro={estado.erro} />
            <Label htmlFor="nome">Nome do projeto</Label>
            <Input
              id="nome"
              name="nome"
              maxLength={80}
              required
              autoFocus
              defaultValue={estado.nome}
              placeholder="Cortes de setembro"
              className="mt-2"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
            <BotaoEnvio carregando="Criando…">Criar projeto</BotaoEnvio>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const MOTIVO = "Você chegou ao limite de projetos do seu plano.";
