import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { publicEnv } from "@/lib/env/public";
import { caminhoDoPedido, destinoSeguro } from "@/lib/auth/destino";
import { ehFalhaTemporaria } from "@/lib/auth/falha-temporaria";
import { buildCsp } from "@/lib/security-headers";
import {
  COOKIE_DE_SESSAO,
  cookieOptions,
} from "@/lib/supabase/cookie-options";

/**
 * `proxy.ts` é o antigo `middleware.ts` (renomeado no Next 16).
 *
 * Faz três coisas, nesta ordem:
 *
 *   1. **Nonce da CSP.** O Next lê a CSP do cabeçalho da requisição, extrai o
 *      `'nonce-…'` e aplica em todo script que emite — inclusive nos inline de
 *      hidratação. Sem isso, `script-src 'self'` derrubaria a página inteira.
 *
 *   2. **Renova a sessão.** É aqui, e só aqui, que o refresh token vira um
 *      access token novo e volta para o cookie. Server component não escreve
 *      cookie; sem esta etapa a sessão morreria em uma hora.
 *
 *   3. **Protege `/app/*`.** Visitante sem sessão vai para `/entrar` antes de
 *      qualquer render. Isso economiza a viagem — mas quem garante que o dado
 *      não vaza é a checagem em cada server component (`exigirUsuario`).
 *
 * O cuidado que percorre o arquivo inteiro: **nenhum caminho de saída pode
 * perder o `Set-Cookie` da renovação**. Um refresh token do Supabase é rotativo
 * — usá-lo invalida o anterior. Se o token novo é emitido mas a resposta sai
 * sem o cookie, o usuário fica com um token já queimado no navegador e é
 * deslogado sozinho pouco depois, sem erro nenhum que explique o porquê.
 */

/** Prefixos que exigem sessão. */
const PROTEGIDAS = ["/app"];

/** Rotas de entrada: quem já está logado não tem o que fazer nelas. */
const SO_PARA_VISITANTE = ["/entrar", "/cadastrar"];

