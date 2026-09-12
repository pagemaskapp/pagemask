import type { Metadata } from "next";
import Link from "next/link";
import { LayoutTemplateIcon } from "lucide-react";

import { NovoTemplate } from "@/app/app/templates/novo-template";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { exigirUsuario } from "@/lib/auth/sessao";
import { dataCurta, numero } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { lerConfig } from "@/lib/template/esquema";

export const metadata: Metadata = { title: "Templates" };

export default async function Templates() {
  await exigirUsuario("/app/templates");
  const supabase = await createClient();

  const { data: templates, error } = await supabase
    .from("templates")
    .select("id, name, version, config, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[templates] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
  }

  const lista = templates ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Templates
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            O padrão visual aplicado ao lote: cabeçalho, frase, tipografia e
            enquadramento. Um template pode ser usado em quantos projetos você
            quiser.
          </p>
        </div>

        <NovoTemplate />
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Não conseguimos carregar seus templates agora. Recarregue a página em
            alguns instantes.
          </AlertDescription>
        </Alert>
      ) : lista.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <LayoutTemplateIcon className="text-muted-foreground size-7" />
            <p className="text-muted-foreground max-w-sm text-sm">
              Você ainda não tem templates. Enquanto não houver nenhum aplicado, o
              lote sai com o modelo padrão do PageMask.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul aria-label="Seus templates" className="space-y-2">
          {lista.map((template) => {
            // O `config` é lido aqui só para avisar. Um template que não passa
            // no esquema ainda aparece na lista — escondê-lo deixaria o usuário
            // sem nenhum caminho para consertá-lo.
            const valido = lerConfig(template.config) !== null;

            return (
              <li key={template.id}>
                <Link
                  href={`/app/templates/${template.id}`}
                  className="bg-card hover:bg-accent/40 flex items-center gap-4 rounded-lg border px-4 py-3 transition-colors"
                >
                  <LayoutTemplateIcon className="text-muted-foreground size-5 shrink-0" />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{template.name}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      versão {numero.format(template.version)} · alterado em{" "}
                      {dataCurta.format(new Date(template.updated_at))}
                    </p>
                  </div>

                  {valido ? null : (
                    <span className="bg-destructive/10 text-destructive rounded-full px-2 py-0.5 text-xs font-medium">
                      precisa de ajuste
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
