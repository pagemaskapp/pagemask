import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import type { Plan } from "@/lib/supabase/database.types";

/**
 * Quanto o plano do usuário permite e quanto ele já usou.
 *
 * **O limite sai da tabela `plans`, nunca de constante no código** (CLAUDE.md,
 * "Convenções"). Vale repetir por quê: mudar preço e limite de plano é operação
 * de produto, feita numa migration de seed, e não pode exigir deploy do app.
 *
 * `cache()` do React memoiza por requisição — a página de projetos pergunta
 * isso no cabeçalho e a de upload pergunta de novo, e são a mesma resposta.
 */
export type LimitesDoUsuario = {
  plano: Plan;
  videosUsados: number;
  projetosUsados: number;
  /** Tamanho máximo de um arquivo, já em bytes. */
  bytesPorArquivo: number;
};

export const limitesDoUsuario = cache(
  async (userId: string): Promise<LimitesDoUsuario> => {
    const supabase = await createClient();

    // `plan_slug` mora em `profiles` e a RLS já limita a linha ao dono; o
    // `join` traz o catálogo, que é leitura pública.
    const [perfil, assinatura, projetos] = await Promise.all([
      supabase
        .from("profiles")
        .select("plan_slug, plans(*)")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("subscriptions")
        .select("videos_used")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("projects")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
    ]);

    if (perfil.error) throw perfil.error;
    const plano = perfil.data?.plans as Plan | null | undefined;
    if (!plano) {
      // Sem plano não dá para decidir nada, e inventar um padrão aqui seria
      // dar limite de graça a quem o banco não sabe classificar.
      throw new Error(`Perfil sem plano correspondente em \`plans\` (${userId}).`);
    }

    // Assinatura ainda não existe para quem nunca enviou vídeo: a linha nasce
    // na primeira confirmação de upload (`register_upload_job`). Ausente e
    // zerada são a mesma coisa aqui.
    if (assinatura.error) throw assinatura.error;
    if (projetos.error) throw projetos.error;

    return {
      plano,
      videosUsados: assinatura.data?.videos_used ?? 0,
      projetosUsados: projetos.count ?? 0,
      bytesPorArquivo: plano.max_mb * 1024 * 1024,
    };
  },
);
