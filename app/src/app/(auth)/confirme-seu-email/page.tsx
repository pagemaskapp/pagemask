import type { Metadata } from "next";
import { z } from "zod";
import Link from "next/link";
import { MailCheckIcon } from "lucide-react";

import { FormularioReenviar } from "@/app/(auth)/confirme-seu-email/formulario";
import { destinoSeguro } from "@/lib/auth/destino";

export const metadata: Metadata = { title: "Confirme seu e-mail" };

export default async function ConfirmeSeuEmail({
  searchParams,
}: PageProps<"/confirme-seu-email">) {
  const params = await searchParams;

  // O `?email=` vem da URL, e esta pagina e publica. Sem validar, um link
  // preparado por terceiro estampa o texto que quiser, em negrito, dentro de
  // uma tela do PageMask — nao e XSS (o React escapa), mas e a mesma
  // transferencia de credibilidade que `destinoSeguro` recusa no `?proximo=`.
  // So passa o que de fato parece um e-mail, e com tamanho de e-mail.
  const bruto = typeof params.email === "string" ? params.email.trim() : "";
  const email =
    bruto.length <= 254 && z.email().safeParse(bruto).success ? bruto : "";

  return (
    <div className="text-center">
      <MailCheckIcon className="text-primary mx-auto mb-4 size-10" />
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Confirme seu e-mail
      </h1>
      {/*
        "O link vai para", e não "enviamos o link": esta tela é o destino de
        três situações, e o envio só aconteceu numa delas. Cadastro de e-mail
        que já tem conta não dispara e-mail nenhum, e cadastro barrado pelo
        limite de envio também não — as três respondem igual de propósito, para
        a tela não virar uma sonda de "esse e-mail tem conta aqui?". Afirmar um
        envio que pode não ter ocorrido seria mentir em dois dos três casos.
      */}
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        {email ? (
          <>
            O link de confirmação vai para{" "}
            <strong className="text-foreground">{email}</strong>. Abra o e-mail
            e clique nele para ativar sua conta.
          </>
        ) : (
          <>
            O link de confirmação vai para o seu e-mail. Abra-o e clique no link
            para ativar sua conta.
          </>
        )}
      </p>
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        Não chegou em alguns minutos? Confira a caixa de spam — e depois peça
        outro.
      </p>

      <div className="mt-6">
        <FormularioReenviar email={email} proximo={destinoSeguro(params.proximo)} />
      </div>

      <p className="text-muted-foreground mt-6 text-sm">
        <Link href="/entrar" className="underline underline-offset-4">
          Voltar para o login
        </Link>
      </p>
    </div>
  );
}
