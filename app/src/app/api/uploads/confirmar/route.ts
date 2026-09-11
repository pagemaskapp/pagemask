import { z } from "zod";

import { corpoJson, erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { chaveDoUsuario, nomeExibivel } from "@/lib/r2/chaves";
import { createR2Client } from "@/lib/r2/cliente";
import { apagarObjeto, cabecalhoDoObjeto, leitorDoObjeto } from "@/lib/r2/objetos";
import { codigoDoErro, CODIGOS, mensagemDoCodigo } from "@/lib/plano/erros";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CONFIRMACOES_POR_HORA,
  esperaEmTexto,
  limiteDeConfirmacao,
} from "@/lib/uploads/limite-de-taxa";
import { LeituraExcedidaError } from "@/lib/video/leitor";
import { sondar, SondaError, type Sonda } from "@/lib/video/sonda";
import { avaliarSonda } from "@/lib/video/veredito";

/**
 * `POST /api/uploads/confirmar` — o arquivo chegou; ele entra ou não entra.
 *
 * Esta é a porta onde a lista fechada de codecs (PLANO §4) é aplicada, e é por
 * isso que ela existe como passo separado do upload: só depois de o objeto
 * estar no R2 dá para LER o cabeçalho dele e descobrir o que ele é de verdade.
 * Extensão e `Content-Type` são declarações do cliente; o cabeçalho do arquivo
 * é evidência.
 *
 * A ordem aqui é deliberada:
 *
 *   1. o objeto existe? (`HEAD`) — sem isso, dava para criar linha em `jobs`
 *      apontando para chave nenhuma, ou para chave que ainda vai ser gravada;
 *   2. o tamanho é o que o R2 viu, não o que o cliente disse;
 *   3. a sondagem lê o cabeçalho e a lista fechada decide;
 *   4. recusa apaga o objeto e grava um job `rejected` com o motivo em pt-BR —
 *      o usuário PRECISA ver por que o arquivo dele não entrou;
 *   5. aceite grava `uploaded` e consome cota, na mesma transação.
 */

