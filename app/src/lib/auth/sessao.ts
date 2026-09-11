import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { ehFalhaTemporaria } from "@/lib/auth/falha-temporaria";
import { createClient } from "@/lib/supabase/server";

/**
 * Quem está logado, ou `null`.
 *
 * Usa `getUser()`, e não `getSession()`, de propósito: `getSession()` devolve o
 * que está no cookie sem conferir nada. O cookie é `HttpOnly` e assinado, mas
 * "provavelmente íntegro" não é base para decidir acesso no servidor.
 * `getUser()` valida o token contra o Supabase e é essa a resposta que vale.
 *
 * `cache()` do React memoiza por requisição. Sem ele, uma navegação para
 * `/app/conta` faz três viagens ao Supabase — layout, página e o próximo
 * `exigirUsuario` — para responder exatamente a mesma pergunta. O cache é
 * descartado no fim da requisição, então nunca atravessa usuários.
 */
export class SessaoIndisponivelError extends Error {
  constructor() {
    super("Nao foi possivel conferir a sessao agora.");
    this.name = "SessaoIndisponivelError";
  }
}

export const usuarioAtual = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error) {
    // Rede caida ou Supabase fora do ar nao significa "nao esta logado".
    // Tratar os dois como a mesma coisa deslogaria todo mundo com cookie
    // valido por causa de um 5xx passageiro — e, pior, em silencio: o usuario
    // veria a tela de login sem entender por que caiu. A regra de qual erro e
    // qual vive em `ehFalhaTemporaria`, para o proxy responder identico.
    if (ehFalhaTemporaria(error)) {
      // Mesma razao do log no proxy: sem isto, uma indisponibilidade some. Aqui
      // ela aparece quando o proxy nao pegou — rota fora do matcher, ou falha
      // que so acontece no segundo `getUser`, ja no render.
      console.error("[sessao] nao foi possivel conferir a sessao", {
        nome: error.name,
        status: error.status,
      });
      throw new SessaoIndisponivelError();
    }
    return null;
  }

  return data.user;
});

/** `?proximo=<caminho>`, ou nada quando nao ha caminho para guardar. */
function consulta(caminho: string): string {
  return caminho ? `?proximo=${encodeURIComponent(caminho)}` : "";
}

/**
 * Exige sessão. Sem ela, redireciona para `/entrar` guardando o destino.
 *
 * Todo server component sob `/app/*` chama isto — **mesmo com o proxy já
 * protegendo a rota**. Não é redundância inútil: o proxy é uma peça só, e uma
 * falha de `matcher`, um `rewrite` novo ou uma rota que alguém adiciona fora do
 * padrão bastam para furá-lo. Quem renderiza o dado é quem tem que conferir se
 * pode. O proxy evita a viagem; isto evita o vazamento.
 */
export async function exigirUsuario(destino?: string): Promise<User> {
  // Lido antes do `try`: `redirect()` funciona lancando, entao qualquer
  // `await` dentro do `catch` viria depois de a decisao ja estar tomada.
  const caminho = destino ?? (await headers()).get("x-caminho") ?? "";

  let usuario: User | null;
  try {
    usuario = await usuarioAtual();
  } catch (erro) {
    // Nao deu para conferir a sessao. Redirect, e nao `throw`: um `error.tsx`
    // NAO captura o que o `layout.tsx` de um segmento lanca durante o SSR — o
    // que sai e a tela generica do Next com 500 (verificado em dev e em
    // producao). E mandar para `/entrar` seria pior ainda: diria a quem tem
    // cookie valido que foi desconectado.
    if (erro instanceof SessaoIndisponivelError) {
      redirect(`/indisponivel${consulta(caminho)}`);
    }
    throw erro;
  }

  if (usuario) return usuario;

  // Sem `destino` explicito, vale o caminho que o proxy anotou no cabecalho.
  // Isso importa porque o LAYOUT resolve antes das paginas: era o redirect
  // dele que vencia, e o `destino` que cada pagina passava nunca chegava a
  // valer. Assim o usuario volta para onde queria ir, venha o redirect de onde
  // vier.
  redirect(`/entrar${consulta(caminho)}`);
}
