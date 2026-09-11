import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Um balde do contador da `auth_rate_limit` (migration 0003).
 *
 * Nasceu dentro de `lib/auth/rate-limit.ts`, colado ao limite de login por IP.
 * A Fase 2 precisa do mesmo contador com outra chave (usuário, não IP), outro
 * número e outra janela — e copiar aquele bloco significaria copiar junto a
 * doutrina dele, que é a parte que não pode divergir: **falha aberta, nunca
 * calada**.
 *
 * Falha aberta porque indisponibilidade do contador não pode virar
 * indisponibilidade do produto: se o Postgres não responder, o upload continua
 * funcionando. Nunca calada porque um limitador quebrado — migration não
 * aplicada, `grant` faltando, cache do PostgREST velho — deixa a rota sem
 * proteção nenhuma por tempo indeterminado, e sem este log nada denuncia isso.
 */

export type ResultadoLimite = {
  permitido: boolean;
  restantes: number;
  liberadoEm: Date;
};

export async function consumirBalde(opcoes: {
  /** Chave do contador. **Nunca vai para o log**: carrega IP ou id de usuário. */
  bucket: string;
  limite: number;
  /** Intervalo do Postgres, ex.: `"15 minutes"`, `"1 hour"`. */
  janela: string;
  /** Nome da rota, para o log. Esse pode aparecer. */
  rotulo: string;
}): Promise<ResultadoLimite> {
  const aberto = {
    permitido: true,
    restantes: opcoes.limite,
    liberadoEm: new Date(),
  };

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("consume_rate_limit", {
      p_bucket: opcoes.bucket,
      p_limite: opcoes.limite,
      p_janela: opcoes.janela,
    });

    if (error || !data || data.length === 0) {
      console.error("[rate-limit] RPC consume_rate_limit falhou", {
        rotulo: opcoes.rotulo,
        codigo: error?.code,
        mensagem: error?.message,
      });
      return aberto;
    }

    const linha = data[0];
    return {
      permitido: linha.permitido,
      restantes: linha.restantes,
      liberadoEm: new Date(linha.liberado_em),
    };
  } catch (erro) {
    console.error("[rate-limit] excecao ao consultar o limite", {
      rotulo: opcoes.rotulo,
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return aberto;
  }
}
