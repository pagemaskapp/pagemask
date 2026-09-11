import "server-only";

import { getServerEnv } from "@/lib/env/server";

/**
 * E-mail transacional, pelo HTTP do Resend.
 *
 * SEM SDK DE PROPÓSITO
 * ====================
 *
 * São duas chamadas HTTP no produto inteiro. Uma dependência a mais para isso
 * significa uma dependência a mais para auditar, para o `npm audit` do CI olhar
 * e para atualizar — e ela rodaria no mesmo processo que decifra token do
 * Instagram. `fetch` resolve.
 *
 * SEM PROVEDOR NÃO É ERRO
 * =======================
 *
 * Quando `RESEND_API_KEY` está em branco, a função registra e devolve
 * `{ enviado: false }`. Quem chama **não** pode tratar isso como falha da
 * operação: no cron, o que faz o cliente saber que precisa reconectar é o
 * estado `needs_reconnect` no banco, que a tela lê. O e-mail é o aviso
 * antecipado, não o mecanismo.
 */

export type ResultadoDoEnvio = {
  enviado: boolean;
  /** Só para o log. Nunca vai para a tela. */
  motivo?: string;
};

export async function enviarEmail(mensagem: {
  para: string;
  assunto: string;
  texto: string;
}): Promise<ResultadoDoEnvio> {
  const env = getServerEnv();
  const chave = env.RESEND_API_KEY;
  const remetente = env.EMAIL_REMETENTE;

  if (!chave || !remetente) {
    console.warn("[email] provedor não configurado; aviso não enviado", {
      assunto: mensagem.assunto,
    });
    return { enviado: false, motivo: "sem provedor" };
  }

  try {
    const resposta = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${chave}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: remetente,
        to: [mensagem.para],
        subject: mensagem.assunto,
        text: mensagem.texto,
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

    if (!resposta.ok) {
      // O corpo do erro do Resend não traz segredo, mas também não traz nada
      // útil além do status na maioria dos casos. Fica só o status.
      console.error("[email] provedor recusou o envio", {
        status: resposta.status,
      });
      return { enviado: false, motivo: `http ${resposta.status}` };
    }

    return { enviado: true };
  } catch (erro) {
    console.error("[email] falha ao enviar", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return { enviado: false, motivo: "falha de rede" };
  }
}
