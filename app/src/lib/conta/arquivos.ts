import "server-only";

import { apagarObjetos, listarPrefixo } from "@/lib/r2/objetos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Todos os arquivos de um titular no R2, e como apagá-los (PLANO §8).
 *
 * DUAS FONTES, DE PROPÓSITO
 * =========================
 *
 * O banco sabe quais chaves ele gravou. O bucket sabe o que de fato está lá.
 * Os dois discordam em situações banais — um `discard_project` que apagou a
 * linha e deixou o upload, uma prévia cuja linha expirou antes de o expurgo do
 * worker rodar, um render gravado no instante em que o job foi cancelado — e a
 * diferença entre eles é exatamente o arquivo que a exclusão de conta não pode
 * deixar para trás. Depois do purge não existe mais nenhuma linha apontando
 * para ele: seria um vídeo de alguém que pediu para ser esquecido, num bucket,
 * sem dono registrado e sem ninguém capaz de encontrá-lo de novo.
 *
 * Então: a união do que o banco conhece com o que a varredura por prefixo
 * encontra.
 *
 * DE ONDE SAEM OS PREFIXOS
 * ========================
 *
 * A entrada mora em `{user_id}/…` e `{user_id}/assets/…`; a saída, a prévia, o
 * pacote e a legenda moram cada uma no seu prefixo, à frente do id do usuário
 * (`saida/{user_id}/…`). Quem decide esses nomes é o worker, por variável de
 * ambiente — e o app não as tem.
 *
 * Por isso a lista abaixo é um PISO (os padrões do `worker/docker-compose.yml`)
 * e os prefixos de verdade são **deduzidos das chaves que o banco guardou**: se
 * alguém trocar `R2_PREFIXO_SAIDA` na VPS, a chave gravada em
 * `jobs.r2_output_key` já carrega o nome novo, e a varredura o alcança sem
 * ninguém precisar lembrar de mexer aqui. Um prefixo esquecido nesta lista
 * seria uma pasta inteira de vídeos sobrevivendo à exclusão em silêncio.
 */
const PREFIXOS_PADRAO = ["saida", "previas", "pacotes", "legendas"] as const;

export type ArquivosDoTitular = {
  chaves: string[];
  /** Quantas vieram da varredura e o banco não conhecia. */
  orfaos: number;
};

/** As chaves que o BANCO conhece. Usadas também para deduzir os prefixos. */
async function chavesDoBanco(userId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const chaves = new Set<string>();

  const guardar = (valor: unknown) => {
    if (typeof valor === "string" && valor.length > 0) chaves.add(valor);
  };

  const [jobs, assets, pacotes, previas] = await Promise.all([
    supabase
      .from("jobs")
      .select("r2_input_key, r2_output_key, r2_srt_key")
      .eq("user_id", userId),
    supabase.from("assets").select("r2_key").eq("user_id", userId),
    supabase.from("batch_zips").select("r2_key").eq("user_id", userId),
    supabase.from("template_previews").select("r2_key").eq("user_id", userId),
  ]);

  // Erro aqui não pode virar "não havia arquivo". Uma consulta que falha e é
  // engolida deixaria a exclusão seguir com a lista incompleta e terminar
  // dizendo que apagou tudo — que é a única falha desta função capaz de passar
  // despercebida.
  for (const consulta of [jobs, assets, pacotes, previas]) {
    if (consulta.error) {
      throw new Error(
        `não foi possível listar as chaves do titular: ${consulta.error.message}`,
      );
    }
  }

  for (const linha of jobs.data ?? []) {
    guardar(linha.r2_input_key);
    guardar(linha.r2_output_key);
    guardar(linha.r2_srt_key);
  }
  for (const linha of assets.data ?? []) guardar(linha.r2_key);
  for (const linha of pacotes.data ?? []) guardar(linha.r2_key);
  for (const linha of previas.data ?? []) guardar(linha.r2_key);

  return [...chaves];
}

/**
 * O conjunto de prefixos a varrer: os padrões, mais o primeiro segmento de
 * toda chave que o banco guardou, menos as que já começam pelo id do usuário
 * (essas estão cobertas pela varredura de `{user_id}/`).
 */
function prefixosAVarrer(userId: string, doBanco: string[]): string[] {
  const prefixos = new Set<string>(PREFIXOS_PADRAO);

  for (const chave of doBanco) {
    const primeiro = chave.split("/")[0];
    if (!primeiro || primeiro === userId) continue;
    prefixos.add(primeiro);
  }

  return [...prefixos];
}

export async function arquivosDoTitular(userId: string): Promise<ArquivosDoTitular> {
  const doBanco = await chavesDoBanco(userId);
  const conhecidas = new Set(doBanco);

  const varreduras = await Promise.all([
    // A entrada e os assets: `{user_id}/…`. A barra no fim não é enfeite —
    // sem ela, o prefixo de um usuário casaria com o de outro cujo UUID
    // começasse com os mesmos caracteres. UUID não se repete, mas prefixo é
    // comparação de texto, e a barra é o que torna a fronteira exata.
    listarPrefixo(`${userId}/`),
    ...prefixosAVarrer(userId, doBanco).map((p) => listarPrefixo(`${p}/${userId}/`)),
  ]);

  const todas = new Set(doBanco);
  let orfaos = 0;
  for (const lote of varreduras) {
    for (const chave of lote) {
      if (!conhecidas.has(chave)) orfaos += 1;
      todas.add(chave);
    }
  }

  return { chaves: [...todas], orfaos };
}

export type ResultadoDaLimpeza = {
  apagados: number;
  falhas: number;
  orfaos: number;
};

/**
 * Apaga tudo. Devolve o que aconteceu — nunca lança por objeto que resistiu.
 *
 * Quem chama (a exclusão de conta) trata `falhas > 0` como motivo para ABORTAR
 * antes de destruir o banco: com as linhas ainda de pé, dá para tentar de novo;
 * sem elas, o arquivo que ficou não tem mais como ser encontrado.
 */
export async function apagarArquivosDoTitular(
  userId: string,
): Promise<ResultadoDaLimpeza> {
  const { chaves, orfaos } = await arquivosDoTitular(userId);
  if (chaves.length === 0) return { apagados: 0, falhas: 0, orfaos: 0 };

  const falhas = await apagarObjetos(chaves);
  return { apagados: chaves.length - falhas, falhas, orfaos };
}
