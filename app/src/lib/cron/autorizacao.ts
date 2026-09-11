import "server-only";

import { timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env/server";

/**
 * A porta das rotas de cron (PLANO §5: "rota protegida por `CRON_SECRET` no
 * header; disparo pelo Vercel Cron").
 *
 * DUAS FORMAS DE MANDAR O SEGREDO
 * ===============================
 *
 * O Vercel Cron manda `Authorization: Bearer <CRON_SECRET>` sozinho, sem
 * configuração. Um disparo manual (o RUNBOOK, um teste) costuma ser mais
 * cômodo com um cabeçalho próprio. As duas valem, e as duas passam pela mesma
 * comparação.
 *
 * SEM SEGREDO CONFIGURADO, A ROTA É NEGADA
 * ========================================
 *
 * Se `CRON_SECRET` está em branco, tudo recebe 401 — e não "tudo passa". Uma
 * rota de cron que roda sem segredo num ambiente onde alguém esqueceu de
 * preencher a variável é uma rota pública que renova token e manda e-mail.
 * Falhar fechado aqui custa um cron que não roda; falhar aberto custa o resto.
 */
export function cronAutorizado(requisicao: Request): boolean {
  const segredo = getServerEnv().CRON_SECRET;
  if (!segredo) {
    console.error("[cron] CRON_SECRET não está definida: chamada recusada");
    return false;
  }

  const cabecalho = requisicao.headers.get("authorization");
  const doBearer = cabecalho?.toLowerCase().startsWith("bearer ")
    ? cabecalho.slice(7)
    : null;
  const doProprio = requisicao.headers.get("x-cron-secret");

  return iguais(doBearer, segredo) || iguais(doProprio, segredo);
}

/**
 * Comparação em tempo constante.
 *
 * `a === b` em string sai no primeiro byte diferente, e essa diferença de tempo
 * é mensurável pela rede em número suficiente de tentativas — é assim que se
 * descobre um segredo caractere a caractere. O tamanho é conferido antes porque
 * `timingSafeEqual` exige buffers do mesmo tamanho; o tamanho do segredo não é
 * a parte secreta dele.
 */
function iguais(recebido: string | null, esperado: string): boolean {
  if (!recebido) return false;
  const a = Buffer.from(recebido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
