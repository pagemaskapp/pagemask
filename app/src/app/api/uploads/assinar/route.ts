import { z } from "zod";

import { corpoJson, erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { assinarEnvio } from "@/lib/r2/assinatura";
import { montarChaveDeEntrada } from "@/lib/r2/chaves";
import { limitesDoUsuario } from "@/lib/plano/limites";
import { createClient } from "@/lib/supabase/server";
import {
  esperaEmTexto,
  limiteDeAssinatura,
  URLS_POR_HORA,
} from "@/lib/uploads/limite-de-taxa";
import { extensaoAceita, FORMATOS_EM_TEXTO, TIPO_POR_EXTENSAO } from "@/lib/video/codecs";

/**
 * `POST /api/uploads/assinar` — uma URL pré-assinada de PUT por arquivo.
 *
 * O arquivo **nunca passa pela Vercel**: esta rota só entrega a autorização, e
 * o navegador fala direto com o R2. É o que torna viável subir 500 MB num
 * ambiente com poucos segundos de execução e alguns MB de corpo de requisição.
 *
 * Tudo que decide a chave é do servidor. O cliente diz o nome e o tamanho do
 * arquivo, e nada mais: o `user_id` vem da sessão, o `project_id` é conferido
 * contra o dono, o UUID é sorteado aqui e o `Content-Type` sai da extensão —
 * nunca do que o navegador declarou. Pedir chave com o `user_id` de outra
 * pessoa não é uma requisição que possa ser recusada, é uma requisição que não
 * existe: não há campo para isso.
 */

const Pedido = z.object({
  projeto: z.uuid("Projeto inválido."),
  nome: z.string().min(1).max(255),
  bytes: z.number().int().positive(),
});

export async function POST(requisicao: Request) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  const bruto = await corpoJson(requisicao);
  if (bruto === null) return erroJson(415, "Requisição inválida.");

  const pedido = Pedido.safeParse(bruto);
  if (!pedido.success) return erroJson(400, "Requisição inválida.");

  const extensao = extensaoAceita(pedido.data.nome);
  if (!extensao) {
    return erroJson(
      400,
      `“${pedido.data.nome}” não é um formato que processamos. ` +
        `Envie ${FORMATOS_EM_TEXTO}.`,
    );
  }

  // O limite fica DEPOIS do que se decide sem tocar no banco (formato e forma
  // do corpo) e ANTES de tudo que custa consulta. A linha é essa de propósito:
  // arrastar sessenta arquivos `.pdf` por engano não pode gastar a cota de
  // envios da hora — mas uma requisição bem formada que vai consultar plano e
  // projeto já custa trabalho ao servidor, e essa conta.
  const limite = await limiteDeAssinatura(usuario.id);
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você pediu mais de ${URLS_POR_HORA} envios nesta hora. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  const limites = await limitesDoUsuario(usuario.id);

  if (pedido.data.bytes > limites.bytesPorArquivo) {
    return erroJson(
      413,
      `Este arquivo tem ${emMegabytes(pedido.data.bytes)} e o limite do plano ` +
        `${limites.plano.name} é ${limites.plano.max_mb} MB por vídeo. ` +
        "Comprima o arquivo ou mude de plano em Conta.",
    );
  }

  // Conferência adiantada da cota, só para o usuário não subir 500 MB e
  // descobrir no fim que não cabia. Quem decide de verdade é a
  // `register_upload_job`, na confirmação, porque lá a checagem e o consumo
  // acontecem na mesma transação — aqui, entre ler e gravar, cabe o lote todo.
  if (limites.videosUsados >= limites.plano.videos_month) {
    return erroJson(
      409,
      `Você usou os ${limites.plano.videos_month} vídeos do plano ` +
        `${limites.plano.name} neste período. Remova vídeos que ainda não ` +
        "foram processados ou mude de plano em Conta.",
    );
  }

  const supabase = await createClient();
  const { data: projeto, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", pedido.data.projeto)
    .eq("user_id", usuario.id)
    .maybeSingle();

  if (error) {
    console.error("[upload] falha ao conferir o projeto", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos preparar o envio agora. Tente de novo.");
  }
  if (!projeto) return erroJson(404, "Não encontramos esse projeto na sua conta.");

  const chave = montarChaveDeEntrada(usuario.id, projeto.id, extensao);
  const envio = await assinarEnvio({
    chave,
    tipo: TIPO_POR_EXTENSAO[extensao],
    bytes: pedido.data.bytes,
  });

  return okJson({ chave, ...envio });
}

function emMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
