import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import {
  COOKIE_DE_SESSAO,
  cookieOptions,
} from "@/lib/supabase/cookie-options";
import { publicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Cliente de servidor **com a sessao do usuario**, lida dos cookies. Usa a
 * chave publishable de proposito: as consultas continuam passando pela RLS, com
 * `auth.uid()` valendo o dono da sessao. E este o cliente de server component,
 * server action e route handler comum.
 *
 * Para o que precisa furar a RLS (webhook, worker, cron), use
 * `@/lib/supabase/admin` — e so ali.
 *
 * **Um cliente por requisicao, e nunca entre requisicoes.** O `cache()` do React
 * e o que garante as duas coisas: memoiza dentro da requisicao e joga fora no
 * fim dela, entao nunca atravessa usuarios.
 *
 * A memoizacao nao e economia — e correcao. Cada cliente guarda a sessao em
 * memoria propria. Com dois clientes no mesmo render (o de `usuarioAtual` e o
 * da pagina, por exemplo) e o access token vencido, os dois tentam renovar: o
 * primeiro gasta o refresh token, e a gravacao do novo e engolida porque server
 * component nao escreve cookie; o segundo le do cookie o token JA CONSUMIDO e
 * tenta de novo. Passada a janela de tolerancia do Supabase, isso falha, as
 * consultas caem para `anon`, a RLS nao devolve linha nenhuma — e a tela diz
 * "nao conseguimos carregar" para quem tem sessao perfeitamente valida.
 */
export const createClient = cache(async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // O segundo argumento (`headers`) traz o anticache que a biblioteca
        // recomenda para resposta que grava cookie. Ele nao e aplicado aqui
        // porque `cookies()` do Next nao da acesso aos cabecalhos da resposta —
        // nao ha onde poe-los. A cobertura vem de outros dois lados, os dois
        // medidos: o Next ja marca resposta dinamica e retorno de server action
        // como `private, no-cache, no-store`, e os redirects que gravam sessao
        // (`proxy.ts` e `/auth/confirmar`) setam os cabecalhos na mao, porque
        // esses o Next deixa sem nenhum.
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch (erro) {
            // Server component nao pode escrever cookie, e ali ignorar e o
            // comportamento certo: o refresh de sessao acontece no `proxy.ts`,
            // que escreve na resposta.
            //
            // Mas este mesmo cliente e usado por server action e por
            // `/auth/confirmar`, onde a gravacao NAO e opcional — e um `catch`
            // vazio transformava a falha ali num ciclo mudo: o link do e-mail
            // levaria de volta ao login, para sempre, sem uma linha de log em
            // lugar nenhum. Por isso so o caso conhecido fica quieto; qualquer
            // outro grita.
            const mensagem = erro instanceof Error ? erro.message : String(erro);
            const ehServerComponent =
              /only be modified in a Server Action or Route Handler/i.test(
                mensagem,
              );
            if (ehServerComponent) return;

            console.error("[supabase] nao foi possivel gravar o cookie de sessao", {
              mensagem,
            });
          }
        },
      },
    },
  );
});

/**
 * Tudo que o `@supabase/ssr` grava em nome da sessao, **incluindo** o
 * `…-auth-token-code-verifier` do PKCE. Casa pelo comeco, sem ancora, de
 * proposito: e o padrao da LIMPEZA, onde levar o verificador junto e desejado.
 *
 * Nao confundir com `COOKIE_DE_SESSAO` (importado de `cookie-options`), que e
 * ancorado e responde outra pergunta: "existe sessao?". Verificador nao e
 * sessao.
 */
const TUDO_DA_SESSAO = /^sb-.+-auth-token/;

/**
 * A sessao esta gravada no cookie DESTA resposta?
 *
 * Serve a quem nao pode seguir em frente sem ela — hoje, `/auth/confirmar`. La
 * a gravacao nao e opcional: se ela falhar, `exchangeCodeForSession` ainda
 * devolve sucesso, a rota redireciona para dentro do app, o proxy nao acha
 * sessao nenhuma e devolve a pessoa para o login. O codigo do e-mail, que vale
 * uma vez so, ja foi gasto — e a pessoa fica num vai-e-vem sem nunca ver um
 * erro. Perguntar aqui transforma isso numa falha visivel.
 */
export async function sessaoGravadaNoCookie(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .some((cookie) => COOKIE_DE_SESSAO.test(cookie.name) && cookie.value !== "");
}

/**
 * Apaga a sessao do navegador na marra.
 *
 * Existe por causa de um caminho especifico do `auth-js` 2.116: quando
 * `signOut()` nao consegue ler a sessao — rede fora, refresh falhando — ele sai
 * de `_signOut` **antes** de remover o cookie e devolve o erro. Quem ignorasse
 * esse erro mandaria o usuario para `/entrar` ainda logado, e o proxy o jogaria
 * de volta para dentro do app sem nenhuma mensagem: o botao "Sair" simplesmente
 * nao sairia.
 *
 * Chamar isto encerra o acesso **neste navegador**, que e exatamente o que a
 * tela promete. O que ele nao faz e revogar o refresh token no servidor — por
 * isso quem chama avisa o usuario de que a saida foi parcial.
 *
 * So funciona onde da para escrever cookie: server action e route handler.
 */
export async function esquecerSessaoNoNavegador(): Promise<void> {
  const cookieStore = await cookies();

  for (const cookie of cookieStore.getAll()) {
    if (!TUDO_DA_SESSAO.test(cookie.name)) continue;
    // `path` igual ao da escrita: cookie so e apagado quando nome e caminho
    // batem — com outro `path`, o navegador guarda os dois e o antigo continua
    // sendo enviado.
    cookieStore.delete({ name: cookie.name, path: cookieOptions.path });
  }
}
