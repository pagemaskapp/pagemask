import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";

/**
 * Qual e-mail está esperando confirmação **neste navegador**.
 *
 * Existe por causa de uma falha concreta, encontrada na revisão de segurança
 * desta mesma mudança, e vale registrar o ataque inteiro para ninguém desfazer
 * isto por achar que é burocracia.
 *
 * A confirmação de cadastro virou código digitado (`verifyOtp`). O código prova
 * posse da caixa de entrada — mas `verifyOtp` recebe um **par**, `(e-mail,
 * código)`, e as duas metades precisam vir de quem está confirmando. Enquanto o
 * e-mail vinha do `?email=` da URL e de um `<input hidden>`, só a segunda
 * metade era do usuário. A primeira era de quem tivesse montado o link:
 *
 *   1. o atacante cria uma conta com o e-mail DELE e lê, na caixa dele, o
 *      código que chegou;
 *   2. manda para a vítima uma mensagem imitando o e-mail do PageMask — com o
 *      código dele e um link para o domínio de verdade:
 *      `https://pagemask.com.br/confirme-seu-email?email=atacante@evil.com`;
 *   3. a vítima abre uma página legítima, com cadeado e tudo, vê um campo de
 *      código e digita o número que "recebeu";
 *   4. o par bate — porque é o par do atacante — e o navegador da vítima recebe
 *      a **sessão da conta do atacante**. Ela segue usando o produto achando que
 *      é a conta dela: o vídeo que ela sobe e a conta de Instagram que ela
 *      conecta ficam com ele.
 *
 * É o mesmo ataque que o cabeçalho de `/auth/confirmar` descreve para explicar
 * por que o ramo `token_hash` foi removido de lá. Não pedir senha em nenhum
 * momento é o que torna o golpe eficaz: nenhum gerenciador de senha e nenhum
 * heurístico de phishing dispara.
 *
 * O que fecha isso é este cookie. O e-mail pendente passa a ser escrito **pelo
 * servidor**, em dois pontos onde o navegador provou alguma coisa:
 *
 *   · no cadastro, porque foi este navegador que digitou o endereço;
 *   · no login com senha que esbarra em `email_not_confirmed`, porque a senha
 *     estava certa (o GoTrue confere a senha ANTES do estado de confirmação —
 *     a medição está em `mensagens.ts`).
 *
 * `httpOnly` tira o cookie do alcance de qualquer JavaScript da página, e
 * `sameSite: "lax"` somado à checagem de origem das server actions impede que
 * um site de terceiro consiga plantar um endereço aqui. A tela de confirmação
 * não aceita mais e-mail de lugar nenhum além daqui.
 */
const NOME = "pagemask-cadastro-pendente";

/**
 * Uma hora, igual à validade do código no GoTrue (`otp_expiry`). Cookie que
 * vive mais que o código só serviria para mostrar um formulário que não
 * funciona mais.
 */
const VALIDADE_SEGUNDOS = 60 * 60;

const opcoes = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  // Mesma razão do cookie de sessão: `localhost` é http em desenvolvimento, e
  // cookie `Secure` simplesmente não é enviado — o fluxo pareceria quebrado sem
  // nenhuma mensagem de erro.
  secure: process.env.NODE_ENV === "production",
  maxAge: VALIDADE_SEGUNDOS,
} as const;

/** Guarda o endereço. Só server action e route handler escrevem cookie. */
export async function guardarCadastroPendente(email: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(NOME, email, opcoes);
}

/**
 * O endereço pendente, ou `null`.
 *
 * Revalidado com o zod na leitura, e não só na escrita: o valor volta do
 * navegador, e tudo que volta do navegador é entrada não confiável — mesmo
 * tendo saído daqui. `254` é o limite de um endereço de e-mail.
 */
export async function lerCadastroPendente(): Promise<string | null> {
  const cookieStore = await cookies();
  const bruto = cookieStore.get(NOME)?.value?.trim();
  if (!bruto || bruto.length > 254) return null;
  return z.email().safeParse(bruto).success ? bruto : null;
}

/**
 * Apaga o cookie. Chamado depois da confirmação dar certo — o endereço já não
 * está pendente, e deixá-lo ali faria a tela de confirmação voltar a funcionar
 * para um cadastro que não existe mais.
 */
export async function esquecerCadastroPendente(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: NOME, path: opcoes.path });
}
