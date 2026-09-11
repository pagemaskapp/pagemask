import { NextResponse } from "next/server";
import { z } from "zod";

import { erroJson, usuarioDaApi } from "@/lib/auth/api";
import { assinarDownload, VALIDADE_DE_DOWNLOAD_S } from "@/lib/r2/assinatura";
import { createClient } from "@/lib/supabase/server";

/**
 * `GET /api/videos/[id]/baixar` — baixa o vídeo PROCESSADO.
 *
 * A rota não serve bytes: ela confere quem está pedindo, assina uma URL de duas
 * horas e manda o navegador direto para o R2. Fazer o download passar pela
 * Vercel seria pagar banda duas vezes e esbarrar no tempo de execução de uma
 * função — um vídeo de 300 MB numa conexão doméstica leva minutos.
 *
 * **Só `r2_output_key`, nunca `r2_input_key`.** O arquivo original é entrada
 * não confiável — foi enviado por alguém e nunca passou por decoder nosso — e
 * `docs/PLANO.md` §4 é explícito: "a entrada nunca é servida ao cliente de
 * volta sem passar pelo pipeline". Devolvê-lo aqui transformaria o bucket em
 * hospedagem de arquivo arbitrário com URL assinada por nós.
 */

const id = z.uuid();

export async function GET(
  _requisicao: Request,
  contexto: RouteContext<"/api/videos/[id]/baixar">,
) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const { id: bruto } = await contexto.params;
  const video = id.safeParse(bruto);
  if (!video.success) return erroJson(400, "Vídeo inválido.");

  const supabase = await createClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, status, filename, r2_output_key")
    .eq("id", video.data)
    .eq("user_id", sessao.usuario.id)
    .maybeSingle();

  if (error) {
    console.error("[download] consulta do job falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos preparar o download agora. Tente de novo.");
  }

  if (!job) return erroJson(404, "Não encontramos esse vídeo na sua conta.");

  if (job.status !== "done" || !job.r2_output_key) {
    return erroJson(
      409,
      "Esse vídeo ainda não foi processado. O download fica disponível quando " +
        "ele ficar pronto.",
    );
  }

  const url = await assinarDownload({
    chave: job.r2_output_key,
    nomeParaSalvar: nomeDeSaida(job.filename),
  });

  // 307 e não 302: o método é preservado, e nenhum intermediário pode tratar
  // isto como redirecionamento permanente e guardar uma URL que expira em 2 h.
  return NextResponse.redirect(url, {
    status: 307,
    headers: {
      // A URL assinada é uma credencial de curta duração. Ela não pode entrar
      // em cache de navegador, de CDN nem de proxy: depois de expirar, o cache
      // devolveria um link morto — e antes disso, um link que funciona para
      // quem não deveria tê-lo.
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex",
      // Informativo, para quem depurar: quanto tempo aquela URL ainda vale.
      "X-Validade-Segundos": String(VALIDADE_DE_DOWNLOAD_S),
    },
  });
}

/**
 * O nome com que o arquivo chega no computador do usuário.
 *
 * A saída do pipeline é sempre MP4, então a extensão original não serve: um
 * `.mov` que sai como MP4 com nome `.mov` abre errado em metade dos programas.
 * O sufixo evita que o arquivo baixado se confunda com o original na pasta de
 * downloads.
 */
function nomeDeSaida(filename: string | null): string {
  const base = (filename ?? "video").replace(/\.[^.]+$/, "").trim();
  return `${base || "video"}-pagemask.mp4`;
}
