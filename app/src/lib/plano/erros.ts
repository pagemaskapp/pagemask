/**
 * Os códigos `PM0xx` das funções da migration 0007, traduzidos para a tela.
 *
 * As funções do banco levantam exceção com um `SQLSTATE` próprio em vez de
 * devolverem uma coluna `ok`. Duas razões: a exceção ABORTA a transação, então
 * um "limite atingido" nunca deixa metade do trabalho gravado; e o código é uma
 * constante, não um texto — a mensagem pode mudar de redação sem quebrar o
 * tratamento aqui.
 *
 * O PostgREST repassa o `SQLSTATE` no campo `code` do erro. É esse que se lê;
 * o `message` que vem do banco é para o log, nunca para o usuário.
 */

export const CODIGOS = {
  semSessao: "PM000",
  limiteDeProjetos: "PM001",
  quotaDeVideos: "PM002",
  nomeInvalido: "PM003",
  planoAusente: "PM004",
  projetoDeOutro: "PM005",
  chaveForaDoPrefixo: "PM006",
  tamanhoInvalido: "PM007",
  jobAusente: "PM008",
  jobEmProcessamento: "PM009",
  projetoEmProcessamento: "PM010",
  registroSumiu: "PM011",
  templateInvalido: "PM013",
  workerSemNome: "PM014",
  saidaSemChave: "PM015",
  jobDeOutroWorker: "PM016",
  probeInvalido: "PM017",
  limiteDeContasIg: "PM018",
  contaIgDeOutro: "PM019",
  planoAusenteNoConector: "PM020",
  templateDeOutro: "PM023",
  limiteDeTemplates: "PM024",
  nomeDeTemplate: "PM025",
  semVideoParaPrevia: "PM026",
  previaDeOutroWorker: "PM027",
  assetInvalido: "PM028",
  semVideoPronto: "PM029",
  zipDeOutroWorker: "PM030",
  assinaturaInativa: "PM031",
  eventoSemId: "PM032",
  clienteDeOutro: "PM033",
  quotaDeTranscricao: "PM034",
  /**
   * `deadlock_detected` do próprio Postgres, não nosso.
   *
   * A migration 0012 alinhou a ordem das travas para que ele não aconteça. Mas
   * "não deveria acontecer" não é o mesmo que "não acontece": uma função nova
   * que pegue as mesmas linhas em ordem diferente traz o impasse de volta, e
   * sem esta linha ele chega ao usuário como 500 mudo. Com ela, chega como o
   * que é — duas ações dele esbarrando uma na outra, e a segunda vale a pena
   * tentar de novo.
   */
  impasse: "40P01",
} as const;

/**
 * `null` quando o erro não é um dos nossos — aí ele é falha de verdade e quem
 * chama deve deixar subir, não transformar em recado amigável.
 */
export function mensagemDoCodigo(codigo: string | undefined): string | null {
  switch (codigo) {
    case CODIGOS.limiteDeProjetos:
      return (
        "Você chegou ao limite de projetos do seu plano. Apague um projeto que " +
        "não usa mais ou mude de plano em Conta."
      );
    case CODIGOS.quotaDeVideos:
      return (
        "Você usou toda a cota de vídeos do seu plano neste período. Remova " +
        "vídeos que ainda não foram processados ou mude de plano em Planos."
      );
    case CODIGOS.quotaDeTranscricao:
      // O worker é quem esbarra neste limite, e ele traduz o `PM034` para a
      // frase que vai parar em `jobs.error`. Esta aqui existe para o caso de
      // alguma rota do app passar a chamar `reserve_transcription` — e porque
      // um código sem tradução vira 500 mudo na primeira vez que aparece.
      return (
        "Você usou toda a cota de legenda automática do seu plano neste " +
        "período. Desligue a legenda no template ou mude de plano em Planos."
      );
    case CODIGOS.assinaturaInativa:
      return (
        "Sua conta não tem assinatura ativa. Escolha um plano em Planos para " +
        "enviar e processar vídeos — o que já está pronto continua disponível " +
        "para baixar."
      );
    case CODIGOS.nomeInvalido:
      return "Dê um nome ao projeto, com até 80 caracteres.";
    case CODIGOS.projetoDeOutro:
    case CODIGOS.jobAusente:
    case CODIGOS.contaIgDeOutro:
    case CODIGOS.templateDeOutro:
      return "Não encontramos esse item na sua conta.";
    case CODIGOS.limiteDeTemplates:
      return (
        "Você chegou ao limite de templates da conta. Apague um que não usa " +
        "mais para criar outro."
      );
    case CODIGOS.nomeDeTemplate:
      return (
        "Dê ao template um nome de até 60 caracteres, diferente dos que você " +
        "já tem."
      );
    case CODIGOS.assetInvalido:
      return (
        "Esta imagem de cabeçalho não pôde ser registrada. Envie o arquivo de novo."
      );
    case CODIGOS.semVideoPronto:
      return (
        "Nenhum vídeo deste projeto está pronto para baixar. Processe o lote " +
        "e peça o pacote de novo."
      );
    case CODIGOS.semVideoParaPrevia:
      return (
        "Este projeto ainda não tem um vídeo para servir de amostra. Envie um " +
        "vídeo e peça a prévia de novo."
      );
    case CODIGOS.limiteDeContasIg:
      return (
        "Seu plano já está com todas as contas do Instagram ocupadas. " +
        "Desconecte uma que você não usa mais ou mude de plano em Conta."
      );
    case CODIGOS.jobEmProcessamento:
      return (
        "Esse vídeo está sendo processado agora e não pode ser removido. " +
        "Tente de novo quando ele terminar."
      );
    case CODIGOS.projetoEmProcessamento:
      return (
        "Este projeto tem vídeo na fila ou sendo processado agora. Espere o " +
        "lote terminar para apagar o projeto."
      );
    case CODIGOS.registroSumiu:
      return (
        "O registro deste envio foi removido no meio da confirmação. " +
        "Envie o vídeo de novo."
      );
    case CODIGOS.templateInvalido:
      return (
        "O template deste projeto não pôde ser preparado. Recarregue a página " +
        "e clique em Processar de novo."
      );
    // PM014, PM015, PM016, PM017, PM027 e PM030 sao conversas entre o worker e
    // o banco: o usuario nao tem acao sobre nenhuma delas e nunca deveria ve-las.
    // Ficam fora do `switch` de proposito — `mensagemDoCodigo` devolve `null`, quem
    // chamou deixa subir, e o erro aparece no log como o defeito que e.
    case CODIGOS.impasse:
      return "Duas ações suas esbarraram uma na outra. Tente de novo.";
    case CODIGOS.semSessao:
      return "Sua sessão expirou. Entre de novo para continuar.";
    default:
      return null;
  }
}

