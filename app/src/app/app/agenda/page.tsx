import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClockIcon, ChevronLeftIcon, ChevronRightIcon, HistoryIcon } from "lucide-react";

import { AgendarVideo } from "@/app/app/agenda/agendar-video";
import { Calendario, type DiaDaGrade, type ItemDaAgenda } from "@/app/app/agenda/calendario";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  chaveDoDia,
  dois,
  horaLocal,
  lerChaveDoDia,
  NOMES_DOS_MESES,
  paraUtc,
  partesLocais,
  somarDias,
} from "@/lib/agenda/fuso";
import { exigirUsuario } from "@/lib/auth/sessao";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Agenda" };

/**
 * `/app/agenda` — o calendário. Mês ou semana, com arrastar para reagendar.
 *
 * TUDO EM `America/Sao_Paulo`, E SÓ AQUI
 * ======================================
 *
 * A grade de dias e a chave de cada item (`YYYY-MM-DD`) são calculadas no
 * servidor, no fuso da tela, e passadas prontas ao cliente. O calendário no
 * navegador nunca chama `new Date()` para decidir em que dia algo cai — o
 * relógio de quem acessa pode estar em outro fuso, e aí um agendamento das
 * 23h apareceria no dia seguinte no HTML e no dia certo depois da hidratação.
 *
 * A CONSULTA LISTA COLUNAS, INCLUSIVE NO EMBED
 * ============================================
 *
 * `ig_accounts(username)` e não `ig_accounts(*)`: o papel `authenticated` só
 * tem SELECT em algumas colunas dessa tabela (GRANT por coluna, 0001), e um
 * `*` no embed dá "permission denied" na consulta inteira — a agenda viria
 * vazia, sem erro na tela.
 */