function ehProtegida(pathname: string): boolean {
  return PROTEGIDAS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Monta os cabeçalhos que seguem para o render, **lendo o `request` agora**.
 *
 * Ler uma vez no começo e reaproveitar não funciona: `request.cookies.set()`
 * atualiza o cabeçalho `cookie` do request, e uma cópia feita antes disso
 * carrega o cookie **antigo**. O render receberia o token já rotacionado e
 * pediria outro refresh, com o token anterior — que o Supabase acabou de
 * invalidar.
 */
function cabecalhosDoRender(
  request: NextRequest,
  nonce: string,
  csp: string,
): Headers {
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  // O caminho pedido, para o layout autenticado conseguir montar o
  // `?proximo=` quando ele mesmo precisar redirecionar. Server component não
  // tem acesso à URL da requisição de outro jeito. Vai limpo dos parâmetros
  // internos do Next — este cabeçalho vira destino de navegação.
  headers.set("x-caminho", caminhoDoPedido(request.nextUrl));
  return headers;
}

export async function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = buildCsp(nonce);

  let response = NextResponse.next({
    request: { headers: cabecalhosDoRender(request, nonce, csp) },
  });

  // Cabeçalhos anticache que o @supabase/ssr entrega junto com os cookies.
  // Guardados à parte para também acompanharem um redirect.
  let anticache: Record<string, string> = {};

  // Foto dos cookies como chegaram, tirada ANTES de a biblioteca poder mexer
  // neles. Serve a um caso só, o de `semRemocoes`: desfazer uma exclusão que
  // não deveria ter acontecido.
  const cookiesOriginais = request.cookies
    .getAll()
    .map(({ name, value }) => ({ name, value }));

  // Visitante sem cookie de sessão não precisa de viagem nenhuma ao Supabase: a
  // sessão vive só neste cookie, então sem ele a resposta é `null` de qualquer
  // jeito. Sem este atalho, cada página pública e cada prefetch custava um
  // `getUser()` — e essas chamadas contam no limite da plataforma, aproximando
  // justamente o 429 tratado mais abaixo.
  //
  // O padrão do nome vem de `cookie-options`, e não escrito de novo aqui: a rota
  // de confirmação faz a mesma pergunta, e duas cópias da mesma regra é uma
  // cópia esperando divergir.
  const temCookieDeSessao = request.cookies
    .getAll()
    .some((cookie) => COOKIE_DE_SESSAO.test(cookie.name));

  // Houve aqui um atalho que pulava a conferência de sessão em requisições de
  // prefetch. Ele saiu, e a medição que o derrubou merece ficar registrada para
  // ninguém reinventá-lo:
  //
  //   · O prefetch do `next/link` se anuncia com `Next-Router-Prefetch` e `RSC`,
  //     e o Next **remove os dois antes do proxy** (Next 16.3.4: o que chega
  //     aqui é `accept, cookie, host, user-agent, x-forwarded-*`, e mais nada).
  //     Ou seja, o atalho nunca pegava o caso que motivou escrevê-lo.
  //   · E abria um risco real: pulando a renovação aqui, ela acontece no render,
  //     onde server component não escreve cookie e a gravação é engolida. O
  //     refresh token é rotativo — gasta-se o antigo e o novo nunca chega ao
  //     navegador, que é logout silencioso alguns minutos depois.
  //
  // O custo que ele tentava evitar (uma ida ao Supabase por navegação de quem
  // está logado) continua de pé, e a saída para ele é outra: verificar a
  // assinatura do access token aqui mesmo, com o JWKS do projeto, em vez de
  // perguntar ao Supabase. Fica anotado para uma fase própria — verificação
  // local não enxerga sessão revogada, e essa troca precisa ser decidida de
  // propósito, não enfiada no meio de outra coisa.

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        // `setAll` é chamado MAIS DE UMA VEZ por requisição: a biblioteca
        // dispara uma vez pelas chaves de PKCE (com `headers` vazio) e outra
        // pelo `onAuthStateChange`. A versão anterior recriava a resposta a
        // cada chamada e jogava fora os cookies da anterior — e sobrescrevia o
        // anticache com `{}`, deixando uma resposta com `Set-Cookie` sem
        // `Cache-Control`. Por isso aqui tudo é acumulado, nunca substituído.
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          // A resposta precisa ser refeita para encaminhar o `request` com os
          // cookies atualizados; o que já estava nela é transportado junto.
          const jaGravados = response.cookies.getAll();
          const nova = NextResponse.next({
            request: { headers: cabecalhosDoRender(request, nonce, csp) },
          });
          for (const cookie of jaGravados) nova.cookies.set(cookie);
          for (const { name, value, options } of cookiesToSet) {
            nova.cookies.set(name, value, options);
          }

          // Resposta que grava cookie de sessão não pode ser cacheada por CDN:
          // o token de um usuário sairia servido para outro.
          anticache = { ...anticache, ...headers };
          for (const [chave, valor] of Object.entries(anticache)) {
            nova.headers.set(chave, valor);
          }

          response = nova;
        },
      },
    },
  );

  // `getUser()` valida o token no servidor do Supabase — e é a chamada que
  // dispara o refresh quando o access token está vencido. Trocar por
  // `getSession()` aqui quebraria a renovação e aceitaria cookie forjado.
  const { data, error: erroDeSessao } = temCookieDeSessao
    ? await supabase.auth.getUser()
    : { data: { user: null }, error: null };
  const user = data.user;

  // Supabase fora do ar não é "usuário deslogado". Mandar para `/entrar` nesse
  // caso derrubaria todo mundo com cookie válido por causa de um 5xx passageiro
  // ou de um 429. A requisição segue; `exigirUsuario` no servidor decide, e ele
  // usa exatamente a mesma regra — é o mesmo `ehFalhaTemporaria`.
  const indisponivel = ehFalhaTemporaria(erroDeSessao);

  if (indisponivel) {
    // "Falha aberta, nunca calada" vale aqui também. Sem esta linha, um dia com
    // todo mundo caindo em `/indisponivel` não deixaria rastro nenhum — e a
    // diferença entre "Supabase fora do ar" e "estouramos o limite do nosso
    // próprio projeto" é justamente `status`, que só aparece se for registrado.
    console.error("[proxy] não foi possível conferir a sessão", {
      nome: erroDeSessao?.name,
      status: erroDeSessao?.status,
    });

    // E o cookie NÃO pode ir embora junto. Quando o access token já venceu, um
    // 429 ou 5xx na renovação faz o auth-js concluir que a sessão morreu e
    // emitir os cookies de remoção (`_removeSession`, verificado na fonte). Mas
    // o refresh token não foi recusado por ser inválido: ele foi barrado por
    // volume, ou o servidor nem respondeu. Apagá-lo transformaria uma
    // instabilidade de minutos em um logout definitivo.
    //
    // A limpeza acontece AQUI, e não em cada saída, porque as saídas são
    // muitas: o redirect para `/indisponivel` cobre `/app/*`, mas `/`,
    // `/entrar`, `/cadastrar` e as outras seguem para o render — e por elas a
    // remoção escapava.
    response = semRemocoes(
      response,
      request,
      nonce,
      csp,
      anticache,
      cookiesOriginais,
    );
  }

  const { pathname } = request.nextUrl;

  if (indisponivel && ehProtegida(pathname)) {
    // Nem `/entrar` (mentiria que a sessão acabou, e a pessoa tentaria entrar
    // de novo contra um serviço fora do ar) nem seguir para o render (gastaria
    // a viagem para chegar na mesma conclusão). O caminho vai junto para o
    // "Tentar de novo" voltar para onde a pessoa estava indo.
    const url = new URL("/indisponivel", request.nextUrl.origin);
    url.searchParams.set("proximo", caminhoDoPedido(request.nextUrl));
    return finalizar(redirecionar(url), response, anticache, csp);
  }

  if (!user && ehProtegida(pathname)) {
    const url = new URL("/entrar", request.nextUrl.origin);
    url.searchParams.set("proximo", caminhoDoPedido(request.nextUrl));
    return finalizar(redirecionar(url), response, anticache, csp);
  }

  // `GET` na condição, e não só o caminho: um POST para `/entrar` é o ENVIO do
  // formulário, e desviá-lo mata a server action antes de ela rodar. Com duas
  // abas abertas — uma que acabou de entrar na conta A, outra com o login da
  // conta B na tela — enviar as credenciais de B caía direto no painel de A,
  // sem mensagem nenhuma, como se a senha de B tivesse funcionado.
  if (user && request.method === "GET" && SO_PARA_VISITANTE.includes(pathname)) {
    // Honra o `?proximo=` em vez de descartá-lo. Quem clicou num link para
    // `/app/conta`, foi mandado para o login e ainda tinha sessão válida
    // precisa cair em `/app/conta` — não numa lista de projetos, tendo que
    // procurar de novo o que já pediu. `destinoSeguro` faz a mesma validação
    // de sempre; o valor vem da URL e não é confiável.
    const destino = destinoSeguro(request.nextUrl.searchParams.get("proximo"));
    return finalizar(
      redirecionar(new URL(destino, request.nextUrl.origin)),
      response,
      anticache,
      csp,
    );
  }

  return finalizar(response, response, anticache, csp);
}

