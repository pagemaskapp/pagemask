import "server-only";

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

import { SessaoIndisponivelError, usuarioAtual } from "@/lib/auth/sessao";

/**
 * Sessão para rota de API.
 *
 * `exigirUsuario()` redireciona, e redirecionar é a resposta certa para uma
 * página — mas para uma chamada de `fetch` é a resposta errada: o cliente
 * seguiria o 307 até `/entrar` e tentaria ler o HTML do login como se fosse
 * JSON, dando um erro de parse que não diz nada sobre o que aconteceu.
 *
 * Aqui a sessão ausente é `401` com JSON, e a sessão que não pôde ser conferida
 * é `503` — a mesma distinção que o resto do app faz e pela mesma razão:
 * Supabase fora do ar não significa "não está logado", e tratar os dois como a
 * mesma coisa faria o app deslogar todo mundo por causa de um 5xx passageiro.
 */
export type SessaoDaApi = { usuario: User } | { resposta: NextResponse };

export async function usuarioDaApi(): Promise<SessaoDaApi> {
  try {
    const usuario = await usuarioAtual();
    if (!usuario) {
      return {
        resposta: erroJson(401, "Sua sessão expirou. Entre de novo para continuar."),
      };
    }
    return { usuario };
  } catch (erro) {
    if (erro instanceof SessaoIndisponivelError) {
      return {
        resposta: erroJson(
          503,
          "Não conseguimos conferir sua sessão agora. Tente de novo em instantes.",
        ),
      };
    }
    throw erro;
  }
}

/**
 * Erro em JSON, sempre com a mesma forma e sempre em pt-BR.
 *
 * `no-store` em todas: resposta que depende de sessão nunca pode ficar num
 * cache compartilhado — o 401 de um visitante servido a outro usuário seria
 * um bug difícil de ver e trivial de causar.
 */
export function erroJson(status: number, mensagem: string): NextResponse {
  return NextResponse.json(
    { erro: mensagem },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function okJson(corpo: unknown): NextResponse {
  return NextResponse.json(corpo, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Corpo JSON de um POST, ou `null` se não for JSON.
 *
 * Exigir `application/json` não é formalidade: é o que impede que um
 * `<form>` em outro site poste nestas rotas. O cookie de sessão é
 * `SameSite=Lax`, o que já barra o envio em POST de terceiros — esta é a
 * segunda tranca, e ela vale porque formulário HTML só consegue mandar três
 * tipos de conteúdo, e `application/json` não é nenhum deles.
 */
export async function corpoJson(requisicao: Request): Promise<unknown | null> {
  const tipo = requisicao.headers.get("content-type") ?? "";
  if (!tipo.toLowerCase().startsWith("application/json")) return null;

  try {
    return await requisicao.json();
  } catch {
    return null;
  }
}
