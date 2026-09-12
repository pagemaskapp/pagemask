import { z } from "zod";

import { erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { codigoDoErro, mensagemDoCodigo } from "@/lib/plano/erros";
import {
  limiteDePacote,
  PACOTES_POR_JANELA,
} from "@/lib/projetos/limite-de-taxa";
import { assinarDownload, VALIDADE_DE_ZIP_S } from "@/lib/r2/assinatura";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { esperaEmTexto } from "@/lib/uploads/limite-de-taxa";

/**
 * O pacote do lote: `POST` pede, `GET` pergunta se ficou pronto.
 *
 * POR QUE O ZIP NÃO É MONTADO AQUI
 * ================================
 *
 * Um lote de 200 vídeos são dezenas de gigabytes. Nenhuma função da Vercel
 * monta isso dentro do prazo dela, e o tráfego seria pago duas vezes (R2 →
 * Vercel → navegador). Quem monta é o worker, que lê do R2 e grava no R2 sem
 * o arquivo passar por disco (`worker/src/servico/pacote.py`); o que chega ao
 * navegador é uma URL pré-assinada, exatamente como no download individual.
 *
 * O QUE O CLIENTE **NÃO** ESCOLHE
 * ===============================
 *
 * Nem a lista de vídeos, nem a chave do objeto. O pedido diz só qual projeto;
 * `request_zip` (migration 0021) lê do banco quais vídeos estão prontos, com o
 * dono conferido na própria consulta, e o worker deriva a chave do id do
 * pacote. É o que impede que um pedido manipulado empacote arquivo alheio.
 *
 * A URL NUNCA PASSA DO `expires_at` DA LINHA, mesma regra da prévia (Fase 6):
 * uma URL pré-assinada vale até o prazo dela e não se invalida quando o objeto
 * some. Assinar 15 minutos cheios para um pacote que vence em 40 segundos
 * deixaria um link funcionando para um arquivo que o expurgo já apagou.
 */

const id = z.uuid();

export async function POST(
  _requisicao: Request,
  contexto: RouteContext<"/api/projetos/[id]/zip">,
) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const { id: bruto } = await contexto.params;
  const projeto = id.safeParse(bruto);
  if (!projeto.success) return erroJson(400, "Projeto inválido.");

  const limite = await limiteDePacote(sessao.usuario.id);
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você pediu mais de ${PACOTES_POR_JANELA} pacotes nesta hora. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  // Cliente ADMIN, como em toda função cujo dono vai por parâmetro (0008): o
  // `p_user_id` sai da sessão conferida aqui, nunca do corpo da requisição.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("request_zip", {
    p_user_id: sessao.usuario.id,
    p_project_id: projeto.data,
  });

  if (error) {
    const mensagem = mensagemDoCodigo(codigoDoErro(error));
    if (mensagem) return erroJson(400, mensagem);

    console.error("[zip] request_zip falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos preparar o pacote agora. Tente de novo.");
  }

  return okJson({ id: data.id, status: data.status });
}

export async function GET(
  requisicao: Request,
  contexto: RouteContext<"/api/projetos/[id]/zip">,
) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const { id: bruto } = await contexto.params;
  const projeto = id.safeParse(bruto);
  if (!projeto.success) return erroJson(400, "Projeto inválido.");

  const pedido = new URL(requisicao.url).searchParams.get("pacote");
  const pacote = pedido === null ? null : id.safeParse(pedido);
  if (pacote && !pacote.success) return erroJson(400, "Pacote inválido.");

  // Leitura pelo cliente do USUÁRIO. A política de `batch_zips` (0021) só
  // devolve a linha do dono, então o pacote de outra pessoa não é 403 — ele
  // simplesmente não existe para quem pergunta, que é a resposta certa (um 403
  // contaria que aquele id existe).
  const supabase = await createClient();

  let consulta = supabase
    .from("batch_zips")
    .select("id, status, r2_key, bytes, videos, error, expires_at")
    .eq("project_id", projeto.data);

  if (pacote?.success) consulta = consulta.eq("id", pacote.data);

  const { data, error } = await consulta
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[zip] consulta do pacote falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos consultar o pacote agora.");
  }

  // Linha que não existe (nunca houve pedido, ou o expurgo dos sete dias já
  // passou) não é erro: a tela trata como "peça o pacote".
  if (!data) return okJson({ status: "ausente" });

  if (data.status !== "done" || !data.r2_key) {
    return okJson({
      id: data.id,
      status: data.status,
      erro: data.error ?? undefined,
    });
  }

  const restaS = Math.floor(
    (new Date(data.expires_at).getTime() - Date.now()) / 1000,
  );
  if (restaS <= 0) return okJson({ id: data.id, status: "expirado" });

  // O nome do projeto vem junto para o arquivo chegar ao computador como
  // "Cliente X-pagemask.zip" em vez do UUID da chave. A RLS de `projects` já
  // limita ao dono; um projeto que não seja dele não teria pacote a devolver.
  const { data: projetoLinha } = await supabase
    .from("projects")
    .select("name")
    .eq("id", projeto.data)
    .maybeSingle();

  const url = await assinarDownload({
    chave: data.r2_key,
    nomeParaSalvar: nomeDoPacote(projetoLinha?.name ?? null),
    validadeS: Math.min(VALIDADE_DE_ZIP_S, restaS),
    tipo: "application/zip",
  });

  return okJson({
    id: data.id,
    status: "done",
    url,
    videos: data.videos,
    bytes: data.bytes ?? 0,
    expira_em_s: Math.min(VALIDADE_DE_ZIP_S, restaS),
  });
}

/**
 * O nome com que o pacote chega no computador do usuário.
 *
 * O nome do projeto é escrito por ele e entra num cabeçalho HTTP, então tudo
 * que quebra cabeçalho sai aqui — o `assinarDownload` ainda faz a própria
 * limpeza, mas contar com uma camada só para isso seria contar com sorte.
 */
function nomeDoPacote(nome: string | null): string {
  const base = (nome ?? "projeto")
    // Escritos como escape unicode de propósito, pela mesma razão de
    // `lib/r2/chaves.ts`: controle literal no fonte é invisível em revisão.
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/["\\/]/g, "-")
    .trim()
    .slice(0, 60);

  return `${base || "projeto"}-pagemask.zip`;
}
