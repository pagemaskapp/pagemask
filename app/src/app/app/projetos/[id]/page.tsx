import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, FilmIcon } from "lucide-react";

import { AcoesDoVideo } from "@/app/app/projetos/[id]/acoes-do-video";
import { EnviarVideos } from "@/app/app/projetos/[id]/enviar-videos";
import { ApagarProjeto } from "@/app/app/projetos/[id]/apagar-projeto";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { exigirUsuario } from "@/lib/auth/sessao";
import { bytesEmTexto, duracaoEmTexto, numero } from "@/lib/formato";
import { limitesDoUsuario } from "@/lib/plano/limites";
import { createClient } from "@/lib/supabase/server";
import type { JobStatus } from "@/lib/supabase/database.types";
import { lerProbe } from "@/lib/video/probe-salvo";

export const metadata: Metadata = { title: "Projeto" };

/**
 * Como cada estado do job aparece na tela.
 *
 * `uploaded` diz "Enviado", e não "Aguardando", porque nesta fase é o estado
 * final do fluxo: o botão "Processar lote" chega na Fase 3. Prometer aqui uma
 * fila que ainda não existe faria o usuário esperar por algo que nunca começa.
 */
const ESTADOS: Record<JobStatus, { texto: string; classe: string }> = {
  uploaded: { texto: "Enviado", classe: "bg-muted text-muted-foreground" },
  queued: { texto: "Na fila", classe: "bg-muted text-muted-foreground" },
  processing: { texto: "Processando", classe: "bg-primary/15 text-primary" },
  done: { texto: "Pronto", classe: "bg-primary/15 text-primary" },
  failed: { texto: "Falhou", classe: "bg-destructive/10 text-destructive" },
  rejected: { texto: "Recusado", classe: "bg-destructive/10 text-destructive" },
  canceled: { texto: "Cancelado", classe: "bg-muted text-muted-foreground" },
};

export default async function Projeto({ params }: PageProps<"/app/projetos/[id]">) {
  const { id } = await params;
  const usuario = await exigirUsuario(`/app/projetos/${id}`);
  const supabase = await createClient();

  const [{ data: projeto, error: erroProjeto }, limites] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name")
      .eq("id", id)
      .eq("user_id", usuario.id)
      .maybeSingle(),
    limitesDoUsuario(usuario.id),
  ]);

  if (erroProjeto) {
    console.error("[projeto] consulta do projeto falhou", {
      codigo: erroProjeto.code,
      mensagem: erroProjeto.message,
    });
  }

  // `notFound()` tanto para o projeto de outra pessoa quanto para o que não
  // existe: são a mesma resposta de propósito. Um 403 contaria que aquele id
  // existe e é de alguém, que é informação que ninguém de fora precisa ter.
  if (!projeto) notFound();

  const { data: videos, error: erroVideos } = await supabase
    .from("jobs")
    .select("id, status, filename, bytes_in, probe, error, queued_at, r2_output_key")
    .eq("project_id", projeto.id)
    .order("queued_at", { ascending: false });

  if (erroVideos) {
    console.error("[projeto] consulta dos videos falhou", {
      codigo: erroVideos.code,
      mensagem: erroVideos.message,
    });
  }

  const vagas = Math.max(limites.plano.videos_month - limites.videosUsados, 0);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/app/projetos"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeftIcon className="size-4" />
        Projetos
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-heading truncate text-2xl font-semibold tracking-tight">
            {projeto.name}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {numero.format(videos?.length ?? 0)}{" "}
            {videos?.length === 1 ? "vídeo" : "vídeos"} · {numero.format(vagas)} de{" "}
            {numero.format(limites.plano.videos_month)} restantes na cota do plano{" "}
            {limites.plano.name}
          </p>
        </div>

        <ApagarProjeto projeto={projeto.id} nome={projeto.name} />
      </div>

      <EnviarVideos
        projeto={projeto.id}
        bytesPorArquivo={limites.bytesPorArquivo}
        vagas={vagas}
        maxMb={limites.plano.max_mb}
        nomeDoPlano={limites.plano.name}
      />

      {erroVideos ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Não conseguimos carregar os vídeos deste projeto agora. Recarregue a
            página em alguns instantes.
          </AlertDescription>
        </Alert>
      ) : null}

      {!erroVideos && (videos?.length ?? 0) === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <FilmIcon className="text-muted-foreground size-7" />
            <p className="text-muted-foreground text-sm">
              Nenhum vídeo neste projeto ainda.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/*
        Rotulada porque a tela tem duas listas — esta e a fila de envio — e um
        leitor de tela anuncia as duas do mesmo jeito sem o rótulo.
      */}
      <ul aria-label="Vídeos do projeto" className="space-y-2">
        {(videos ?? []).map((video) => {
          const probe = lerProbe(video.probe);
          const estado = ESTADOS[video.status];

          return (
            <li
              key={video.id}
              className="bg-card flex items-center gap-4 rounded-lg border px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {video.filename ?? "vídeo sem nome"}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${estado.classe}`}
                  >
                    {estado.texto}
                  </span>
                </div>

                <p className="text-muted-foreground mt-1 text-xs">
                  {bytesEmTexto(video.bytes_in ?? 0)} ·{" "}
                  {duracaoEmTexto(probe?.duracaoSegundos)}
                  {probe?.largura && probe?.altura
                    ? ` · ${probe.largura}×${probe.altura}`
                    : ""}
                </p>

                {/*
                  O motivo da recusa é a informação mais importante da linha:
                  sem ele o usuário vê "Recusado" e não tem o que fazer a
                  respeito. Vem do servidor, em pt-BR, já pronto para ler.
                */}
                {video.error ? (
                  <p className="text-destructive mt-1.5 text-xs">{video.error}</p>
                ) : null}
              </div>

              <AcoesDoVideo
                video={video.id}
                projeto={projeto.id}
                nome={video.filename ?? "este vídeo"}
                podeBaixar={video.status === "done" && Boolean(video.r2_output_key)}
                devolveCota={video.status === "uploaded"}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
