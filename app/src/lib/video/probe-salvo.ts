import { z } from "zod";

/**
 * Leitura do que está gravado em `jobs.probe`.
 *
 * A coluna é `jsonb`, então o que volta do banco é `Json` — o TypeScript não
 * sabe nada sobre a forma dela, e afirmar `as Sonda` seria mentir para o
 * compilador sobre um dado que já esteve gravado antes desta versão do código.
 *
 * Há um segundo motivo, e ele é a razão de isto existir como módulo próprio: a
 * **Fase 3 vai reescrever esta coluna com a saída do `ffprobe`**, que tem outro
 * formato. Uma tela que lê a duração precisa continuar funcionando nos dois
 * casos, e precisa aguentar não achar nada. Por isso tudo aqui é opcional e o
 * fracasso é `null`, nunca exceção.
 */

const Esquema = z.object({
  fonte: z.string().optional(),
  container: z.string().optional(),
  duracao_s: z.number().nullish(),
  largura: z.number().nullish(),
  altura: z.number().nullish(),
});

export type ProbeSalvo = {
  container: string | null;
  duracaoSegundos: number | null;
  largura: number | null;
  altura: number | null;
};

export function lerProbe(valor: unknown): ProbeSalvo | null {
  const analisado = Esquema.safeParse(valor);
  if (!analisado.success) return null;

  return {
    container: analisado.data.container ?? null,
    duracaoSegundos: analisado.data.duracao_s ?? null,
    largura: analisado.data.largura ?? null,
    altura: analisado.data.altura ?? null,
  };
}
