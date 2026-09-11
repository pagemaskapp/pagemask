import type { Metadata } from "next";
import Link from "next/link";
import { FolderIcon, VideoIcon } from "lucide-react";

import { NovoProjeto } from "@/app/app/projetos/novo-projeto";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { exigirUsuario } from "@/lib/auth/sessao";
import { dataCurta, numero } from "@/lib/formato";
import { limitesDoUsuario } from "@/lib/plano/limites";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Projetos" };

export default async function Projetos() {
  const usuario = await exigirUsuario("/app/projetos");
  const supabase = await createClient();

  const limites = await limitesDoUsuario(usuario.id);

  // `jobs(count)` vem pela relação: um `select` só em vez de um por projeto.
  // A RLS de `jobs` filtra pelo dono, então a contagem já é a dele.
  const { data: projetos, error } = await supabase
    .from("projects")
    .select("id, name, created_at, jobs(count)")
    .eq("user_id", usuario.id)
    .order("created_at", { ascending: false });

  if (error) {
    // Mesma lição da tela de Conta: erro de consulta engolido aqui vira uma
    // lista vazia perfeitamente plausível, e foi assim que a falta de uma
    // migration de privilégios passou despercebida por dias.
    console.error("[projetos] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
  }

  const cabeMaisUm = limites.projetosUsados < limites.plano.projects;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Projetos
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {limites.projetosUsados} de {limites.plano.projects} projetos do plano{" "}
            {limites.plano.name} · {numero.format(limites.videosUsados)} de{" "}
            {numero.format(limites.plano.videos_month)} vídeos usados no período
          </p>
        </div>

        <NovoProjeto cabe={cabeMaisUm} />
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Não conseguimos carregar seus projetos agora. Recarregue a página em
            alguns instantes.
          </AlertDescription>
        </Alert>
      ) : null}

      {!error && (!projetos || projetos.length === 0) ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FolderIcon className="text-muted-foreground size-8" />
            <div>
              <p className="font-medium">Nenhum projeto ainda</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Crie o primeiro projeto para começar a enviar vídeos.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(projetos ?? []).map((projeto) => {
          // O PostgREST devolve a contagem como uma lista de um item só.
          const quantos = projeto.jobs?.[0]?.count ?? 0;

          return (
            <Link
              key={projeto.id}
              href={`/app/projetos/${projeto.id}`}
              className="focus-visible:ring-ring rounded-xl focus-visible:ring-3 focus-visible:outline-none"
            >
              <Card className="hover:border-primary/50 h-full transition-colors">
                <CardHeader>
                  <CardTitle className="truncate">{projeto.name}</CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground flex items-center gap-4 text-sm">
                  <span className="flex items-center gap-1.5">
                    <VideoIcon className="size-4" />
                    {quantos === 1 ? "1 vídeo" : `${numero.format(quantos)} vídeos`}
                  </span>
                  <span>criado em {dataCurta.format(new Date(projeto.created_at))}</span>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