/**
 * Devolve a resposta sem os cookies de EXCLUSÃO que ela estiver carregando.
 *
 * Cookie de valor vazio é uma ordem de apagar. Quando a sessão não pôde ser
 * conferida, essa ordem não pode sair daqui — ver o ramo que chama isto. Os
 * cookies de verdade (uma renovação que tenha dado certo antes da falha, as
 * chaves de PKCE) continuam.
 */
function semRemocoes(
  atual: NextResponse,
  request: NextRequest,
  nonce: string,
  csp: string,
  anticache: Record<string, string>,
  originais: { name: string; value: string }[],
): NextResponse {
  // Devolver ao REQUEST **só o que foi apagado**, não a foto inteira. A
  // biblioteca já tinha chamado `request.cookies.set(nome, "")` ao concluir que
  // a sessão morreu, e o render lê o cookie de lá — sem isto, a resposta
  // preservaria a sessão no navegador enquanto a página daquela mesma
  // requisição renderizaria como visitante.
  //
  // Restaurar tudo seria pior do que não restaurar nada num caso específico:
  // quando a renovação DEU CERTO e a falha veio depois dela (o `/user`
  // respondeu 429). Aí o navegador recebe o token novo e o render receberia de
  // volta o antigo — que a renovação acabou de queimar, porque o refresh token
  // do Supabase é rotativo.
  for (const cookie of originais) {
    if (request.cookies.get(cookie.name)?.value !== "") continue;
    request.cookies.set(cookie.name, cookie.value);
  }

  const limpa = NextResponse.next({
    request: { headers: cabecalhosDoRender(request, nonce, csp) },
  });

  for (const cookie of atual.cookies.getAll()) {
    if (cookie.value === "") continue;
    limpa.cookies.set(cookie);
  }
  for (const [chave, valor] of Object.entries(anticache)) {
    limpa.headers.set(chave, valor);
  }

  return limpa;
}

/**
 * Redirect com **303**, não com o 307 padrão do `NextResponse.redirect`.
 *
 * 307 preserva o método: uma server action enviada com a sessão vencida seria
 * re-enviada como POST para `/entrar`, que não espera POST nenhum. 303 diz ao
 * navegador para buscar o destino com GET, que é o que faz sentido quando a
 * resposta é "vá para outro lugar", e não "reenvie isto ali".
 *
 * O destino é montado com `new URL(...)`, nunca atribuindo a `url.pathname`:
 * atribuir um caminho que já traz query percent-encoda o `?`, e
 * `/app/conta?aba=x` viraria `/app/conta%3Faba=x` — um 404.
 */
function redirecionar(url: URL): NextResponse {
  return NextResponse.redirect(url, 303);
}

