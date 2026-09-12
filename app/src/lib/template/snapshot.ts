import "server-only";

import {
  ConfigDoTemplate,
  configPadrao,
  lerConfig,
} from "@/lib/template/esquema";
import { createClient } from "@/lib/supabase/server";

/**
 * O template que o lote leva quando é enfileirado.
 *
 * `jobs.template_snapshot` é **cópia congelada**, e isso não mudou com a Fase
 * 6 — mudou só de onde a cópia vem. Antes era uma constante no código; agora é
 * o `config` do template escolhido no projeto. Editar o template no meio de um
 * lote continua não mexendo nos vídeos que já estão na fila, porque quem
 * renderiza é o snapshot gravado por `enqueue_project`, nunca o template
 * "atual".
 *
 * PROJETO SEM TEMPLATE CONTINUA FUNCIONANDO, e de propósito: `template_id` é
 * nulo em todo projeto criado antes desta fase, e obrigar a escolher um
 * template para poder processar transformaria "clique em Processar" em duas
 * telas. Sem escolha, vale o padrão.
 *
 * TEMPLATE INVÁLIDO NÃO VIRA PADRÃO EM SILÊNCIO. Um `config` que não passa no
 * `zod` — gravado antes de uma mudança de formato, ou editado por fora — faz o
 * enfileiramento PARAR e dizer isso. Cair no padrão aqui renderizaria o lote
 * inteiro com um visual que o usuário não escolheu, e ele só descobriria
 * depois de baixar os arquivos.
 */

export type TemplateDoProjeto = {
  config: ConfigDoTemplate;
  /** `null` quando o projeto não tem template e o padrão está valendo. */
  template: { id: string; name: string; version: number } | null;
};

export class TemplateInvalidoError extends Error {
  constructor(public readonly nome: string) {
    super(`Template "${nome}" com config fora do formato.`);
    this.name = "TemplateInvalidoError";
  }
}

export async function templateDoProjeto(
  projectId: string,
): Promise<TemplateDoProjeto> {
  const supabase = await createClient();

  // A RLS de `projects` e a de `templates` já limitam as duas pontas ao dono:
  // o projeto de outra pessoa não volta, e o template dela também não.
  const { data, error } = await supabase
    .from("projects")
    .select("template_id, templates(id, name, version, config)")
    .eq("id", projectId)
    .maybeSingle();

  if (error) throw error;

  const template = data?.templates;
  if (!template) return { config: configPadrao(), template: null };

  const config = lerConfig(template.config);
  if (!config) throw new TemplateInvalidoError(template.name);

  return {
    config,
    template: { id: template.id, name: template.name, version: template.version },
  };
}
