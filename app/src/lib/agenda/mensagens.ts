import type { ScheduleStatus } from "@/lib/supabase/database.types";

/**
 * O que a tela diz sobre cada estado de agendamento. Sem `"server-only"`: o
 * calendário (cliente) e o histórico (servidor) usam a mesma tabela.
 */
export const ESTADOS_DA_AGENDA: Record<
  ScheduleStatus,
  { rotulo: string; classe: string }
> = {
  scheduled: {
    rotulo: "Agendado",
    classe: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
  publishing: {
    rotulo: "Publicando",
    classe: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  },
  published: {
    rotulo: "Publicado",
    classe: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  },
  deferred: {
    rotulo: "Adiado",
    classe: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  failed: {
    rotulo: "Falhou",
    classe: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  },
};

/** Estados em que o usuário ainda pode mexer (arrastar, editar, cancelar). */
export const EDITAVEIS: ReadonlySet<ScheduleStatus> = new Set<ScheduleStatus>([
  "scheduled",
  "deferred",
]);
