import "server-only";

import { createHmac } from "node:crypto";

import { getServerEnv } from "@/lib/env/server";

/**
 * O token de curta duração que autoriza o Realtime no navegador.
 *
 * POR QUE ISTO EXISTE, E NÃO UM `getSession()`
 * ============================================
 *
 * A Fase 1 tirou o token de sessão do alcance do JavaScript: o cookie é
 * `HttpOnly` e o cliente de navegador é anônimo por construção. O comentário
 * de `@/lib/supabase/cookie-options` já previa este dia e já escreveu a saída:
 *
 *   "Quando a Fase 3 precisar de Realtime autenticado no navegador, o token
 *    para essa conexão terá que ser emitido pelo servidor, de propósito e com
 *    escopo curto — não lido de um cookie."
 *
 * É o que esta função faz. Não é o `access_token` da sessão (que vale 1 hora e
 * serve para tudo): é um JWT novo, assinado aqui, que vale **5 minutos** e
 * carrega só `sub` e `role`. Se ele vazar — e ele vive na memória da página,
 * então um XSS o alcança —, o estrago tem prazo de validade curto e não dá
 * para renová-lo sem passar de novo por uma rota que exige a sessão.
 *
 * O QUE ELE AINDA PERMITE, dito sem maquiagem: **não existe escopo "só
 * Realtime" no Supabase.** Dentro desses 5 minutos o token vale contra o
 * PostgREST (`/rest/v1`), o Storage e o GoTrue, como aquele usuário. A RLS
 * continua valendo — ele não vira `service_role` nem nada parecido —, mas ele
 * lê e escreve o que o usuário leria e escreveria. E, por não carregar
 * `session_id`, sair da conta **não o invalida**: ele morre de velhice, e só.
 *
 * A troca é essa, e vale a pena saber o tamanho dela: progresso ao vivo custa
 * uma janela de 5 minutos, sem revogação, em vez da janela de 60 que seria
 * entregar o token de sessão. Quem preferir não pagar nada deixa
 * `SUPABASE_JWT_SECRET` em branco e fica com a recarga periódica.
 *
 * SEM `SUPABASE_JWT_SECRET`, NADA QUEBRA
 * ======================================
 *
 * A variável é opcional. Sem ela esta função devolve `null`, o navegador não
 * abre Realtime e a lista se atualiza pela rede de segurança que o componente
 * já tem de qualquer jeito (um `router.refresh()` periódico enquanto houver
 * job andando). Mais lento, igualmente correto — e é o caminho a escolher de
 * propósito para quem preferir não ter token nenhum no navegador.
 */

/** 5 minutos. O cliente renova antes de expirar; não há refresh token. */
export const VALIDADE_S = 5 * 60;

export type CredencialRealtime = {
  token: string;
  /** Epoch em segundos. O cliente renova um pouco antes disso. */
  expira_em: number;
};

export function credencialDeRealtime(userId: string): CredencialRealtime | null {
  const segredo = getServerEnv().SUPABASE_JWT_SECRET;
  if (!segredo) return null;

  const agora = Math.floor(Date.now() / 1000);
  const expira = agora + VALIDADE_S;

  const corpo = {
    sub: userId,
    // `authenticated` é o papel que as políticas de RLS de `jobs` esperam. Não
    // existe caminho daqui para `service_role`: o valor é constante.
    role: "authenticated",
    aud: "authenticated",
    iat: agora,
    exp: expira,
  };

  return { token: assinarHS256(corpo, segredo), expira_em: expira };
}

/**
 * HS256 na mão, com `node:crypto`.
 *
 * Uma biblioteca de JWT resolveria isto, e resolveria também dezenas de casos
 * que não temos: outros algoritmos, verificação, JWKS, `none`. Assinar um
 * token de formato fixo são doze linhas, e doze linhas que não fazem parsing
 * de nada não têm como ser confundidas por uma entrada.
 */
function assinarHS256(corpo: Record<string, unknown>, segredo: string): string {
  const cabecalho = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const carga = base64url(JSON.stringify(corpo));
  const conteudo = `${cabecalho}.${carga}`;

  const assinatura = createHmac("sha256", segredo).update(conteudo).digest("base64url");

  return `${conteudo}.${assinatura}`;
}

function base64url(texto: string): string {
  return Buffer.from(texto, "utf8").toString("base64url");
}
