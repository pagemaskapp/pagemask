import { z } from "zod";

import { corpoJson, erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import {
  escreverSrt,
  lerSrt,
  MAX_BYTES_DO_SRT,
  SrtInvalidoError,
} from "@/lib/legenda/srt";
import { GRAVACOES_POR_HORA, limiteDeLegenda } from "@/lib/legenda/limite-de-taxa";
import { assinarLegenda, VALIDADE_DE_LEGENDA_S } from "@/lib/r2/assinatura";
import { gravarTexto } from "@/lib/r2/objetos";
import { createClient } from "@/lib/supabase/server";
import { esperaEmTexto } from "@/lib/uploads/limite-de-taxa";

/**
 * `GET  /api/videos/[id]/legenda` — a URL para o editor carregar o SRT.
 * `PUT  /api/videos/[id]/legenda` — grava o texto corrigido por cima.
 *
 * A LEGENDA É O ÚNICO OBJETO DO BUCKET QUE O USUÁRIO REESCREVE, e as duas
 * pontas desta rota existem por causa disso.
 *
 * No GET, o navegador recebe uma URL pré-assinada e busca o texto direto do R2:
 * o arquivo não passa pela função da Vercel só para ser copiado.
 *
 * No PUT é o contrário, e de propósito — **não existe URL pré-assinada de
 * escrita para a legenda**. O que for gravado naquela chave é o insumo de um
 * render: ele vira um arquivo ASS dentro do libass, no worker. Deixar o
 * navegador escrever bytes arbitrários ali seria abrir uma porta para dentro do
 * pipeline. Aqui o texto passa por `lerSrt`/`escreverSrt` antes de virar objeto,
 * e o que o bucket guarda é o que ESTE processo escreveu.
 *
 * A higienização acontece de novo no worker (`servico/legenda.py`), e isso não
 * é redundância: o worker não pode confiar no que está no bucket, porque ele é
 * quem monta o arquivo que o interpretador de estilo vai ler.
 *
 * QUANDO NÃO DÁ PARA EDITAR. Um vídeo `queued` ou `processing` está com o
 * worker — ele pode já ter baixado o SRT, ou baixá-lo no meio da gravação. Em
 * vez de uma corrida silenciosa (o usuário salva, o vídeo sai com o texto
 * velho, e nada explica por quê), a rota recusa com a frase que diz o que
 * fazer: esperar o lote terminar.
 */

const id = z.uuid();

/**
 * O teto é em BYTES, e o `zod` sozinho não sabe contar bytes.
 *
 * `z.string().max(n)` conta unidades de UTF-16, e legenda em português é cheia
 * de acento: "ção" são três caracteres e cinco bytes. Com o teto só no `max`,
 * um SRT de 400 mil caracteres acentuados passaria aqui com mais de 512 KB — e
 * seria REJEITADO depois, no worker, que aplica `MAX_BYTES_DO_SRT` ao BAIXAR o
 * objeto. O arquivo já estaria gravado, e o erro apareceria no render seguinte
 * em vez de no salvamento, sem nada ligando um ao outro.
 *
 * O `max` continua como primeira peneira barata (nenhum SRT válido tem mais
 * caracteres do que bytes permitidos); quem decide é o `Buffer.byteLength`.
 */
const Pedido = z.object({
  srt: z
    .string()
    .max(MAX_BYTES_DO_SRT, "Esta legenda é grande demais para ser salva.")
    .refine((valor) => Buffer.byteLength(valor, "utf8") <= MAX_BYTES_DO_SRT, {
      message: "Esta legenda é grande demais para ser salva.",
    }),
});

type Job = {
  id: string;
  status: string;
  filename: string | null;
  r2_srt_key: string | null;
};

async function jobDoUsuario(
  bruto: string,
  userId: string,
): Promise<{ job: Job } | { resposta: Response }> {
  const video = id.safeParse(bruto);
  if (!video.success) return { resposta: erroJson(400, "Vídeo inválido.") };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, filename, r2_srt_key")
    .eq("id", video.data)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[legenda] consulta do job falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return {
      resposta: erroJson(500, "Não conseguimos abrir a legenda agora. Tente de novo."),
    };
  }

  // 404 tanto para o vídeo de outra pessoa quanto para o que não existe: um 403
  // contaria que aquele id existe e é de alguém.
  if (!data) {
    return { resposta: erroJson(404, "Não encontramos esse vídeo na sua conta.") };
  }

  if (!data.r2_srt_key) {
    return {
      resposta: erroJson(
        409,
        "Este vídeo não tem legenda. Ligue a legenda no template e processe o " +
          "vídeo para que ela seja gerada.",
      ),
    };
  }

  return { job: data as Job };
}

