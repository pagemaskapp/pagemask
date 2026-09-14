"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import {
  esquecerCadastroPendente,
  guardarCadastroPendente,
  lerCadastroPendente,
} from "@/lib/auth/cadastro-pendente";
import { consumirLimiteAuth } from "@/lib/auth/rate-limit";
import { DESTINO_PADRAO, destinoSeguro } from "@/lib/auth/destino";
import {
  CODIGO_MAX,
  CODIGO_MIN,
  TAMANHO_MINIMO_SENHA,
  type EstadoFormulario,
} from "@/lib/auth/formulario";
import { isAuthApiError } from "@supabase/supabase-js";

import {
  mensagemDeBloqueio,
  mensagemDeErroAuth,
  temFraseEspecifica,
} from "@/lib/auth/mensagens";
import { publicEnv } from "@/lib/env/public";
import {
  createClient,
  esquecerSessaoNoNavegador,
  sessaoGravadaNoCookie,
} from "@/lib/supabase/server";

const email = z
  .string()
  .trim()
  .min(1, "Informe seu e-mail.")
  .pipe(z.email("Esse e-mail não parece válido. Confira se não faltou algo."))
  .transform((v) => v.toLowerCase());

const senha = z
  .string()
  .min(
    TAMANHO_MINIMO_SENHA,
    `A senha precisa ter pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.`,
  )
  // O bcrypt corta em 72 **bytes**, nao caracteres, e o Supabase nao avisa: ele
  // guardaria um prefixo da senha em silencio. Em pt-BR a diferenca e real —
  // cada acento custa 2 bytes em UTF-8, entao uma frase de 60 caracteres com
  // acentos passa dos 72 bytes.
  .refine((valor) => new TextEncoder().encode(valor).length <= 72, {
    error:
      "Essa senha e longa demais. Use uma frase mais curta — acentos e " +
      "emojis contam mais que uma letra.",
  });

/**
 * Nome: obrigatório desde a 0025.
 *
 * A validação aqui e o `not null` da coluna são a mesma regra escrita duas
 * vezes de propósito — o formulário dá a mensagem em português, a coluna
 * garante que nenhum outro caminho (a API do Supabase chamada direto, um
 * usuário criado pelo painel) crie perfil sem nome.
 *
 * `min(2)` e não `min(1)`: uma letra só não é nome, é campo preenchido para
 * passar da validação, e o texto do perfil ("Olá, A") fica pior do que se
 * tivesse ficado vazio.
 */
const nome = z
  .string()
  .trim()
  .min(1, "Informe seu nome.")
  .min(2, "Esse nome parece curto demais. Escreva pelo menos duas letras.")
  .max(120, "O nome pode ter no máximo 120 caracteres.");

/**
 * Código numérico do e-mail de confirmação.
 *
 * A faixa (e não um tamanho exato) é deliberada — a explicação longa está em
 * `CODIGO_MIN`/`CODIGO_MAX`, em `lib/auth/formulario.ts`. Resumo: quem define o
 * tamanho do código é o painel do Supabase, e cravar 6 aqui trava todo cadastro
 * no dia em que o painel estiver em 8.
 */
const codigo = z
  .string()
  .trim()
  // Espaço e traço saem antes de contar: quem copia do e-mail costuma trazer
  // um espaço invisível junto, e reprovar isso por "tamanho errado" é uma
  // mensagem que não ajuda ninguém a consertar nada.
  .transform((valor) => valor.replace(/[\s-]/g, ""))
  .pipe(
    z
      .string()
      .regex(
        new RegExp(`^\\d{${CODIGO_MIN},${CODIGO_MAX}}$`),
        "O código só tem números. Confira o que veio no e-mail e digite de novo.",
      ),
  );

/**
 * Acrescenta a checagem de "as duas senhas batem" a um esquema que tenha
 * `senha` e `confirmacao`.
 *
 * Escrito uma vez porque a regra vale em dois lugares (cadastro e troca de
 * senha) e a mensagem precisa ser a mesma nos dois — duas cópias é uma cópia
 * esperando divergir.
 */
function conferindoAConfirmacao<T extends z.ZodType<{ senha: string; confirmacao: string }>>(
  esquema: T,
) {
  return esquema.refine((dados) => dados.senha === dados.confirmacao, {
    // `path` no campo da confirmação: sem ele o erro fica no objeto inteiro e
    // nenhum campo é apontado.
    path: ["confirmacao"],
    error: "As duas senhas não são iguais. Confira e digite de novo.",
  });
}

