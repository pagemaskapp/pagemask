"use client";

import { useActionState, useEffect, useState } from "react";
import { CaptionsIcon, RefreshCwIcon } from "lucide-react";

import { rerenderizarComLegenda } from "@/app/app/projetos/acoes";
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
 * Ver e corrigir a legenda de um vídeo, antes de queimá-la de novo.
 *
 * POR QUE UM `<textarea>` COM O SRT CRU, e não uma tabela de falas com campos
 * de tempo: o trabalho real aqui é **trocar uma palavra que a transcrição
 * errou**. Num editor de linhas, corrigir "Santa Catarina" em seis falas são
 * seis cliques e seis campos; num textarea é `Ctrl+H` mental e um scroll. O
 * formato é feio e é o certo — e quem nunca viu um SRT reconhece o padrão em
 * dois segundos, porque ele é o mesmo de qualquer legenda baixada da internet.
 *
 * O TEXTO QUE VOLTA DO SALVAMENTO SUBSTITUI O QUE ESTÁ NA TELA. O servidor
 * normaliza: refaz a numeração, quebra linhas longas, remove o que é sintaxe.
 * Deixar o `<textarea>` com o texto digitado esconderia essas mudanças até o
 * vídeo ficar pronto — e aí a pessoa veria uma legenda diferente da que ela
 * leu, sem nada explicando a diferença.
 *
 * SALVAR E RENDERIZAR SÃO DOIS BOTÕES, de propósito. Salvar é barato e não
 * custa cota; renderizar de novo consome uma vaga do plano e ocupa o worker por
 * minutos. Juntar os dois num botão só faria a correção de uma vírgula cobrar
 * um vídeo — e quem está corrigindo um lote salva várias vezes antes de mandar
 * renderizar.
 */
