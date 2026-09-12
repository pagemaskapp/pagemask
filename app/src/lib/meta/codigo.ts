import "server-only";

import { randomBytes } from "node:crypto";

/**
 * Código de confirmação de uma solicitação de exclusão.
 *
 * Doze caracteres de um alfabeto sem `0/O`, `1/I/L` — ele vai ser digitado por
 * alguém lendo de um e-mail da Meta. 31 símbolos ^ 12 ≈ 2^59: não é adivinhável
 * na prática, e é `unique` no banco (`data_requests.confirmation_code`).
 */
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function novoCodigoDeConfirmacao(): string {
  const bytes = randomBytes(12);
  let saida = "";
  for (let i = 0; i < 12; i += 1) {
    saida += ALFABETO[bytes[i] % ALFABETO.length];
    if (i === 3 || i === 7) saida += "-";
  }
  return saida;
}

/** `ABCD-EFGH-JKMN`, exatamente. Tolera minúscula e espaço nas pontas. */
export function normalizarCodigo(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().toUpperCase();
  return /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(limpo) ? limpo : null;
}