const esquemaCadastro = conferindoAConfirmacao(
  z.object({ nome, email, senha, confirmacao: z.string() }),
);

const esquemaLogin = z.object({ email, senha: z.string().min(1, "Informe sua senha.") });

const esquemaEmail = z.object({ email });

const esquemaCodigo = z.object({ codigo });

const esquemaNovaSenha = conferindoAConfirmacao(
  z.object({ senha, confirmacao: z.string() }),
);

/** Primeira mensagem de erro do zod, que é a que interessa mostrar. */
function primeiroErro(erro: z.ZodError): string {
  return erro.issues[0]?.message ?? "Confira os dados e tente de novo.";
}

/**
 * Lê um campo do formulário sempre como texto.
 *
 * Campo ausente vira `null`, e `null` reprova na checagem de TIPO do zod, que
 * acontece antes do `.min()` — então a mensagem que chega na tela é a padrão da
 * biblioteca, em inglês: "Invalid input: expected string, received null".
 * Normalizando para `""`, quem responde é sempre a mensagem em português que
 * escrevemos.
 */
function campo(dados: FormData, nome: string): string {
  const valor = dados.get(nome);
  return typeof valor === "string" ? valor : "";
}

/**
 * URL para onde o link do e-mail volta.
 *
 * Montada com `new URL`, e nao por concatenacao: `NEXT_PUBLIC_APP_URL` passa no
 * `z.url()` com barra no fim, e `${base}/auth/confirmar` viraria
 * `https://host//auth/confirmar`. Duas barras mudam a URL inteira, e a lista de
 * Redirect URLs do Supabase compara a URL inteira — o link pararia de funcionar
 * em silencio, do jeito que o README descreve.
 */
