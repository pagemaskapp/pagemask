import "server-only";

import { NextResponse } from "next/server";

import { ipDoCabecalho } from "@/lib/auditoria";
import {
  lerSignedRequest,
  signedRequestDoCorpo,
  type PedidoAssinado,
} from "@/lib/meta/signed-request";
import { consumirBalde } from "@/lib/rate-limit/balde";

/**
 * A porta comum dos dois callbacks da Meta (exclusão de dados e
 * desautorização): limite por IP, leitura do corpo, validação do
 * `signed_request`. Quem chama recebe o pedido validado ou a resposta pronta.
 *
 * Um lugar só porque o contrato é um só: mudar o que é 400, o que é 500 ou o
 * cabeçalho de cache precisa valer para os dois, e valia para um.
 */
export type RecepcaoDoCallback =
  | { pedido: PedidoAssinado }
  | { resposta: NextResponse };

export async function receberCallbackDaMeta(
  requisicao: Request,
  escopo: string,
): Promise<RecepcaoDoCallback> {
  const limite = await consumirBalde({
    bucket: `meta-callback:${ipDoCabecalho(requisicao.headers) ?? "sem-ip"}`,
    limite: 120,
    janela: "1 hour",
    rotulo: "meta-callback",
  });
  if (!limite.permitido) {
    return { resposta: json({ erro: "muitas chamadas" }, 429) };
  }

  let pedido: PedidoAssinado | null;
  try {
    pedido = lerSignedRequest(await signedRequestDoCorpo(requisicao));
  } catch (erro) {
    // `IG_APP_SECRET` ausente cai aqui. É configuração nossa, não pedido ruim.
    console.error(`[${escopo}] não foi possível validar`, {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return { resposta: json({ erro: "indisponível" }, 500) };
  }

  if (!pedido) {
    console.warn(`[${escopo}] signed_request inválido`);
    return { resposta: json({ erro: "signed_request inválido" }, 400) };
  }

  return { pedido };
}

export function json(corpo: unknown, status = 200): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
