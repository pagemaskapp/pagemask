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
import { headerConferido } from "@/lib/template/header";
import {
  templateDoProjeto,
  TemplateInvalidoError,
} from "@/lib/template/snapshot";

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

  // A função devolve, além da entrada e da saída do vídeo, as chaves dos
  // pacotes ZIP daquele projeto — remover um vídeo invalida os pacotes que o
  // contêm, e deixá-los no bucket manteria baixável por sete dias justamente o
  // arquivo que o usuário acabou de mandar apagar (migration 0021).
  const chaves = data
    .map((linha) => linha.chave)
    .filter((chave): chave is string => typeof chave === "string" && chave !== "");
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
 *
 * O TEMPLATE, DESDE A FASE 6, É O DO PROJETO. O snapshot continua sendo cópia
 * congelada gravada por `enqueue_project`; o que mudou é a origem — o `config`
 * do template escolhido, ou o padrão quando o projeto não escolheu nenhum.
 *
 * A LISTA DE IDS é "aplicar a itens selecionados". Ela vem do navegador e é
 * entrada não confiável: quem a filtra é o `where` da função, que exige o
 * mesmo projeto, o mesmo dono e o estado `uploaded`. Id de vídeo alheio na
 * lista não dá erro — ele simplesmente não casa, e o número devolvido (quantos
 * entraram) já denuncia a diferença para quem tentou.
 */
export async function processarLote(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario();

  const projeto = id.safeParse(formData.get("projeto"));
  if (!projeto.success) return { erro: "Projeto inválido." };

  const selecionados = z
    .array(id)
    .max(500)
    .safeParse(formData.getAll("video").map(String));
  if (!selecionados.success) return { erro: "Seleção inválida." };

  let snapshot;
  try {
    snapshot = await templateDoProjeto(projeto.data);
  } catch (erro) {
    if (erro instanceof TemplateInvalidoError) {
      // Não cair no padrão de propósito: renderizar o lote inteiro com um
      // visual que o usuário não escolheu seria um estrago que ele só veria
      // depois de baixar os arquivos.
      return {
        erro:
          `O template “${erro.nome}” está com uma configuração que não ` +
          "reconhecemos. Abra-o em Templates, ajuste e salve de novo.",
      };
    }
    throw erro;
  }

  // O `config` foi lido do banco, e `templates` é uma tabela que o dono edita
  // (0001) — ou seja, ele pode ter chegado ali por um PATCH direto no
  // PostgREST, sem passar por `salvarTemplate`. Esta é a terceira entrada do
  // mesmo dado, e é a que renderiza de verdade.
  const header = await headerConferido(snapshot.config, usuario.id);
  if (!header.ok) return { erro: header.motivo };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("enqueue_project", {
    p_user_id: usuario.id,
    p_project_id: projeto.data,
    p_snapshot: snapshot.config,
    p_job_ids: selecionados.data.length > 0 ? selecionados.data : null,
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

  const comTemplate = snapshot.template
    ? ` com o template “${snapshot.template.name}”`
    : "";

  return {
    aviso:
      quantos === 1
        ? `1 vídeo entrou na fila${comTemplate}.`
        : `${quantos} vídeos entraram na fila${comTemplate}.`,
  };
}

/**
 * "Reprocessar os que falharam" — os `failed` do projeto voltam para a fila.
 *
 * SEM DUPLICAR JOB, e isso é do banco, não da tela: `requeue_failed_jobs`
 * (migration 0021) faz um UPDATE filtrado por `status = 'failed'`. O segundo
 * clique — ou dois cliques em duas abas ao mesmo tempo — não encontra mais
 * nada para mudar e devolve 0. Não existe insert neste caminho, então não
 * existe segunda linha para o mesmo vídeo.
 *
 * O ARQUIVO DE ENTRADA AINDA ESTÁ LÁ, e é por isso que reprocessar funciona:
 * falha PRESERVA a entrada no R2 de propósito (só `rejected` apaga). Ver o
 * cabeçalho de `worker/src/servico/trabalho.py`.
 *
 * A COTA É COBRADA DE NOVO, porque ela foi DEVOLVIDA quando o vídeo falhou.
 * Quem está no teto do plano ouve isso aqui, antes de a fila encher — a
 * mensagem do `PM002` é a mesma do upload.
 *
 * O template é relido do projeto, e não reaproveitado do snapshot antigo: um
 * vídeo que falhou por causa de um template quebrado precisa rodar com o
 * template consertado.
 */
export async function reprocessarFalhas(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario();

  const projeto = id.safeParse(formData.get("projeto"));
  if (!projeto.success) return { erro: "Projeto inválido." };

  const selecionados = z
    .array(id)
    .max(500)
    .safeParse(formData.getAll("video").map(String));
  if (!selecionados.success) return { erro: "Seleção inválida." };

  let snapshot;
  try {
    snapshot = await templateDoProjeto(projeto.data);
  } catch (erro) {
    if (erro instanceof TemplateInvalidoError) {
      return {
        erro:
          `O template “${erro.nome}” está com uma configuração que não ` +
          "reconhecemos. Abra-o em Templates, ajuste e salve de novo.",
      };
    }
    throw erro;
  }

  const header = await headerConferido(snapshot.config, usuario.id);
  if (!header.ok) return { erro: header.motivo };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("requeue_failed_jobs", {
    p_user_id: usuario.id,
    p_project_id: projeto.data,
    p_snapshot: snapshot.config,
    p_job_ids: selecionados.data.length > 0 ? selecionados.data : null,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return { erro: mensagem };

    console.error("[projetos] requeue_failed_jobs falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos reenviar esses vídeos agora. Tente de novo." };
  }

  revalidatePath(`/app/projetos/${projeto.data}`);

  const quantos = typeof data === "number" ? data : 0;
  if (quantos === 0) {
    // Não é erro: é o clique repetido, ou a outra aba que já reenviou. Dizer
    // "falhou" faria a pessoa procurar um problema que não existe.
    return { aviso: "Nenhum vídeo com falha para reprocessar agora." };
  }

  return {
    aviso:
      quantos === 1
        ? "1 vídeo voltou para a fila."
        : `${quantos} vídeos voltaram para a fila.`,
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
