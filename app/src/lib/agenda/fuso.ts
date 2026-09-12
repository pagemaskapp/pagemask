/**
 * Fuso da tela: `America/Sao_Paulo`. No banco, sempre UTC (CLAUDE.md).
 *
 * SEM BIBLIOTECA, DE PROPÓSITO
 * ============================
 *
 * Tudo que a agenda precisa é converter "dia 14, 18:30, em São Paulo" para um
 * instante UTC e o caminho de volta. `Intl.DateTimeFormat` já sabe o fuso, com
 * as regras de horário de verão que a plataforma carrega — uma dependência de
 * datas seria mais código no bundle para responder a mesma pergunta.
 *
 * Sem `"server-only"` porque o calendário, no navegador, precisa das mesmas
 * contas: o dia em que um item aparece tem que ser o mesmo no HTML do
 * servidor e na hidratação, senão a tela pisca e o React reclama.
 */

export const FUSO = "America/Sao_Paulo";

/**
 * Limite de caracteres da legenda no Instagram. Conferido na referência de
 * `POST /{ig-user-id}/media` em 11/09/2026: 2.200 caracteres, 30 hashtags,
 * 20 menções. A migration 0019 cobra o mesmo número no banco.
 */
export const LIMITE_LEGENDA = 2200;

export type PartesLocais = {
  ano: number;
  /** 1–12 */
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  /** 0 = domingo … 6 = sábado, no fuso. */
  diaDaSemana: number;
};

const formatador = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** As partes de um instante, lidas no fuso da tela. */
export function partesLocais(instante: Date): PartesLocais {
  const partes: Record<string, string> = {};
  for (const p of formatador.formatToParts(instante)) partes[p.type] = p.value;
  return {
    ano: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour),
    minuto: Number(partes.minute),
    diaDaSemana: Math.max(0, DIAS.indexOf(partes.weekday)),
  };
}

/** Quantos minutos o fuso está à frente do UTC naquele instante (negativo no Brasil). */
export function deslocamentoMin(instante: Date): number {
  const partes: Record<string, string> = {};
  for (const p of formatador.formatToParts(instante)) partes[p.type] = p.value;
  const comoUtc = Date.UTC(
    Number(partes.year),
    Number(partes.month) - 1,
    Number(partes.day),
    Number(partes.hour),
    Number(partes.minute),
    Number(partes.second),
  );
  return Math.round((comoUtc - instante.getTime()) / 60_000);
}

/**
 * "Dia 14/09/2026 às 18:30 em São Paulo" → instante UTC.
 *
 * Duas passadas porque o deslocamento depende do próprio instante que se está
 * procurando (numa virada de horário de verão o primeiro palpite pode cair do
 * outro lado da linha). Na segunda passada o deslocamento já é o certo.
 */
export function paraUtc(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
): Date {
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto);
  const primeiro = deslocamentoMin(new Date(palpite));
  let utc = palpite - primeiro * 60_000;
  const segundo = deslocamentoMin(new Date(utc));
  if (segundo !== primeiro) utc = palpite - segundo * 60_000;
  return new Date(utc);
}

/** `YYYY-MM-DD` no fuso da tela. É a chave dos dias no calendário. */
export function chaveDoDia(instante: Date): string {
  const p = partesLocais(instante);
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

/** `HH:mm` no fuso da tela. */
export function horaLocal(instante: Date): string {
  const p = partesLocais(instante);
  return `${dois(p.hora)}:${dois(p.minuto)}`;
}

export function lerChaveDoDia(
  chave: string,
): { ano: number; mes: number; dia: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(chave);
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  // Rejeita 31/02 e afins: o Date.UTC "corrige" para o mês seguinte.
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1) return null;
  return { ano, mes, dia };
}

export function lerHora(valor: string): { hora: number; minuto: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(valor);
  if (!m) return null;
  const hora = Number(m[1]);
  const minuto = Number(m[2]);
  if (hora > 23 || minuto > 59) return null;
  return { hora, minuto };
}

/** Soma dias a uma chave `YYYY-MM-DD` sem passar por fuso nenhum. */
export function somarDias(chave: string, dias: number): string {
  const p = lerChaveDoDia(chave);
  if (!p) return chave;
  const d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + dias));
  return `${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}`;
}

export function dois(n: number): string {
  return String(n).padStart(2, "0");
}

export const NOMES_DOS_MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export const DIAS_CURTOS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "sábado, 14 de setembro, 18:30" */
export const dataHoraLonga = new Intl.DateTimeFormat("pt-BR", {
  timeZone: FUSO,
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/** "14/09/2026 18:30" */
export const dataHoraCurta = new Intl.DateTimeFormat("pt-BR", {
  timeZone: FUSO,
  dateStyle: "short",
  timeStyle: "short",
});
