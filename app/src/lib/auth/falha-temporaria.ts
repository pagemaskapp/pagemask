import type { AuthError } from "@supabase/supabase-js";

/**
 * O erro de sessao diz "nao deu para conferir agora" ou diz "nao esta logado"?
 *
 * A pergunta parece detalhe e nao e: as duas respostas mandam o usuario para
 * lugares opostos. "Nao esta logado" leva a `/entrar`. "Nao deu para conferir"
 * leva a `/indisponivel` — porque mandar para o login quem tem cookie valido e
 * dizer, com todas as letras, que a sessao dele acabou. Ele tenta entrar de
 * novo, contra um servico que esta fora do ar, e conclui que perdeu a conta.
 *
 * Mora num arquivo proprio, sem `server-only`, porque **os dois lados precisam
 * responder igual**: o `proxy.ts` (runtime edge) e o `exigirUsuario` dos server
 * components. Quando a regra estava escrita duas vezes, as duas versoes
 * comparavam so `AuthRetryableFetchError` — que cobre rede caida, e nao cobre o
 * Supabase respondendo. Um 429 (limite da plataforma) ou um 500 chegam como
 * `AuthApiError`, e os dois lados concluiam "nao esta logado" e deslogavam
 * sessao boa em silencio, que e exatamente o que este projeto nao pode fazer.
 *
 * O que NAO entra aqui: 400, 401 e 403. Esses sao respostas legitimas sobre o
 * token — invalido, vencido, revogado — e a conclusao certa para eles e mesmo
 * "nao esta logado".
 */
export function ehFalhaTemporaria(erro: AuthError | null | undefined): boolean {
  if (!erro) return false;

  // Sem rede, DNS fora, fetch abortado: o supabase-js nem chegou a falar com o
  // servidor.
  if (erro.name === "AuthRetryableFetchError") return true;

  // Sem `status` é sempre infraestrutura. Medido nas classes do auth-js 2.116:
  // todo erro que significa "nao esta logado" traz status 400
  // (`AuthSessionMissingError`, `AuthInvalidJwtError`,
  // `AuthInvalidCredentialsError`); os unicos sem status sao
  // `AuthRetryableFetchError` e `AuthUnknownError`.
  //
  // `AuthUnknownError` importa mais do que o nome sugere: e nele que cai
  // qualquer resposta que nao seja JSON — um 429 em HTML de um Cloudflare na
  // frente do Supabase, por exemplo. Fora desta lista, uma protecao de borda
  // derrubando o projeto viraria logout em massa de gente com cookie valido.
  if (erro.status === undefined) return true;

  return erro.status === 429 || erro.status >= 500;
}
