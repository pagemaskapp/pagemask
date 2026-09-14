import type { Metadata } from "next";
import Link from "next/link";
import { MailCheckIcon } from "lucide-react";

import { FormularioConfirmacao } from "@/app/(auth)/confirme-seu-email/formulario";
import { lerCadastroPendente } from "@/lib/auth/cadastro-pendente";
import { destinoSeguro } from "@/lib/auth/destino";

export const metadata: Metadata = { title: "Confirme seu e-mail" };

export default async function ConfirmeSeuEmail({
  searchParams,
}: PageProps<"/confirme-seu-email">) {
  const params = await searchParams;

  // O endereço vem do **cookie**, escrito pelo servidor, e não mais do
  // `?email=` da URL. A troca não foi cosmética: enquanto ele vinha da URL,
  // qualquer um montava um link do PageMask apontando para a conta dele, e a
  // vítima que digitasse o código recebido por phishing acabava logada nessa
  // conta. O ataque completo está em `lib/auth/cadastro-pendente`.
  //
  // Efeito colateral bem-vindo: o e-mail sai da barra de endereços, do
  // histórico e do `Referer`.
  const pendente = await lerCadastroPendente();

  return (
    <div className="text-center">
      <MailCheckIcon className="text-primary mx-auto mb-4 size-10" />
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Confirme seu e-mail
      </h1>

      {pendente ? (
        <>
          {/*
            "Enviamos um código" não é dito aqui, e a omissão continua
            deliberada — só que por um motivo a menos do que antes.

            O cadastro com e-mail já cadastrado parou de cair aqui: ele agora
            recebe "este e-mail já possui uma conta" na própria tela de
            cadastro. O que sobra é o login de conta não confirmada, que manda
            para cá SEM disparar e-mail nenhum — quem chega por esse caminho
            precisa do botão "Reenviar código", e afirmar um envio que não houve
            o faria ignorar justamente o botão de que precisa.
          */}
          <p className="text-muted-foreground mt-3 text-sm text-balance">
            Digite o código enviado para o seu e-mail.
          </p>
          <p className="text-muted-foreground mt-3 text-sm text-balance">
            Não chegou em alguns minutos? Confira a caixa de spam — e depois
            peça outro. O código vale 1 hora.
          </p>

          <div className="mt-6">
            <FormularioConfirmacao proximo={destinoSeguro(params.proximo)} />
          </div>
        </>
      ) : (
        // Sem cadastro pendente neste navegador não há par `(e-mail, código)`
        // para verificar — e aceitar um e-mail digitado aqui reabriria
        // exatamente o buraco que este arquivo fechou. O login resolve: quem
        // acerta a senha de uma conta não confirmada recebe o cookie de volta e
        // cai aqui de novo, agora com o formulário.
        <p className="text-muted-foreground mt-3 text-sm text-balance">
          Não encontramos um cadastro pendente neste navegador — o pedido pode
          ter expirado, ou você começou o cadastro em outro aparelho. Entre com
          seu e-mail e senha: se a conta ainda estiver por confirmar, trazemos
          você de volta para cá com um código novo.
        </p>
      )}

      <p className="text-muted-foreground mt-6 text-sm">
        <Link href="/entrar" className="underline underline-offset-4">
          Voltar para o login
        </Link>
      </p>
    </div>
  );
}
