"use client";

import { useActionState, useState } from "react";
import { DownloadIcon, Trash2Icon } from "lucide-react";

import { removerVideo } from "@/app/app/projetos/acoes";
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
 * Baixar e remover, por vídeo.
 *
 * A remoção pede confirmação porque ela apaga o arquivo no R2 junto com a
 * linha — não há lixeira e não há como desfazer. O texto do modal diz isso com
 * todas as letras, inclusive que a cota volta, que é a parte que o usuário não
 * tem como adivinhar.
 */
export function AcoesDoVideo({
  video,
  projeto,
  nome,
  podeBaixar,
  devolveCota,
}: {
  video: string;
  projeto: string;
  nome: string;
  podeBaixar: boolean;
  devolveCota: boolean;
}) {
  const [estado, acao] = useActionState(removerVideo, INICIAL);
  const [aberto, setAberto] = useState(false);

  return (
    <div className="flex shrink-0 items-center gap-1">
      {podeBaixar ? (
        <Button asChild variant="outline" size="sm">
          {/*
            Link de verdade, não `fetch`: o navegador precisa tratar a resposta
            como download. A rota confere a sessão, assina uma URL de 15 minutos
            e redireciona para ela.
          */}
          <a href={`/api/videos/${video}/baixar`}>
            <DownloadIcon />
            Baixar
          </a>
        </Button>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remover ${nome}`}
        onClick={() => setAberto(true)}
      >
        <Trash2Icon />
      </Button>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-md">
          <form action={acao}>
            <input type="hidden" name="video" value={video} />
            <input type="hidden" name="projeto" value={projeto} />

            <DialogHeader>
              <DialogTitle>Remover este vídeo?</DialogTitle>
              <DialogDescription>
                <span className="font-medium">{nome}</span> será apagado do
                armazenamento e da sua lista. Não dá para desfazer.
                {devolveCota
                  ? " Como ele ainda não foi processado, a vaga volta para a sua cota."
                  : null}
              </DialogDescription>
            </DialogHeader>

            <div className="my-4">
              <CampoMensagem erro={estado.erro} />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAberto(false)}>
                Cancelar
              </Button>
              <BotaoEnvio carregando="Removendo…" variant="destructive">
                Remover
              </BotaoEnvio>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
