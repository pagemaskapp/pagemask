import { z } from "zod";

import { corpoJson, erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { BYTES_PARA_DECIDIR, identificar } from "@/lib/imagem/assinatura";
import { assinarImagem, VALIDADE_DE_IMAGEM_S } from "@/lib/r2/assinatura";
import { chaveDeAssetDoUsuario, nomeExibivel } from "@/lib/r2/chaves";
import { createR2Client } from "@/lib/r2/cliente";
import { apagarObjeto, cabecalhoDoObjeto, leitorDoObjeto } from "@/lib/r2/objetos";
import { createAdminClient } from "@/lib/supabase/admin";
import { esperaEmTexto } from "@/lib/uploads/limite-de-taxa";
import { HEADERS_POR_HORA, limiteDeHeader } from "@/lib/template/limite-de-taxa";

/**
 * `POST /api/templates/header/confirmar` — a imagem chegou; ela entra ou não.
 *
 * **Esta é a porta da assinatura de bytes**, e ela existe como passo separado
 * pelo mesmo motivo da confirmação de vídeo: só depois de o objeto estar no R2
 * dá para LER o começo dele e descobrir o que ele é de verdade.
 *
 * A ordem importa:
 *
 *   1. a chave tem a forma que o servidor gera, e o prefixo é do dono;
 *   2. o objeto existe e cabe no limite (o R2 já travou isso na assinatura,
 *      mas quem decide o que vai para o banco é o que o bucket viu);
 *   3. os primeiros 64 KB dizem se é PNG ou JPG, e qual a geometria;
 *   4. **recusa apaga o objeto** — arquivo recusado não fica guardado, mesma
 *      regra da Fase 2;
 *   5. aceite grava a linha em `assets` e devolve uma URL para a tela mostrar.
 */

const MAXIMO_BYTES = 5 * 1024 * 1024;

const Pedido = z.object({
  chave: z.string().min(1).max(200),
  nome: z.string().min(1).max(255),
});

export async function POST(requisicao: Request) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  const bruto = await corpoJson(requisicao);
  if (bruto === null) return erroJson(415, "Requisição inválida.");

  const pedido = Pedido.safeParse(bruto);
  if (!pedido.success) return erroJson(400, "Requisição inválida.");

  const { chave } = pedido.data;

  // A chave volta pelo cliente, então ela é entrada não confiável de novo. Sem
  // esta conferência, bastaria trocá-la aqui para gravar em `assets` uma linha
  // apontando para o objeto de outra pessoa — e a linha vira URL assinada
  // legítima na tela seguinte. A política de RLS de `assets` repete a regra do
  // prefixo no banco; esta é a primeira das duas camadas.
  if (!chaveDeAssetDoUsuario(chave, usuario.id)) {
    return erroJson(400, "Requisição inválida.");
  }

  const limite = await limiteDeHeader(usuario.id, "confirmar");
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você enviou mais de ${HEADERS_POR_HORA} imagens nesta hora. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  const r2 = createR2Client();

  const cabecalho = await cabecalhoDoObjeto(chave, r2);
  if (!cabecalho || cabecalho.bytes <= 0) {
    return erroJson(
      404,
      "Não encontramos essa imagem no armazenamento. Envie o arquivo de novo.",
    );
  }

  if (cabecalho.bytes > MAXIMO_BYTES) {
    await apagarComCuidado(chave, r2);
    return erroJson(
      413,
      `A imagem de cabeçalho pode ter até ${MAXIMO_BYTES / (1024 * 1024)} MB.`,
    );
  }

  let inicio: Buffer;
  try {
    const leitor = leitorDoObjeto(chave, cabecalho.bytes, r2);
    inicio = await leitor.ler(0, Math.min(BYTES_PARA_DECIDIR, cabecalho.bytes));
  } catch (erro) {
    // Falha de infraestrutura não é recusa do arquivo: dizer "sua imagem é
    // inválida" quando quem falhou fomos nós manda o usuário procurar defeito
    // num arquivo que está certo — e apagaria o objeto por causa disso.
    console.error("[header] leitura do objeto falhou", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return erroJson(
      500,
      "Não conseguimos analisar a imagem agora. Tente confirmar de novo em instantes.",
    );
  }

  const veredito = identificar(inicio);
  if (!veredito.ok) {
    await apagarComCuidado(chave, r2);
    return erroJson(415, veredito.motivo);
  }

  const { imagem } = veredito;

  // A extensão da chave foi escolhida na assinatura a partir do tipo que o
  // cliente DECLAROU. Se os bytes dizem outra coisa, o objeto está gravado com
  // o `Content-Type` errado — e como o tipo é imposto de novo na URL assinada
  // de leitura, a divergência viraria uma imagem que não abre. Recusar é mais
  // honesto do que entregar um arquivo que não funciona.
  const esperada = chave.endsWith(".png") ? "png" : "jpg";
  if (imagem.extensao !== esperada) {
    await apagarComCuidado(chave, r2);
    return erroJson(
      415,
      "O conteúdo da imagem não confere com o formato declarado. " +
        "Exporte-a de novo e envie.",
    );
  }

  // Cliente ADMIN, e a `register_header_asset` só é executável por
  // `service_role` (migration 0020). Isso NÃO é conveniência, e a história
  // está escrita na migration: enquanto `authenticated` teve `insert` em
  // `assets`, esta rota inteira era opcional — bastava gravar o objeto no R2
  // pela URL pré-assinada, pular a confirmação e inserir a linha pelo
  // PostgREST para que bytes nunca conferidos chegassem ao Pillow do worker.
  //
  // Agora a linha só nasce aqui, depois da assinatura de bytes. É o que faz
  // "existe linha em `assets`" significar "este arquivo é mesmo uma imagem" —
  // e é nisso que o editor e o enfileiramento se apoiam.
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("register_header_asset", {
    p_user_id: usuario.id,
    p_r2_key: chave,
    p_mime: imagem.tipo,
    p_bytes: cabecalho.bytes,
    p_sha256: null,
  });

  if (error) {
    console.error("[header] register_header_asset falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    await apagarComCuidado(chave, r2);
    return erroJson(500, "Não conseguimos registrar a imagem agora. Tente de novo.");
  }

  const url = await assinarImagem({
    chave,
    tipo: imagem.tipo,
    validadeS: VALIDADE_DE_IMAGEM_S,
  });

  return okJson({
    id: data.id,
    chave: data.r2_key,
    nome: nomeExibivel(pedido.data.nome),
    largura: imagem.largura,
    altura: imagem.altura,
    url,
  });
}

/**
 * Apagar do R2 é limpeza, não é a decisão.
 *
 * Se a remoção falhar, o objeto fica órfão e o lifecycle de 30 dias o recolhe
 * — enquanto derrubar a requisição por causa disso faria o usuário ficar sem
 * saber por que a imagem dele foi recusada, que é o que ele veio descobrir.
 */
async function apagarComCuidado(chave: string, r2: ReturnType<typeof createR2Client>) {
  try {
    await apagarObjeto(chave, r2);
  } catch (erro) {
    console.error("[header] nao foi possivel apagar o objeto recusado", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