function urlDeRetorno(destino: string): string {
  const url = new URL("/auth/confirmar", publicEnv.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("proximo", destino);
  return url.toString();
}

/**
 * Cobra uma tentativa do limite. **Chamar depois do zod, nunca antes.**
 *
 * O balde e por IP e nao tem dimensao de usuario (de proposito — a explicacao
 * esta em `rate-limit.ts`). Cobrando antes da validacao, dez POSTs com o
 * formulario vazio — que nao chegam nem perto do Supabase e nao tentam adivinhar
 * senha nenhuma — fechavam o login por 15 minutos para todo mundo que
 * dividisse aquele IP. Requisicao malformada nao e tentativa: nao custa balde.
 */
async function limite(rota: string): Promise<string | null> {
  const resultado = await consumirLimiteAuth(rota);
  if (resultado.permitido) return null;
  // A dica de "recupere a senha" só faz sentido para quem estava tentando
  // entrar com senha.
  return mensagemDeBloqueio(resultado.liberadoEm, rota === "entrar");
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

export async function cadastrar(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const emailDigitado = campo(dados, "email");
  const nomeDigitado = campo(dados, "nome");
  // O cadastro era o único fluxo que perdia o destino no caminho: quem clicava
  // num link para `/app/conta`, caía no login e escolhia "Criar conta" acabava
  // em `/app/projetos` depois de confirmar o e-mail.
  const destino = destinoSeguro(campo(dados, "proximo"));

  const analise = esquemaCadastro.safeParse({
    nome: nomeDigitado,
    email: emailDigitado,
    senha: campo(dados, "senha"),
    confirmacao: campo(dados, "confirmacao"),
  });
  if (!analise.success) {
    return {
      erro: primeiroErro(analise.error),
      email: emailDigitado,
      nome: nomeDigitado,
    };
  }

  const bloqueio = await limite("cadastrar");
  if (bloqueio) {
    return { erro: bloqueio, email: emailDigitado, nome: nomeDigitado };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: analise.data.email,
    password: analise.data.senha,
    options: {
      data: { name: analise.data.nome },
      // O template de confirmação manda o código de 6 dígitos
      // (`{{ .Token }}`), e não um link — mas `emailRedirectTo` continua aqui
      // de propósito: ele é o que o Supabase usa para montar
      // `{{ .ConfirmationURL }}`, e um template com as duas coisas (código para
      // digitar, link para clicar) continua funcionando sem mudar código
      // nenhum. Sem ele, o link do template cairia na Site URL.
      emailRedirectTo: urlDeRetorno(destino),
    },
  });

  if (error) {
    // Conta já existente NÃO pode dar mensagem própria: isso transforma o
    // cadastro numa sonda de "esse e-mail tem conta aqui?". Com a confirmação
    // de e-mail ligada, o próprio Supabase já devolve sucesso nesse caso; com
    // ela desligada, ele devolve `email_exists` — e é essa diferença que
    // precisa ser apagada aqui, para as duas configurações se comportarem
    // igual. Quem já tem conta recebe a mesma tela e descobre pelo e-mail.
    //
    // `over_email_send_rate_limit` cai no mesmo lugar, pela mesma razão. Ele é
    // contado por endereço e só existe onde houve envio: uma conta já
    // confirmada não dispara e-mail nenhum, então dois cadastros seguidos para
    // o mesmo endereço separariam "já existe confirmada" (segue direto) de
    // "endereço novo" (mensagem de espera). Igualar as duas respostas fecha
    // essa diferença — e a tela de destino já explica o que fazer se o e-mail
    // demorar.
    if (
      isAuthApiError(error) &&
      (error.code === "email_exists" ||
        error.code === "user_already_exists" ||
        error.code === "over_email_send_rate_limit")
    ) {
      // O endereço vai para o cookie, e não para a URL: é ele que a tela de
      // confirmação vai usar no `verifyOtp`. O porquê está em
      // `lib/auth/cadastro-pendente`.
      await guardarCadastroPendente(analise.data.email);
      redirect(`/confirme-seu-email?proximo=${encodeURIComponent(destino)}`);
    }
    // Erro sem frase própria vira "tente de novo em instantes" na tela — que não
    // diz nada a ninguém. Se o GoTrue cair, é este log que separa "o cadastro
    // está quebrado para todo mundo" de "essa pessoa digitou algo errado".
    if (!temFraseEspecifica(error)) {
      console.error("[auth] cadastro falhou", {
        nome: error.name,
        status: error.status,
        codigo: error.code,
      });
    }
    return { erro: mensagemDeErroAuth(error), email: emailDigitado, nome: nomeDigitado };
  }

  // Com confirmação de e-mail ligada, `signUp` devolve usuário sem sessão. Se
  // vier sessão, a confirmação está desligada no painel do Supabase — o que
  // contraria o PLANO §1. O README diz onde ligar.
  //
  // O log é a única coisa que denuncia isso. A configuração vive no painel,
  // fora do código e fora do CI; sem esta linha, um projeto com "Confirm email"
  // desligado funcionaria bonito, deixaria qualquer um criar conta com o e-mail
  // de outra pessoa, e nada em lugar nenhum diria que a trava está aberta.
  // Recusar a sessão aqui seria pior: quebraria o cadastro inteiro por causa de
  // uma caixa desmarcada, sem dar a ninguém a informação de qual é ela.
  if (data.session) {
    console.error(
      "[auth] signUp devolveu sessão: 'Confirm email' está DESLIGADO no painel do Supabase (PLANO §1)",
    );
    redirect(destino);
  }

  await guardarCadastroPendente(analise.data.email);
  redirect(`/confirme-seu-email?proximo=${encodeURIComponent(destino)}`);
}

// ---------------------------------------------------------------------------
// Confirmação por código de 6 dígitos
// ---------------------------------------------------------------------------

/**
 * Troca o código digitado por uma sessão.
 *
 * É o caminho que o cabeçalho de `/auth/confirmar` antecipou: confirmar o
 * e-mail **sem** transformar um link encaminhado numa sessão. E a peça que faz
 * isso valer não é o código, é de onde vem o e-mail.
 *
 * `verifyOtp` recebe um PAR, `(e-mail, código)`, e as duas metades precisam ser
 * de quem está confirmando. O e-mail sai do **cookie de cadastro pendente**,
 * escrito pelo servidor, e não de campo do formulário nem de parâmetro da URL:
 * com o endereço vindo da URL, um atacante mandava o código da conta DELE junto
 * de um link do PageMask e a vítima entregava o navegador dela à conta dele. O
 * ataque inteiro está descrito em `lib/auth/cadastro-pendente`.
 *
 * Sem cookie não há o que confirmar — e a tela sequer mostra o formulário.
 */
export async function confirmarCodigo(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const destino = destinoSeguro(campo(dados, "proximo"));

  const analise = esquemaCodigo.safeParse({ codigo: campo(dados, "codigo") });
  if (!analise.success) {
    return { erro: primeiroErro(analise.error) };
  }

  const pendente = await lerCadastroPendente();
  if (!pendente) {
    return {
      erro:
        "Não encontramos um cadastro pendente neste navegador — o pedido pode " +
        "ter expirado. Entre com seu e-mail e senha para receber um código novo.",
      acao: { href: "/entrar", rotulo: "Ir para o login" },
    };
  }

  // Balde próprio, e ele é o que sustenta um código numérico: seis dígitos são
  // um milhão de combinações, e sem limite de tentativas um script varre isso
  // em minutos. 10 tentativas por 15 minutos por rede deixa o acerto por sorte
  // em algo perto de nada dentro da validade do código.
  const bloqueio = await limite("confirmar");
  if (bloqueio) return { erro: bloqueio };

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    email: pendente,
    token: analise.data.codigo,
    type: "signup",
  });

  if (error) {
    if (!temFraseEspecifica(error)) {
      console.error("[auth] confirmação por código falhou", {
        nome: error.name,
        status: error.status,
        codigo: error.code,
      });
    }
    return { erro: mensagemDeErroAuth(error) };
  }

  // Mesma trava de `/auth/confirmar`: `verifyOtp` devolver sucesso não garante
  // que a sessão virou cookie. Sem esta conferência, o redirect mandaria a
  // pessoa para dentro do app sem sessão, o proxy a devolveria ao login, e o
  // código — que vale uma vez só — já estaria gasto.
  if (!(await sessaoGravadaNoCookie())) {
    console.error(
      "[auth] código verificado com sucesso, mas a sessão não foi para o cookie",
    );
    return {
      erro:
        "Confirmamos seu e-mail, mas não conseguimos abrir a sessão neste " +
        "navegador. Entre com seu e-mail e senha.",
      acao: { href: "/entrar", rotulo: "Ir para o login" },
    };
  }

  // O cadastro deixou de estar pendente. Deixar o cookie ali faria esta tela
  // voltar a oferecer um formulário que não confirma mais nada.
  await esquecerCadastroPendente();

  redirect(destino);
}

