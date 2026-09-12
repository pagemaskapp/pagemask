"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Os campos do editor.
 *
 * Eles existem aqui, e não em `components/ui/`, porque não são componentes de
 * uso geral: são a forma que ESTE formulário tem — rótulo em cima, ajuda
 * embaixo, tudo em coluna estreita ao lado da prévia. Promovê-los a
 * componentes do sistema antes de haver um segundo formulário parecido seria
 * inventar uma abstração para um caso só.
 *
 * **Todo controle tem rótulo ligado por `htmlFor`.** Um `<select>` sem isso é
 * um campo mudo para leitor de tela, e o editor é quase todo feito deles.
 */

export function Secao({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t py-5 first:border-t-0 first:pt-0">
      <h2 className="text-sm font-semibold">{titulo}</h2>
      {descricao ? (
        <p className="text-muted-foreground mt-0.5 text-xs">{descricao}</p>
      ) : null}
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

export function Campo({
  id,
  rotulo,
  ajuda,
  children,
}: {
  id: string;
  rotulo: string;
  ajuda?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id}>{rotulo}</Label>
      <div className="mt-1.5">{children}</div>
      {ajuda ? (
        <p className="text-muted-foreground mt-1 text-xs">{ajuda}</p>
      ) : null}
    </div>
  );
}

const CLASSE_SELECT =
  "border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 " +
  "h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3 " +
  "dark:bg-input/30";

export function Escolha<T extends string>({
  id,
  valor,
  opcoes,
  aoMudar,
}: {
  id: string;
  valor: T;
  opcoes: ReadonlyArray<{ valor: T; rotulo: string }>;
  aoMudar: (valor: T) => void;
}) {
  return (
    <select
      id={id}
      value={valor}
      onChange={(evento) => aoMudar(evento.target.value as T)}
      className={CLASSE_SELECT}
    >
      {opcoes.map((opcao) => (
        <option key={opcao.valor} value={opcao.valor}>
          {opcao.rotulo}
        </option>
      ))}
    </select>
  );
}

/**
 * Número com faixa fechada.
 *
 * A faixa é a MESMA do `zod` e a mesma do `molde.py`, e ela é aplicada no
 * `onChange` porque `min`/`max` de um `<input type="number">` não impedem
 * digitar fora: eles só reprovam na validação nativa do formulário, que aqui
 * não existe (o salvamento é uma server action, não um submit). Sem a trava,
 * o campo aceitaria `size_px: 9000`, a prévia voltaria com erro do servidor, e
 * o usuário ficaria sem saber qual campo estava errado.
 */
export function Numero({
  id,
  valor,
  minimo,
  maximo,
  passo = 1,
  sufixo,
  aoMudar,
}: {
  id: string;
  valor: number;
  minimo: number;
  maximo: number;
  passo?: number;
  sufixo?: string;
  aoMudar: (valor: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        value={valor}
        min={minimo}
        max={maximo}
        step={passo}
        onChange={(evento) => {
          const numero = Number(evento.target.value);
          if (!Number.isFinite(numero)) return;
          aoMudar(Math.min(maximo, Math.max(minimo, numero)));
        }}
        className="w-28"
      />
      {sufixo ? (
        <span className="text-muted-foreground text-xs">{sufixo}</span>
      ) : null}
    </div>
  );
}

export function Deslizante({
  id,
  valor,
  minimo,
  maximo,
  passo = 1,
  formatar,
  aoMudar,
}: {
  id: string;
  valor: number;
  minimo: number;
  maximo: number;
  passo?: number;
  formatar: (valor: number) => string;
  aoMudar: (valor: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        value={valor}
        min={minimo}
        max={maximo}
        step={passo}
        onChange={(evento) => aoMudar(Number(evento.target.value))}
        className="accent-primary h-1.5 flex-1"
      />
      <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">
        {formatar(valor)}
      </span>
    </div>
  );
}

/**
 * Cor.
 *
 * Dois controles para o mesmo valor, de propósito: o seletor nativo para
 * escolher no olho e o campo de texto para colar o hexadecimal da marca. O
 * seletor sozinho torna impossível digitar `#10B981` — e é assim que a cor
 * chega de um guia de identidade visual.
 *
 * O CAMPO DE TEXTO TEM ESTADO PRÓPRIO, e não dá para ser diferente. Ele é
 * controlado, e uma cor só sobe para o template quando está completa: sem
 * rascunho local, cada tecla era descartada e o React repintava o valor
 * antigo — o campo simplesmente não aceitava digitação, só colagem de um
 * `#RRGGBB` inteiro de uma vez.
 *
 * O rascunho é abandonado assim que `valor` muda por fora (o seletor de cor,
 * ou trocar "cor fixa" por "detectar no vídeo"), senão os dois controles
 * passariam a discordar na tela.
 */
export function Cor({
  id,
  valor,
  aoMudar,
}: {
  id: string;
  valor: string;
  aoMudar: (valor: string) => void;
}) {
  const [rascunho, setRascunho] = useState(valor);
  const [visto, setVisto] = useState(valor);
  if (visto !== valor) {
    setVisto(valor);
    setRascunho(valor);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="color"
        value={completa(valor) ? valor : "#000000"}
        onChange={(evento) => aoMudar(evento.target.value.toUpperCase())}
        className="border-input size-8 shrink-0 cursor-pointer rounded-lg border bg-transparent p-0.5"
      />
      <Input
        aria-label="Cor em hexadecimal"
        value={rascunho}
        maxLength={7}
        spellCheck={false}
        onChange={(evento) => {
          const texto = evento.target.value.trim();
          setRascunho(texto);
          if (completa(texto)) aoMudar(texto.toUpperCase());
        }}
        onBlur={() => setRascunho(valor)}
        className="w-28 font-mono"
      />
    </div>
  );
}

function completa(valor: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(valor);
}

export function Interruptor({
  id,
  rotulo,
  ajuda,
  marcado,
  aoMudar,
}: {
  id: string;
  rotulo: string;
  ajuda?: string;
  marcado: boolean;
  aoMudar: (marcado: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={marcado}
        onChange={(evento) => aoMudar(evento.target.checked)}
        className="accent-primary mt-0.5 size-4 shrink-0"
      />
      <div>
        <Label htmlFor={id} className="font-normal">
          {rotulo}
        </Label>
        {ajuda ? (
          <p className="text-muted-foreground mt-0.5 text-xs">{ajuda}</p>
        ) : null}
      </div>
    </div>
  );
}
