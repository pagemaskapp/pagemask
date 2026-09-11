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
        "vídeos que ainda não foram processados ou mude de plano em Conta."
      );
    case CODIGOS.nomeInvalido:
      return "Dê um nome ao projeto, com até 80 caracteres.";
    case CODIGOS.projetoDeOutro:
    case CODIGOS.jobAusente:
      return "Não encontramos esse item na sua conta.";
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
