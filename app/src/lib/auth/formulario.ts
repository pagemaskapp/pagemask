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

/**
 * Dígitos do código de confirmação de cadastro — o que o projeto **deveria**
 * estar configurado para mandar. Vale para o placeholder e para o
 * `supabase/config.toml`.
 */
export const TAMANHO_DO_CODIGO = 6;

/**
 * O que a validação de fato aceita. **Faixa, e não o número acima**, e isso
 * custou um aceite para descobrir.
 *
 * Quem decide o tamanho do código é o `Email OTP Length` do painel do Supabase,
 * que vive fora do código e fora do CI. O projeto estava em 8 quando esta tela
 * nasceu: com uma validação de exatamente 6, TODO cadastro pararia na frase
 * "o código tem 6 dígitos" enquanto o e-mail trazia 8 — o produto inteiro
 * travado por uma caixa de texto num painel, sem nada no log dizendo isso.
 *
 * A faixa cobre o intervalo que o GoTrue permite (6 a 10). Não é afrouxamento
 * de segurança: o que protege um código numérico é o limite de tentativas por
 * IP, não a recusa antecipada de um comprimento. Código maior é mais forte, não
 * mais fraco.
 *
 * Por isso também nenhum texto de tela crava o número — a tela diz "o código
 * enviado para o seu e-mail", que é verdade em qualquer configuração.
 */
export const CODIGO_MIN = 6;
export const CODIGO_MAX = 10;

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
