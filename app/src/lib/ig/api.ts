import "server-only";

import { requireServerEnv } from "@/lib/env/server";

/**
 * Os endpoints do **Business Login for Instagram** (Instagram API with
 * Instagram Login). Conferidos na documentação oficial da Meta em 11/09/2026,
 * como manda o prompt da Fase 4 — e como manda o CLAUDE.md ("APIs externas:
 * confira a documentação oficial atual antes de implementar").
 *
 * O que a conferência devolveu, e que vale registrar porque muda decisões:
 *
 *   · O `code` da autorização vale **1 hora e é de uso único**. A segunda
 *     tentativa com o mesmo `code` é recusada pela Meta — o cross-check da
 *     fase testa exatamente isso.
 *   · O token longo vale **60 dias** e só pode ser renovado depois de ter
 *     **pelo menos 24 horas de vida**. Renovar antes disso é erro, não
 *     no-op: é por isso que o cron precisa saber distinguir "cedo demais" de
 *     "falhou de verdade" — ver `ehCedoParaRenovar`.
 *   · Token que passa 60 dias sem renovação expira e não volta: só
 *     reautorizando.
 *
 * TRÊS HOSTS DIFERENTES, DE PROPÓSITO
 * ===================================
 *
 * `www.instagram.com` autoriza, `api.instagram.com` troca o code, e
 * `graph.instagram.com` faz todo o resto. Não é redundância nem legado: são
 * três serviços distintos da Meta, e trocar um pelo outro devolve 404 ou um
 * erro de OAuth que não explica nada. Por isso ficam aqui em constantes, e não
 * montados por concatenação em cada chamada.
 */

const AUTORIZACAO = "https://www.instagram.com/oauth/authorize";
const TOKEN_CURTO = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";

/**
 * A versão fica presa aqui de propósito. Chamada sem versão para o Graph é
 * atendida pela versão **mais antiga ainda viva**, que muda sozinha quando a
 * Meta aposenta uma — ou seja, o comportamento do produto mudaria sem deploy
 * nenhum e sem aviso. Com a versão presa, uma mudança de contrato aparece como
 * erro claro no dia em que ela for aposentada, e não como comportamento novo.
 */
const VERSAO = "v25.0";

/** Os dois escopos do PLANO. `basic` lê o perfil; `content_publish` publica. */
export const ESCOPOS = [
  "instagram_business_basic",
  "instagram_business_content_publish",
] as const;

/**
 * Teto de espera para qualquer chamada à Meta.
 *
 * Sem ele, um `fetch` pendurado prende o handler até o limite da plataforma —
 * e no callback do OAuth isso é uma janela do navegador parada em branco,
 * enquanto o `code` (que vale 1 hora) já pode ter sido consumido do outro lado.
 */
const TIMEOUT_MS = 15_000;

export class ErroDaMeta extends Error {
  constructor(
    /** `rede` = não chegou lá. `meta` = ela respondeu recusando. */
    readonly origem: "rede" | "meta" | "formato",
    readonly detalhe: string,
    readonly codigo?: number,
    readonly subcodigo?: number,
    readonly tipo?: string,
  ) {
    super(detalhe);
    this.name = "ErroDaMeta";
  }
}

/**
 * A URL para onde o popup vai. `state` já assinado por quem chama.
 *
 * `force_reauth=true` existe para o caso mais comum de suporte: alguém que já
 * está logado no Instagram com a conta errada no navegador. Sem ele, a Meta
 * autoriza silenciosamente com a sessão que encontrar, e a pessoa conecta um
 * perfil sem nunca ter visto a tela de escolha — e não entende por que
 * apareceu outro @.
 */
