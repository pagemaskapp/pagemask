/**
 * Traduz o erro do Supabase Auth para uma frase em pt-BR que diz **o que houve
 * e o que fazer**. "Invalid login credentials" não é nenhuma das duas coisas.
 *
 * A tradução é por `code`, não pela mensagem: a mensagem em inglês muda entre
 * versões, o código não.
 */

import type { AuthError } from "@supabase/supabase-js";

const POR_CODIGO: Record<string, string> = {
  invalid_credentials:
    "E-mail ou senha incorretos. Confira os dois e tente de novo.",
  // Sem "abaixo", "ao lado" nem nenhuma outra referência a um controle da
  // tela: esta frase aparece em `/entrar`, que não tem botão de reenvio — ele
  // mora em `/confirme-seu-email`. Quem mostra o caminho é o `acao` do
  // `EstadoFormulario`, junto da mensagem.
  //
  // E esta frase, ao contrário das outras que falam de conta, PODE ser
  // específica: ela não vaza existência de conta. O GoTrue confere a senha
  // antes do estado de confirmação — medido contra o projeto real, com uma
  // conta pendente de verdade:
  //
  //     pendente    + senha errada  -> invalid_credentials
  //     pendente    + senha certa   -> email_not_confirmed
  //     inexistente + senha qualquer-> invalid_credentials
  //
  // Ou seja, só chega aqui quem já tem a senha certa — e quem tem a senha já
  // sabe que a conta existe. Não há o que esconder dele.
  email_not_confirmed:
    "Sua conta ainda não foi confirmada. Abra o e-mail que enviamos e clique " +
    "no link — confira também a caixa de spam. Se ele não chegou, peça outro.",
  // `email_exists`, `user_already_exists` e `user_not_found` NÃO têm frase
  // própria, e isso é a decisão, não um esquecimento. Os três respondem "esse
  // e-mail tem conta aqui?" — a pergunta que nenhuma tela pública do PageMask
  // responde. Hoje todos os chamadores interceptam esses códigos antes de
  // chegar aqui (cadastro redireciona, link e reenvio devolvem aviso neutro),
  // mas uma frase escrita neste mapa é uma armadilha esperando o próximo
  // chamador que esquecer de interceptar: ela vazaria sozinha, sem ninguém
  // decidir nada. Sem entrada, o pior caso é a mensagem genérica.
  weak_password:
    "Senha fraca demais. Use pelo menos 10 caracteres e evite sequências " +
    "óbvias e palavras do dicionário.",
  over_email_send_rate_limit:
    "Enviamos e-mails demais para esse endereço agora há pouco. Espere alguns " +
    "minutos antes de pedir outro.",
  over_request_rate_limit:
    "Tentativas demais em pouco tempo. Espere alguns minutos e tente de novo.",
  otp_expired:
    "Esse link de acesso expirou ou já foi usado. Peça um novo — cada link " +
    "vale uma vez só.",
  otp_disabled:
    "O acesso por link não está disponível. Entre com e-mail e senha.",
  signup_disabled:
    "O cadastro está fechado no momento. Escreva para o suporte se precisar " +
    "de acesso.",
  email_provider_disabled:
    "O acesso por e-mail não está disponível. Escreva para o suporte.",
  user_banned:
    "Essa conta está suspensa. Escreva para o suporte para entender o motivo.",
  email_address_invalid:
    "Esse endereço de e-mail não foi aceito. Confira se o domínio está certo — " +
    "endereços de teste, como os terminados em .test, não funcionam.",
  email_address_not_authorized:
    "Esse endereço não está autorizado a receber e-mails deste projeto ainda. " +
    "Escreva para o suporte.",
  validation_failed:
    "Os dados enviados não são válidos. Confira o e-mail e tente de novo.",
  bad_json: "Não conseguimos ler os dados enviados. Recarregue a página.",
  flow_state_expired:
    "O link demorou demais para ser aberto. Peça um novo.",
  flow_state_not_found:
    "Esse link não vale mais, ou foi aberto em outro navegador. Peça um novo " +
    "e abra no mesmo aparelho em que pediu.",
};

