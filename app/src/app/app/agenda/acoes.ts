"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  chaveDoDia,
  dataHoraLonga,
  horaLocal,
  LIMITE_LEGENDA,
  lerChaveDoDia,
  lerHora,
  paraUtc,
} from "@/lib/agenda/fuso";
import type { EstadoFormulario } from "@/lib/auth/formulario";
import { exigirUsuario } from "@/lib/auth/sessao";
import {
  consultarLimiteDePublicacao,
  ehTokenInvalido,
  ErroDaMeta,
} from "@/lib/ig/api";
import { marcarParaReconectar } from "@/lib/ig/reconectar";
import { contaComToken, type ContaComToken } from "@/lib/ig/token";
import { registrarAuditoria } from "@/lib/auditoria";
import { codigoDoErro, mensagemDoCodigo } from "@/lib/plano/erros";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * As ações da agenda.
 *
 * QUAL CLIENTE, E POR QUÊ
 * =======================
 *
 * Criar, reagendar e cancelar vão pelo cliente do USUÁRIO: a linha nasce e
 * morre dentro da RLS, com `auth.uid()` valendo o dono. É isso que faz o
 * cross-check da fase ("agendar em `ig_account_id` de outro → RLS bloqueia")
 * ser uma propriedade do banco, e não uma checagem que alguém esquece.
 *
 * O que passa pelo cliente ADMIN é o que a RLS não alcança: ler o token para
 * perguntar o limite à Meta (`contaComToken`), virar `failed` em `scheduled`
 * (`retry_schedule` — `status` não é coluna do cliente) e a auditoria.
 */

const DIA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Escolha uma data.");
const HORA = z.string().regex(/^\d{2}:\d{2}$/, "Escolha um horário.");

const Agendamento = z.object({
  conta: z.uuid("Escolha uma conta do Instagram."),
  video: z.uuid("Escolha um vídeo pronto."),
  data: DIA,
  hora: HORA,
  legenda: z
    .string()
    .max(LIMITE_LEGENDA, `A legenda pode ter até ${LIMITE_LEGENDA} caracteres.`)
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v : null)),
});

export type Sugestao = { data: string; hora: string; texto: string };

export type EstadoAgendamento = EstadoFormulario & { sugestao?: Sugestao };

export type Limite =
  | { ok: true; usados: number; total: number; username: string }
  | { ok: false; erro: string };

const ERRO_RECONECTAR =
  "Essa conta precisa ser reconectada em Conectores antes de agendar.";

/**
 * "X de Y publicações usadas nas últimas 24 h" — consultado ao escolher a
 * conta no diálogo, antes de gravar (prompt da Fase 5).
 */
export async function consultarLimite(contaId: string): Promise<Limite> {
  const usuario = await exigirUsuario("/app/agenda");

  const id = z.uuid().safeParse(contaId);
  if (!id.success) return { ok: false, erro: "Conta inválida." };

  const conta = await contaComToken(usuario.id, id.data);
  if (!conta.ok) {
    return {
      ok: false,
      erro:
        conta.motivo === "inexistente"
          ? "Não encontramos essa conta na sua lista."
          : ERRO_RECONECTAR,
    };
  }

  try {
    const limite = await consultarLimiteDePublicacao(conta.conta.token, conta.conta.igUserId);
    return {
      ok: true,
      usados: limite.usados,
      total: limite.total,
      username: conta.conta.username,
    };
  } catch (erro) {
    return { ok: false, erro: await tratarErroDaMeta(erro, conta.conta, usuario.id) };
  }
}

