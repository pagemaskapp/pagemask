import { ErroDaMeta } from "@/lib/ig/api";

/**
 * O que a tela diz quando a conexão não deu certo (prompt da Fase 4, item 4:
 * "nunca um erro cru").
 *
 * O CALLBACK NÃO DEVOLVE TEXTO, DEVOLVE UM CÓDIGO
 * ===============================================
 *
 * A rota de callback termina num redirect para `/app/conectores/retorno`, e o
 * que viaja na URL é um dos `MotivoDaFalha` abaixo — nunca a mensagem da Meta.
 *
 * Duas razões, nesta ordem de importância:
 *
 *   1. A mensagem da Meta é escrita por terceiro e chega pela URL. Repassá-la
 *      para a tela é aceitar que um estranho escreva dentro do produto: basta
 *      montar um link para `/app/conectores/retorno?motivo=<texto>` e mandá-lo
 *      para a vítima. O React escapa HTML, então não vira script — mas vira um
 *      recado convincente ("sua sessão expirou, entre de novo em …"), que é
 *      phishing dentro da nossa própria página.
 *   2. A mensagem da Meta é em inglês e fala de OAuth. O CLAUDE.md pede pt-BR,
 *      e quem está na tela precisa saber o que FAZER, não o que falhou.
 *
 * O texto da Meta vai inteiro para o log do servidor, que é onde ele serve.
 */

export const MOTIVOS = [
  "negado",
  "estado",
  "sem-sessao",
  "limite",
  "nao-profissional",
  "codigo-usado",
  "limite-de-taxa",
  "meta",
  "config",
  "interno",
] as const;

export type MotivoDaFalha = (typeof MOTIVOS)[number];

export function ehMotivo(valor: string | null | undefined): valor is MotivoDaFalha {
  return typeof valor === "string" && (MOTIVOS as readonly string[]).includes(valor);
}

export type Recado = { titulo: string; texto: string };

export function recadoDaFalha(motivo: MotivoDaFalha): Recado {
  switch (motivo) {
    case "negado":
      return {
        titulo: "Você não autorizou a conexão",
        texto:
          "A janela do Instagram foi fechada ou o acesso foi recusado. Nada foi " +
          "conectado. Clique em Conectar Instagram para tentar de novo.",
      };
    case "estado":
      return {
        titulo: "A janela ficou aberta tempo demais",
        texto:
          "Por segurança, o pedido de conexão vale por 10 minutos e só pode ser " +
          "usado uma vez. Comece de novo pelo botão Conectar Instagram.",
      };
    case "sem-sessao":
      return {
        titulo: "Sua sessão expirou durante a conexão",
        texto:
          "Entre de novo no PageMask e repita o Conectar Instagram. Nenhuma " +
          "conta foi conectada.",
      };
    case "limite":
      return {
        titulo: "Seu plano já está com todas as contas ocupadas",
        texto:
          "Desconecte uma conta que você não usa mais nesta tela, ou mude de " +
          "plano em Conta, e tente de novo.",
      };
    case "nao-profissional":
      return {
        titulo: "Essa conta ainda não é Profissional",
        texto:
          "No app do Instagram, vá em Perfil › Menu (☰) › Configurações e " +
          "privacidade › Tipo de conta e ferramentas › Mudar para conta " +
          "profissional, e escolha Empresa ou Criador de conteúdo. Depois volte " +
          "aqui e conecte de novo.",
      };
    case "codigo-usado":
      return {
        titulo: "Essa autorização já tinha sido usada",
        texto:
          "Isso acontece quando a página de retorno é recarregada. Se a conta " +
          "não aparecer na lista, clique em Conectar Instagram outra vez.",
      };
    case "limite-de-taxa":
      return {
        titulo: "Você tentou conectar muitas vezes seguidas",
        texto:
          "Espere alguns minutos e tente de novo. Nenhuma conta foi alterada.",
      };
    case "meta":
      return {
        titulo: "O Instagram recusou a conexão",
        texto:
          "Confira se a conta é Profissional e se você foi convidado como " +
          "testador do app, e tente de novo em alguns minutos. Se continuar, " +
          "fale com o suporte.",
      };
    case "config":
      return {
        titulo: "A conexão com o Instagram não está configurada",
        texto:
          "Isso é um problema do nosso lado, não seu. Já registramos o erro; " +
          "tente de novo mais tarde.",
      };
    case "interno":
      return {
        titulo: "Algo deu errado ao conectar",
        texto:
          "Nenhuma conta foi alterada. Tente de novo em alguns instantes; se " +
          "continuar, fale com o suporte.",
      };
  }
}

/**
 * O motivo que corresponde a um erro da Meta.
 *
 * `code: 100` com `error_subcode: 33` e as variações de "does not exist" são o
 * que a Meta devolve quando a conta não é Profissional: o nó existe, mas não
 * expõe nada para este app. Como ela nunca diz isso em português nem de forma
 * única, a checagem é por padrão de texto — e o padrão está AQUI, num lugar só,
 * em vez de espalhado pelas rotas.
 */
export function motivoDoErroDaMeta(erro: unknown): MotivoDaFalha {
  if (!(erro instanceof ErroDaMeta)) return "interno";
  if (erro.origem === "rede" || erro.origem === "formato") return "meta";

  const texto = erro.detalhe.toLowerCase();

  if (/already been used|code has expired|authorization code/.test(texto)) {
    return "codigo-usado";
  }
  if (
    /not a (business|professional)|professional account|does not exist.*permission|nonexisting field/.test(
      texto,
    )
  ) {
    return "nao-profissional";
  }
  return "meta";
}

/**
 * O tipo de conta que a Meta devolve em `account_type`.
 *
 * `null` passa: quando a Meta omite o campo (ou o recusa, e o `/me` cai no
 * conjunto mínimo), não dá para afirmar que a conta é pessoal — e barrar por
 * falta de informação recusaria conexões perfeitamente válidas.
 */
export function ehProfissional(tipoDeConta: string | null): boolean {
  if (tipoDeConta === null) return true;
  return tipoDeConta.toUpperCase() !== "PERSONAL";
}