// ---------------------------------------------------------------------------
// Login com senha
// ---------------------------------------------------------------------------

export async function entrarComSenha(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const emailDigitado = campo(dados, "email");
  const destino = destinoSeguro(campo(dados, "proximo"));

  const analise = esquemaLogin.safeParse({
    email: campo(dados, "email"),
    senha: campo(dados, "senha"),
  });
  if (!analise.success) {
    return { erro: primeiroErro(analise.error), email: emailDigitado };
  }

  const bloqueio = await limite("entrar");
  if (bloqueio) return { erro: bloqueio, email: emailDigitado };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: analise.data.email,
    password: analise.data.senha,
  });

  if (error) {
    // Conta correta, senha correta, só falta confirmar: este navegador provou o
    // endereço, então ele pode receber o cookie de cadastro pendente e digitar
    // o código. O GoTrue confere a senha ANTES do estado de confirmação (a
    // medição está em `mensagens.ts`), então `email_not_confirmed` só chega
    // aqui para quem acertou a senha — ninguém planta endereço alheio por esta
    // porta.
    if (isAuthApiError(error) && error.code === "email_not_confirmed") {
      await guardarCadastroPendente(analise.data.email);
    }
    // Mesma regra do cadastro: só o que não tem explicação na tela vai ao log.
    // Senha errada (`invalid_credentials`) fica de fora de propósito — é o caso
    // mais comum de todos, e enchê-lo de linhas esconderia o que importa.
    if (!temFraseEspecifica(error)) {
      console.error("[auth] login falhou", {
        nome: error.name,
        status: error.status,
        codigo: error.code,
      });
    }
    return {
      erro: mensagemDeErroAuth(error),
      email: emailDigitado,
      // A mensagem de conta não confirmada manda digitar o código, e o campo
      // que faz isso não está nesta tela — está em `/confirme-seu-email`. Sem
      // este link, o usuário fica com uma instrução sem lugar onde cumpri-la.
      acao:
        isAuthApiError(error) && error.code === "email_not_confirmed"
          ? {
              // O `proximo` vai junto: a pessoa pediu uma página específica,
              // caiu no login e agora vai confirmar o e-mail. Sem ele, a
              // confirmação a deixa em `/app/projetos` e ela precisa procurar
              // de novo o que já tinha pedido.
              href: `/confirme-seu-email?proximo=${encodeURIComponent(destino)}`,
              rotulo: "Digitar o código de confirmação",
            }
          : undefined,
    };
  }

  redirect(destino);
}

