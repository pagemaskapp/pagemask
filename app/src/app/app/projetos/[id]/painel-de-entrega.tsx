"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { DownloadIcon, PackageIcon, RotateCcwIcon } from "lucide-react";

import { reprocessarFalhas } from "@/app/app/projetos/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Button } from "@/components/ui/button";
import type { EstadoFormulario } from "@/lib/auth/formulario";
import { bytesEmTexto, numero } from "@/lib/formato";

const INICIAL: EstadoFormulario = {};

/** De quanto em quanto tempo a tela pergunta se o pacote ficou pronto. */
const ESPERA_MS = 2000;
/** Teto de perguntas: 10 minutos. Depois disso, a tela para de insistir. */
const MAXIMO_DE_PERGUNTAS = 300;

export type Resumo = {
  prontos: number;
  falhados: number;
  reprocessaveis: number;
  pendentes: number;
};

type EstadoDoPacote =
  | { fase: "parado" }
  | { fase: "montando" }
  | { fase: "pronto"; url: string; videos: number; bytes: number; expiraEm: number }
  | { fase: "erro"; mensagem: string };

/**
 * A faixa de entrega: quantos ficaram prontos, quantos falharam, e o que fazer
 * com cada grupo.
 *
 * ELA VIVE DENTRO DA LISTA, e não no cabeçalho da página, porque os números
 * precisam ser os da tela — a lista recebe patch do Realtime sem recarregar a
 * página, então uma contagem vinda do servidor ficaria parada em "3 prontos"
 * depois de o quarto terminar na frente do usuário.
 *
 * O PACOTE É PEDIDO, NÃO BAIXADO NA HORA. O servidor enfileira e responde na
 * mesma requisição; quem monta é o worker. A tela pergunta de 2 em 2 segundos
 * até o pacote existir — e o link que aparece vai direto para o R2, sem passar
 * pela Vercel.
 */