/**
 * Fecha a resposta que vai sair, seja ela o `next()` ou um redirect.
 *
 * O redirect é um objeto novo, criado fora do fluxo do cliente Supabase: ele
 * não herda nada. Sem esta função ele sairia **sem os cookies da renovação**
 * (deslogando o usuário na navegação seguinte), sem os cabeçalhos anticache, e
 * com a CSP sem nonce do `next.config`.
 */
function finalizar(
  saida: NextResponse,
  comCookies: NextResponse,
  anticache: Record<string, string>,
  csp: string,
): NextResponse {
  const ehRedirect = saida !== comCookies;

  if (ehRedirect) {
    for (const cookie of comCookies.cookies.getAll()) {
      saida.cookies.set(cookie);
    }
    for (const [chave, valor] of Object.entries(anticache)) {
      saida.headers.set(chave, valor);
    }
  }

  // Redirect do Next sai sem `Cache-Control` nenhum (medido). Um "/app/x →
  // /entrar" guardado por CDN mandaria para o login um usuário que já está
  // logado; o inverso é pior. Decisão de sessão nunca é cacheável — e todo
  // redirect daqui é decisão de sessão, tenha ele cookie ou não.
  //
  // A segunda metade da condição cobre a resposta que NÃO é redirect mas leva
  // `Set-Cookie`: quando a renovação vem por uma chamada de `setAll` com o lote
  // de cabeçalhos vazio (é o que a biblioteca faz nas chaves de PKCE), o
  // `anticache` fica `{}` e a resposta seguiria com o cookie de sessão sem
  // instrução de cache nenhuma vinda daqui.
  const levaCookie = saida.cookies.getAll().length > 0;
  if ((ehRedirect || levaCookie) && !saida.headers.has("Cache-Control")) {
    saida.headers.set("Cache-Control", "private, no-store, max-age=0");
  }

  saida.headers.set("Content-Security-Policy", csp);
  return saida;
}

export const config = {
  // Todo documento passa por aqui. Fora ficam só `_next/` (chunk, imagem
  // otimizada, HMR — nunca um documento) e o favicon.
  //
  // Aqui havia também uma lista de extensões (`.png`, `.woff`, `.mp4`…) para
  // poupar uma ida ao Supabase por arquivo servido de `public/`. Ela saiu por
  // dois motivos. O primeiro: a lista casa pelo **fim do caminho**, e não pelo
  // arquivo existir — então o 404 de `/qualquer.png`, que é um documento HTML
  // completo com script inline, escapava do proxy e saía com a CSP sem nonce,
  // sem hidratar nunca (medido). O segundo: a economia que ela dava já vem de
  // outro lugar — o atalho do `temCookieDeSessao`, que não fala com o Supabase
  // quando não há sessão, e `_next/static`, que é de onde vem quase todo asset.
  //
  // `public/` hoje tem só o favicon. Quando entrar arquivo de verdade ali, a
  // exclusão volta **por prefixo de caminho** (`/imagens/…`), nunca por
  // extensão: extensão não diz onde o arquivo está nem se ele existe.
  //
  // A entrada `/app` explícita fica: ela garante que nenhuma regra futura de
  // exclusão consiga, por descuido, tirar uma rota autenticada do proxy.
  //
  // A documentação do Next sugere excluir também os prefetch. Não aqui: um
  // pedido com `Purpose: prefetch` devolve documento HTML completo, e sem
  // passar por este proxy ele sai com a CSP sem nonce — o navegador guarda
  // esse documento e, na navegação seguinte, bloqueia todo script da página.
  // `favicon\.ico$` com ponto escapado e âncora: sem os dois, a exclusão vale
  // por PREFIXO e com o ponto casando qualquer caractere, então
  // `/favicon.ico.map`, `/favicon.icon` e `/faviconXico` saíam do proxy. Não são
  // arquivos — são 404, que o Next devolve como documento HTML com script
  // inline, e fora daqui esse documento sai com a CSP sem nonce e nunca hidrata.
  // É exatamente a falha que a remoção da lista de extensões veio consertar.
  //
  // `prova/` é a regra do parágrafo acima em uso. Os dois WebP do antes e
  // depois da landing (Fase 11) são os primeiros arquivos de verdade em
  // `public/`, e saem daqui **por prefixo de caminho**, não por extensão. Sem
  // isto, cada imagem custava um `getUser()` a mais por visita de quem está
  // logado — chamadas paralelas disputando o mesmo refresh token, que é
  // rotativo — e a resposta da imagem ainda podia sair com
  // `Cache-Control: private, no-store`. Não existe rota `/prova/*` no app: a
  // pasta só tem asset estático, então nada que dependa de sessão escapa por
  // aqui. Arquivo novo em `public/` pede uma entrada nova nesta lista.
  matcher: ["/app", "/app/:caminho*", "/((?!_next/|prova/|favicon\\.ico$).*)"],
};
