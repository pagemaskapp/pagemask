"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import type { EstadoFormulario } from "@/lib/auth/formulario";
import { exigirUsuario } from "@/lib/auth/sessao";
import { codigoDoErro, mensagemDoCodigo } from "@/lib/plano/erros";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * As ações da aba Conectores. Hoje só uma: desconectar.
 *
 * CONECTAR NÃO É UMA ACTION
 * =========================
 *
 * Conectar precisa abrir uma janela para o Instagram, e uma server action não
 * consegue fazer isso — ela responde dados, não navegação de uma janela nova. O
 * início do fluxo é `GET /api/ig/iniciar`, que o popup abre direto.
 *
 * DESCONECTAR PASSA PELO BANCO, E NÃO PELO CLIENTE
 * ================================================
 *
 * O papel `authenticated` tem `delete` em `ig_accounts` (migration 0004), então
 * o navegador conseguiria apagar a linha sozinho. Não é o que se quer: apagar
 * perde o registro de que a conta existiu, e a `audit_log` passaria a apontar
 * para um id que não existe mais. `disconnect_ig_account` (0018) apaga o TOKEN
 * e marca `revoked` — o segredo some, o histórico fica.
 */

const idDaConta = z.uuid();

export async function desconectarConta(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario("/app/conectores");

  const analisado = idDaConta.safeParse(formData.get("conta"));
  if (!analisado.success) {
    return { erro: "Não encontramos essa conta na sua lista." };
  }

  const supabase = createAdminClient();
  const { data: conta, error } = await supabase.rpc("disconnect_ig_account", {
    p_user_id: usuario.id,
    p_account_id: analisado.data,
  });

  if (error) {
    const amigavel = mensagemDoCodigo(codigoDoErro(error));
    if (amigavel) return { erro: amigavel };

    console.error("[conectores] falha ao desconectar", {
      codigo: error.code,
      mensagem: error.message,
    });
    return {
      erro: "Não conseguimos desconectar agora. Tente de novo em instantes.",
    };
  }

  // A auditoria vem DEPOIS da desconexão e não a desfaz se falhar: o token já
  // foi apagado, que é a parte que importa. Mesma decisão do callback.
  const { error: erroDaAuditoria } = await supabase.from("audit_log").insert({
    user_id: usuario.id,
    actor: "user",
    action: "ig.disconnect",
    target: analisado.data,
    meta: { username: conta?.username ?? null },
    ip: await ipAtual(),
  });
  if (erroDaAuditoria) {
    console.error("[conectores] auditoria não registrada", {
      acao: "ig.disconnect",
      codigo: erroDaAuditoria.code,
      mensagem: erroDaAuditoria.message,
    });
  }

  revalidatePath("/app/conectores");

  return {
    aviso: conta?.username
      ? `A conta @${conta.username} foi desconectada.`
      : "A conta foi desconectada.",
  };
}

async function ipAtual(): Promise<string | null> {
  const encaminhado = (await headers()).get("x-forwarded-for");
  if (!encaminhado) return null;
  const primeiro = encaminhado.split(",")[0]?.trim();
  return primeiro && primeiro.length > 0 ? primeiro : null;
}
