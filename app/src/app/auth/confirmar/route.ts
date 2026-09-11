import { NextResponse, type NextRequest } from "next/server";

import { destinoSeguro } from "@/lib/auth/destino";
import { createClient, sessaoGravadaNoCookie } from "@/lib/supabase/server";

/**
 * Toda resposta daqui grava (ou tenta gravar) o cookie de sessão, e um redirect
 * do Next sai sem `Cache-Control` por padrão. Sem isto, um proxy ou CDN no
 * caminho poderia guardar a resposta **com o `Set-Cookie` dentro** e entregar a
 * sessão de uma pessoa para a próxima que abrisse o mesmo link.
 */
function semCache(resposta: NextResponse): NextResponse {
  resposta.headers.set(
    "Cache-Control",
    "private, no-cache, no-store, max-age=0, must-revalidate",
  );
  resposta.headers.set("Pragma", "no-cache");
  resposta.headers.set("Expires", "0");
  return resposta;
}

/**
 * Destino do link que chega por e-mail: confirmação de cadastro e link de
 * acesso. Troca o código de uso único por uma sessão em cookie.
 *
 * **Só o fluxo PKCE** (`?code=…`, trocado por `exchangeCodeForSession`), e essa
 * é uma decisão de segurança, não uma limitação.
 *
 * Havia aqui um segundo ramo, `?token_hash=…&type=…` com `verifyOtp`, para o
 * caso de o template de e-mail ser trocado. Ele saiu porque estabelece sessão a
 * partir de um GET sem nada que ligue o token ao navegador que pediu o link.
 * Quem tem o token entra — e o token viaja no e-mail. Um atacante pede o link
 * da PRÓPRIA conta (o `token=` do template padrão do Supabase é justamente o
 * `TokenHash`), monta `/auth/confirmar?token_hash=…&type=signup` e manda para a
 * vítima: ela clica e cai logada **na conta dele**, onde tudo que ela subir e
 * toda conta do Instagram que ela conectar ficam com ele.
 *
 * O PKCE não tem essa brecha: a troca exige o verificador que ficou como cookie
 * no aparelho que iniciou o fluxo, e um link repassado a outra pessoa
 * simplesmente falha.
 *
 * O que se perde: confirmar o e-mail num aparelho diferente daquele em que a
 * conta foi criada. Hoje isso já não funciona (o verificador é do aparelho), e
 * o dia em que precisar funcionar não se resolve reabrindo este ramo — se
 * resolve com uma tela que peça um código digitado, que prova posse do e-mail
 * sem transformar um link encaminhado numa sessão.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const code = searchParams.get("code");

  // `proximo` vem da URL de um link de e-mail: a entrada menos confiável que
  // existe neste projeto. `destinoSeguro` recusa tudo que não seja caminho
  // interno — inclusive os caracteres de controle que o parser do navegador
  // apaga antes de resolver o endereço.
  const destino = destinoSeguro(searchParams.get("proximo"));

  const supabase = await createClient();

  // Qual verificador do PKCE usar, quando o auth-js manda essa informação de
  // volta na URL. Ela só aparece com `experimental.appendPkceFlowIdToRedirects`
  // ligado, que **não** está ligado — e a escolha é deliberada: esse sinalizador
  // faz TODO link de e-mail ganhar um parâmetro a mais, e a lista de Redirect
  // URLs do Supabase compara a URL inteira, query incluída — então cada
  // parâmetro novo é mais uma chance de o link cair fora da lista e ser
  // descartado em silêncio. (O `?proximo=` já obriga o curinga `**` na lista,
  // ver README; o ponto aqui é não somar um segundo motivo sem precisar.)
  //
  // O que se perde sem ele: dois fluxos PKCE em voo ao mesmo tempo (cadastrar e,
  // antes de confirmar, pedir um link de acesso) não são correlacionados, e o
  // link mais antigo cai em `/link-invalido` — a pessoa entra pelo mais novo.
  // Ler o parâmetro aqui custa nada e deixa a rota certa no dia em que ligarmos.
  const flowId = searchParams.get("sb_flow_id") ?? undefined;

  // O motivo da recusa não vai para a tela nem para a URL — mas precisa ir para
  // o log. Este é o único caminho de autenticação que ninguém vê falhar: o
  // usuário recebe "link inválido" e vai embora. Um template de e-mail trocado
  // ou uma Redirect URL fora da lista manda 100% das pessoas para
  // `/link-invalido`, e sem estas linhas não haveria nada em lugar nenhum
  // dizendo o porquê. Na Fase 10 vira alerta no Sentry.
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code, {
      flowId,
    });

    if (!error) {
      // Trocar o código não basta: a sessão precisa ter virado cookie. A
      // gravação pode falhar sem `exchangeCodeForSession` saber, e aí o redirect
      // mandaria a pessoa para dentro do app sem sessão — o proxy a devolveria
      // ao login, com o código do e-mail (que vale uma vez só) já gasto, num
      // vai-e-vem sem nenhuma mensagem. Melhor dizer que o link não funcionou.
      if (await sessaoGravadaNoCookie()) {
        return semCache(NextResponse.redirect(new URL(destino, origin)));
      }
      console.error(
        "[auth] código trocado com sucesso, mas a sessão não foi para o cookie",
      );
    } else {
      console.error("[auth] troca do código por sessão falhou", {
        codigo: error.code,
        status: error.status,
      });
    }
  } else {
    // Sem `?code=`. O template de e-mail do painel está mandando outra coisa —
    // `token_hash` (que esta rota recusa de propósito, ver o cabeçalho) ou os
    // tokens no fragmento da URL, que nem chegam ao servidor. Sem este log, a
    // diferença entre "link velho" e "painel mal configurado" é invisível.
    console.error("[auth] link de e-mail sem código PKCE", {
      parametros: [...searchParams.keys()].join(", ") || "(nenhum)",
    });
  }

  // Link vencido, já usado, ou aberto em outro navegador (o verificador PKCE
  // fica no aparelho que pediu). A mensagem em pt-BR está na página de erro; o
  // motivo exato não vai para a URL, porque diria a um atacante se um código é
  // válido ou não.
  return semCache(NextResponse.redirect(new URL("/link-invalido", origin)));
}