/**
 * O erro tem frase própria aqui, ou vai cair na genérica?
 *
 * Serve para quem chama decidir se registra no log: erro com frase própria é
 * caso previsto e explicado ao usuário — não precisa de rastro. O resto (5xx,
 * rede caída, código que o Supabase inventou depois) some atrás de "tente de
 * novo em instantes", e aí o log é a única coisa que diz o que aconteceu.
 */
export function temFraseEspecifica(erro: AuthError | null | undefined): boolean {
  return Boolean(erro?.code && Object.hasOwn(POR_CODIGO, erro.code));
}

const GENERICA =
  "Não conseguimos concluir agora. Tente de novo em instantes — se " +
  "continuar, escreva para o suporte.";

/**
 * Devolve a frase em português para o usuário.
 *
 * O erro cru nunca é repassado: mensagem de erro de provedor de autenticação é
 * lugar clássico de vazar se um e-mail existe ou não. O detalhe técnico vai
 * para o Sentry (Fase 10), não para a tela.
 */
export function mensagemDeErroAuth(erro: AuthError | null | undefined): string {
  if (!erro) return GENERICA;

  // A checagem é pelo `code` do `AuthError` base, e **não** por
  // `isAuthApiError`. Nem todo erro com código é um `AuthApiError`: o auth-js
  // 2.116 lança `AuthWeakPasswordError` para `weak_password`, cujo `name` é
  // `"AuthWeakPasswordError"` — e `isAuthApiError` exige `name ===
  // "AuthApiError"`. Com o portão errado, a frase sobre senha fraca era código
  // morto: quem escolhia uma senha ruim recebia a mensagem genérica, que não
  // diz o que consertar. `code` mora na classe base, então serve para todas.
  //
  // `Object.hasOwn` porque indexar objeto comum alcança `Object.prototype`: um
  // `code` chamado `toString` devolveria uma função no lugar da frase.
  if (erro.code && Object.hasOwn(POR_CODIGO, erro.code)) {
    return POR_CODIGO[erro.code];
  }

  // Sem rede, Supabase fora do ar: vale a pena distinguir, porque a ação do
  // usuário é diferente — esperar, e não corrigir o que digitou.
  if (erro.name === "AuthRetryableFetchError") {
    return (
      "Não conseguimos falar com o servidor. Verifique sua conexão e tente " +
      "de novo."
    );
  }

  return GENERICA;
}

/**
 * Quanto falta, em português, para o fim de um bloqueio por tentativas.
 *
 * `dicaDeSenha` só vale na tela de login. A mesma função responde pelos baldes
 * de cadastro, link de acesso e reenvio, e mandar "peça um link de acesso" para
 * quem tentava se cadastrar é conselho errado: com `shouldCreateUser: false` o
 * link não sai para quem ainda não tem conta, e a pessoa esperaria por um
 * e-mail que nunca vem.
 */
export function mensagemDeBloqueio(
  liberadoEm: Date,
  dicaDeSenha = false,
): string {
  const minutos = Math.max(1, Math.ceil((liberadoEm.getTime() - Date.now()) / 60000));
  const tempo = minutos === 1 ? "1 minuto" : `${minutos} minutos`;
  const base =
    `Tentativas demais a partir da sua conexão. Por segurança, esta ação está ` +
    `bloqueada por ${tempo}.`;

  // "Peça um link de acesso" sem "espere o bloqueio passar": o balde do link é
  // outro (`link:<ip>`), e o bloqueio do login não o alcança. Mandar esperar
  // quinze minutos por um caminho que está aberto agora é dar conselho errado
  // para quem justamente nao consegue entrar.
  return dicaDeSenha
    ? `${base} Se esqueceu a senha, peça um link de acesso — ele não depende deste bloqueio.`
    : base;
}
