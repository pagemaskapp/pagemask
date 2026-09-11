import "server-only";

import { consumirBalde, type ResultadoLimite } from "@/lib/rate-limit/balde";

/** 60 URLs de upload por usuário por hora (docs/PLANO.md, Fase 2). */
export const URLS_POR_HORA = 60;

/**
 * A confirmação tem balde próprio, com o dobro do teto.
 *
 * Não dá para contar as duas no mesmo balde: cada upload gasta uma assinatura
 * **e** uma confirmação, então um teto compartilhado de 60 viraria 30 vídeos
 * por hora — metade do que o plano promete. Balde separado mantém o limite de
 * assinatura sendo o que o PLANO diz, e ainda assim põe teto na confirmação,
 * que é a chamada cara: ela faz `HEAD` e várias leituras por `Range` no R2, e
 * sem teto seria um jeito barato de mandar o servidor trabalhar de graça.
 */
export const CONFIRMACOES_POR_HORA = URLS_POR_HORA * 2;

export const JANELA = "1 hour";

export function limiteDeAssinatura(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `upload-assinar:${userId}`,
    limite: URLS_POR_HORA,
    janela: JANELA,
    rotulo: "upload-assinar",
  });
}

export function limiteDeConfirmacao(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `upload-confirmar:${userId}`,
    limite: CONFIRMACOES_POR_HORA,
    janela: JANELA,
    rotulo: "upload-confirmar",
  });
}

/** Quanto tempo falta para o balde virar, em português de gente. */
export function esperaEmTexto(liberadoEm: Date): string {
  const minutos = Math.max(1, Math.ceil((liberadoEm.getTime() - Date.now()) / 60000));
  if (minutos === 1) return "um minuto";
  if (minutos < 60) return `${minutos} minutos`;

  const horas = Math.ceil(minutos / 60);
  return horas === 1 ? "uma hora" : `${horas} horas`;
}
