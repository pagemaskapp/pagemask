import "server-only";

import { decifrar } from "@/lib/ig/cripto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { IgAccountStatus } from "@/lib/supabase/database.types";

/**
 * O token de UMA conta do usuário, decifrado, para uma chamada do servidor.
 *
 * Existe para a agenda perguntar à Meta "quantas publicações essa conta já fez
 * nas últimas 24 h" antes de gravar o agendamento. É a única leitura de token
 * fora do cron e do worker, e ela fica aqui — num módulo `server-only` que
 * devolve o token para quem chamou e nunca o grava em lugar nenhum.
 *
 * O dono é conferido pela função do banco (`ig_account_token`, 0019): o
 * `userId` vem da sessão validada, nunca do formulário.
 */
export type ContaComToken = {
  id: string;
  igUserId: string;
  username: string;
  status: IgAccountStatus;
  token: string;
};

export type ResultadoDoToken =
  | { ok: true; conta: ContaComToken }
  | {
      ok: false;
      motivo: "inexistente" | "sem-token" | "reconectar" | "indecifravel";
    };

export async function contaComToken(
  userId: string,
  accountId: string,
): Promise<ResultadoDoToken> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("ig_account_token", {
    p_user_id: userId,
    p_account_id: accountId,
  });

  if (error) {
    console.error("[ig/token] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { ok: false, motivo: "inexistente" };
  }

  const linha = data?.[0];
  if (!linha) return { ok: false, motivo: "inexistente" };
  if (linha.status !== "active") return { ok: false, motivo: "reconectar" };
  if (!linha.cipher_hex || !linha.iv_hex || !linha.tag_hex) {
    return { ok: false, motivo: "sem-token" };
  }

  try {
    const token = decifrar(
      {
        cipherHex: linha.cipher_hex,
        ivHex: linha.iv_hex,
        tagHex: linha.tag_hex,
        keyVersion: linha.key_version,
      },
      linha.ig_user_id,
    );
    return {
      ok: true,
      conta: {
        id: linha.id,
        igUserId: linha.ig_user_id,
        username: linha.username,
        status: linha.status,
        token,
      },
    };
  } catch (erro) {
    // A mensagem de `decifrar` não carrega conteúdo nenhum — só a versão da
    // chave. Vai para o log; a tela recebe um motivo fechado.
    console.error("[ig/token] não foi possível decifrar", {
      conta: accountId,
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return { ok: false, motivo: "indecifravel" };
  }
}
