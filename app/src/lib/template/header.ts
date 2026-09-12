import "server-only";

import { chaveDeAssetDoUsuario } from "@/lib/r2/chaves";
import { createClient } from "@/lib/supabase/server";
import type { ConfigDoTemplate } from "@/lib/template/esquema";

/**
 * A imagem de cabeçalho deste template existe, é do usuário e passou pelos
 * bytes?
 *
 * TRÊS CAMADAS, E CADA UMA RESPONDE UMA PERGUNTA DIFERENTE:
 *
 *   1. o `zod` (`esquema.ts`) diz que a chave TEM A FORMA de uma chave;
 *   2. `chaveDeAssetDoUsuario` diz que ela é do formato exato que o servidor
 *      gera e está sob o prefixo deste usuário;
 *   3. a linha em `assets` diz que **os bytes foram lidos** — desde a
 *      migration 0020, só `register_header_asset` insere ali, e ela só é
 *      chamada por `/api/templates/header/confirmar`, depois da assinatura de
 *      bytes. Antes disso o cliente inseria a linha sozinho, e a checagem de
 *      conteúdo virava opcional na prática.
 *
 * Por que isso mora num arquivo só: são TRÊS entradas para o mesmo dado, e a
 * mais perigosa é a menos óbvia. A prévia recebe o config por HTTP; o
 * salvamento recebe por server action; e o enfileiramento lê o config **do
 * banco** — onde ele pode ter sido escrito direto pelo PostgREST, porque
 * `templates` é uma tabela que o dono edita (0001). Conferir em duas das três
 * deixaria a terceira valendo por todas.
 */
export async function headerConferido(
  config: ConfigDoTemplate,
  userId: string,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const header = config.profile.header;
  if (header.fonte !== "r2") return { ok: true };

  if (!chaveDeAssetDoUsuario(header.chave, userId)) {
    return { ok: false, motivo: MOTIVO };
  }

  // Cliente do USUÁRIO: a RLS de `assets` já esconde o alheio, então "não
  // voltou" cobre tanto "não existe" quanto "é de outra pessoa" — e as duas
  // merecem a mesma resposta.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("assets")
    .select("id")
    .eq("r2_key", header.chave)
    .eq("kind", "header")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, motivo: MOTIVO };

  return { ok: true };
}

const MOTIVO =
  "A imagem de cabeçalho escolhida não está mais na sua conta. " +
  "Envie a imagem de novo.";
