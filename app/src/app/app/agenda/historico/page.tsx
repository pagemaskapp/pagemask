import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";

import { TentarDeNovo } from "@/app/app/agenda/historico/tentar-de-novo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { dataHoraCurta } from "@/lib/agenda/fuso";
import { ESTADOS_DA_AGENDA } from "@/lib/agenda/mensagens";
import { exigirUsuario } from "@/lib/auth/sessao";
import { createClient } from "@/lib/supabase/server";
import type { ScheduleStatus } from "@/lib/supabase/database.types";

export const metadata: Metadata = { title: "Histórico de publicações" };

const GRUPOS: { status: ScheduleStatus[]; titulo: string; vazio: string }[] = [
  {
    status: ["publishing"],
    titulo: "Publicando agora",
    vazio: "",
  },
  {
    status: ["failed"],
    titulo: "Com falha",
    vazio: "Nenhuma publicação falhou.",
  },
  {
    status: ["deferred"],
    titulo: "Adiadas",
    vazio: "Nenhuma publicação adiada.",
  },
  {
    status: ["published"],
    titulo: "Publicadas",
    vazio: "Nada publicado ainda.",
  },
];

/**
 * `/app/agenda/historico` — publicados (com link), adiados e com falha
 * (com "Tentar de novo"). O que está `scheduled` mora no calendário.
 */
export default async function Historico() {
  const usuario = await exigirUsuario("/app/agenda/historico");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("schedules")
    .select(
      "id, scheduled_at, published_at, status, error, ig_permalink, attempts, jobs!inner(filename, user_id), ig_accounts(username)",
    )
    .eq("jobs.user_id", usuario.id)
    .in("status", ["publishing", "failed", "deferred", "published"])
    .order("scheduled_at", { ascending: false })
    .limit(300);

  if (error) {
    console.error("[historico] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
  }

  const linhas = data ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/app/agenda"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeftIcon className="size-4" />
        Agenda
      </Link>

      <h1 className="font-heading text-2xl font-semibold tracking-tight">Histórico</h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        O que já foi publicado, o que foi adiado e o que falhou. Horários em São Paulo.
      </p>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Não conseguimos carregar o histórico agora. Recarregue a página em
            alguns instantes.
          </AlertDescription>
        </Alert>
      ) : null}

      {!error
        ? GRUPOS.map((grupo) => {
            const itens = linhas.filter((l) => grupo.status.includes(l.status));
            if (itens.length === 0 && grupo.vazio === "") return null;
            return (
              <section key={grupo.titulo} className="mb-8">
                <h2 className="font-heading mb-3 text-lg font-semibold">{grupo.titulo}</h2>
                {itens.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{grupo.vazio}</p>
                ) : (
                  <ul className="space-y-2">
                    {itens.map((item) => {
                      const estado = ESTADOS_DA_AGENDA[item.status];
                      return (
                        <li key={item.id}>
                          <Card>
                            <CardContent className="flex flex-wrap items-center gap-3 py-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-sm font-medium">
                                    {item.jobs?.filename ?? "vídeo"}
                                  </span>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${estado.classe}`}
                                  >
                                    {estado.rotulo}
                                  </span>
                                </div>
                                <p className="text-muted-foreground mt-1 text-xs">
                                  @{item.ig_accounts?.username ?? "—"} ·{" "}
                                  {item.status === "published" && item.published_at
                                    ? `publicado em ${dataHoraCurta.format(new Date(item.published_at))}`
                                    : `marcado para ${dataHoraCurta.format(new Date(item.scheduled_at))}`}
                                  {item.attempts > 1 ? ` · ${item.attempts} tentativas` : ""}
                                </p>
                                {item.error ? (
                                  <p
                                    className={`mt-1.5 text-xs ${
                                      item.status === "failed" ? "text-destructive" : "text-muted-foreground"
                                    }`}
                                  >
                                    {item.error}
                                  </p>
                                ) : null}
                              </div>

                              {item.ig_permalink ? (
                                <Button asChild variant="outline" size="sm">
                                  <a href={item.ig_permalink} target="_blank" rel="noopener noreferrer">
                                    <ExternalLinkIcon />
                                    Ver no Instagram
                                  </a>
                                </Button>
                              ) : null}

                              {item.status === "failed" ? <TentarDeNovo agendamento={item.id} /> : null}
                            </CardContent>
                          </Card>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        : null}
    </div>
  );
}
