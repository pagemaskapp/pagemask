import "server-only";

import { apagarArquivosDoTitular } from "@/lib/conta/arquivos";
import { publicEnv } from "@/lib/env/public";
import { enviarEmail } from "@/lib/email/enviar";
import { revogarPermissoes } from "@/lib/ig/api";
import { decifrar } from "@/lib/ig/cripto";
import { ENCARREGADO, PRAZO_DE_EXCLUSAO_HORAS } from "@/lib/legal/encarregado";
import { novoCodigoDeConfirmacao } from "@/lib/meta/codigo";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * A exclusão de conta ponta a ponta (PLANO §8).
 *
 * A ORDEM É A PARTE QUE IMPORTA
 * =============================
 *
 * Cada passo destrói algo que o passo seguinte poderia precisar, então a ordem
 * foi escolhida pelo tamanho do estrago de uma falha no meio — e não pela
 * conveniência:
 *
 *   0. abre a solicitação    um código existe antes de qualquer destruição, e a
 *                            página pública passa a mostrar "em andamento"
 *   1. apaga no R2           precisa das linhas para saber o que existe, e o
 *                            passo 3 as apaga. Falha aqui **ABORTA**: arquivo
 *                            que sobra depois do purge é vídeo de alguém que
 *                            pediu para ser esquecido, sem nenhum registro
 *                            capaz de encontrá-lo de novo
 *   2. revoga na Meta        precisa do token, que o passo 3 apaga. Falha aqui
 *                            NÃO aborta: indisponibilidade da Meta não pode
 *                            impedir ninguém de excluir a conta
 *   3. purge no banco        apaga as linhas e anonimiza a auditoria
 *   4. apaga no Auth         o usuário deixa de existir. Rede de segurança do
 *                            passo 3: o que ele não alcançou, o cascade pega
 *   5. e-mail de confirmação depois de tudo, com o endereço guardado no começo
 *
 * POR QUE O R2 VEM ANTES DA META, e não o contrário
 * =================================================
 *
 * Os dois passos só precisam vir antes do purge — o R2 porque depende das
 * linhas para saber o que existe, a Meta porque depende do token que o purge
 * apaga. Entre eles, a ordem é livre, e ela foi escolhida pelo que sobra quando
 * o passo do meio falha.
 *
 * Com a Meta primeiro, uma falha no R2 abortava a exclusão **depois** de
 * revogar toda autorização do Instagram — algo irreversível, que o cliente só
 * desfaz reconectando conta por conta. E a mensagem de erro dizia que a conta
 * continuava inteira, o que era falso. Com o R2 primeiro, uma falha ali para
 * antes de qualquer coisa irreversível do lado da Meta: as conexões continuam
 * funcionando e o cliente tenta de novo.
 *
 * O que continua irreversível numa falha do R2 é o que já tinha sido apagado
 * antes de ela acontecer. É por isso que a mensagem daquele ramo fala em
 * "parte dos seus arquivos" e não em "nada foi tocado".
 *
 * O e-mail é o único passo que acontece DEPOIS de o titular deixar de existir,
 * e por isso o endereço é capturado no início: no fim não há mais de onde
 * tirá-lo. Falhar nele não desfaz nada — a conta já foi, e o registro da
 * exclusão está em `data_requests` com o código.
 *
 * NÃO EXISTE 72 HORAS AQUI
 * ========================
 *
 * A política promete exclusão "em até 72 horas" porque é o prazo que se
 * consegue honrar em qualquer cenário. O que este fluxo faz é na hora. O prazo
 * continua na política como teto, não como espera programada — e o e-mail diz
 * que já aconteceu, não que vai acontecer.
 */

export type ResultadoDaExclusao =
  | {
      ok: true;
      codigo: string;
      arquivos: { apagados: number; orfaos: number };
      contasRevogadas: number;
      contasNaoRevogadas: number;
      emailEnviado: boolean;
      apagado: Json;
    }
  | { ok: false; codigo: string | null; motivo: string; mensagem: string };

/**
 * Erro de servidor em pt-BR, sem detalhe técnico. Detalhe vai para o log.
 *
 * ELA NÃO PROMETE QUE NADA FOI APAGADO, e a versão anterior prometia. Este
 * texto é usado pelo `catch` que envolve os passos 1 a 5 — inclusive uma falha
 * do `purge_account`, que acontece com o bucket já limpo. Dizer "nada foi
 * apagado pela metade" ali era exatamente a frase errada no exato momento em
 * que ela era falsa, e ainda convidava a pessoa a tentar de novo achando que o
 * estado estava intacto.
 *
 * O que a mensagem faz agora é o que uma mensagem de erro pode honestamente
 * fazer: dizer que parou no meio, entregar o código para o suporte reconstituir
 * o que aconteceu, e não afirmar nada sobre o estado.
 */
