import "server-only";

import { consumirBalde, type ResultadoLimite } from "@/lib/rate-limit/balde";

/**
 * Os limites das duas ações de LGPD da tela de conta (PLANO §6).
 *
 * Números baixos, e por um motivo diferente do resto dos baldes do projeto.
 * Nos outros, o limite protege o servidor de trabalho repetido. Aqui ele
 * protege o **usuário**: as duas ações são caras de um jeito incomum — a
 * exportação varre todas as tabelas dele e monta um JSON que pode passar de
 * alguns megabytes; a exclusão varre o bucket inteiro do titular e apaga
 * centenas de objetos. Nenhuma das duas é algo que alguém precise fazer dez
 * vezes por hora, e as duas seriam um jeito barato de pôr o servidor para
 * trabalhar de graça a partir de uma sessão legítima.
 *
 * A exclusão tem teto ainda menor que a exportação: quando ela dá certo, a
 * conta deixa de existir e não há segunda chamada. Um teto de 5 existe para o
 * caso em que ela FALHA (Meta fora do ar, objeto que resistiu no R2) e a pessoa
 * tenta de novo — e para impedir que uma tentativa em laço, por bug de tela,
 * repita a varredura do bucket indefinidamente.
 */
export const EXPORTACOES_POR_HORA = 10;
export const EXCLUSOES_POR_HORA = 5;

export const JANELA = "1 hour";

export function limiteDeExportacao(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `conta-exportar:${userId}`,
    limite: EXPORTACOES_POR_HORA,
    janela: JANELA,
    rotulo: "conta-exportar",
  });
}

export function limiteDeExclusao(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `conta-excluir:${userId}`,
    limite: EXCLUSOES_POR_HORA,
    janela: JANELA,
    rotulo: "conta-excluir",
  });
}