// ---------------------------------------------------------------------------
// Recuperação de senha
// ---------------------------------------------------------------------------

/**
 * Manda o e-mail de recuperação.
 *
 * O link volta por `/auth/confirmar` (PKCE, como todo link deste projeto) e cai
 * em `/nova-senha`, que é onde a senha de fato muda. `resetPasswordForEmail`
 * sozinho não troca senha nenhuma — ele só abre uma sessão de recuperação.
 *
 * A resposta é neutra e sempre a mesma, exista a conta ou não: esta tela é
 * pública, e uma mensagem diferente para "e-mail sem cadastro" responderia
 * "esse e-mail tem conta aqui?" — a pergunta que nenhuma tela pública do
 * PageMask responde.
 */
export async function recuperarSenha(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const emailDigitado = campo(dados, "email");

  const analise = esquemaEmail.safeParse({ email: emailDigitado });
  if (!analise.success) {
    return { erro: primeiroErro(analise.error), email: emailDigitado };
  }

  const bloqueio = await limite("recuperar");
  if (bloqueio) return { erro: bloqueio, email: emailDigitado };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(
    analise.data.email,
    { redirectTo: urlDeRetorno("/nova-senha") },
  );

  const neutro = {
    aviso:
      `Se existir uma conta para ${analise.data.email}, o link para criar uma ` +
      "senha nova chega em instantes. Ele vale uma vez só e expira em 1 hora. " +
      "Confira também a caixa de spam — e abra o link no mesmo navegador em " +
      "que você pediu.",
    email: emailDigitado,
  };

  if (error) {
    // Mesma regra do reenvio: `over_email_send_rate_limit` é contado POR
    // ENDEREÇO e só dispara depois de um envio de verdade. Como e-mail sem
    // conta nunca gera envio, traduzi-lo separaria "tem conta" de "não tem" —
    // a sonda de volta, por outra porta. Só o limite por IP, que independe da
    // conta, aparece.
    if (isAuthApiError(error) && error.code === "over_request_rate_limit") {
      return { erro: mensagemDeErroAuth(error), email: emailDigitado };
    }

    console.error("[auth] recuperação de senha falhou", {
      nome: error.name,
      status: error.status,
      codigo: error.code,
    });
    return neutro;
  }

  return neutro;
}

/**
 * Grava a senha nova. Exige a sessão que o link de recuperação abriu.
 *
 * Sem sessão não há o que atualizar: `updateUser` age sobre quem está logado.
 * Por isso o caminho é link → `/auth/confirmar` (que troca o código por sessão)
 * → esta tela. Quem chega aqui sem sessão volta para pedir outro link.
 */
export async function definirNovaSenha(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const analise = esquemaNovaSenha.safeParse({
    senha: campo(dados, "senha"),
    confirmacao: campo(dados, "confirmacao"),
  });
  if (!analise.success) return { erro: primeiroErro(analise.error) };

  const bloqueio = await limite("nova-senha");
  if (bloqueio) return { erro: bloqueio };

  const supabase = await createClient();

  // `getUser()` e não `getSession()`: é o servidor do Supabase que diz se a
  // sessão vale. A página já confere isso antes de renderizar, mas a action é
  // um endpoint próprio — quem renderiza não é quem autoriza.
  const { data, error: erroDeSessao } = await supabase.auth.getUser();
  if (erroDeSessao || !data.user) {
    return {
      erro:
        "Seu link de recuperação não vale mais. Peça outro e abra-o no mesmo " +
        "navegador.",
      acao: { href: "/recuperar-senha", rotulo: "Pedir outro link" },
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: analise.data.senha,
  });

  if (error) {
    if (!temFraseEspecifica(error)) {
      console.error("[auth] troca de senha falhou", {
        nome: error.name,
        status: error.status,
        codigo: error.code,
      });
    }
    return { erro: mensagemDeErroAuth(error) };
  }

  // Direto para dentro do app: a sessao de recuperacao ja e uma sessao valida,
  // e mandar para `/entrar` obrigaria a pessoa a digitar agora a senha que ela
  // acabou de criar — sem ganho nenhum de seguranca, porque ela ja esta logada.
  redirect(DESTINO_PADRAO);
}

