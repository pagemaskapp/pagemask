import "server-only";

import { consumirBalde, type ResultadoLimite } from "@/lib/rate-limit/balde";

/**
 * "Conectar conta" está na lista de rotas com limite de taxa (PLANO §6).
 *
 * O número é folgado de propósito: conectar é uma ação rara — três a dez vezes
 * na vida de uma conta, conforme o plano — e um teto apertado transformaria
 * "tentei de novo porque fechei a janela sem querer" em bloqueio. Vinte por
 * hora não atrapalha ninguém e ainda impede o laço automatizado, que é o que
 * importa aqui: cada início escreve uma linha em `ig_oauth_states` e cada
 * conclusão gasta cota de OAuth na Meta, que é contada **por app**, não por
 * usuário. Um cliente em laço derrubaria a conexão de todos os outros.
 */
export const CONEXOES_POR_HORA = 20;

export function limiteDeConexao(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `ig-conectar:${userId}`,
    limite: CONEXOES_POR_HORA,
    janela: "1 hour",
    rotulo: "ig-conectar",
  });
}
