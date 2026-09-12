import { publicEnv } from "@/lib/env/public";
import { json, receberCallbackDaMeta } from "@/lib/meta/callback";
import { novoCodigoDeConfirmacao } from "@/lib/meta/codigo";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `POST /api/meta/data-deletion` — o Data Deletion Request Callback (PLANO §5).
 *
 * A Meta chama esta URL quando alguém, no Instagram, pede que o app apague os
 * dados dele. O contrato, conferido em 11/09/2026: chega um POST com o campo
 * `signed_request`, e a resposta precisa ser JSON com `url` (onde a pessoa
 * acompanha o pedido) e `confirmation_code`.
 *
 * O QUE ACONTECE AQUI, E O QUE NÃO
 * ================================
 *
 * Aqui: assinatura conferida, contas daquele `ig_user_id` revogadas (token
 * apagado), solicitação aberta em `data_requests` com um código, evento gravado
 * em `webhook_events` para o mesmo pedido reenviado devolver o mesmo código.
 * Tudo isso numa função só do banco, numa transação só.
 *
 * Não aqui: apagar arquivos, perfil e usuário. Isso é o fluxo de exclusão da
 * Fase 10, que lê `data_requests` e fecha o pedido em até 72 h. A página
 * `/exclusao-de-dados?code=…` mostra o estado enquanto isso.
 *
 * `signed_request` inválido é 400 e **nada é gravado** — é o primeiro item do
 * cross-check da fase. O motivo exato não sai na resposta.
 */
export async function POST(requisicao: Request) {
  const recepcao = await receberCallbackDaMeta(requisicao, "meta/data-deletion");
  if ("resposta" in recepcao) return recepcao.resposta;
  const { pedido } = recepcao;

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("open_meta_data_deletion", {
    p_ig_user_id: pedido.userId,
    p_code: novoCodigoDeConfirmacao(),
    p_event_id: `meta:deletion:${pedido.hash}`,
  });

  const linha = data?.[0];
  if (error || !linha) {
    console.error("[meta/data-deletion] não foi possível registrar", {
      codigo: error?.code,
      mensagem: error?.message,
    });
    return json({ erro: "indisponível" }, 500);
  }

  console.log(
    JSON.stringify({
      escopo: "meta/data-deletion",
      resultado: linha.ja_existia ? "repetido" : "ok",
      ig_user_id: pedido.userId,
      // Só o começo: o código inteiro é o que abre a consulta pública do
      // pedido, e log de servidor não é lugar de credencial (PLANO §3).
      codigo: `${linha.confirmation_code.slice(0, 4)}-…`,
    }),
  );

  const url = new URL("/exclusao-de-dados", publicEnv.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("code", linha.confirmation_code);

  return json({ url: url.toString(), confirmation_code: linha.confirmation_code });
}