const MENSAGEM_GENERICA =
  "A exclusão parou no meio e não foi concluída. Guarde o código abaixo e " +
  `escreva para ${ENCARREGADO.email}: com ele conseguimos ver exatamente em ` +
  "que ponto paramos e terminar o que faltou.";

export async function excluirConta(entrada: {
  userId: string;
  email: string | null;
  ip: string | null;
}): Promise<ResultadoDaExclusao> {
  const supabase = createAdminClient();
  const email = entrada.email;

  // --- 0. a solicitação, antes de tudo ------------------------------------
  const abertura = await supabase.rpc("open_account_deletion", {
    p_user_id: entrada.userId,
    p_code: novoCodigoDeConfirmacao(),
    p_ip: entrada.ip,
  });

  const solicitacao = abertura.data?.[0];
  if (abertura.error || !solicitacao) {
    console.error("[conta/exclusao] nao foi possivel abrir a solicitacao", {
      codigo: abertura.error?.code,
      mensagem: abertura.error?.message,
    });
    return {
      ok: false,
      codigo: null,
      motivo: "abertura",
      mensagem: MENSAGEM_GENERICA,
    };
  }

  const codigo = solicitacao.confirmation_code;

  try {
    // --- 1. apagar no R2 ---------------------------------------------------
    const arquivos = await apagarArquivosDoTitular(entrada.userId);
    if (arquivos.falhas > 0) {
      // Sem `throw`: o motivo é específico e a mensagem precisa dizer o que
      // ficou de pé e o que não ficou, que é a informação que muda o que a
      // pessoa faz em seguida.
      await marcarFalha(codigo, `r2: ${arquivos.falhas} objetos resistiram`);
      console.error("[conta/exclusao] abortada: objetos nao apagados no R2", {
        codigo,
        falhas: arquivos.falhas,
        apagados: arquivos.apagados,
      });
      return {
        ok: false,
        codigo,
        motivo: "r2",
        // A mensagem diz as duas coisas, e a segunda é a que estava faltando:
        // a conta continua existindo (nenhum dado de cadastro foi tocado, as
        // conexões com o Instagram continuam valendo), MAS parte dos arquivos
        // já foi apagada antes de a falha acontecer, e isso não volta.
        mensagem:
          "Não conseguimos apagar todos os seus arquivos do armazenamento e " +
          "interrompemos aí. Sua conta, seus projetos e suas conexões com o " +
          "Instagram continuam funcionando — mas parte dos vídeos já foi " +
          "apagada e não há como recuperá-los. Tente de novo em alguns " +
          `minutos; se persistir, escreva para ${ENCARREGADO.email} com o ` +
          `código ${codigo}.`,
      };
    }

    // --- 2. revogar na Meta ------------------------------------------------
    const revogacao = await revogarContas(entrada.userId);

    // --- 3. purge no banco -------------------------------------------------
    const purge = await supabase.rpc("purge_account", {
      p_user_id: entrada.userId,
      p_code: codigo,
    });
    if (purge.error) {
      throw new Error(`purge_account: ${purge.error.message}`);
    }

    // --- 4. apagar no Auth -------------------------------------------------
    const { error: erroDoAuth } = await supabase.auth.admin.deleteUser(
      entrada.userId,
    );
    if (erroDoAuth) {
      // O purge já passou: as linhas e os arquivos se foram. Deixar de apagar
      // o usuário no Auth não devolve nada disso — o que ele deixa para trás é
      // um login que entra numa conta vazia. Isso é falha, e precisa aparecer
      // na solicitação, mas não é motivo para dizer que a exclusão não
      // aconteceu.
      console.error("[conta/exclusao] usuario nao removido do Auth", {
        codigo,
        mensagem: erroDoAuth.message,
      });
      await marcarFalha(codigo, `auth: ${erroDoAuth.message}`);
      return {
        ok: false,
        codigo,
        motivo: "auth",
        mensagem:
          "Seus dados e arquivos foram apagados, mas o login não foi removido " +
          `no último passo. Escreva para ${ENCARREGADO.email} com o código ` +
          `${codigo} para finalizarmos.`,
      };
    }

    // --- 5. e-mail ---------------------------------------------------------
    const emailEnviado = email ? await avisar(email, codigo) : false;

    return {
      ok: true,
      codigo,
      arquivos: { apagados: arquivos.apagados, orfaos: arquivos.orfaos },
      contasRevogadas: revogacao.revogadas,
      contasNaoRevogadas: revogacao.naoRevogadas,
      emailEnviado,
      apagado: (purge.data ?? {}) as Json,
    };
  } catch (erro) {
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    console.error("[conta/exclusao] falhou no meio", { codigo, mensagem: detalhe });
    await marcarFalha(codigo, detalhe);
    // O código VAI na mensagem: ela pede para guardá-lo, e uma mensagem que
    // pede um código sem mostrá-lo é pior do que não pedir.
    return {
      ok: false,
      codigo,
      motivo: "interno",
      mensagem: `${MENSAGEM_GENERICA} Código: ${codigo}.`,
    };
  }
}

