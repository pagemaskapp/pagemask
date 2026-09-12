import { z } from "zod";

import { erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { assinarImagem, VALIDADE_DE_PREVIA_S } from "@/lib/r2/assinatura";
import { createClient } from "@/lib/supabase/server";

/**
 * `GET /api/templates/previa/[id]` — a prévia ficou pronta?
 *
 * O editor pergunta a cada segundo enquanto o worker trabalha. A leitura passa
 * pelo cliente do USUÁRIO: a política de `template_previews` (0020) só devolve
 * a linha do dono, então a prévia de outra pessoa não é 403 — ela simplesmente
 * não existe para quem pergunta, que é a resposta certa (um 403 contaria que
 * aquele id existe).
 *
 * A VALIDADE DA URL NUNCA PASSA DO `expires_at`, e é isso que faz "expira em 1
 * hora" ser verdade e não uma coluna decorativa. Uma URL pré-assinada vale até
 * o prazo dela e não se invalida quando o objeto some — assinar uma hora cheia
 * para uma prévia que vence em dois minutos deixaria um link funcionando por
 * 58 minutos depois de o PNG ter sido apagado, ou pior, um link vivo para um
 * objeto que o expurgo ainda não alcançou.
 */

const id = z.uuid();

export async function GET(
  _requisicao: Request,
  { params }: RouteContext<"/api/templates/previa/[id]">,
) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const { id: bruto } = await params;
  const previa = id.safeParse(bruto);
  if (!previa.success) return erroJson(400, "Prévia inválida.");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("template_previews")
    .select("id, status, r2_key, error, expires_at")
    .eq("id", previa.data)
    .maybeSingle();

  if (error) {
    console.error("[previa] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos consultar a prévia agora.");
  }

  // Linha que não existe mais é o caso normal do expurgo da hora, não um erro:
  // a tela trata como "prévia expirada, peça outra".
  if (!data) return okJson({ status: "expirada" });

  if (data.status !== "done" || !data.r2_key) {
    return okJson({ status: data.status, erro: data.error ?? undefined });
  }

  const restaS = Math.floor((new Date(data.expires_at).getTime() - Date.now()) / 1000);
  if (restaS <= 0) return okJson({ status: "expirada" });

  const url = await assinarImagem({
    chave: data.r2_key,
    tipo: "image/png",
    validadeS: Math.min(VALIDADE_DE_PREVIA_S, restaS),
  });

  return okJson({ status: "done", url, expira_em_s: restaS });
}
