import * as Sentry from "@sentry/nextjs";

import { publicEnv } from "@/lib/env/public";
import {
  ambienteDoSentry,
  OPCOES_COMUNS,
} from "@/lib/observabilidade/sentry-comum";

/**
 * Sentry no servidor (PLANO §7).
 *
 * `register()` roda uma vez por instância do servidor Next, antes da primeira
 * requisição, nos dois runtimes. `onRequestError` recebe todo erro que o Next
 * captura em render, route handler, server action e proxy — inclusive os que
 * nunca chegam a um `try/catch` nosso.
 *
 * SEM DSN, NÃO INICIALIZA — E ISSO É NORMAL
 * =========================================
 *
 * `NEXT_PUBLIC_SENTRY_DSN` é opcional (`lib/env/public.ts`). Em
 * desenvolvimento e no CI ela não existe, e chamar `Sentry.init` sem DSN faz o
 * SDK subir inteiro para descartar todo evento em seguida — custo de memória e
 * de patch em `fetch`, `http` e console, em troca de nada. A ausência é o
 * estado esperado fora de produção, não um defeito.
 *
 * O que ela NÃO pode ser é ausência silenciosa EM produção: o `console.warn`
 * abaixo é o que faz um deploy sem DSN aparecer no log da Vercel, em vez de
 * virar meses sem erro nenhum no painel — que é indistinguível de meses sem
 * erro nenhum no produto, e muito mais provável.
 */
export async function register(): Promise<void> {
  const dsn = publicEnv.NEXT_PUBLIC_SENTRY_DSN;

  if (!dsn) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[sentry] NEXT_PUBLIC_SENTRY_DSN ausente: nenhum erro do servidor " +
          "será reportado.",
      );
    }
    return;
  }

  Sentry.init({
    ...OPCOES_COMUNS,
    dsn,
    environment: ambienteDoSentry(),
    // O runtime vira etiqueta: o mesmo erro no edge e no Node costuma ter
    // causas diferentes (o proxy roda em edge; o resto, em Node), e separá-los
    // no painel poupa a pergunta "onde isso aconteceu?" em toda triagem.
    initialScope: { tags: { runtime: process.env.NEXT_RUNTIME ?? "nodejs" } },
  });
}

/**
 * `captureRequestError` do próprio SDK: ele já associa o erro à requisição, à
 * rota e ao span em andamento — coisas que um `captureException` solto perde.
 * O `beforeSend` de `sentry-comum` continua valendo por cima do que ele monta.
 */
export const onRequestError = Sentry.captureRequestError;
