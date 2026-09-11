import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { requireServerEnv } from "@/lib/env/server";

/**
 * O `state` do OAuth: HMAC de `user_id + nonce + timestamp`, 10 minutos de
 * validade (docs/PLANO.md, Fase 4).
 *
 * O `state` responde a UMA pergunta: "este callback é a volta de um fluxo que
 * este servidor começou, para este usuário?". Sem ele, qualquer um monta uma
 * URL para `/api/ig/callback?code=…` com um `code` obtido no app dele e faz a
 * vítima logada conectar a conta de Instagram do atacante — *login CSRF*. O
 * usuário passaria a publicar, sem saber, num perfil alheio.
 *
 * ASSINATURA E NONCE FAZEM COISAS DIFERENTES
 * ==========================================
 *
 * O HMAC prova ORIGEM: só quem tem `IG_APP_SECRET` consegue produzir um
 * `state` que valide. Ele não prova FRESCOR além do carimbo de tempo, e não
 * impede que o mesmo `state` volte duas vezes dentro dos 10 minutos.
 *
 * Quem impede é o nonce, que vive em `ig_oauth_states` e é queimado no
 * primeiro uso (`consume_ig_state`). Os dois juntos: a assinatura descarta o
 * forjado sem ir ao banco, e o banco descarta o repetido.
 *
 * A CHAVE É O `IG_APP_SECRET`
 * ===========================
 *
 * Reaproveitar aqui o segredo do próprio app do Instagram evita inventar mais
 * uma variável de ambiente para o operador administrar — e ele já é
 * obrigatório para o fluxo funcionar, então não há o caso "o state deixou de
 * ser assinado porque faltou configurar algo". Não é reúso de chave entre
 * propósitos criptográficos distintos: a Meta usa esse segredo como credencial
 * de cliente em requisições HTTPS, nunca como chave de HMAC sobre dado nosso.
 */

/** Validade do `state`, em minutos. O banco cobra o mesmo prazo no nonce. */
export const VALIDADE_EM_MINUTOS = 10;

export type Estado = {
  userId: string;
  nonce: string;
  emitidoEm: number;
};

function base64url(dados: Buffer): string {
  return dados.toString("base64url");
}

function assinar(corpo: string): string {
  return base64url(
    createHmac("sha256", requireServerEnv("IG_APP_SECRET")).update(corpo).digest(),
  );
}

/** Um nonce de 256 bits. Gravado no banco antes de o usuário sair daqui. */
export function novoNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function montarEstado(userId: string, nonce: string): string {
  const corpo = base64url(
    Buffer.from(JSON.stringify({ userId, nonce, emitidoEm: Date.now() }), "utf8"),
  );
  return `${corpo}.${assinar(corpo)}`;
}

/**
 * `null` para tudo que não seja um `state` íntegro e dentro do prazo. Quem
 * chama não precisa saber QUAL das condições falhou — e não deve contar isso a
 * quem mandou o `state`, porque a diferença entre "assinatura errada" e
 * "expirado" é informação útil para quem está sondando.
 */
export function lerEstado(state: string | null): Estado | null {
  if (!state) return null;

  const corte = state.lastIndexOf(".");
  if (corte <= 0) return null;

  const corpo = state.slice(0, corte);
  const assinaturaRecebida = state.slice(corte + 1);
  const assinaturaEsperada = assinar(corpo);

  // Comparação em tempo constante. `===` em string vaza, pelo tempo, quantos
  // caracteres iniciais batem — e com isso uma assinatura pode ser descoberta
  // byte a byte. `timingSafeEqual` exige tamanhos iguais, então o tamanho é
  // conferido antes (e o tamanho não é segredo: é sempre o do SHA-256).
  const recebida = Buffer.from(assinaturaRecebida, "base64url");
  const esperada = Buffer.from(assinaturaEsperada, "base64url");
  if (recebida.length !== esperada.length) return null;
  if (!timingSafeEqual(recebida, esperada)) return null;

  let dados: unknown;
  try {
    dados = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof dados !== "object" || dados === null) return null;
  const { userId, nonce, emitidoEm } = dados as Record<string, unknown>;

  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  if (typeof emitidoEm !== "number" || !Number.isFinite(emitidoEm)) return null;

  const idade = Date.now() - emitidoEm;
  // `idade < 0` recusa carimbo no futuro. Não é paranoia teórica: um relógio
  // adiantado numa instância criaria `state` que outra instância aceitaria por
  // muito mais que 10 minutos.
  if (idade < 0 || idade > VALIDADE_EM_MINUTOS * 60_000) return null;

  return { userId, nonce, emitidoEm };
}
