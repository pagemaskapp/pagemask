import type { CookieOptions } from "@supabase/ssr";

/**
 * Opções do cookie de sessão (docs/PLANO.md, Segurança §1).
 *
 * O padrão do `@supabase/ssr` é `httpOnly: false`, porque o cliente de
 * navegador dele lê a sessão de `document.cookie`. Aqui isso é sobrescrito de
 * propósito: `httpOnly: true` tira o token do alcance de qualquer JavaScript
 * da página, que é a diferença entre um XSS virar incômodo e virar sequestro
 * de conta.
 *
 * **A consequência precisa ser lembrada nas próximas fases:** com `httpOnly`,
 * `createClient()` de `@/lib/supabase/browser` **não enxerga a sessão** — ele é
 * um cliente anônimo. Tudo que depende de identidade passa por server component,
 * server action ou route handler. Quando a Fase 3 precisar de Realtime
 * autenticado no navegador, o token para essa conexão terá que ser emitido pelo
 * servidor, de propósito e com escopo curto — não lido de um cookie.
 *
 * `secure` fica desligado só em desenvolvimento: `localhost` é http, e um
 * cookie `Secure` simplesmente não é enviado, o que faria o login parecer
 * quebrado sem nenhuma mensagem de erro.
 */
/**
 * Nome do cookie onde a sessão vive — incluindo o sufixo de pedaço (`.0`,
 * `.1`), que o `@supabase/ssr` usa quando o valor não cabe num cookie só.
 *
 * Mora aqui, junto das opções do cookie, porque **duas partes do sistema
 * precisam da mesma resposta**: o proxy, para saber se vale a pena perguntar ao
 * Supabase, e a rota de confirmação, para saber se a sessão de fato virou
 * cookie. Escrito duas vezes, bastaria uma das cópias mudar para o proxy parar
 * de renovar sessão e todo mundo ser deslogado uma hora depois de entrar, sem
 * erro nenhum.
 *
 * A âncora `$` é o que separa este cookie do `…-auth-token-code-verifier` do
 * PKCE, que tem 400 dias de validade e não é sessão.
 */
export const COOKIE_DE_SESSAO = /^sb-.+-auth-token(\.\d+)?$/;

export const cookieOptions: CookieOptions = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // `maxAge` NÃO entra aqui de propósito: o `@supabase/ssr` sobrescreve esse
  // campo com o padrão dele (400 dias) depois de espalhar estas opções, então
  // um valor escrito aqui seria ignorado em silêncio. Declará-lo daria a
  // impressão de que a duração da sessão se ajusta neste arquivo — e uma
  // tentativa futura de encurtá-la não teria efeito nenhum, sem erro.
  // Para mudar a validade, é preciso mexer no cookie na resposta.
};
