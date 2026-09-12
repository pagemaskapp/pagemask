import { json, receberCallbackDaMeta } from "@/lib/meta/callback";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `POST /api/meta/deauthorize` — o Deauthorize Callback (PLANO §5).
 *
 * A pessoa removeu o PageMask em "Apps e sites" do Instagram. O token dela
 * já está morto do lado da Meta; aqui ele é apagado e a conta vira `revoked`,
 * para a tela de Conectores parar de mostrar "Ativa" numa conta que não
 * publica mais — e para a agenda parar de aceitar agendamentos nela.
 *
 * Mesmo `signed_request` do callback de exclusão, mesma validação, mesma
 * idempotência por hash do pedido. Resposta: 200 com JSON mínimo de propósito
 * — a Meta só quer saber que chegou.
 */
export async function POST(requisicao: Request) {
  const recepcao = await receberCallbackDaMeta(requisicao, "meta/deauthorize");
  if ("resposta" in recepcao) return recepcao.resposta;
  const { pedido } = recepcao;

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("deauthorize_ig", {
    p_ig_user_id: pedido.userId,
    p_event_id: `meta:deauthorize:${pedido.hash}`,
  });

  if (error) {
    console.error("[meta/deauthorize] não foi possível revogar", {
      codigo: error.code,
      mensagem: error.message,
    });
    return json({ erro: "indisponível" }, 500);
  }

  console.log(
    JSON.stringify({
      escopo: "meta/deauthorize",
      resultado: data === -1 ? "repetido" : "ok",
      ig_user_id: pedido.userId,
      contas: data,
    }),
  );

  return json({ ok: true });
}