/** O `code` de um erro do PostgREST, quando existe. */
export function codigoDoErro(erro: unknown): string | undefined {
  if (typeof erro !== "object" || erro === null) return undefined;
  const codigo = (erro as { code?: unknown }).code;
  return typeof codigo === "string" ? codigo : undefined;
}

/**
 * A mensagem de cota estourada COM OS NÚMEROS, quando o banco os mandou.
 *
 * `enqueue_project` e `requeue_failed_jobs` levantam `PM002` com
 * `detail = '<usados>/<limite>/<pedidos>'` (migration 0022). O PostgREST
 * repassa o `DETAIL` da exceção no campo `details` do erro, e é dali que saem os
 * três números — mensagem de banco nunca chega crua à tela, mas número de banco
 * pode, formatado.
 *
 * `pedidos` é o que separa os dois casos, e eles são genuinamente diferentes:
 *
 *   processar lote   `pedidos = 0`. A vaga foi cobrada no UPLOAD, então
 *                    `videos_used` já inclui os vídeos selecionados. Quem chega
 *                    aqui é quem baixou de plano entre enviar e processar, e o
 *                    que ele precisa ouvir é "você está acima do teto novo".
 *   reprocessar      `pedidos = N`. A cota foi DEVOLVIDA quando cada vídeo
 *                    falhou, e reprocessar cobra de novo. O que ele precisa
 *                    ouvir é "você pediu N e só cabem M".
 *
 * Devolve `null` quando o erro não é `PM002` ou quando o `detail` não tem a
 * forma esperada; aí vale a frase genérica de `mensagemDoCodigo`. Não vale
 * inventar um número: "faltam NaN vagas" é pior que não dizer quantas.
 */
export function mensagemDaQuota(erro: unknown): string | null {
  if (codigoDoErro(erro) !== CODIGOS.quotaDeVideos) return null;

  const detalhe =
    typeof erro === "object" && erro !== null
      ? (erro as { details?: unknown }).details
      : undefined;
  if (typeof detalhe !== "string") return null;

  const casado = /^(\d+)\/(\d+)\/(\d+)$/.exec(detalhe.trim());
  if (!casado) return null;

  const usados = Number(casado[1]);
  const limite = Number(casado[2]);
  const pedidos = Number(casado[3]);
  if (![usados, limite, pedidos].every(Number.isFinite)) return null;

  const numero = new Intl.NumberFormat("pt-BR");
  const cabem = Math.max(limite - usados, 0);

  if (pedidos > 0) {
    const quantosCabem =
      // "ainda cabem 0" é o tipo de frase que se escreve sozinha ao formatar um
      // número e sai torta. Com a cota cheia, o que a pessoa precisa ler é que
      // não há vaga — não um zero no meio da frase.
      cabem === 0
        ? "não há mais vaga"
        : `ainda ${cabem === 1 ? "cabe" : "cabem"} ${numero.format(cabem)}`;

    return (
      `Você pediu ${numero.format(pedidos)} ${pedidos === 1 ? "vídeo" : "vídeos"} e ` +
      `${quantosCabem} na cota deste período ` +
      `(${numero.format(usados)} de ${numero.format(limite)} usados). ` +
      "Selecione menos vídeos ou mude de plano em Planos."
    );
  }

  const excesso = usados - limite;
  return (
    `Você tem ${numero.format(usados)} vídeos usados e o plano atual comporta ` +
    `${numero.format(limite)}. ` +
    (excesso > 0
      ? `São ${numero.format(excesso)} ${excesso === 1 ? "vídeo" : "vídeos"} ` +
        "acima do limite: remova os que ainda não foram processados ou mude de " +
        "plano em Planos."
      : "Remova vídeos que ainda não foram processados ou mude de plano em Planos.")
  );
}
