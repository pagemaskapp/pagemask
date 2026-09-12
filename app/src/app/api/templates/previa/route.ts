import { z } from "zod";

import { corpoJson, erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { codigoDoErro, mensagemDoCodigo } from "@/lib/plano/erros";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigDoTemplate, primeiroErro } from "@/lib/template/esquema";
import { headerConferido } from "@/lib/template/header";
import {
  limiteDePrevia,
  PREVIAS_POR_JANELA,
} from "@/lib/template/limite-de-taxa";
import { esperaEmTexto } from "@/lib/uploads/limite-de-taxa";

/**
 * `POST /api/templates/previa` — enfileira um PNG de rascunho.
 *
 * O editor manda o template EM EDIÇÃO, que pode nunca ser salvo. É por isso
 * que a prévia tem fila própria (`template_previews`, migration 0020) e não
 * depende de um template gravado: o que se está ajustando aqui ainda não é um
 * template, é um rascunho.
 *
 * TRÊS CONFERÊNCIAS, NESTA ORDEM, e a ordem é a mesma lógica das rotas de
 * upload: primeiro o que se decide sem sair do processo, depois o que custa
 * banco.
 *
 *   1. o `zod` (recusa campo desconhecido, fonte fora da lista, número fora de
 *      faixa) — barato, e é o que devolve mensagem útil;
 *   2. o limite de taxa — antes de qualquer consulta, porque daqui para baixo
 *      tudo custa viagem de rede;
 *   3. o dono da imagem de cabeçalho e o dono do projeto — no banco.
 *
 * A conferência da imagem mora em `lib/template/header.ts` porque ela precisa
 * ser a MESMA em três entradas (prévia, salvamento e enfileiramento): desde a
 * migration 0020 existir linha em `assets` é prova de que os bytes foram
 * lidos, e essa prova não pode valer só aqui.
 *
 * O vídeo de amostra **não** é escolhido pelo cliente. Ele pode sugerir um id,
 * e a `request_preview` só o aceita se for do mesmo projeto e do mesmo dono;
 * sem sugestão, o banco pega o mais recente. Chave de objeto nunca chega pelo
 * pedido — é o que impede uma prévia de renderizar o vídeo de outra pessoa.
 */

const Pedido = z.object({
  projeto: z.uuid("Projeto inválido."),
  video: z.uuid().nullish(),
  config: z.unknown(),
});

export async function POST(requisicao: Request) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  const bruto = await corpoJson(requisicao);
  if (bruto === null) return erroJson(415, "Requisição inválida.");

  const pedido = Pedido.safeParse(bruto);
  if (!pedido.success) return erroJson(400, "Requisição inválida.");

  const config = ConfigDoTemplate.safeParse(pedido.data.config);
  if (!config.success) {
    return erroJson(400, primeiroErro(config.error));
  }

  const limite = await limiteDePrevia(usuario.id);
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você pediu mais de ${PREVIAS_POR_JANELA} prévias nos últimos minutos. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  const header = await headerConferido(config.data, usuario.id);
  if (!header.ok) return erroJson(400, header.motivo);

  // Cliente ADMIN, como em toda função cujo dono vai por parâmetro (0008): o
  // `p_user_id` sai da sessão conferida aqui, nunca do corpo da requisição.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("request_preview", {
    p_user_id: usuario.id,
    p_project_id: pedido.data.projeto,
    p_job_id: pedido.data.video ?? null,
    p_config: config.data,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return erroJson(400, mensagem);

    console.error("[previa] request_preview falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos preparar a prévia agora. Tente de novo.");
  }

  return okJson({ id: data.id, status: data.status });
}
