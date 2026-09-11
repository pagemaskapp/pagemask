/**
 * O canal entre a janela do OAuth e a aba que a abriu.
 *
 * Sem `"server-only"` de propósito: as duas pontas são componentes de cliente,
 * e o nome do canal precisa ser literalmente o mesmo nos dois lados — duas
 * constantes iguais em arquivos diferentes é o tipo de coisa que diverge numa
 * renomeação e falha em silêncio, porque `BroadcastChannel` com nome errado não
 * dá erro: só não entrega nada.
 *
 * Não trafega segredo nenhum aqui, e não poderia: `BroadcastChannel` alcança
 * qualquer aba da mesma origem. O que viaja é "terminou, vá buscar a lista de
 * novo" — o resultado de verdade está no banco, atrás da sessão.
 */

export const CANAL_DO_RETORNO = "pagemask:ig-retorno";

export type AvisoDoRetorno = {
  tipo: "ig:retorno";
  ok: boolean;
};