export function LegendaDoVideo({
  video,
  projeto,
  nome,
}: {
  video: string;
  projeto: string;
  nome: string;
}) {
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Editar a legenda de ${nome}`}
        title="Legenda"
        onClick={() => setAberto(true)}
      >
        <CaptionsIcon />
      </Button>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-2xl">
          {/*
            O conteúdo só é montado com o diálogo aberto: assim o `fetch` da
            legenda acontece ao abrir, e uma lista com cinquenta vídeos não
            dispara cinquenta requisições ao carregar a página.
          */}
          {aberto ? (
            <Conteudo
              video={video}
              projeto={projeto}
              nome={nome}
              aoFechar={() => setAberto(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

type Estado =
  | { fase: "carregando" }
  | { fase: "erro"; mensagem: string }
  | { fase: "pronta"; texto: string; editavel: boolean };

function Conteudo({
  video,
  projeto,
  nome,
  aoFechar,
}: {
  video: string;
  projeto: string;
  nome: string;
  aoFechar: () => void;
}) {
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });
  const [rascunho, setRascunho] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState<{ erro?: string; aviso?: string }>({});
  const [tentativa, setTentativa] = useState(0);
  const [render, acaoDeRender] = useActionState(rerenderizarComLegenda, INICIAL);

  /**
   * A busca da legenda, com o ciclo de vida no efeito.
   *
   * `vivo` não é zelo: o `Dialog` desmonta este componente ao fechar, e sem a
   * trava um `setEstado` chegando depois disso escreve num componente que não
   * existe mais. `tentativa` é o que o botão "tentar de novo" incrementa —
   * refazer o efeito é mais simples do que ter uma função de recarga que
   * também precisa da mesma trava.
   */
  useEffect(() => {
    let vivo = true;

    void (async () => {
      try {
        const resposta = await fetch(`/api/videos/${video}/legenda`, {
          cache: "no-store",
        });
        const dados = (await resposta.json()) as {
          url?: string;
          editavel?: boolean;
          erro?: string;
        };
        if (!vivo) return;

        if (!resposta.ok || !dados.url) {
          setEstado({
            fase: "erro",
            mensagem: dados.erro ?? "Não conseguimos abrir a legenda deste vídeo.",
          });
          return;
        }

        // O texto vem DIRETO do R2, por URL pré-assinada: ele não passa pela
        // nossa função só para ser copiado de um lado para o outro.
        const arquivo = await fetch(dados.url, { cache: "no-store" });
        if (!vivo) return;

        if (!arquivo.ok) {
          setEstado({
            fase: "erro",
            mensagem:
              "O arquivo de legenda não pôde ser baixado. Tente abrir de novo.",
          });
          return;
        }

        const texto = await arquivo.text();
        if (!vivo) return;

        setRascunho(texto);
        setEstado({ fase: "pronta", texto, editavel: dados.editavel !== false });
      } catch {
        if (!vivo) return;
        setEstado({
          fase: "erro",
          mensagem: "Não conseguimos falar com o servidor. Tente de novo.",
        });
      }
    })();

    return () => {
      vivo = false;
    };
  }, [video, tentativa]);

  async function salvar() {
    setSalvando(true);
    setMensagem({});

    try {
      const resposta = await fetch(`/api/videos/${video}/legenda`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srt: rascunho }),
      });
      const dados = (await resposta.json()) as {
        srt?: string;
        falas?: number;
        erro?: string;
      };

      if (!resposta.ok || !dados.srt) {
        setMensagem({ erro: dados.erro ?? "Não conseguimos salvar a legenda." });
        return;
      }

      setRascunho(dados.srt);
      setEstado({ fase: "pronta", texto: dados.srt, editavel: true });
      setMensagem({
        aviso:
          `Legenda salva com ${dados.falas} ${dados.falas === 1 ? "fala" : "falas"}. ` +
          "Clique em Renderizar de novo para o vídeo sair com o texto novo.",
      });
    } catch {
      setMensagem({ erro: "Não conseguimos falar com o servidor. Tente de novo." });
    } finally {
      setSalvando(false);
    }
  }

  const mudou = estado.fase === "pronta" && rascunho !== estado.texto;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Legenda de {nome}</DialogTitle>
        <DialogDescription>
          Corrija o texto e salve. O vídeo só muda quando você renderizar de
          novo — e isso consome uma vaga da cota do seu plano.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4">
        {estado.fase === "carregando" ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            Carregando a legenda…
          </p>
        ) : null}

        {estado.fase === "erro" ? (
          <div className="space-y-3 py-4">
            <CampoMensagem erro={estado.mensagem} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEstado({ fase: "carregando" });
                setMensagem({});
                setTentativa((n) => n + 1);
              }}
            >
              Tentar de novo
            </Button>
          </div>
        ) : null}

        {estado.fase === "pronta" ? (
          <>
            <label htmlFor="srt" className="sr-only">
              Legenda no formato SRT
            </label>
            <textarea
              id="srt"
              value={rascunho}
              onChange={(evento) => setRascunho(evento.target.value)}
              disabled={!estado.editavel}
              spellCheck={false}
              rows={16}
              className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:ring-3 disabled:opacity-60"
            />
            <p className="text-muted-foreground mt-1 text-xs">
              {estado.editavel
                ? "Cada bloco é: número, tempo de início → fim, e o texto. " +
                  "Mexer no texto é o caso comum; os tempos vêm da transcrição."
                : "Este vídeo está na fila ou sendo processado agora, então a " +
                  "legenda dele está em uso. Espere o lote terminar para editar."}
            </p>
          </>
        ) : null}

        <CampoMensagem
          erro={mensagem.erro ?? render.erro}
          aviso={mensagem.aviso ?? render.aviso}
        />
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        <Button type="button" variant="ghost" onClick={aoFechar}>
          Fechar
        </Button>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={salvar}
            disabled={estado.fase !== "pronta" || !estado.editavel || salvando || !mudou}
          >
            {salvando ? "Salvando…" : "Salvar legenda"}
          </Button>

          <form action={acaoDeRender}>
            <input type="hidden" name="projeto" value={projeto} />
            <input type="hidden" name="video" value={video} />
            {/*
              Três condições, e cada uma evita cobrar uma vaga da cota por um
              clique que o usuário não teria dado se soubesse:

              · `!pronta` — a legenda ainda está carregando, ou a carga falhou.
                Renderizar aqui é mandar refazer o vídeo com um texto que a
                pessoa nunca viu;
              · `!editavel` — o vídeo está na fila ou sendo processado agora,
                então já existe um render em andamento para ele;
              · `mudou` — há correção não salva. O render usa o que está no R2,
                não o que está na tela: o vídeo sairia sem a última correção.
            */}
            <BotaoEnvio
              carregando="Enviando…"
              disabled={estado.fase !== "pronta" || !estado.editavel || mudou}
            >
              <RefreshCwIcon />
              Renderizar de novo
            </BotaoEnvio>
          </form>
        </div>
      </DialogFooter>
    </>
  );
}