export async function agendarVideo(
  _estado: EstadoAgendamento,
  formData: FormData,
): Promise<EstadoAgendamento> {
  const usuario = await exigirUsuario("/app/agenda");

  const analisado = Agendamento.safeParse({
    conta: formData.get("conta"),
    video: formData.get("video"),
    data: formData.get("data"),
    hora: formData.get("hora"),
    legenda: formData.get("legenda") ?? undefined,
  });
  if (!analisado.success) {
    return { erro: analisado.error.issues[0]?.message ?? "Preencha os campos." };
  }
  const pedido = analisado.data;

  const quando = instanteDe(pedido.data, pedido.hora);
  if (!quando) return { erro: "Data ou horário inválidos." };
  if (quando.getTime() < Date.now() - 60_000) {
    return { erro: "Escolha um horário no futuro." };
  }

  // --- a conta e o token ------------------------------------------------
  const conta = await contaComToken(usuario.id, pedido.conta);
  if (!conta.ok) {
    return {
      erro:
        conta.motivo === "inexistente"
          ? "Não encontramos essa conta na sua lista."
          : ERRO_RECONECTAR,
    };
  }

  // --- cabe nas 24 h? ---------------------------------------------------
  //
  // A Meta conta publicações numa janela MÓVEL de 24 h. Para um horário T, o
  // que pesa é o que foi (ou vai ser) publicado em [T − 24 h, T]. Duas fontes:
  //
  //   · a Meta, para o que já aconteceu — `quota_usage` das últimas 24 h. Só
  //     conta contra T se T − 24 h ainda alcança o passado; se T está a mais de
  //     um dia, nada do que já foi publicado pesa;
  //   · o nosso banco, para o que ainda vai acontecer — os agendamentos
  //     pendentes da mesma conta dentro da janela.
  //
  // A Meta não diz QUANDO cada post foi publicado, então a conta é
  // conservadora: assume que todos os usados ainda estão dentro da janela.
  // Errar para o lado de "não cabe" custa uma sugestão de horário; errar para
  // o outro lado custa um `deferred` na hora de publicar — que o worker também
  // trata, então nenhum dos dois erros perde a publicação.
  let aviso: string | undefined;
  let usadosNaMeta = 0;
  let total = 100;
  try {
    const limite = await consultarLimiteDePublicacao(conta.conta.token, conta.conta.igUserId);
    total = limite.total;
    usadosNaMeta = quando.getTime() - limite.duracaoS * 1000 < Date.now() ? limite.usados : 0;
  } catch (erro) {
    const mensagem = await tratarErroDaMeta(erro, conta.conta, usuario.id);
    if (ehTokenInvalido(erro)) return { erro: mensagem };
    // Falha de rede: o agendamento não fica refém disso. O worker respeita o
    // limite de novo na hora de publicar, adiando se preciso.
    aviso =
      "Não conseguimos conferir o limite de publicações agora. O agendamento " +
      "foi gravado; se a conta estiver no limite na hora, a publicação é " +
      "adiada automaticamente.";
  }

  const supabase = await createClient();
  const pendentes = await pendentesNaJanela(supabase, pedido.conta, quando);
  if (pendentes === null) {
    return { erro: "Não conseguimos conferir sua agenda agora. Tente de novo." };
  }

  if (usadosNaMeta + pendentes >= total) {
    const livre = await proximoHorarioLivre(supabase, pedido.conta, quando, total);
    return {
      erro:
        `A conta @${conta.conta.username} já tem ${usadosNaMeta + pendentes} de ${total} ` +
        "publicações nas 24 horas em volta desse horário. O Instagram não " +
        "aceitaria mais uma.",
      sugestao: livre,
    };
  }

  // --- grava, dentro da RLS ---------------------------------------------
  const { data: linha, error } = await supabase
    .from("schedules")
    .insert({
      job_id: pedido.video,
      ig_account_id: pedido.conta,
      scheduled_at: quando.toISOString(),
      caption: pedido.legenda,
    })
    .select("id")
    .single();

  if (error || !linha) {
    return { erro: mensagemDoErroDeEscrita(error, "agendar") };
  }

  await auditar(usuario.id, "schedule.create", linha.id, {
    job_id: pedido.video,
    ig_account_id: pedido.conta,
    scheduled_at: quando.toISOString(),
  });

  revalidatePath("/app/agenda");
  revalidatePath("/app/agenda/historico");

  return {
    aviso:
      `Agendado para ${dataHoraLonga.format(quando)} em @${conta.conta.username}.` +
      (aviso ? ` ${aviso}` : ""),
  };
}

export type ResultadoDaAlteracao =
  | { ok: true; quando: string }
  | { ok: false; erro: string };