export function urlDeAutorizacao(state: string): string {
  const url = new URL(AUTORIZACAO);
  url.searchParams.set("client_id", requireServerEnv("IG_APP_ID"));
  url.searchParams.set("redirect_uri", requireServerEnv("IG_REDIRECT_URI"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ESCOPOS.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("force_reauth", "true");
  return url.toString();
}

export type TokenCurto = {
  accessToken: string;
  igUserId: string;
  permissoes: string[];
};

/**
 * Troca o `code` por um token de 1 hora.
 *
 * A resposta tem DUAS formas no mundo real: o objeto solto que a API antiga
 * devolvia e o `{"data":[{…}]}` do Business Login. Ler as duas é mais barato
 * que descobrir, num sábado, que a Meta mudou o envelope — e mais honesto que
 * afirmar que só existe uma.
 */
export async function trocarCodePorTokenCurto(code: string): Promise<TokenCurto> {
  const corpo = new URLSearchParams({
    client_id: requireServerEnv("IG_APP_ID"),
    client_secret: requireServerEnv("IG_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: requireServerEnv("IG_REDIRECT_URI"),
    code,
  });

  const json = await pedir(TOKEN_CURTO, {
    method: "POST",
    body: corpo,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

  const raiz = json as Record<string, unknown>;
  const lista = raiz.data;
  const alvo = (
    Array.isArray(lista) && lista.length > 0 ? lista[0] : raiz
  ) as Record<string, unknown>;

  const accessToken = alvo.access_token;
  const igUserId = alvo.user_id;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ErroDaMeta("formato", "resposta sem `access_token`");
  }
  if (typeof igUserId !== "string" && typeof igUserId !== "number") {
    throw new ErroDaMeta("formato", "resposta sem `user_id`");
  }

  const permissoes =
    typeof alvo.permissions === "string"
      ? alvo.permissions.split(",").map((p) => p.trim()).filter(Boolean)
      : Array.isArray(alvo.permissions)
        ? alvo.permissions.map(String)
        : [];

  return { accessToken, igUserId: String(igUserId), permissoes };
}

export type TokenLongo = {
  accessToken: string;
  /** Já convertido de `expires_in` (segundos) para o instante do vencimento. */
  expiraEm: Date;
};

export function trocarPorTokenLongo(tokenCurto: string): Promise<TokenLongo> {
  const url = new URL(`${GRAPH}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", requireServerEnv("IG_APP_SECRET"));
  url.searchParams.set("access_token", tokenCurto);
  return tokenComPrazo(url, tokenCurto);
}

export function renovarToken(tokenLongo: string): Promise<TokenLongo> {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", tokenLongo);
  return tokenComPrazo(url, tokenLongo);
}

async function tokenComPrazo(url: URL, tokenEnviado: string): Promise<TokenLongo> {
  const json = (await pedir(url.toString(), { method: "GET" }, tokenEnviado)) as Record<
    string,
    unknown
  >;

  const accessToken = json.access_token;
  const expiresIn = json.expires_in;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ErroDaMeta("formato", "resposta sem `access_token`");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ErroDaMeta("formato", "resposta sem `expires_in` utilizável");
  }

  return { accessToken, expiraEm: new Date(Date.now() + expiresIn * 1000) };
}

export type PerfilDoInstagram = {
  igUserId: string;
  username: string;
  fotoUrl: string | null;
  /** `BUSINESS`, `MEDIA_CREATOR`, `PERSONAL` — ou `null` quando a Meta omite. */
  tipoDeConta: string | null;
};

/**
 * O perfil da conta recém-conectada.
 *
 * `account_type` é pedido porque o passo 4 do prompt depende dele para dizer
 * "sua conta não é Profissional" em vez de um erro cru. Mas um campo que a Meta
 * não reconheça derruba a requisição INTEIRA com `code: 100` — e aí a conexão
 * falharia por causa de um campo informativo. Por isso a segunda tentativa com
 * o conjunto mínimo: é melhor conectar sem saber o tipo da conta do que não
 * conectar.
 */
export async function buscarPerfil(token: string): Promise<PerfilDoInstagram> {
  const completo = "user_id,username,profile_picture_url,account_type";
  const minimo = "user_id,username";

  let json: Record<string, unknown>;
  try {
    json = (await perfilComCampos(token, completo)) as Record<string, unknown>;
  } catch (erro) {
    if (erro instanceof ErroDaMeta && erro.codigo === 100) {
      console.warn("[ig] campo recusado pela Meta em /me; tentando o mínimo", {
        detalhe: erro.detalhe,
      });
      json = (await perfilComCampos(token, minimo)) as Record<string, unknown>;
    } else {
      throw erro;
    }
  }

  const igUserId = json.user_id ?? json.id;
  const username = json.username;
  if (typeof igUserId !== "string" && typeof igUserId !== "number") {
    throw new ErroDaMeta("formato", "perfil sem `user_id`");
  }
  if (typeof username !== "string" || username.length === 0) {
    throw new ErroDaMeta("formato", "perfil sem `username`");
  }

  return {
    igUserId: String(igUserId),
    username,
    fotoUrl:
      typeof json.profile_picture_url === "string" && json.profile_picture_url
        ? json.profile_picture_url
        : null,
    tipoDeConta:
      typeof json.account_type === "string" ? json.account_type : null,
  };
}

function perfilComCampos(token: string, campos: string): Promise<unknown> {
  const url = new URL(`${GRAPH}/${VERSAO}/me`);
  url.searchParams.set("fields", campos);
  // O token vai no cabeçalho, e não na query. Query string entra em log de
  // proxy, em Referer e no histórico de qualquer intermediário; cabeçalho de
  // autorização, não. Os endpoints de troca acima não têm essa opção — eles
  // exigem o token como parâmetro —, mas o Graph tem, e onde dá, usa-se.
  return pedir(
    url.toString(),
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    token,
  );
}

/**
 * `true` quando a Meta recusou a renovação por o token ainda não ter 24 h.
 *
 * Isso não é falha da conta: é o cron alcançando um token recém-criado. Tratar
 * como falha marcaria `needs_reconnect` e mandaria e-mail para quem acabou de
 * conectar — o pior momento possível para dizer "reconecte".
 */
export function ehCedoParaRenovar(erro: unknown): boolean {
  if (!(erro instanceof ErroDaMeta)) return false;
  return /24\s*hours|24h|too soon|not old enough/i.test(erro.detalhe);
}

/**
 * Uma requisição à Meta, com prazo, com erro tipado e **sem token no log**.
 *
 * `tokenEnviado` não é usado na requisição: serve só para remover o token da
 * mensagem de erro, caso a Meta o devolva ecoado. Vale a rede de segurança —
 * mensagem de erro é o lugar mais fácil de um segredo escapar (PLANO §3).
 */
async function pedir(
  url: string,
  init: RequestInit,
  tokenEnviado?: string,
): Promise<unknown> {
  let resposta: Response;
  try {
    resposta = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (erro) {
    throw new ErroDaMeta(
      "rede",
      erro instanceof Error ? redigir(erro.message, tokenEnviado) : "falha de rede",
    );
  }

  const texto = await resposta.text();
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new ErroDaMeta(
      "formato",
      `resposta ${resposta.status} não era JSON`,
    );
  }

  const corpo = json as Record<string, unknown>;

  // A Meta tem dois formatos de erro e usa os dois: `{error:{…}}` no Graph e
  // `{error_type, code, error_message}` no `api.instagram.com`.
  const aninhado = corpo.error as Record<string, unknown> | undefined;
  const temErro =
    (aninhado && typeof aninhado === "object") ||
    typeof corpo.error_message === "string" ||
    !resposta.ok;

  if (temErro) {
    const mensagem =
      (typeof aninhado?.message === "string" ? aninhado.message : undefined) ??
      (typeof corpo.error_message === "string" ? corpo.error_message : undefined) ??
      `HTTP ${resposta.status}`;
    const codigo =
      typeof aninhado?.code === "number"
        ? aninhado.code
        : typeof corpo.code === "number"
          ? corpo.code
          : undefined;
    const subcodigo =
      typeof aninhado?.error_subcode === "number" ? aninhado.error_subcode : undefined;
    const tipo =
      (typeof aninhado?.type === "string" ? aninhado.type : undefined) ??
      (typeof corpo.error_type === "string" ? corpo.error_type : undefined);

    throw new ErroDaMeta(
      "meta",
      redigir(mensagem, tokenEnviado),
      codigo,
      subcodigo,
      tipo,
    );
  }

  return json;
}

export type LimiteDePublicacao = {
  /** Publicacoes feitas pela API na janela (`quota_usage`). */
  usados: number;
  /** Teto da janela (`config.quota_total`). 100 por 24 h, hoje. */
  total: number;
  /** Tamanho da janela em segundos (`config.quota_duration`). */
  duracaoS: number;
};

/**
 * `GET /{ig_user_id}/content_publishing_limit?fields=quota_usage,config`.
 *
 * Conferido na referencia em 11/09/2026: a resposta e
 * `{ data: [{ quota_usage, config: { quota_total, quota_duration } }] }`, e o
 * limite documentado e de 100 publicacoes pela API por janela movel de 24 h.
 * `since` (Unix, no maximo 24 h atras) restringe a contagem a partir de um
 * instante — util para saber quantas publicacoes ainda vao contar contra um
 * horario futuro.
 *
 * `total` e `duracaoS` vem da Meta, nunca de constante: se a cota mudar, a
 * tela muda junto sem deploy.
 */
export async function consultarLimiteDePublicacao(
  token: string,
  igUserId: string,
  desde?: Date,
): Promise<LimiteDePublicacao> {
  const url = new URL(`${GRAPH}/${VERSAO}/${encodeURIComponent(igUserId)}/content_publishing_limit`);
  url.searchParams.set("fields", "quota_usage,config");
  if (desde) {
    url.searchParams.set("since", String(Math.floor(desde.getTime() / 1000)));
  }

  const json = (await pedir(
    url.toString(),
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    token,
  )) as Record<string, unknown>;

  const lista = json.data;
  const item = (Array.isArray(lista) && lista.length > 0 ? lista[0] : json) as Record<
    string,
    unknown
  >;
  const config = (item.config ?? {}) as Record<string, unknown>;

  const usados = item.quota_usage;
  if (typeof usados !== "number" || !Number.isFinite(usados)) {
    throw new ErroDaMeta("formato", "resposta sem `quota_usage`");
  }
  const total =
    typeof config.quota_total === "number" && config.quota_total > 0
      ? config.quota_total
      : 100;
  const duracaoS =
    typeof config.quota_duration === "number" && config.quota_duration > 0
      ? config.quota_duration
      : 86_400;

  return { usados, total, duracaoS };
}

/**
 * `true` quando a Meta disse que o token nao vale mais: `code 190`
 * (OAuthException, token invalido ou vencido) ou `102` (sessao invalida).
 * E o unico caso em que a conta deve virar `needs_reconnect` — os outros
 * erros nao dizem nada sobre a autorizacao.
 */
export function ehTokenInvalido(erro: unknown): boolean {
  if (!(erro instanceof ErroDaMeta) || erro.origem !== "meta") return false;
  return erro.codigo === 190 || erro.codigo === 102;
}

function redigir(texto: string, token?: string): string {
  if (!token || token.length < 8) return texto;
  return texto.split(token).join("[token]");
}
