import "server-only";

import { consumirBalde, type ResultadoLimite } from "@/lib/rate-limit/balde";

/**
 * 20 pedidos de pacote por usuário a cada hora (docs/PLANO.md, Fase 7).
 *
 * Montar um ZIP é a operação mais cara que um usuário dispara sem gastar cota:
 * o worker lê do R2 e grava no R2 o lote inteiro — dezenas de gigabytes de
 * tráfego num projeto grande, e egress de download que a Cloudflare não cobra
 * mas que ocupa a única thread de pacote do contêiner.
 *
 * O `digest` de `request_zip` (migration 0021) já resolve o caso honesto: o
 * segundo clique no mesmo lote devolve o pacote que existe em vez de montar
 * outro. O balde é para o resto — um laço de `fetch` alternando entre projetos,
 * onde o digest muda a cada pedido e cada pedido é trabalho novo.
 */
export const PACOTES_POR_JANELA = 20;

export const JANELA_DO_PACOTE = "1 hour";

export function limiteDePacote(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `projeto-zip:${userId}`,
    limite: PACOTES_POR_JANELA,
    janela: JANELA_DO_PACOTE,
    rotulo: "projeto-zip",
  });
}
