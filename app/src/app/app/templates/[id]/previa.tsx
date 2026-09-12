"use client";

import { Loader2Icon, ImageOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * O painel da prévia.
 *
 * A imagem ANTERIOR continua na tela enquanto a nova é gerada, esmaecida. A
 * alternativa — limpar e mostrar um retângulo vazio — pisca a cada tecla
 * digitada, e ajustar uma frase olhando para um quadro em branco não é ajustar
 * nada. O `aria-busy` conta a mesma coisa para quem não vê o esmaecimento.
 *
 * 1080×1920 sempre, com `aspect-[9/16]`: a prévia é o quadro final do vídeo, e
 * vê-la em outra proporção derrotaria o propósito de ter uma prévia.
 */

export type EstadoDaPrevia = {
  carregando: boolean;
  url?: string;
  erro?: string;
};

export function Previa({
  estado,
  aoTentarDeNovo,
}: {
  estado: EstadoDaPrevia;
  aoTentarDeNovo: () => void;
}) {
  return (
    <div>
      <div
        aria-busy={estado.carregando}
        aria-live="polite"
        className="bg-muted relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-xl border"
      >
        {estado.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={estado.url}
            alt="Prévia do vídeo com o template aplicado"
            className={`size-full object-contain transition-opacity ${
              estado.carregando ? "opacity-40" : "opacity-100"
            }`}
          />
        ) : estado.erro ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <ImageOffIcon className="size-6" />
            <p className="text-xs">{estado.erro}</p>
            <Button type="button" variant="outline" size="sm" onClick={aoTentarDeNovo}>
              Tentar de novo
            </Button>
          </div>
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-xs">
            {estado.carregando
              ? "Gerando a primeira prévia…"
              : "Escolha um vídeo de amostra para ver a prévia."}
          </div>
        )}

        {estado.carregando && estado.url ? (
          <span className="bg-background/90 text-muted-foreground absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
            <Loader2Icon className="size-3 animate-spin" />
            atualizando
          </span>
        ) : null}
      </div>

      {/*
        A prévia é um quadro do MEIO do vídeo, composto pelo mesmo código que
        renderiza o lote (`build_overlay` + `render_preview`, no worker). Dizer
        isso importa: é o que sustenta a promessa de que o lote sai igual ao que
        está na tela, e é o que explica por que o áudio e o movimento não estão
        aqui.
      */}
      <p className="text-muted-foreground mt-3 text-center text-xs">
        Um quadro do meio do vídeo, montado pelo mesmo motor que renderiza o
        lote. Sem áudio e sem movimento — o resto sai idêntico.
      </p>
    </div>
  );
}
