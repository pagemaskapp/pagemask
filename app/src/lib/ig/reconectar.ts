import "server-only";

import { enviarEmail } from "@/lib/email/enviar";
import { publicEnv } from "@/lib/env/public";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Marca uma conta como `needs_reconnect` e avisa o dono — **uma vez só**.
 *
 * Nasceu dentro do cron de renovação (Fase 4) e saiu de lá porque a agenda
 * (Fase 5) descobre token morto pelo mesmo caminho — a Meta recusa uma
 * chamada — e precisa fazer exatamente o mesmo: marcar, auditar e avisar. Duas
 * cópias divergiriam na primeira correção, e a mais provável era a agenda
 * marcar em silêncio: o cron do dia seguinte encontraria a conta já marcada,
 * `mark_ig_needs_reconnect` devolveria `false`, e o e-mail nunca sairia.
 *
 * A ORDEM IMPORTA: marca primeiro, avisa depois. O estado no banco é o que faz
 * a tela pedir a reconexão e o que impede a agenda e o worker de tentarem
 * publicar com um token morto. O e-mail é cortesia — e ele pode falhar (sem
 * provedor configurado, provedor fora do ar) sem que isso desfaça a marcação.
 *
 * `mark_ig_needs_reconnect` devolve `true` só quando ESTA chamada mudou o
 * estado. Sem essa distinção o cliente receberia o mesmo e-mail todo dia até
 * reconectar — e um aviso repetido é um aviso que se aprende a ignorar.
 *
 * Devolve `true` quando foi esta chamada que marcou.
 */
export async function marcarParaReconectar(
  supabase: ReturnType<typeof createAdminClient>,
  contaId: string,
  userId: string,
  username: string,
): Promise<boolean> {
  const { data: marcouAgora, error } = await supabase.rpc(
    "mark_ig_needs_reconnect",
    { p_account_id: contaId },
  );

  if (error) {
    console.error("[ig] não foi possível marcar needs_reconnect", {
      conta: contaId,
      codigo: error.code,
      mensagem: error.message,
    });
    return false;
  }

  if (marcouAgora !== true) return false; // já estava marcada; o aviso já saiu antes.

  const { error: erroDaAuditoria } = await supabase.from("audit_log").insert({
    user_id: userId,
    actor: "system",
    action: "ig.needs_reconnect",
    target: contaId,
    meta: { username },
  });
  if (erroDaAuditoria) {
    console.error("[ig] auditoria não registrada", {
      acao: "ig.needs_reconnect",
      codigo: erroDaAuditoria.code,
      mensagem: erroDaAuditoria.message,
    });
  }

  // O e-mail do usuário vive em `auth.users`, que só a chave secreta lê. Ele
  // NÃO é gravado em `audit_log` nem em log nenhum (PLANO §7).
  const { data, error: erroDoUsuario } =
    await supabase.auth.admin.getUserById(userId);
  const email = data?.user?.email;

  if (erroDoUsuario || !email) {
    console.warn("[ig] sem e-mail para avisar", { conta: contaId });
    return true;
  }

  await enviarEmail({
    para: email,
    assunto: `Reconecte o Instagram @${username} no PageMask`,
    texto:
      `Olá!\n\n` +
      `Não conseguimos renovar o acesso do PageMask à conta @${username} do ` +
      `Instagram. Enquanto isso não for resolvido, as publicações dessa conta ` +
      `ficam paradas.\n\n` +
      `Para resolver, entre no PageMask, abra Conectores e clique em ` +
      `Reconectar na conta @${username}:\n` +
      `${publicEnv.NEXT_PUBLIC_APP_URL}/app/conectores\n\n` +
      `Leva menos de um minuto.\n\n` +
      `Equipe PageMask`,
  });

  return true;
}
