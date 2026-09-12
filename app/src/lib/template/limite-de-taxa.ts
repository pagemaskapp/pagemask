import "server-only";

import { consumirBalde, type ResultadoLimite } from "@/lib/rate-limit/balde";

/**
 * 30 prévias por usuário a cada 10 minutos (docs/PLANO.md, Fase 6).
 *
 * O número não é arbitrário e o debounce de 600 ms do editor não substitui
 * este limite. Uma prévia custa, no worker, um download do vídeo de amostra e
 * uma passada de detecção — é a operação mais cara que um usuário consegue
 * disparar sem gastar cota de vídeo. Sem teto, um laço de `fetch` na rota da
 * prévia ocupa a thread de prévia de todo mundo de graça.
 *
 * O debounce cuida do caso honesto (quem digita); o balde cuida do resto.
 */
export const PREVIAS_POR_JANELA = 30;

export const JANELA_DA_PREVIA = "10 minutes";

export function limiteDePrevia(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `template-previa:${userId}`,
    limite: PREVIAS_POR_JANELA,
    janela: JANELA_DA_PREVIA,
    rotulo: "template-previa",
  });
}

/**
 * O envio de cabeçalho tem balde próprio, mais folgado.
 *
 * Ele é barato para o servidor (uma assinatura, depois um `HEAD` e uma leitura
 * de 64 KB) e caro para o usuário refazer, então o teto aqui existe contra
 * abuso, não contra uso intenso.
 */
export const HEADERS_POR_HORA = 60;

export function limiteDeHeader(userId: string, etapa: "assinar" | "confirmar") {
  return consumirBalde({
    bucket: `template-header-${etapa}:${userId}`,
    limite: HEADERS_POR_HORA,
    janela: "1 hour",
    rotulo: `template-header-${etapa}`,
  });
}
