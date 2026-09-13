"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { registrarAuditoria, ipDaRequisicaoAtual } from "@/lib/auditoria";
import { exigirUsuario } from "@/lib/auth/sessao";
import { esperaEmTexto } from "@/lib/uploads/limite-de-taxa";
import { excluirConta } from "@/lib/conta/exclusao";
import { limiteDeExclusao } from "@/lib/conta/limite-de-taxa";
import {
  createClient,
  esquecerSessaoNoNavegador,
} from "@/lib/supabase/server";
import type { EstadoFormulario } from "@/lib/auth/formulario";

/**
 * As ações da tela de conta que destroem algo: excluir a conta e encerrar a
 * sessão em todos os aparelhos.
 *
 * A EXPORTAÇÃO NÃO ESTÁ AQUI, e não é por organização: uma server action
 * responde dados serializados para o React, não um arquivo para download. Ela é
 * `GET /api/conta/exportar`, uma rota que responde com `Content-Disposition`.
 *
 * POR QUE A CONFIRMAÇÃO É O E-MAIL, E NÃO A SENHA
 * ===============================================
 *
 * Pedir a senha seria a reautenticação clássica, e foi o primeiro desenho. Ele
 * não serve aqui: o PLANO §1 prevê **magic link** junto com e-mail/senha, e
 * quem entrou só por link nunca definiu senha nenhuma. Esse desenho deixaria
 * essa pessoa sem caminho self-service para excluir a conta — exatamente o
 * direito que a LGPD manda oferecer — e o erro que ela veria seria "senha
 * incorreta", que não explica coisa alguma.
 *
 * Digitar o próprio endereço cumpre o que a confirmação precisa cumprir: torna
 * o ato deliberado e impossível de cometer por engano ou por clique acidental.
 * O que ela NÃO cumpre é provar identidade contra uma sessão roubada — e para
 * isso a defesa é a sessão em si (`HttpOnly`, `SameSite=Lax`, `getUser()`
 * conferido no servidor), não um campo de texto que quem tem a sessão lê na
 * própria tela de conta.
 */

const confirmacao = z
  .string()
  .trim()
  .min(1, "Digite o e-mail da conta para confirmar.")
  .transform((v) => v.toLowerCase());

export async function excluirMinhaConta(
  _estado: EstadoFormulario,
  formData: FormData,
): Promise<EstadoFormulario> {
  const usuario = await exigirUsuario("/app/conta");

  const analisado = confirmacao.safeParse(formData.get("confirmacao"));
  if (!analisado.success) {
    return { erro: analisado.error.issues[0]?.message ?? "Confirmação inválida." };
  }

  const emailDaConta = usuario.email?.trim().toLowerCase() ?? null;
  if (!emailDaConta || analisado.data !== emailDaConta) {
    return {
      erro:
        "O e-mail digitado não é o desta conta. Confira e digite exatamente " +
        "como aparece acima.",
    };
  }

  const limite = await limiteDeExclusao(usuario.id);
  if (!limite.permitido) {
    return {
      erro:
        "Você tentou excluir a conta vezes demais em pouco tempo. Espere " +
        `${esperaEmTexto(limite.liberadoEm)} e tente de novo.`,
    };
  }

  const resultado = await excluirConta({
    userId: usuario.id,
    email: usuario.email ?? null,
    ip: await ipDaRequisicaoAtual(),
  });

  if (!resultado.ok) {
    return { erro: resultado.mensagem };
  }

  // O cookie precisa sumir: o usuário não existe mais no Auth, e a sessão que
  // sobrar no navegador vira um `getUser()` que falha em toda navegação. Sem
  // `signOut` (não há sessão do outro lado para encerrar) — só o cookie.
  await esquecerSessaoNoNavegador();

  // `redirect` lança: tudo que precisava acontecer já aconteceu.
  redirect(`/conta-excluida?code=${encodeURIComponent(resultado.codigo)}`);
}

/**
 * "Sair de todos os aparelhos" — `scope: "global"`.
 *
 * O botão que a Fase 1 deixou anotado para esta fase. O "Sair desta conta" usa
 * `scope: "local"` de propósito, porque a tela promete encerrar o acesso NESTE
 * navegador; este aqui é o outro caso, o que importa depois de perder o celular
 * ou desconfiar de acesso indevido: revoga todo refresh token do usuário, em
 * todo aparelho, inclusive o deste.
 */
export async function sairDeTodosOsAparelhos(): Promise<void> {
  const usuario = await exigirUsuario("/app/conta");
  const supabase = await createClient();

  const { error } = await supabase.auth.signOut({ scope: "global" });

  if (error) {
    console.error("[conta] signOut global falhou", {
      nome: error.name,
      status: error.status,
      codigo: error.code,
    });
    // Mesma doutrina do "Sair": o cookie daqui vai embora de qualquer forma, e
    // a tela de login avisa que a revogação do lado do servidor não pôde ser
    // confirmada.
    await esquecerSessaoNoNavegador();
    redirect("/entrar?saida=parcial");
  }

  await registrarAuditoria({
    userId: usuario.id,
    actor: "user",
    action: "session.revoke_all",
    target: null,
  });

  redirect("/entrar?saida=global");
}