export function PainelDeEntrega({
  projeto,
  resumo,
}: {
  projeto: string;
  resumo: Resumo;
}) {
  const [pacote, setPacote] = useState<EstadoDoPacote>({ fase: "parado" });
  const [estado, acao] = useActionState(reprocessarFalhas, INICIAL);

  // O temporizador precisa morrer junto com o componente: sem isto, sair do
  // projeto no meio da montagem deixaria um `setTimeout` perguntando para
  // sempre por um pacote que ninguém mais vai ver.
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  async function pedirPacote() {
    setPacote({ fase: "montando" });

    try {
      const resposta = await fetch(`/api/projetos/${projeto}/zip`, {
        method: "POST",
        cache: "no-store",
      });
      const corpo = await resposta.json().catch(() => null);

      if (!resposta.ok) {
        setPacote({
          fase: "erro",
          mensagem:
            corpo?.erro ?? "Não conseguimos preparar o pacote. Tente de novo.",
        });
        return;
      }

      await acompanhar(corpo?.id);
    } catch {
      setPacote({
        fase: "erro",
        mensagem: "Não conseguimos falar com o servidor. Tente de novo.",
      });
    }
  }

  async function acompanhar(id: string | undefined) {
    for (let pergunta = 0; pergunta < MAXIMO_DE_PERGUNTAS; pergunta += 1) {
      if (!vivo.current) return;

      const endereco = id
        ? `/api/projetos/${projeto}/zip?pacote=${id}`
        : `/api/projetos/${projeto}/zip`;

      const resposta = await fetch(endereco, { cache: "no-store" });
      const corpo = await resposta.json().catch(() => null);

      if (!vivo.current) return;

      if (!resposta.ok) {
        setPacote({
          fase: "erro",
          mensagem: corpo?.erro ?? "Não conseguimos consultar o pacote.",
        });
        return;
      }

      if (corpo?.status === "done" && corpo.url) {
        setPacote({
          fase: "pronto",
          url: corpo.url,
          videos: Number(corpo.videos ?? 0),
          bytes: Number(corpo.bytes ?? 0),
          expiraEm: Date.now() + Number(corpo.expira_em_s ?? 0) * 1000,
        });
        return;
      }

      if (corpo?.status === "failed") {
        setPacote({
          fase: "erro",
          mensagem:
            corpo.erro ?? "Não conseguimos montar o pacote. Tente de novo.",
        });
        return;
      }

      if (corpo?.status === "expirado" || corpo?.status === "ausente") {
        setPacote({
          fase: "erro",
          mensagem: "O pacote expirou. Peça o download de novo.",
        });
        return;
      }

      await new Promise((resolver) => setTimeout(resolver, ESPERA_MS));
    }

    if (vivo.current) {
      setPacote({
        fase: "erro",
        mensagem:
          "O pacote está demorando mais que o normal. Recarregue a página em " +
          "alguns minutos e peça de novo.",
      });
    }
  }

  /**
   * O link pronto tem hora para morrer, e a tela precisa saber disso.
   *
   * A URL vale 15 minutos. Sem este efeito, quem deixasse a aba aberta ficaria
   * com um botão "Baixar pacote" que responde 403 — e sem nenhum caminho de
   * volta, porque o "Baixar tudo" some enquanto há pacote pronto. Vencido o
   * prazo, o painel volta ao estado inicial e o botão de pedir reaparece.
   */
  const expiraEm = pacote.fase === "pronto" ? pacote.expiraEm : 0;
  useEffect(() => {
    if (!expiraEm) return;

    const quanto = Math.max(0, expiraEm - Date.now());
    const timer = setTimeout(() => setPacote({ fase: "parado" }), quanto);
    return () => clearTimeout(timer);
  }, [expiraEm]);

  /**
   * Vídeo novo ficou pronto? O pacote na tela não tem esse vídeo dentro.
   *
   * O servidor já resolve isso — o `digest` muda e um pedido novo monta um
   * pacote novo (migration 0021) —, mas só quando alguém pede. Sem isto, a
   * tela ofereceria em silêncio um download desatualizado a quem esperou o
   * lote terminar com a página aberta.
   */
  const prontosNoPacote = useRef(resumo.prontos);
  useEffect(() => {
    if (prontosNoPacote.current === resumo.prontos) return;
    prontosNoPacote.current = resumo.prontos;
    setPacote((atual) => (atual.fase === "pronto" ? { fase: "parado" } : atual));
  }, [resumo.prontos]);

  const nada =
    resumo.prontos === 0 && resumo.falhados === 0 && resumo.pendentes === 0;
  if (nada) return null;

  return (
    <div className="bg-card mb-3 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <dl className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <div className="flex items-center gap-1.5">
            <dt>Concluídos</dt>
            <dd className="text-foreground font-medium">
              {numero.format(resumo.prontos)}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt>Com falha</dt>
            <dd
              className={
                resumo.falhados > 0 ? "text-destructive font-medium" : "text-foreground font-medium"
              }
            >
              {numero.format(resumo.falhados)}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt>Pendentes</dt>
            <dd className="text-foreground font-medium">
              {numero.format(resumo.pendentes)}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            O formulário vai SEM a lista de ids, de propósito. O botão é "todos
            os que falharam", e é isso que a ausência de `video` diz ao servidor
            (`p_job_ids = null`). Mandar os ids seria repetir no navegador uma
            decisão que o banco toma melhor — e esbarraria no teto de 500 da
            action num projeto com mais falhas que isso, onde o botão passaria a
            responder "Seleção inválida." para sempre.
          */}
          {resumo.reprocessaveis > 0 ? (
            <form action={acao}>
              <input type="hidden" name="projeto" value={projeto} />
              <BotaoEnvio carregando="Reenviando…" variant="outline" size="sm">
                <RotateCcwIcon />
                {resumo.reprocessaveis === 1
                  ? "Reprocessar 1 com falha"
                  : `Reprocessar ${resumo.reprocessaveis} com falha`}
              </BotaoEnvio>
            </form>
          ) : null}

          {resumo.prontos > 0 && pacote.fase !== "pronto" ? (
            <Button
              type="button"
              size="sm"
              onClick={pedirPacote}
              disabled={pacote.fase === "montando"}
            >
              <PackageIcon />
              {pacote.fase === "montando"
                ? "Montando o pacote…"
                : `Baixar tudo (${numero.format(resumo.prontos)})`}
            </Button>
          ) : null}

          {pacote.fase === "pronto" ? (
            <Button asChild size="sm">
              {/*
                Link de verdade, e não `fetch`: a URL é do R2 e vem com
                `Content-Disposition: attachment`. O navegador precisa navegar
                até ela para tratar a resposta como download.
              */}
              <a href={pacote.url}>
                <DownloadIcon />
                Baixar pacote ({bytesEmTexto(pacote.bytes)})
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      {pacote.fase === "montando" ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Estamos juntando {numero.format(resumo.prontos)}{" "}
          {resumo.prontos === 1 ? "vídeo" : "vídeos"} num arquivo só. Isso leva
          alguns minutos em lotes grandes — pode deixar esta página aberta.
        </p>
      ) : null}

      {pacote.fase === "pronto" ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {numero.format(pacote.videos)}{" "}
          {pacote.videos === 1 ? "vídeo" : "vídeos"} no pacote. O link vale por
          alguns minutos; quando ele vencer, o botão de pedir volta sozinho.
        </p>
      ) : null}

      {pacote.fase === "erro" ? (
        <div className="mt-2">
          <CampoMensagem erro={pacote.mensagem} />
        </div>
      ) : null}

      {estado.erro || estado.aviso ? (
        <div className="mt-2">
          <CampoMensagem erro={estado.erro} aviso={estado.aviso} />
        </div>
      ) : null}
    </div>
  );
}
