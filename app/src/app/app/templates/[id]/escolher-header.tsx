"use client";

import { useRef, useState } from "react";
import { CheckIcon, ImageIcon, UploadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { HEADER_EMBUTIDO } from "@/lib/template/esquema";
import type { ConfigDoTemplate } from "@/lib/template/esquema";

/**
 * A imagem de cabeçalho: escolher uma já enviada, ou enviar outra.
 *
 * O ENVIO SEGUE O MESMO CAMINHO DO VÍDEO (Fase 2), em três passos, e nenhum
 * deles manda bytes para a Vercel:
 *
 *   1. `POST /api/templates/header/assinar`   → autorização de PUT
 *   2. `PUT <url do R2>`                      → a imagem, direto
 *   3. `POST /api/templates/header/confirmar` → o servidor lê os primeiros
 *                                               bytes e decide
 *
 * `fetch` aqui, e não `XMLHttpRequest` como no vídeo: a diferença lá era a
 * barra de progresso, que num arquivo de até 5 MB não tem o que mostrar.
 *
 * **A recusa do passo 3 é a que importa.** Um `.html` renomeado para `.png`
 * passa pelos dois primeiros — o navegador declara `image/png` pela extensão e
 * o R2 grava o que recebeu — e morre na confirmação, que lê a assinatura de
 * bytes do arquivo. É por isso que o envio não termina no PUT.
 */

export type HeaderDisponivel = {
  chave: string;
  url: string;
};

const MAXIMO_BYTES = 5 * 1024 * 1024;

export function EscolherHeader({
  header,
  headers,
  aoEscolher,
  aoEnviar,
}: {
  header: ConfigDoTemplate["profile"]["header"];
  headers: HeaderDisponivel[];
  aoEscolher: (header: ConfigDoTemplate["profile"]["header"]) => void;
  aoEnviar: (novo: HeaderDisponivel) => void;
}) {
  const entrada = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | undefined>(undefined);

  async function enviar(arquivo: File) {
    setErro(undefined);

    const tipo = arquivo.type === "image/jpeg" ? "image/jpeg" : "image/png";
    if (arquivo.type !== "image/png" && arquivo.type !== "image/jpeg") {
      setErro("Envie um arquivo PNG ou JPG.");
      return;
    }
    if (arquivo.size === 0) {
      setErro("O arquivo está vazio.");
      return;
    }
    if (arquivo.size > MAXIMO_BYTES) {
      setErro("A imagem de cabeçalho pode ter até 5 MB.");
      return;
    }

    setEnviando(true);
    try {
      const assinatura = await postJson("/api/templates/header/assinar", {
        tipo,
        bytes: arquivo.size,
      });
      if (assinatura.erro) {
        setErro(assinatura.erro);
        return;
      }

      const put = await fetch(assinatura.url as string, {
        method: "PUT",
        headers: (assinatura.cabecalhos ?? {}) as Record<string, string>,
        body: arquivo,
      });
      // 412 é a escrita condicional dizendo "essa chave já existe" — numa
      // repetição do PUT isso não é falha, o arquivo está lá (ver
      // `lib/r2/assinatura.ts`).
      if (!put.ok && put.status !== 412) {
        setErro(`O armazenamento recusou o envio (erro ${put.status}). Tente de novo.`);
        return;
      }

      const confirmacao = await postJson("/api/templates/header/confirmar", {
        chave: assinatura.chave,
        nome: arquivo.name,
      });
      if (confirmacao.erro) {
        setErro(confirmacao.erro);
        return;
      }

      const novo: HeaderDisponivel = {
        chave: confirmacao.chave as string,
        url: confirmacao.url as string,
      };
      aoEnviar(novo);
      aoEscolher({ fonte: "r2", chave: novo.chave });
    } catch {
      setErro("Não conseguimos falar com o servidor. Tente de novo.");
    } finally {
      setEnviando(false);
    }
  }

  const embutidoAtivo = header.fonte === "embutido";

  return (
    <div>
      <CampoMensagem erro={erro} />

      <ul className="grid grid-cols-3 gap-2" aria-label="Imagens de cabeçalho">
        <li>
          <Opcao
            ativa={embutidoAtivo}
            rotulo="Modelo padrão"
            aoClicar={() => aoEscolher({ fonte: "embutido", nome: HEADER_EMBUTIDO })}
          >
            <div className="bg-muted text-muted-foreground flex h-full w-full items-center justify-center">
              <ImageIcon className="size-5" />
            </div>
          </Opcao>
        </li>

        {headers.map((disponivel) => (
          <li key={disponivel.chave}>
            <Opcao
              ativa={header.fonte === "r2" && header.chave === disponivel.chave}
              rotulo="Imagem enviada"
              aoClicar={() => aoEscolher({ fonte: "r2", chave: disponivel.chave })}
            >
              {/*
                `<img>` e não `next/image`, de propósito. A URL é pré-assinada e
                expira em 15 minutos: o otimizador do Next guardaria em cache
                uma cópia de um objeto privado do usuário, servida do nosso
                domínio, com validade própria — e a assinatura da URL deixaria
                de significar alguma coisa. Além disso ele exigiria cadastrar o
                host do R2 em `images.remotePatterns`, o que é o contrário do
                que uma URL efêmera quer.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={disponivel.url}
                alt=""
                className="bg-muted absolute inset-0 size-full object-contain"
              />
            </Opcao>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={enviando}
        onClick={() => entrada.current?.click()}
      >
        <UploadIcon />
        {enviando ? "Enviando…" : "Enviar imagem"}
      </Button>
      <p className="text-muted-foreground mt-1 text-xs">
        PNG ou JPG, até 5 MB. Use uma imagem de 1080 px de largura, com fundo
        transparente ou na cor do vídeo.
      </p>

      <input
        ref={entrada}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(evento) => {
          const arquivo = evento.target.files?.[0];
          // Zerar o valor faz o `change` disparar de novo se a pessoa escolher
          // exatamente o mesmo arquivo depois de um erro.
          evento.target.value = "";
          if (arquivo) void enviar(arquivo);
        }}
      />
    </div>
  );
}

function Opcao({
  ativa,
  rotulo,
  aoClicar,
  children,
}: {
  ativa: boolean;
  rotulo: string;
  aoClicar: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={aoClicar}
      aria-pressed={ativa}
      aria-label={rotulo}
      className={`relative block aspect-video w-full overflow-hidden rounded-lg border-2 transition-colors ${
        ativa ? "border-primary" : "border-transparent hover:border-muted-foreground/30"
      }`}
    >
      {children}
      {ativa ? (
        <span className="bg-primary text-primary-foreground absolute top-1 right-1 rounded-full p-0.5">
          <CheckIcon className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

type Resposta = Record<string, unknown> & { erro?: string };

async function postJson(url: string, corpo: unknown): Promise<Resposta> {
  const resposta = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });

  let dados: unknown = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  if (!resposta.ok) {
    const mensagem =
      dados && typeof dados === "object" && "erro" in dados
        ? String((dados as { erro: unknown }).erro)
        : "Não conseguimos falar com o servidor. Tente de novo.";
    return { erro: mensagem };
  }

  return (dados ?? {}) as Resposta;
}
