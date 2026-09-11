"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { consumirLimiteAuth } from "@/lib/auth/rate-limit";
import { destinoSeguro } from "@/lib/auth/destino";
import {
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

const esquemaCadastro = z.object({
  nome: z
    .string()
    .trim()
    .max(120, "O nome pode ter no máximo 120 caracteres.")
    .optional(),
  email,
  senha,
});

const esquemaLogin = z.object({ email, senha: z.string().min(1, "Informe sua senha.") });

const esquemaLink = z.object({ email });

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
  // A dica de "peça um link de acesso" só faz sentido para quem estava tentando
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
  // O cadastro era o único fluxo que perdia o destino no caminho: quem clicava
  // num link para `/app/conta`, caía no login e escolhia "Criar conta" acabava
  // em `/app/projetos` depois de confirmar o e-mail.
  const destino = destinoSeguro(campo(dados, "proximo"));

  const analise = esquemaCadastro.safeParse({
    nome: campo(dados, "nome") || undefined,
    email: campo(dados, "email"),
    senha: campo(dados, "senha"),
  });
  if (!analise.success) {
    return {
      erro: primeiroErro(analise.error),
      email: emailDigitado,
      nome: campo(dados, "nome"),
    };
  }

  const bloqueio = await limite("cadastrar");
  if (bloqueio) {
    return { erro: bloqueio, email: emailDigitado, nome: campo(dados, "nome") };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: analise.data.email,
    password: analise.data.senha,
    options: {
      data: analise.data.nome ? { name: analise.data.nome } : undefined,
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
      redirect(
        `/confirme-seu-email?email=${encodeURIComponent(analise.data.email)}` +
          `&proximo=${encodeURIComponent(destino)}`,
      );
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
    return { erro: mensagemDeErroAuth(error), email: emailDigitado, nome: analise.data.nome };
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

  redirect(
    `/confirme-seu-email?email=${encodeURIComponent(analise.data.email)}` +
      `&proximo=${encodeURIComponent(destino)}`,
  );
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
      // A mensagem de conta não confirmada manda pedir outro link, e o botão
      // que faz isso não está nesta tela — está em `/confirme-seu-email`. Sem
      // este link, o usuário fica com uma instrução sem lugar onde cumpri-la.
      acao:
        isAuthApiError(error) && error.code === "email_not_confirmed"
          ? {
              // O `proximo` vai junto: a pessoa pediu uma página específica,
              // caiu no login e agora vai confirmar o e-mail. Sem ele, o link
              // do e-mail a deixa em `/app/projetos` e ela precisa procurar de
              // novo o que já tinha pedido.
              href:
                `/confirme-seu-email?email=${encodeURIComponent(analise.data.email)}` +
                `&proximo=${encodeURIComponent(destino)}`,
              rotulo: "Pedir outro link de confirmação",
            }
          : undefined,
    };
  }

  redirect(destino);
}

// ---------------------------------------------------------------------------
// Link de acesso (magic link)
// ---------------------------------------------------------------------------

export async function enviarLinkDeAcesso(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const emailDigitado = campo(dados, "email");
  const destino = destinoSeguro(campo(dados, "proximo"));

  const analise = esquemaLink.safeParse({ email: campo(dados, "email") });
  if (!analise.success) {
    return { erro: primeiroErro(analise.error), email: emailDigitado };
  }

  const bloqueio = await limite("link");
  if (bloqueio) return { erro: bloqueio, email: emailDigitado };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: analise.data.email,
    options: {
      // `false`: link de acesso entra em conta que já existe, não cria conta
      // nova. Sem isso, o formulário de login vira um cadastro silencioso e dá
      // para descobrir quais e-mails têm conta pela diferença de comportamento.
      shouldCreateUser: false,
      emailRedirectTo: urlDeRetorno(destino),
    },
  });

  const neutro = {
    aviso:
      `Se existir uma conta para ${analise.data.email}, o link de acesso ` +
      "chega em instantes. Ele vale uma vez só e expira em 1 hora. Se você " +
      "acabou de pedir um, espere alguns minutos antes de pedir outro.",
    email: emailDigitado,
  };

  if (error) {
    // A resposta é a MESMA quando a conta não existe. Com
    // `shouldCreateUser: false`, o Supabase devolve `otp_disabled` ou
    // `user_not_found` nesse caso, e traduzir esses códigos entregaria de
    // graça uma sonda de "esse e-mail tem conta aqui?" — que é o oposto do
    // aviso neutro logo acima.
    //
    // `over_email_send_rate_limit` entra na mesma regra, e antes não entrava:
    // ele é contado POR ENDEREÇO e só dispara depois de um envio de verdade.
    // Como e-mail inexistente nunca gera envio, dois pedidos seguidos para o
    // mesmo endereço separavam "tem conta" (mensagem de espera) de "não tem"
    // (aviso neutro) — a sonda de volta, por outra porta. A orientação de
    // esperar não se perdeu: ela está no aviso neutro, que é igual para os dois
    // casos.
    //
    // `over_request_rate_limit` é outra coisa: conta por IP, dispara exista a
    // conta ou não, e por isso não separa nada.
    if (isAuthApiError(error) && error.code === "over_request_rate_limit") {
      return { erro: mensagemDeErroAuth(error), email: emailDigitado };
    }

    // `name` e `status` junto do codigo: `AuthRetryableFetchError` (provedor de
    // e-mail fora do ar, rede caida) NAO tem `code`, e o log sozinho diria
    // apenas `{ codigo: undefined }` — enquanto o usuario recebe o aviso neutro
    // de sempre. Esta e a unica pista de que nada foi enviado.
    console.error("[auth] link de acesso falhou", {
      nome: error.name,
      status: error.status,
      codigo: error.code,
    });
    return neutro;
  }

  return neutro;
}

// ---------------------------------------------------------------------------
// Reenviar confirmação
// ---------------------------------------------------------------------------

export async function reenviarConfirmacao(
  _anterior: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const emailDigitado = campo(dados, "email");
  const destino = destinoSeguro(campo(dados, "proximo"));

  const analise = esquemaLink.safeParse({ email: campo(dados, "email") });
  if (!analise.success) {
    return { erro: primeiroErro(analise.error), email: emailDigitado };
  }

  const bloqueio = await limite("reenviar");
  if (bloqueio) return { erro: bloqueio, email: emailDigitado };

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: analise.data.email,
    options: {
      emailRedirectTo: urlDeRetorno(destino),
    },
  });

  // Mesma resposta exista a conta ou não, pela mesma razão do link de acesso:
  // `/confirme-seu-email` é público, então uma mensagem diferente para
  // `user_not_found` transformaria esta tela numa sonda de "esse e-mail tem
  // conta aqui?". Só o limite de envio escapa da regra — não diz nada sobre a
  // conta, e o usuário precisa saber que deve esperar.
  const neutro = {
    aviso:
      "Se houver um cadastro pendente para esse e-mail, o link de confirmação " +
      "chega em instantes. Confira também o spam. Se você acabou de pedir um, " +
      "espere alguns minutos antes de pedir outro.",
    email: emailDigitado,
  };

  if (error) {
    // Mesma regra do link de acesso: `over_email_send_rate_limit` é contado por
    // endereço e só existe onde houve envio, então distinguí-lo diria quem tem
    // cadastro pendente. Só o limite por IP, que independe da conta, aparece.
    if (isAuthApiError(error) && error.code === "over_request_rate_limit") {
      return { erro: mensagemDeErroAuth(error), email: emailDigitado };
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