export default async function Agenda({ searchParams }: PageProps<"/app/agenda">) {
  const usuario = await exigirUsuario("/app/agenda");
  const params = await searchParams;

  const visao = params.visao === "semana" ? "semana" : "mes";
  const hoje = chaveDoDia(new Date());
  const ancora =
    typeof params.data === "string" && lerChaveDoDia(params.data) ? params.data : hoje;
  const partes = lerChaveDoDia(ancora)!;

  // --- a grade ------------------------------------------------------------
  let inicio: string;
  let quantos: number;
  let titulo: string;

  if (visao === "mes") {
    const primeiro = `${partes.ano}-${dois(partes.mes)}-01`;
    const dow = partesLocais(paraUtc(partes.ano, partes.mes, 1, 12, 0)).diaDaSemana;
    inicio = somarDias(primeiro, -dow);
    quantos = 42;
    titulo = `${NOMES_DOS_MESES[partes.mes - 1]} de ${partes.ano}`;
  } else {
    const dow = partesLocais(paraUtc(partes.ano, partes.mes, partes.dia, 12, 0)).diaDaSemana;
    inicio = somarDias(ancora, -dow);
    quantos = 7;
    const fim = lerChaveDoDia(somarDias(inicio, 6))!;
    const ini = lerChaveDoDia(inicio)!;
    titulo =
      ini.mes === fim.mes
        ? `${ini.dia} a ${fim.dia} de ${NOMES_DOS_MESES[ini.mes - 1]} de ${ini.ano}`
        : `${ini.dia} de ${NOMES_DOS_MESES[ini.mes - 1]} a ${fim.dia} de ${NOMES_DOS_MESES[fim.mes - 1]} de ${fim.ano}`;
  }

  const dias: DiaDaGrade[] = [];
  for (let i = 0; i < quantos; i += 1) {
    const chave = somarDias(inicio, i);
    const p = lerChaveDoDia(chave)!;
    dias.push({
      chave,
      numero: p.dia,
      doMes: visao === "semana" || p.mes === partes.mes,
      passado: chave < hoje,
    });
  }

  const ini = lerChaveDoDia(inicio)!;
  const fimChave = lerChaveDoDia(somarDias(inicio, quantos))!;
  const inicioUtc = paraUtc(ini.ano, ini.mes, ini.dia, 0, 0);
  const fimUtc = paraUtc(fimChave.ano, fimChave.mes, fimChave.dia, 0, 0);

  // --- os dados -------------------------------------------------------------
  const supabase = await createClient();
  const [agenda, contas, videos] = await Promise.all([
    supabase
      .from("schedules")
      // `jobs!inner` + `jobs.user_id`: o dono explícito na consulta, e não só
      // na RLS. A RLS continua sendo quem garante; o filtro é o que deixa o
      // planejador usar o índice em vez de avaliar a política linha a linha
      // sobre os agendamentos de todo mundo.
      .select(
        "id, job_id, ig_account_id, scheduled_at, caption, status, error, ig_permalink, attempts, jobs!inner(filename, user_id), ig_accounts(username)",
      )
      .eq("jobs.user_id", usuario.id)
      .gte("scheduled_at", inicioUtc.toISOString())
      .lt("scheduled_at", fimUtc.toISOString())
      .order("scheduled_at"),
    supabase
      .from("ig_accounts")
      .select("id, username, status")
      .eq("user_id", usuario.id)
      .eq("status", "active")
      .order("connected_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, filename, finished_at, projects(name)")
      .eq("user_id", usuario.id)
      .eq("status", "done")
      .not("r2_output_key", "is", null)
      .order("finished_at", { ascending: false })
      .limit(200),
  ]);

  for (const [origem, erro] of [
    ["schedules", agenda.error],
    ["ig_accounts", contas.error],
    ["jobs", videos.error],
  ] as const) {
    if (erro) {
      console.error("[agenda] consulta falhou", {
        origem,
        codigo: erro.code,
        mensagem: erro.message,
      });
    }
  }

  const itens: ItemDaAgenda[] = (agenda.data ?? []).map((linha) => {
    const quando = new Date(linha.scheduled_at);
    return {
      id: linha.id,
      dia: chaveDoDia(quando),
      hora: horaLocal(quando),
      quandoIso: linha.scheduled_at,
      video: linha.jobs?.filename ?? "vídeo",
      username: linha.ig_accounts?.username ?? "",
      status: linha.status,
      erro: linha.error,
      permalink: linha.ig_permalink,
      legenda: linha.caption,
    };
  });

  const contasAtivas = (contas.data ?? []).map((c) => ({ id: c.id, username: c.username }));
  const videosProntos = (videos.data ?? []).map((v) => ({
    id: v.id,
    nome: v.filename ?? "vídeo sem nome",
    projeto: v.projects?.name ?? "",
  }));

  const linkPara = (v: "mes" | "semana", data: string) =>
    `/app/agenda?visao=${v}&data=${data}`;
  const anterior = visao === "mes" ? mesVizinho(partes, -1) : somarDias(ancora, -7);
  const proximo = visao === "mes" ? mesVizinho(partes, 1) : somarDias(ancora, 7);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Agenda</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Horários em São Paulo. Arraste um agendamento para outro dia para
            reagendar; clique para ver detalhes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/app/agenda/historico">
              <HistoryIcon />
              Histórico
            </Link>
          </Button>
          <AgendarVideo contas={contasAtivas} videos={videosProntos} hoje={hoje} />
        </div>
      </div>

      {agenda.error ? (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertDescription>
            Não conseguimos carregar a agenda agora. Recarregue a página em
            alguns instantes.
          </AlertDescription>
        </Alert>
      ) : null}

      {!contas.error && contasAtivas.length === 0 ? (
        <Alert className="mb-4">
          <CalendarClockIcon />
          <AlertDescription>
            Nenhuma conta ativa do Instagram. Conecte uma em{" "}
            <Link href="/app/conectores" className="underline underline-offset-4">
              Conectores
            </Link>{" "}
            para agendar.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Anterior">
            <Link href={linkPara(visao, anterior)}>
              <ChevronLeftIcon />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="icon-sm" aria-label="Próximo">
            <Link href={linkPara(visao, proximo)}>
              <ChevronRightIcon />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={linkPara(visao, hoje)}>Hoje</Link>
          </Button>
          <h2 className="font-heading ml-2 text-lg font-semibold capitalize">{titulo}</h2>
        </div>

        <nav aria-label="Visão" className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1 text-sm">
          {(
            [
              ["mes", "Mês"],
              ["semana", "Semana"],
            ] as const
          ).map(([valor, rotulo]) => (
            <Link
              key={valor}
              href={linkPara(valor, ancora)}
              aria-current={visao === valor ? "page" : undefined}
              className={`rounded-md px-3 py-1 text-center font-medium transition-colors ${
                visao === valor
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {rotulo}
            </Link>
          ))}
        </nav>
      </div>

      {!agenda.error ? (
        <Calendario visao={visao} dias={dias} itens={itens} hoje={hoje} />
      ) : null}

      {!agenda.error && itens.length === 0 ? (
        <Card className="mt-4 border-dashed">
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            Nada agendado neste período. Clique em <strong>Agendar vídeo</strong>{" "}
            para marcar a primeira publicação.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function mesVizinho(p: { ano: number; mes: number }, delta: number): string {
  const d = new Date(Date.UTC(p.ano, p.mes - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}-01`;
}
