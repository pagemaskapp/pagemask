import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { ApagarProjeto } from "@/app/app/projetos/[id]/apagar-projeto";
import { EnviarVideos } from "@/app/app/projetos/[id]/enviar-videos";
import { ListaDeVideos, type VideoNaTela } from "@/app/app/projetos/[id]/lista-de-videos";
import { ProcessarLote } from "@/app/app/projetos/[id]/processar-lote";
import { TemplateDoProjeto } from "@/app/app/projetos/[id]/template-do-projeto";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { exigirUsuario } from "@/lib/auth/sessao";
import { bytesEmTexto, duracaoEmTexto, numero } from "@/lib/formato";
import { limitesDoUsuario } from "@/lib/plano/limites";
import { createClient } from "@/lib/supabase/server";
import { lerProbe } from "@/lib/video/probe-salvo";

export const metadata: Metadata = { title: "Projeto" };

export default async function Projeto({ params }: PageProps<"/app/projetos/[id]">) {
  const { id } = await params;
  const usuario = await exigirUsuario(`/app/projetos/${id}`);
  const supabase = await createClient();

  const [{ data: projeto, error: erroProjeto }, limites, { data: templates }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id, name, template_id")
        .eq("id", id)
        .eq("user_id", usuario.id)
        .maybeSingle(),
      limitesDoUsuario(usuario.id),
      // A RLS de `templates` já limita ao dono; a lista alimenta o seletor.
      supabase.from("templates").select("id, name").order("name"),
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
    .select(
      "id, status, progress, filename, bytes_in, probe, error, queued_at, r2_output_key",
    )
    .eq("project_id", projeto.id)
    .order("queued_at", { ascending: false });

  if (erroVideos) {
    console.error("[projeto] consulta dos videos falhou", {
      codigo: erroVideos.code,
      mensagem: erroVideos.message,
    });
  }

  const vagas = Math.max(limites.plano.videos_month - limites.videosUsados, 0);

  // O `probe` é lido e formatado AQUI, no servidor. A lista ao vivo recebe
  // texto pronto: `probe` é um jsonb que não muda depois do upload, e mandá-lo
  // inteiro para o navegador — em toda recarga, para cada vídeo — seria pagar
  // banda por um dado que a tela usa em duas linhas de texto.
  const naTela: VideoNaTela[] = (videos ?? []).map((video) => {
    const probe = lerProbe(video.probe);
    const dimensao =
      probe?.largura && probe?.altura ? ` · ${probe.largura}×${probe.altura}` : "";

    return {
      id: video.id,
      nome: video.filename ?? "vídeo sem nome",
      status: video.status,
      progresso: video.progress ?? 0,
      erro: video.error,
      temSaida: Boolean(video.r2_output_key),
      tamanho: bytesEmTexto(video.bytes_in ?? 0),
      detalhe: ` · ${duracaoEmTexto(probe?.duracaoSegundos)}${dimensao}`,
    };
  });

  const porProcessar = naTela.filter((v) => v.status === "uploaded").length;

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
            {numero.format(naTela.length)} {naTela.length === 1 ? "vídeo" : "vídeos"} ·{" "}
            {numero.format(vagas)} de {numero.format(limites.plano.videos_month)}{" "}
            restantes na cota do plano {limites.plano.name}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <ProcessarLote projeto={projeto.id} quantos={porProcessar} />
          <ApagarProjeto projeto={projeto.id} nome={projeto.name} />
        </div>
      </div>

      <TemplateDoProjeto
        projeto={projeto.id}
        atual={projeto.template_id}
        templates={templates ?? []}
      />

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
      ) : (
        <ListaDeVideos projeto={projeto.id} videos={naTela} />
      )}
    </div>
  );
}