export async function GET(
  _requisicao: Request,
  contexto: RouteContext<"/api/videos/[id]/legenda">,
) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const { id: bruto } = await contexto.params;
  const achado = await jobDoUsuario(bruto, sessao.usuario.id);
  if ("resposta" in achado) return achado.resposta;

  const url = await assinarLegenda({ chave: achado.job.r2_srt_key! });

  return okJson({
    url,
    expira_em_s: VALIDADE_DE_LEGENDA_S,
    editavel: EDITAVEIS.has(achado.job.status),
    status: achado.job.status,
  });
}

/** Em que estados o vídeo não está com o worker. */
const EDITAVEIS = new Set(["done", "failed", "uploaded", "canceled"]);

export async function PUT(
  requisicao: Request,
  contexto: RouteContext<"/api/videos/[id]/legenda">,
) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const { id: bruto } = await contexto.params;
  const achado = await jobDoUsuario(bruto, sessao.usuario.id);
  if ("resposta" in achado) return achado.resposta;

  if (!EDITAVEIS.has(achado.job.status)) {
    return erroJson(
      409,
      "Este vídeo está na fila ou sendo processado agora, e a legenda dele já " +
        "está em uso. Espere o lote terminar para editar.",
    );
  }

  const corpo = await corpoJson(requisicao);
  if (corpo === null) return erroJson(415, "Requisição inválida.");

  const pedido = Pedido.safeParse(corpo);
  if (!pedido.success) {
    return erroJson(400, pedido.error.issues[0]?.message ?? "Legenda inválida.");
  }

  const limite = await limiteDeLegenda(sessao.usuario.id);
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você salvou legendas mais de ${GRAVACOES_POR_HORA} vezes na última hora. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  let texto: string;
  let falas: number;
  try {
    const lidas = lerSrt(pedido.data.srt);
    falas = lidas.length;
    texto = escreverSrt(lidas);
  } catch (erro) {
    if (erro instanceof SrtInvalidoError) return erroJson(400, erro.message);
    throw erro;
  }

  // O que vai para o bucket é o texto NORMALIZADO, não o que chegou: `lerSrt`
  // quebra linhas longas e refaz a numeração, então ele pode ser maior. Quem
  // precisa caber no teto do worker é este, e é ele que a conta confere.
  if (Buffer.byteLength(texto, "utf8") > MAX_BYTES_DO_SRT) {
    return erroJson(400, "Esta legenda é grande demais para ser salva.");
  }

  try {
    await gravarTexto(
      achado.job.r2_srt_key!,
      texto,
      "text/plain; charset=utf-8",
    );
  } catch (erro) {
    console.error("[legenda] gravacao no R2 falhou", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return erroJson(500, "Não conseguimos salvar a legenda agora. Tente de novo.");
  }

  // O texto normalizado volta para a tela. Sem isso, o `<textarea>` continuaria
  // mostrando o que foi digitado — com a numeração furada, as tags removidas
  // ainda visíveis e as linhas por quebrar — e a pessoa só descobriria a
  // diferença ao ver o vídeo pronto.
  return okJson({ srt: texto, falas });
}