/**
 * Arrastar no calendário e o campo de horário do detalhe chamam isto. A
 * validação é a mesma do agendamento; a escrita é `UPDATE` na RLS, que só
 * alcança `scheduled`/`deferred` do próprio dono (migration 0019).
 */
export async function reagendar(entrada: {
  id: string;
  data: string;
  hora: string;
}): Promise<ResultadoDaAlteracao> {
  const usuario = await exigirUsuario("/app/agenda");

  const analisado = z
    .object({ id: z.uuid(), data: DIA, hora: HORA })
    .safeParse(entrada);
  if (!analisado.success) return { ok: false, erro: "Data ou horário inválidos." };

  const quando = instanteDe(analisado.data.data, analisado.data.hora);
  if (!quando) return { ok: false, erro: "Data ou horário inválidos." };
  if (quando.getTime() < Date.now() - 60_000) {
    return { ok: false, erro: "Escolha um horário no futuro." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("schedules")
    .update({ scheduled_at: quando.toISOString() })
    .eq("id", analisado.data.id)
    .select("id, scheduled_at");

  if (error) return { ok: false, erro: mensagemDoErroDeEscrita(error, "reagendar") };
  if (!data || data.length === 0) {
    // A RLS não devolveu a linha: já está publicando, já foi publicada, ou
    // não é deste usuário. Para quem vê a tela, as três são a mesma coisa.
    return {
      ok: false,
      erro: "Esse agendamento não pode mais ser alterado. Recarregue a página.",
    };
  }

  await auditar(usuario.id, "schedule.reschedule", analisado.data.id, {
    scheduled_at: quando.toISOString(),
  });

  revalidatePath("/app/agenda");
  return { ok: true, quando: quando.toISOString() };
}

export async function cancelarAgendamento(id: string): Promise<{ ok: boolean; erro?: string }> {
  const usuario = await exigirUsuario("/app/agenda");

  const analisado = z.uuid().safeParse(id);
  if (!analisado.success) return { ok: false, erro: "Agendamento inválido." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("schedules")
    .delete()
    .eq("id", analisado.data)
    .select("id");

  if (error) return { ok: false, erro: mensagemDoErroDeEscrita(error, "cancelar") };
  if (!data || data.length === 0) {
    return {
      ok: false,
      erro: "Esse agendamento está sendo publicado agora e não pode ser cancelado.",
    };
  }

  await auditar(usuario.id, "schedule.cancel", analisado.data, {});

  revalidatePath("/app/agenda");
  revalidatePath("/app/agenda/historico");
  return { ok: true };
}

/** "Tentar de novo" do histórico: `failed` volta para a fila agora. */
export async function tentarDeNovo(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario("/app/agenda/historico");

  const analisado = z.uuid().safeParse(formData.get("agendamento"));
  if (!analisado.success) return { erro: "Agendamento inválido." };

  const supabase = createAdminClient();
  const { error } = await supabase.rpc("retry_schedule", {
    p_user_id: usuario.id,
    p_id: analisado.data,
  });

  if (error) {
    if (codigoDoErro(error) === "23505") {
      // O mesmo vídeo já foi agendado de novo nessa conta depois da falha —
      // o índice parcial permite a falha E o novo pendente, mas não dois
      // pendentes. Condição permanente, não "tente de novo".
      return {
        erro:
          "Esse vídeo já tem outro agendamento nessa conta. Cancele um dos " +
          "dois na Agenda antes de tentar de novo.",
      };
    }
    if (codigoDoErro(error) === "PM021") {
      return {
        erro:
          "Esse agendamento não está em falha, ou a conta dele precisa ser " +
          "reconectada em Conectores antes de tentar de novo.",
      };
    }
    const amigavel = mensagemDoCodigo(codigoDoErro(error));
    if (amigavel) return { erro: amigavel };

    console.error("[agenda] retry_schedule falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { erro: "Não conseguimos reenviar agora. Tente de novo em instantes." };
  }

  revalidatePath("/app/agenda");
  revalidatePath("/app/agenda/historico");
  return { aviso: "De volta à fila. A publicação sai no próximo minuto." };
}

// ---------------------------------------------------------------------------

function instanteDe(data: string, hora: string): Date | null {
  const d = lerChaveDoDia(data);
  const h = lerHora(hora);
  if (!d || !h) return null;
  return paraUtc(d.ano, d.mes, d.dia, h.hora, h.minuto);
}

/**
 * Agendamentos pendentes da conta em [T − 24 h, T], fora o que já falhou ou
 * foi publicado (o publicado já está na contagem da Meta).
 */
async function pendentesNaJanela(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contaId: string,
  quando: Date,
): Promise<number | null> {
  const inicio = new Date(quando.getTime() - 24 * 60 * 60 * 1000);
  const { count, error } = await supabase
    .from("schedules")
    .select("id", { count: "exact", head: true })
    .eq("ig_account_id", contaId)
    .in("status", ["scheduled", "publishing", "deferred"])
    .gte("scheduled_at", inicio.toISOString())
    .lte("scheduled_at", quando.toISOString());

  if (error) {
    console.error("[agenda] contagem da janela falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return null;
  }
  return count ?? 0;
}

/**
 * O primeiro horário, em passos de 24 h a partir do pedido, em que a conta
 * cabe de novo. 24 h porque é o tamanho da janela: um dia depois, tudo que a
 * Meta contou hoje saiu dela. Mantém a hora que a pessoa escolheu.
 */
async function proximoHorarioLivre(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contaId: string,
  pedido: Date,
  total: number,
): Promise<Sugestao> {
  let candidato = new Date(Math.max(pedido.getTime(), Date.now()) + 24 * 60 * 60 * 1000);

  for (let i = 0; i < 7; i += 1) {
    const pendentes = await pendentesNaJanela(supabase, contaId, candidato);
    if (pendentes !== null && pendentes < total) break;
    candidato = new Date(candidato.getTime() + 24 * 60 * 60 * 1000);
  }

  return {
    data: chaveDoDia(candidato),
    hora: horaLocal(candidato),
    texto: dataHoraLonga.format(candidato),
  };
}

/**
 * Token recusado pela Meta marca a conta para reconectar — o mesmo caminho do
 * cron da Fase 4 (`marcarParaReconectar`: marca, audita e avisa uma vez), e
 * pelo mesmo motivo: só a Meta pode dizer que um token morreu. Falha de rede
 * não marca nada.
 */
async function tratarErroDaMeta(
  erro: unknown,
  conta: ContaComToken,
  userId: string,
): Promise<string> {
  if (ehTokenInvalido(erro)) {
    await marcarParaReconectar(createAdminClient(), conta.id, userId, conta.username);
    return ERRO_RECONECTAR;
  }

  console.error("[agenda] limite de publicação indisponível", {
    conta: conta.id,
    mensagem: erro instanceof ErroDaMeta ? erro.detalhe : String(erro),
  });
  return "Não conseguimos consultar o limite de publicações agora. Tente de novo em instantes.";
}

function mensagemDoErroDeEscrita(
  erro: { code?: string; message?: string } | null,
  acao: "agendar" | "reagendar" | "cancelar",
): string {
  const codigo = erro?.code;
  if (codigo === "23505") return "Esse vídeo já está agendado nessa conta.";
  if (codigo === "23514") return `A legenda pode ter até ${LIMITE_LEGENDA} caracteres.`;
  if (codigo === "42501") {
    // A RLS recusou: vídeo que não é `done`, conta que não é `active`, ou
    // qualquer um dos dois de outro usuário. Para a tela, uma frase só.
    return acao === "agendar"
      ? "Não encontramos esse vídeo pronto ou essa conta ativa na sua lista."
      : "Esse agendamento não pode mais ser alterado. Recarregue a página.";
  }

  console.error(`[agenda] ${acao} falhou`, { codigo, mensagem: erro?.message });
  return "Não conseguimos gravar agora. Tente de novo em instantes.";
}

async function auditar(
  userId: string,
  acao: string,
  alvo: string,
  meta: Record<string, string | number | null>,
): Promise<void> {
  await registrarAuditoria({ userId, actor: "user", action: acao, target: alvo, meta });
}