// ---------------------------------------------------------------------------
// Reenviar confirmação
// ---------------------------------------------------------------------------

export async function reenviarConfirmacao(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const destino = destinoSeguro(campo(dados, "proximo"));

  // Mesmo endereço que o `confirmarCodigo` usa, e pela mesma razão: com o
  // e-mail vindo do formulário, esta tela pública viraria um botão de "mande
  // e-mail do PageMask para quem eu quiser".
  const pendente = await lerCadastroPendente();
  if (!pendente) {
    return {
      erro:
        "Não encontramos um cadastro pendente neste navegador — o pedido pode " +
        "ter expirado. Entre com seu e-mail e senha para receber um código novo.",
      acao: { href: "/entrar", rotulo: "Ir para o login" },
    };
  }

  const bloqueio = await limite("reenviar");
  if (bloqueio) return { erro: bloqueio };

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: pendente,
    options: {
      emailRedirectTo: urlDeRetorno(destino),
    },
  });

  // Mesma resposta exista a conta ou não: `/confirme-seu-email` é público,
  // então uma mensagem diferente para `user_not_found` transformaria esta tela
  // numa sonda de "esse e-mail tem conta aqui?". Só o limite de envio escapa da
  // regra — não diz nada sobre a conta, e o usuário precisa saber que deve
  // esperar.
  const neutro = {
    aviso:
      "Se houver um cadastro pendente para esse e-mail, o código novo chega " +
      "em instantes. Confira também o spam. Se você acabou de pedir um, " +
      "espere alguns minutos antes de pedir outro — e use sempre o código " +
      "mais recente, porque o anterior deixa de valer.",
  };

  if (error) {
    // Mesma regra do de cima: `over_email_send_rate_limit` é contado por
    // endereço e só existe onde houve envio, então distinguí-lo diria quem tem
    // cadastro pendente. Só o limite por IP, que independe da conta, aparece.
    if (isAuthApiError(error) && error.code === "over_request_rate_limit") {
      return { erro: mensagemDeErroAuth(error) };
    }
    console.error("[auth] reenvio de confirmação falhou", {
      nome: error.name,
      status: error.status,
      codigo: error.code,
    });
    return neutro;
  }

  return neutro;
}

// ---------------------------------------------------------------------------
// Sair
// ---------------------------------------------------------------------------

export async function sair(): Promise<void> {
  const supabase = await createClient();
  // Um detalhe que precisou de medição, não de leitura: nesta mesma requisição
  // o proxy pode ter renovado a sessão e gravado um `Set-Cookie` novo, enquanto
  // esta ação grava um `Set-Cookie` que apaga. Os dois saem na resposta, e a
  // ordem é [renovação, exclusão] — quem escreve por último vence, então o
  // "Sair" sai mesmo quando cai em cima de uma renovação. Verificado forçando o
  // access token a vencer dentro da POST: navegador terminou sem cookie e
  // `/app/conta` voltou a pedir login.
  //
  // `scope: "local"` encerra só esta sessão. O padrão do supabase-js é
  // `global`, que derruba o usuário em todos os aparelhos — e a tela promete
  // "encerra o acesso neste navegador". Sair do celular não pode deslogar o
  // computador sem avisar. Revogar tudo é outra ação, e vai ter botão próprio
  // na Fase 10, junto com a exclusão de conta.
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (!error) redirect("/entrar?saida=ok");

  // O erro NÃO pode ser descartado. No `auth-js` 2.116, `_signOut` desiste
  // antes de limpar o cookie quando não consegue ler a sessão (rede fora,
  // refresh falhando) — devolve o erro e deixa o token no navegador. Redirecionar
  // sem olhar isso levava o usuário para `/entrar` ainda logado, e o proxy o
  // devolvia para `/app/projetos`: o botão "Sair" que não sai, sem uma palavra
  // de explicação.
  console.error("[auth] signOut falhou", {
    nome: error.name,
    status: error.status,
    codigo: error.code,
  });

  // Apagar o cookie aqui cumpre o que a tela promete — o acesso neste navegador
  // acaba. O que não dá para garantir é a revogação do refresh token no
  // servidor, então a tela de login avisa e recomenda trocar a senha.
  await esquecerSessaoNoNavegador();
  redirect("/entrar?saida=parcial");
}
