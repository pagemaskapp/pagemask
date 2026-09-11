"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import type { EstadoFormulario } from "@/lib/auth/formulario";
import { exigirUsuario } from "@/lib/auth/sessao";
import { apagarObjetos } from "@/lib/r2/objetos";
import { codigoDoErro, mensagemDoCodigo } from "@/lib/plano/erros";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { templateDoProjeto } from "@/lib/template/padrao";

/**
 * As ações de projeto e de vídeo.
 *
 * Todas passam por uma função `security definer` do banco (migrations 0007 e
 * 0008) em vez de escreverem direto nas tabelas, e isso é a arquitetura da
 * fase, não gosto: limite de plano, cota e devolução de crédito precisam ser
 * conferidos e aplicados **na mesma transação**. Feito na aplicação, entre o
 * `select` que confere e o `insert` que grava cabe o lote inteiro do usuário.
 *
 * O que sobra para cá é o que o banco não alcança: apagar o objeto no R2, que
 * exige credencial que só o servidor tem.
 *
 * Qual cliente usar segue a regra da 0008. `create_project` é chamada com o
 * cliente do USUÁRIO, e a identidade dela é o `auth.uid()` — chamá-la direto
 * pelo PostgREST daria exatamente o mesmo resultado, então expô-la não abre
 * nada. As duas de remoção vão pelo cliente ADMIN, porque depois delas vem um
 * passo que só o servidor consegue fazer: apagar os objetos no R2. Expostas ao
 * cliente, elas apagariam a linha e deixariam o arquivo para trás.
 */

const nome = z
  .string()
  .trim()
  .min(1, "Dê um nome ao projeto.")
  .max(80, "O nome do projeto pode ter até 80 caracteres.");

const id = z.uuid();

export async function criarProjeto(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  await exigirUsuario("/app/projetos");

  const analisado = nome.safeParse(formData.get("nome"));
  if (!analisado.success) {
    return {
      erro: analisado.error.issues[0]?.message ?? "Nome inválido.",
      nome: String(formData.get("nome") ?? ""),
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_project", {
    p_name: analisado.data,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem, nome: analisado.data };

    console.error("[projetos] create_project falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return {
      erro: "Não conseguimos criar o projeto agora. Tente de novo.",
      nome: analisado.data,
    };
  }

  revalidatePath("/app/projetos");
  // Fora do `try`: `redirect()` funciona lançando, e um `catch` em volta o
  // transformaria num erro genérico de servidor.
  redirect(`/app/projetos/${data.id}`);
}

export async function apagarProjeto(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  // Sessão primeiro: sem ela, `exigirUsuario` redireciona para o login, e
  // responder "Projeto inválido." a quem só perdeu a sessão seria mentir.
  const usuario = await exigirUsuario("/app/projetos");

  const projeto = id.safeParse(formData.get("projeto"));
  if (!projeto.success) return { erro: "Projeto inválido." };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("discard_project", {
    p_user_id: usuario.id,
    p_project_id: projeto.data,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem };

    console.error("[projetos] discard_project falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos apagar o projeto agora. Tente de novo." };
  }

  // Banco primeiro, bucket depois. A ordem inversa deixaria, numa falha,
  // linhas apontando para arquivos que não existem mais — e essas a tela
  // mostra. Objeto órfão, ao contrário, é invisível e o lifecycle o recolhe.
  await apagarNoBucket(data.map((linha) => linha.chave));

  revalidatePath("/app/projetos");
  redirect("/app/projetos");
}

export async function removerVideo(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario();

  const job = id.safeParse(formData.get("video"));
  const projeto = id.safeParse(formData.get("projeto"));
  if (!job.success || !projeto.success) return { erro: "Vídeo inválido." };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("discard_job", {
    p_user_id: usuario.id,
    p_job_id: job.data,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem };

    console.error("[projetos] discard_job falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos remover o vídeo agora. Tente de novo." };
  }

  const chaves = data.flatMap((linha) =>
    [linha.input_key, linha.output_key].filter(
      (chave): chave is string => typeof chave === "string" && chave !== "",
    ),
  );
  await apagarNoBucket(chaves);

  revalidatePath(`/app/projetos/${projeto.data}`);
  revalidatePath("/app/projetos");
  return {};
}

/**
 * "Processar lote" — os vídeos `uploaded` do projeto entram na fila.
 *
 * Vai pelo cliente ADMIN, como as de remoção, e pela mesma razão da 0008: o
 * `p_user_id` é escolhido aqui, no servidor, a partir da sessão. Exposta ao
 * PostgREST, a função aceitaria o `p_user_id` que o chamador quisesse.
 *
 * SOBRE A QUOTA, e vale ser preciso porque a palavra engana: a vaga já foi
 * cobrada no upload (`register_upload_job` incrementa `videos_used` ao aceitar
 * o arquivo). Enfileirar **não cobra de novo** — contaria o mesmo vídeo duas
 * vezes. O que a função confere é se o plano ainda comporta o que já foi
 * aceito, que é o caso de quem baixou de plano entre enviar e processar.
 */
export async function processarLote(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario();

  const projeto = id.safeParse(formData.get("projeto"));
  if (!projeto.success) return { erro: "Projeto inválido." };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("enqueue_project", {
    p_user_id: usuario.id,
    p_project_id: projeto.data,
    // A cópia congelada do template. Enquanto o editor não existe (Fase 6),
    // o molde é o mesmo para todo mundo — ver `@/lib/template/padrao`.
    p_snapshot: templateDoProjeto(),
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem };

    console.error("[projetos] enqueue_project falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos enviar o lote para a fila agora. Tente de novo." };
  }

  revalidatePath(`/app/projetos/${projeto.data}`);

  const quantos = typeof data === "number" ? data : 0;
  if (quantos === 0) {
    // Não é erro: é o clique repetido, ou o projeto sem nada para processar.
    // Dizer "falhou" para quem clicou duas vezes faria a pessoa procurar um
    // problema que não existe.
    return { aviso: "Nenhum vídeo novo para processar neste projeto." };
  }

  return {
    aviso:
      quantos === 1
        ? "1 vídeo entrou na fila."
        : `${quantos} vídeos entraram na fila.`,
  };
}

/**
 * A remoção no bucket é limpeza, e limpeza não derruba a operação.
 *
 * A linha do banco já se foi quando isto roda. Propagar o erro faria a tela
 * dizer "não foi possível remover" sobre um vídeo que **foi** removido — e o
 * usuário clicaria de novo, num item que não existe mais.
 */
async function apagarNoBucket(chaves: string[]): Promise<void> {
  if (chaves.length === 0) return;

  try {
    await apagarObjetos(chaves);
  } catch (erro) {
    console.error("[projetos] falha ao apagar objetos no R2", {
      quantos: chaves.length,
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
