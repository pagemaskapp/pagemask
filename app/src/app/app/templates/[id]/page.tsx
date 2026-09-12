import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { ApagarTemplate } from "@/app/app/templates/[id]/apagar-template";
import { Editor, type Amostra, type HeaderDisponivel } from "@/app/app/templates/[id]/editor";
import { exigirUsuario } from "@/lib/auth/sessao";
import { assinarImagem, VALIDADE_DE_IMAGEM_S } from "@/lib/r2/assinatura";
import { chaveDeAssetDoUsuario } from "@/lib/r2/chaves";
import { createClient } from "@/lib/supabase/server";
import { configPadrao, lerConfig } from "@/lib/template/esquema";

export const metadata: Metadata = { title: "Editar template" };

/**
 * O editor de template.
 *
 * O servidor traz três coisas que o cliente não teria como montar sozinho:
 *
 *   · o `config` gravado, já conferido contra o esquema;
 *   · as AMOSTRAS — os vídeos que podem servir de base para a prévia, com o
 *     nome do projeto de cada um. A prévia roda sobre um vídeo de verdade, e
 *     não sobre um quadro genérico, porque metade do que o template faz
 *     depende do vídeo: onde está o cabeçalho antigo, onde começa a faixa de
 *     vídeo, qual a cor de fundo;
 *   · as imagens de cabeçalho já enviadas, cada uma com uma URL assinada de
 *     15 minutos. Assinar aqui, no servidor, evita uma rota só para isso.
 */
export default async function EditarTemplate({
  params,
}: PageProps<"/app/templates/[id]">) {
  const { id } = await params;
  const usuario = await exigirUsuario(`/app/templates/${id}`);
  const supabase = await createClient();

  const { data: template, error } = await supabase
    .from("templates")
    .select("id, name, version, config")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[template] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
  }

  // Mesma resposta para "não existe" e "é de outra pessoa", como no projeto:
  // um 403 contaria que aquele id existe e é de alguém.
  if (!template) notFound();

  const [{ data: videos }, { data: assets }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, filename, project_id, projects(name)")
      // `rejected` fica de fora: o objeto de entrada dele foi apagado na recusa
      // (Fase 2), então não há o que renderizar.
      .neq("status", "rejected")
      .order("queued_at", { ascending: false })
      .limit(60),
    supabase
      .from("assets")
      .select("id, r2_key, mime, created_at")
      .eq("kind", "header")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const amostras: Amostra[] = [];
  for (const video of videos ?? []) {
    const projeto = video.projects;
    if (!projeto) continue;

    let grupo = amostras.find((a) => a.projetoId === video.project_id);
    if (!grupo) {
      grupo = { projetoId: video.project_id, projetoNome: projeto.name, videos: [] };
      amostras.push(grupo);
    }
    grupo.videos.push({ id: video.id, nome: video.filename ?? "vídeo sem nome" });
  }

  // A forma da chave é conferida antes de assinar, mesmo vindo do banco: uma
  // linha de `assets` gravada por outro caminho (ou por uma versão anterior
  // deste código, quando o cliente ainda tinha INSERT — ver a 0020) não pode
  // virar URL assinada para um objeto que o servidor nunca escolheu.
  const headers: HeaderDisponivel[] = await Promise.all(
    (assets ?? [])
      .filter((asset) => chaveDeAssetDoUsuario(asset.r2_key, usuario.id))
      .map(async (asset) => ({
        chave: asset.r2_key,
        url: await assinarImagem({
          chave: asset.r2_key,
          tipo: asset.mime === "image/jpeg" ? "image/jpeg" : "image/png",
          validadeS: VALIDADE_DE_IMAGEM_S,
        }),
      })),
  );

  // Um `config` que não passa no esquema abre no padrão, e a tela avisa. Abrir
  // vazio, ou não abrir, deixaria o usuário sem caminho para consertar.
  const config = lerConfig(template.config);

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        href="/app/templates"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeftIcon className="size-4" />
        Templates
      </Link>

      <Editor
        template={{ id: template.id, nome: template.name, versao: template.version }}
        configInicial={config ?? configPadrao()}
        configIlegivel={config === null}
        amostras={amostras}
        headers={headers}
        acoes={<ApagarTemplate template={template.id} nome={template.name} />}
      />
    </div>
  );
}
