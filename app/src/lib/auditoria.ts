import "server-only";

import { headers } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * `audit_log` (PLANO §7) e o IP de quem chamou, num lugar só.
 *
 * A escrita é sempre com a chave secreta — o papel `authenticated` não tem
 * INSERT na tabela (0001) — e **nunca derruba a operação**: o que estava sendo
 * auditado já aconteceu, e desfazê-lo por causa de um insert de log seria
 * trocar um problema pequeno por um grande. A falha vai para o log do
 * servidor, que é onde alguém percebe que a auditoria parou.
 *
 * Nunca gravar token nem e-mail em `meta`.
 */
export async function registrarAuditoria(entrada: {
  userId: string | null;
  actor: "user" | "system" | "worker" | "meta";
  action: string;
  target: string | null;
  meta?: Json;
  ip?: string | null;
}): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("audit_log").insert({
    user_id: entrada.userId,
    actor: entrada.actor,
    action: entrada.action,
    target: entrada.target,
    meta: entrada.meta ?? {},
    ip: entrada.ip === undefined ? await ipDaRequisicaoAtual() : entrada.ip,
  });

  if (error) {
    console.error("[auditoria] não registrada", {
      acao: entrada.action,
      codigo: error.code,
      mensagem: error.message,
    });
  }
}

/**
 * O IP do cliente, para a auditoria e para os baldes de limite.
 *
 * `x-forwarded-for` é uma lista e o primeiro item é o cliente — mas só quando
 * quem escreve o cabeçalho é o nosso proxy. Em produção (Vercel) é. Rodando
 * localmente o cabeçalho não existe e o campo fica nulo, que é melhor que
 * gravar um valor que o próprio cliente escolheu.
 */
export function ipDoCabecalho(cabecalhos: Headers): string | null {
  const encaminhado = cabecalhos.get("x-forwarded-for");
  if (!encaminhado) return null;
  const primeiro = encaminhado.split(",")[0]?.trim();
  return primeiro && primeiro.length > 0 ? primeiro : null;
}

/** O mesmo, para server action e server component (sem objeto `Request`). */
export async function ipDaRequisicaoAtual(): Promise<string | null> {
  return ipDoCabecalho(await headers());
}
