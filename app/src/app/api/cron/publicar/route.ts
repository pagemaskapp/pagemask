import { NextResponse } from "next/server";

import { cronAutorizado } from "@/lib/cron/autorizacao";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `GET /api/cron/publicar` — uma vez por dia, às 3h (Vercel Cron,
 * `app/vercel.json`).
 *
 * Faz uma coisa só: vira `scheduled`/`deferred` vencidos em `publishing`
 * (`mark_due_schedules`, migration 0019). Quem publica é o worker, que reclama
 * os `publishing` com `FOR UPDATE SKIP LOCKED` — este handler não tem token,
 * não fala com a Meta e termina em milissegundos.
 *
 * Idempotente por construção: o UPDATE só encontra o que ainda não foi
 * marcado, então duas execuções no mesmo minuto (ou um disparo manual em cima
 * do agendado) marcam o mesmo conjunto uma vez só. O cross-check da fase mede
 * isso junto com o `SKIP LOCKED` do worker.
 *
 * POR QUE DIÁRIO, E O QUE ISSO CUSTA
 * ===================================
 *
 * Cron por minuto é recurso do plano Pro; no Hobby o menor intervalo é diário,
 * e é nele que o projeto está. Um `* * * * *` aqui não é "mais lento no
 * Hobby" — é um deploy que a Vercel recusa.
 *
 * O preço é real e precisa estar escrito: um agendamento feito para as 19h só
 * vira `publishing` no tique das 3h **do dia seguinte**. Nada se perde —
 * `mark_due_schedules` varre tudo que está vencido (`scheduled_at <= now()`),
 * do mais antigo para o mais novo — mas o horário que o cliente escolheu
 * deixa de ser cumprido, e a vazão fica limitada a 200 agendamentos por
 * execução (o `p_max` abaixo), ou seja, 200 por dia.
 *
 * Hoje isso é inócuo: o App Review da Meta não saiu, então não há publicação
 * automática para atrasar. Quando sair, "agendar" volta a precisar significar
 * o horário agendado.
 *
 * E a saída provavelmente não é o plano Pro. O worker na VPS já é um processo
 * contínuo — `restart: unless-stopped`, com `PUBLISH_POLL_S` em 5 s por padrão
 * — e ele fala com o mesmo banco. Chamar `mark_due_schedules` de lá devolve
 * precisão de segundos sem depender de plano de Vercel nenhum, e deixa este
 * handler como o que ele já é: uma rede de segurança diária.
 *
 * Sem o cron, o worker sozinho não publica nada — está documentado no README.
 */
export const maxDuration = 60;

export async function GET(requisicao: Request) {
  if (!cronAutorizado(requisicao)) {
    return NextResponse.json(
      { erro: "não autorizado" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const inicio = Date.now();
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("mark_due_schedules", { p_max: 200 });

  if (error) {
    console.error("[cron/publicar] mark_due_schedules falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return NextResponse.json(
      { erro: "falha ao marcar os agendamentos" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const marcados = typeof data === "number" ? data : 0;
  if (marcados > 0) {
    console.log(
      JSON.stringify({
        escopo: "cron/publicar",
        etapa: "marcar",
        resultado: "ok",
        marcados,
        ms: Date.now() - inicio,
      }),
    );
  }

  return NextResponse.json(
    { marcados, ms: Date.now() - inicio },
    { headers: { "Cache-Control": "no-store" } },
  );
}
