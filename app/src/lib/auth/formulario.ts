/**
 * Constantes e tipos dos formulários de autenticação.
 *
 * Moram fora de `acoes.ts` porque um arquivo `"use server"` só pode exportar
 * função assíncrona. Exportar uma constante de lá não dá erro de compilação —
 * o módulo simplesmente fica **sem export nenhum**, e o build quebra com
 * "The export X was not found", apontando para o import, não para a causa.
 */

/** Mínimo de 10 caracteres (docs/PLANO.md, Segurança §1). */
export const TAMANHO_MINIMO_SENHA = 10;

/** Limite das rotas de autenticação: 10 tentativas por 15 minutos. */
export const LIMITE_TENTATIVAS = 10;

/**
 * Link mostrado junto da mensagem, quando a saída do erro é outra tela.
 *
 * Existe porque uma mensagem sozinha não pode prometer um controle: a de
 * "conta não confirmada" dizia "peça outro link abaixo" na tela de login, que
 * não tem esse botão — o reenvio mora em `/confirme-seu-email`. Ou a mensagem
 * traz o caminho junto, ou ela deixa o usuário procurando.
 */
export type AcaoMensagem = {
  href: string;
  rotulo: string;
};

export type EstadoFormulario = {
  erro?: string;
  aviso?: string;
  acao?: AcaoMensagem;
  /**
   * Devolvidos para os campos, para o usuário não redigitar o que já escreveu.
   * O React 19 limpa o formulário depois que a action responde, então o que
   * não voltar aqui some da tela — e some sem aviso, o que parece defeito.
   */
  email?: string;
  nome?: string;
};
