/**
 * Os recados que as rotas de cobrança devolvem pela URL, traduzidos para
 * português de gente.
 *
 * As rotas de checkout e portal redirecionam com `?aviso=<código>` em vez de
 * carregar a frase na query string. Duas razões, e a segunda é a que importa:
 *
 *   · a frase muda de redação sem mexer na rota;
 *   · **texto na URL é texto que o atacante escolhe.** Uma rota que aceitasse
 *     `?mensagem=` estaria pedindo para renderizar na nossa página o recado que
 *     um link de phishing quiser ("sua assinatura expirou, ligue para…"). Com
 *     código fechado, o que não está na lista não aparece — e é por isso que
 *     `avisoDaCobranca` devolve `null` no `default`, em vez de ecoar o valor.
 *
 * Não é `server-only`: é só tradução, e a tela de planos a usa num componente
 * de servidor que poderia perfeitamente virar de cliente.
 */
export type AvisoDaCobranca = {
  titulo: string;
  detalhe: string;
  tom: "aviso" | "erro";
};

export function avisoDaCobranca(
  codigo: string | undefined,
  cobranca?: string,
): AvisoDaCobranca | null {
  if (cobranca === "cancelado") {
    return {
      titulo: "Checkout interrompido",
      detalhe:
        "Você saiu antes de concluir e nada foi cobrado. Pode tentar de novo " +
        "quando quiser.",
      tom: "aviso",
    };
  }

  if (cobranca === "ok") {
    return {
      titulo: "Pagamento recebido, estamos confirmando",
      detalhe:
        "A Stripe nos avisa em segundos. Esta página mostra o plano novo assim " +
        "que a confirmação chegar — recarregue se demorar mais que isso. " +
        "Pagando por Pix, a autorização vale desde já e o débito acontece no " +
        "ciclo combinado.",
      tom: "aviso",
    };
  }

  switch (codigo) {
    case "sem-assinatura":
      return {
        titulo: "Você ainda não tem assinatura",
        detalhe: "Escolha um plano abaixo para começar.",
        tom: "aviso",
      };
    case "ja-tem-assinatura":
      return {
        titulo: "Você já tem uma assinatura ativa",
        detalhe:
          "Para trocar de plano, cancelar ou atualizar a forma de pagamento, " +
          "use Gerenciar cobrança — assinar de novo criaria uma segunda " +
          "cobrança mensal.",
        tom: "aviso",
      };
    case "plano-invalido":
    case "plano-indisponivel":
      return {
        titulo: "Não conseguimos abrir esse plano",
        detalhe:
          "Recarregue a página e tente de novo. Se continuar assim, escreva " +
          "para o suporte — o problema é do nosso lado.",
        tom: "erro",
      };
    case "cobranca-indisponivel":
    case "portal-indisponivel":
      return {
        titulo: "A cobrança está indisponível agora",
        detalhe:
          "Tente de novo em instantes. Nenhuma cobrança foi feita e seu plano " +
          "não mudou.",
        tom: "erro",
      };
    case "muitas-tentativas":
      return {
        titulo: "Muitas tentativas em pouco tempo",
        detalhe: "Espere alguns minutos antes de tentar de novo.",
        tom: "aviso",
      };
    case "origem-invalida":
      return {
        titulo: "Pedido recusado",
        detalhe:
          "Esse pedido não veio desta página. Use os botões daqui para " +
          "assinar ou gerenciar seu plano.",
        tom: "erro",
      };
    default:
      // Código que não está na lista não vira texto na tela. Ver o topo.
      return null;
  }
}
