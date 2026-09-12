"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import type { EstadoFormulario } from "@/lib/auth/formulario";
import { exigirUsuario } from "@/lib/auth/sessao";
import { codigoDoErro, mensagemDoCodigo } from "@/lib/plano/erros";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ConfigDoTemplate, configPadrao, primeiroErro } from "@/lib/template/esquema";
import { headerConferido } from "@/lib/template/header";

/**
 * As ações do editor de template.
 *
 * `save_template` vai pelo cliente ADMIN, pela regra da migration 0008: o dono
 * chega por `p_user_id` decidido aqui, a partir da sessão. Exposta ao
 * PostgREST, ela aceitaria o `p_user_id` que o chamador escrevesse — e
 * escreveria template na conta de outra pessoa.
 *
 * Apagar e escolher o template de um projeto vão pelo cliente do USUÁRIO: são
 * operações de uma tabela só, sem passo de servidor depois, e a RLS de
 * `templates` e `projects` (0001) já decide tudo que há para decidir. A de
 * `projects` inclusive confere que o `template_id` novo é de um template do
 * próprio dono, que é o que impede apontar um projeto para o visual de outro.
 *
 * SOBRE A VALIDAÇÃO: a `config` chega como argumento de uma server action, e
 * argumento de server action é entrada tão não confiável quanto corpo de POST
 * — a função é uma rota HTTP com outro nome. Por isso ela passa pelo mesmo
 * `zod` da rota de prévia antes de chegar ao banco.
 */

const id = z.uuid();

const nome = z
  .string()
  .trim()
  .min(1, "Dê um nome ao template.")
  .max(60, "O nome do template pode ter até 60 caracteres.");

export type EstadoDoTemplate = EstadoFormulario & {
  /** A versão que o banco gravou, para a tela mostrar sem recarregar. */
  versao?: number;
};

export async function criarTemplate(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario("/app/templates");

  const analisado = nome.safeParse(formData.get("nome"));
  if (!analisado.success) {
    return {
      erro: analisado.error.issues[0]?.message ?? "Nome inválido.",
      nome: String(formData.get("nome") ?? ""),
    };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("save_template", {
    p_user_id: usuario.id,
    p_id: null,
    p_name: analisado.data,
    p_config: configPadrao(),
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem, nome: analisado.data };

    console.error("[templates] save_template falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return {
      erro: "Não conseguimos criar o template agora. Tente de novo.",
      nome: analisado.data,
    };
  }

  revalidatePath("/app/templates");
  // Fora do `try`: `redirect()` funciona lançando.
  redirect(`/app/templates/${data.id}`);
}

export async function salvarTemplate(pedido: {
  id: string;
  nome: string;
  config: unknown;
}): Promise<EstadoDoTemplate> {
  const usuario = await exigirUsuario("/app/templates");

  const template = id.safeParse(pedido.id);
  if (!template.success) return { erro: "Template inválido." };

  const nomeOk = nome.safeParse(pedido.nome);
  if (!nomeOk.success) {
    return { erro: nomeOk.error.issues[0]?.message ?? "Nome inválido." };
  }

  const config = ConfigDoTemplate.safeParse(pedido.config);
  if (!config.success) return { erro: primeiroErro(config.error) };

  // A imagem de cabeçalho do R2 precisa ser uma que passou pela leitura de
  // bytes. O `zod` confere a forma da chave; quem confere o CONTEÚDO é a linha
  // em `assets`, que desde a 0020 só existe se `/header/confirmar` a criou.
  const header = await headerConferido(config.data, usuario.id);
  if (!header.ok) return { erro: header.motivo };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("save_template", {
    p_user_id: usuario.id,
    p_id: template.data,
    p_name: nomeOk.data,
    p_config: config.data,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem };

    console.error("[templates] save_template falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos salvar o template agora. Tente de novo." };
  }

  revalidatePath("/app/templates");
  revalidatePath(`/app/templates/${template.data}`);

  return {
    aviso: `Template salvo (versão ${data.version}).`,
    versao: data.version,
  };
}

export async function apagarTemplate(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  await exigirUsuario("/app/templates");

  const template = id.safeParse(formData.get("template"));
  if (!template.success) return { erro: "Template inválido." };

  const supabase = await createClient();
  const { error } = await supabase.from("templates").delete().eq("id", template.data);

  if (error) {
    console.error("[templates] delete falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos apagar o template agora. Tente de novo." };
  }

  // Projeto que usava este template volta ao padrão sozinho: a chave
  // estrangeira é `on delete set null` (0001). É o comportamento certo — o
  // contrário seria impedir de apagar um template por causa de um projeto
  // antigo, ou apagar o projeto junto.
  revalidatePath("/app/templates");
  revalidatePath("/app/projetos");
  redirect("/app/templates");
}

/**
 * "Aplicar ao projeto inteiro" — o projeto passa a usar este template.
 *
 * Ela grava a ESCOLHA, não o desenho: o desenho só vira `template_snapshot` na
 * hora de processar. A diferença aparece quando o usuário edita o template
 * depois — o projeto acompanha a edição até o clique em Processar, e a partir
 * dali o lote fica congelado no que estava valendo.
 */
export async function aplicarTemplate(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  await exigirUsuario();

  const projeto = id.safeParse(formData.get("projeto"));
  if (!projeto.success) return { erro: "Projeto inválido." };

  const bruto = formData.get("template");
  const escolhido = bruto === "" || bruto === null ? null : id.safeParse(bruto);
  if (escolhido !== null && !escolhido.success) {
    return { erro: "Template inválido." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .update({ template_id: escolhido === null ? null : escolhido.data })
    .eq("id", projeto.data)
    .select("id, templates(name)")
    .maybeSingle();

  if (error) {
    // AS DUAS METADES DA RLS DÃO RESPOSTAS DIFERENTES, e é preciso tratar as
    // duas. O `using` esconde a linha: o UPDATE não acha nada e volta sem erro
    // (o `!data` abaixo). O `with check` REJEITA: o Postgres levanta "new row
    // violates row-level security policy", que chega aqui como `42501` — e é
    // esse o caminho de quem aponta o projeto para o template de outra pessoa.
    // Tratá-lo como falha genérica daria "tente de novo" para quem tentaria
    // para sempre.
    if (error.code === "42501") {
      return { erro: "Não encontramos esse item na sua conta." };
    }

    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem };

    console.error("[templates] update do projeto falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos aplicar o template agora. Tente de novo." };
  }

  // Sem linha de volta e sem erro: o `using` escondeu o projeto, ou seja, ele
  // não é do usuário. Mesma frase do caso acima de propósito — dizer qual dos
  // dois foi contaria o que existe na conta de outra pessoa.
  if (!data) return { erro: "Não encontramos esse item na sua conta." };

  revalidatePath(`/app/projetos/${projeto.data}`);

  return {
    aviso: data.templates
      ? `O projeto passou a usar o template “${data.templates.name}”.`
      : "O projeto voltou a usar o template padrão.",
  };
}
