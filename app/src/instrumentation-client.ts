import * as Sentry from "@sentry/nextjs";

import { publicEnv } from "@/lib/env/public";
import {
  ambienteDoSentry,
  OPCOES_COMUNS,
} from "@/lib/observabilidade/sentry-comum";

/**
 * Sentry no navegador (PLANO §7).
 *
 * Roda depois do HTML e ANTES da hidratação, que é o instante certo: erro de
 * hidratação é justamente o que não aparece em log de servidor nenhum.
 *
 * SEM `replayIntegration`, E A RAZÃO É §8
 * =======================================
 *
 * O Session Replay é a integração mais tentadora do SDK e a que não cabe aqui:
 * ela grava o DOM da sessão e manda para o Sentry. No PageMask o DOM tem o
 * e-mail do titular na tela de conta, o @ das contas conectadas, a legenda dos
 * vídeos e o primeiro quadro de cada vídeo enviado. Mascarar campo por campo
 * seria uma lista para manter para sempre, com um erro de manutenção custando
 * vídeo de cliente num serviço de terceiro — e o inventário de `docs/DADOS.md`
 * teria que declarar o Sentry como destino de conteúdo de vídeo.
 *
 * `browserTracingIntegration` fica (é o padrão do SDK): ela mede navegação e
 * requisição, sem conteúdo de tela, e as URLs que ela registra passam pelo
 * scrubber de `sentry-comum`.
 */
const dsn = publicEnv.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    ...OPCOES_COMUNS,
    dsn,
    environment: ambienteDoSentry(),
    initialScope: { tags: { runtime: "browser" } },
  });
}

/**
 * O breadcrumb de navegação do App Router.
 *
 * Sem ele, um erro de cliente chega ao painel sem nada dizendo de onde a pessoa
 * veio — e no App Router a URL do momento do erro é quase sempre a terceira ou
 * quarta da sessão, não a de entrada.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