const Pedido = z.object({
  projeto: z.uuid("Projeto inválido."),
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

  const { chave, projeto } = pedido.data;

  // A chave volta pelo cliente, então ela é entrada não confiável de novo — e
  // aqui não basta "começa com o meu id": a forma inteira precisa ser a que o
  // servidor gera. A `register_upload_job` repete a checagem no banco.
  if (!chaveDoUsuario(chave, usuario.id, projeto)) {
    return erroJson(400, "Requisição inválida.");
  }

  // Mesma linha de corte da rota de assinatura: o limite cobra depois do que se
  // decide sem sair do processo e antes do que custa rede. Cobrar antes faria
  // um cliente em laço de retentativa com chave velha gastar os 120 créditos da
  // hora sem tocar no R2 — e aí a confirmação DE VERDADE levaria 429, deixando
  // no bucket um arquivo já enviado que ninguém registrou.
  const limite = await limiteDeConfirmacao(usuario.id);
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você confirmou mais de ${CONFIRMACOES_POR_HORA} envios nesta hora. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  // Um cliente só do R2 para toda a rota: são um `HEAD` e várias leituras por
  // `Range` no mesmo objeto, e abrir conexão nova a cada uma é desperdício
  // dentro de uma função com poucos segundos de vida.
  const r2 = createR2Client();

  const cabecalho = await cabecalhoDoObjeto(chave, r2);
  if (!cabecalho || cabecalho.bytes <= 0) {
    return erroJson(
      404,
      "Não encontramos esse arquivo no armazenamento. Envie o vídeo de novo.",
    );
  }

  let sonda: Sonda | null = null;
  let recusa: string | null = null;

  try {
    sonda = await sondar(leitorDoObjeto(chave, cabecalho.bytes, r2));
    const veredito = avaliarSonda(sonda);
    if (!veredito.ok) recusa = veredito.motivo;
  } catch (erro) {
    if (erro instanceof SondaError) {
      recusa = erro.message;
    } else if (erro instanceof LeituraExcedidaError) {
      recusa =
        "Não conseguimos analisar este arquivo: os metadados dele são grandes " +
        "demais. Reexporte o vídeo e envie de novo.";
    } else {
      // Falha de infraestrutura não é recusa do arquivo. Marcar `rejected` aqui
      // diria ao usuário que o vídeo dele tem problema quando quem teve foi a
      // gente — e o objeto seria apagado por causa disso.
      console.error("[upload] sondagem falhou", {
        mensagem: erro instanceof Error ? erro.message : String(erro),
      });
      return erroJson(
        500,
        "Não conseguimos analisar o arquivo agora. Tente confirmar de novo em instantes.",
      );
    }
  }

  // Cliente ADMIN, e a `register_upload_job` so e executavel por `service_role`
  // (migration 0008). Isso nao e conveniencia: com `grant … to authenticated`,
  // a funcao virava rota publica no PostgREST, e qualquer usuario podia
  // chama-la direto com `p_recusa => null` e um `p_probe` inventado — pulando
  // exatamente a sondagem de codec que esta rota existe para aplicar.
  //
  // O dono vai por parametro porque `auth.uid()` e nulo com a chave de
  // servico. `usuario.id` aqui veio de `supabase.auth.getUser()`, que valida o
  // token contra o Supabase — nunca do corpo da requisicao.
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("register_upload_job", {
    p_user_id: usuario.id,
    p_project_id: projeto,
    p_r2_key: chave,
    p_bytes: cabecalho.bytes,
    p_filename: nomeExibivel(pedido.data.nome),
    // O `probe` vai com um bloco `objeto` ao lado do que a sonda leu: ele
    // descreve o ARQUIVO (tamanho, tipo, ETag), não o conteúdo. É o que dá à
    // Fase 3 como conferir que o arquivo que ela vai baixar é o mesmo que
    // passou aqui — ver `CabecalhoDoObjeto.etag`.
    p_probe: sonda
      ? {
          ...sonda,
          objeto: {
            bytes: cabecalho.bytes,
            content_type: cabecalho.tipo,
            etag: cabecalho.etag,
          },
        }
      : null,
    p_recusa: recusa,
  });

  if (error) {
    const codigo = codigoDoErro(error);

    // Cota estourada entre a assinatura e a confirmação: o arquivo está no
    // bucket e não vai ser processado, então ele não fica lá ocupando espaço.
    if (codigo === CODIGOS.quotaDeVideos) {
      await apagarComCuidado(chave, r2);
    }

    const mensagem = mensagemDoCodigo(codigo);
    if (mensagem) {
      return erroJson(codigo === CODIGOS.quotaDeVideos ? 409 : 400, mensagem);
    }

    console.error("[upload] register_upload_job falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return erroJson(500, "Não conseguimos registrar o vídeo agora. Tente de novo.");
  }

  // O objeto só some DEPOIS de o banco decidir, e a decisão é o `status` da
  // linha que ficou — não a variável `recusa` desta chamada.
  //
  // A diferença aparece na confirmação repetida (migration 0009): se esta
  // chamada recusa mas já existe um job `uploaded` para a mesma chave, quem
  // vale é o job — apagar aqui deixaria uma linha válida, com cota consumida,
  // apontando para um arquivo que não existe mais, e a tela diria "Enviado".
  // Guardar por 30 dias um arquivo que já sabemos que não será processado é
  // pagar armazenamento por um binário de formato desconhecido; a LINHA fica,
  // com o motivo, porque é ela que explica ao usuário o que aconteceu.
  if (data.status === "rejected") {
    await apagarComCuidado(chave, r2);
  }

  return okJson({
    id: data.id,
    status: data.status,
    filename: data.filename,
    bytes_in: data.bytes_in,
    // Do que ficou gravado, não do que esta chamada concluiu: numa confirmação
    // repetida o motivo certo é o da linha.
    motivo: data.error ?? recusa,
  });
}

/**
 * Apagar do R2 é limpeza, não é a decisão.
 *
 * Se a remoção falhar, o objeto fica órfão e o lifecycle de 30 dias o recolhe
 * — enquanto derrubar a requisição por causa disso faria o usuário ficar sem
 * saber por que o vídeo dele foi recusado, que é a informação que ele veio
 * buscar.
 */
async function apagarComCuidado(chave: string, r2: ReturnType<typeof createR2Client>) {
  try {
    await apagarObjeto(chave, r2);
  } catch (erro) {
    console.error("[upload] nao foi possivel apagar o objeto recusado", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
