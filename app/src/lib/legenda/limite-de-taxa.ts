import "server-only";

import { consumirBalde, type ResultadoLimite } from "@/lib/rate-limit/balde";

/**
 * 120 gravações de legenda por hora, por usuário.
 *
 * A escrita da legenda é a única rota do PageMask em que o navegador manda
 * CONTEÚDO que vai parar no bucket. Ela é barata (meio megabyte, uma passada de
 * higienização, um `PutObject`), então o teto é folgado: quem corrige um lote
 * inteiro de vinte vídeos salvando várias vezes cada um continua abaixo dele.
 *
 * O que o balde barra é o laço — gravar a mesma chave mil vezes por minuto
 * custa `PutObject` cobrado no R2 e, com sorte de quem ataca, uma escrita bem
 * no instante em que o worker está lendo aquele arquivo.
 *
 * A leitura não tem balde: ela devolve uma URL assinada de 10 minutos e não
 * escreve nada.
 */
export const GRAVACOES_POR_HORA = 120;

export function limiteDeLegenda(userId: string): Promise<ResultadoLimite> {
  return consumirBalde({
    bucket: `legenda-gravar:${userId}`,
    limite: GRAVACOES_POR_HORA,
    janela: "1 hour",
    rotulo: "legenda-gravar",
  });
}