/**
 * Devolve a autorização de cada conta conectada para a Meta.
 *
 * Uma conta que não revoga não derruba as outras nem a exclusão: o `catch` é
 * por conta, e o número de fracassos vira dado do resultado. O token some do
 * banco no purge de qualquer maneira.
 */
async function revogarContas(
  userId: string,
): Promise<{ revogadas: number; naoRevogadas: number }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("ig_account_tokens", {
    p_user_id: userId,
  });

  if (error) {
    console.error("[conta/exclusao] nao foi possivel ler as contas para revogar", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { revogadas: 0, naoRevogadas: 0 };
  }

  let revogadas = 0;
  let naoRevogadas = 0;

  for (const conta of data ?? []) {
    if (!conta.cipher_hex || !conta.iv_hex || !conta.tag_hex) continue;

    try {
      const token = decifrar(
        {
          cipherHex: conta.cipher_hex,
          ivHex: conta.iv_hex,
          tagHex: conta.tag_hex,
          keyVersion: conta.key_version,
        },
        conta.ig_user_id,
      );
      const ok = await revogarPermissoes(token, conta.ig_user_id);
      if (ok) revogadas += 1;
      else naoRevogadas += 1;
    } catch (erro) {
      // Token indecifrável (chave rotacionada sem recifrar, por exemplo). Não
      // há o que revogar com ele; a mensagem de `decifrar` não carrega
      // conteúdo nenhum além da versão da chave.
      naoRevogadas += 1;
      console.error("[conta/exclusao] token indecifravel na revogacao", {
        conta: conta.id,
        mensagem: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  return { revogadas, naoRevogadas };
}

async function marcarFalha(codigo: string, motivo: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("fail_account_deletion", {
    p_code: codigo,
    p_motivo: motivo,
  });
  if (error) {
    console.error("[conta/exclusao] nao foi possivel marcar a falha", {
      codigo,
      mensagem: error.message,
    });
  }
}

async function avisar(email: string, codigo: string): Promise<boolean> {
  const consulta = new URL("/exclusao-de-dados", publicEnv.NEXT_PUBLIC_APP_URL);
  consulta.searchParams.set("code", codigo);

  const { enviado } = await enviarEmail({
    para: email,
    assunto: "Sua conta do PageMask foi excluída",
    texto: [
      "Sua conta do PageMask foi excluída, junto com:",
      "",
      "· os vídeos que você enviou e os que produzimos a partir deles;",
      "· seus projetos, templates e agendamentos;",
      "· as contas do Instagram conectadas, com a autorização devolvida à Meta;",
      "· seu cadastro e seu login.",
      "",
      "Os registros de auditoria foram anonimizados: o que aconteceu e quando " +
        "continua registrado, sem nada que ligue àquilo a você.",
      "",
      `Código da solicitação: ${codigo}`,
      `Acompanhe em: ${consulta.toString()}`,
      "",
      "A exclusão é irreversível — não há como recuperar os arquivos. Se você " +
        "não pediu isso, responda a este e-mail imediatamente.",
      "",
      `Encarregado de dados: ${ENCARREGADO.nome} — ${ENCARREGADO.email}`,
      `Prazo máximo previsto na política: ${PRAZO_DE_EXCLUSAO_HORAS} horas ` +
        "(esta exclusão foi imediata).",
    ].join("\n"),
  });

  return enviado;
}
