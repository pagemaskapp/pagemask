"use client";

import { useActionState } from "react";
import Link from "next/link";
import { LayoutTemplateIcon } from "lucide-react";

import { aplicarTemplate } from "@/app/app/templates/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Label } from "@/components/ui/label";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * Qual template este projeto usa.
 *
 * A escolha vale para o PRÓXIMO processamento: o que já foi para a fila leva
 * uma cópia congelada do template (`jobs.template_snapshot`) e não muda mais.
 * A frase abaixo do seletor diz isso — sem ela, trocar o template no meio de um
 * lote pareceria uma ação sem efeito.
 *
 * "Padrão do PageMask" é uma opção de verdade, e não a ausência de escolha: é
 * para onde o projeto volta quando o usuário desiste de um template, e é o que
 * todo projeto criado antes desta fase usa.
 */
export function TemplateDoProjeto({
  projeto,
  atual,
  templates,
}: {
  projeto: string;
  atual: string | null;
  templates: { id: string; name: string }[];
}) {
  const [estado, acao] = useActionState(aplicarTemplate, INICIAL);

  return (
    <div className="bg-card mb-6 rounded-lg border px-4 py-3">
      <CampoMensagem erro={estado.erro} aviso={estado.aviso} />

      <form action={acao} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="projeto" value={projeto} />

        <div className="min-w-0 flex-1">
          <Label htmlFor="template" className="flex items-center gap-1.5">
            <LayoutTemplateIcon className="size-3.5" />
            Template do projeto
          </Label>
          <select
            id="template"
            name="template"
            defaultValue={atual ?? ""}
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 mt-1.5 h-8 w-full max-w-sm rounded-lg border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3"
          >
            <option value="">Padrão do PageMask</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>

        <BotaoEnvio carregando="Aplicando…" variant="outline">
          Aplicar ao projeto
        </BotaoEnvio>
      </form>

      <p className="text-muted-foreground mt-2 text-xs">
        Vale para o próximo processamento. Vídeos que já estão na fila guardam a
        cópia do template usada na hora.{" "}
        <Link href="/app/templates" className="underline underline-offset-2">
          Editar templates
        </Link>
      </p>
    </div>
  );
}
