import { NextResponse } from "next/server";

import { cronAutorizado } from "@/lib/cron/autorizacao";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `GET /api/cron/publicar` — a cada minuto (Vercel Cron, `app/vercel.json`).
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
 * Vercel Cron por minuto é recurso do plano Pro; no Hobby o menor intervalo é
 * diário. Sem o cron, o worker sozinho não publica nada — está documentado no
 * README.
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
