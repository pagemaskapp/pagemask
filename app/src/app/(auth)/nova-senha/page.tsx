import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { FormularioNovaSenha } from "@/app/(auth)/nova-senha/formulario";
import { usuarioAtual, SessaoIndisponivelError } from "@/lib/auth/sessao";

export const metadata: Metadata = { title: "Criar uma senha nova" };

/**
 * Onde a senha de fato muda, no fim do fluxo de recuperação.
 *
 * `resetPasswordForEmail` não troca senha nenhuma: ele manda um link que, por
 * `/auth/confirmar`, vira uma sessão. É com essa sessão que `updateUser`
 * consegue gravar a senha nova — e é por isso que esta tela exige estar logado.
 *
 * Fica em `(auth)` e **fora** de `/app/*` de propósito: o proxy protege o
 * prefixo `/app`, e uma tela de recuperação dentro dele herdaria o layout
 * autenticado inteiro (barra lateral, plano, quota) para quem só quer trocar a
 * senha. Ela também não entra na lista `SO_PARA_VISITANTE` do proxy — quem
 * chega aqui está logado, e seria justamente ele o expulso.
 */
export default async function NovaSenha() {
  let usuario;
  try {
    usuario = await usuarioAtual();
  } catch (erro) {
    // Supabase fora do ar não é "link inválido". Mandar para `/recuperar-senha`
    // faria a pessoa gastar outro link contra um serviço que está caído.
    if (erro instanceof SessaoIndisponivelError) redirect("/indisponivel");
    throw erro;
  }

  if (!usuario) {
    return (
      <div className="text-center">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Link de recuperação inválido
        </h1>
        <p className="text-muted-foreground mt-3 text-sm text-balance">
          Esse link expirou, já foi usado ou foi aberto em outro navegador. Cada
          link vale uma vez só e precisa ser aberto no mesmo aparelho em que
          você o pediu.
        </p>
        <p className="mt-6 text-sm">
          <Link
            href="/recuperar-senha"
            className="text-primary font-medium underline underline-offset-4"
          >
            Pedir outro link
          </Link>
        </p>
      </div>
    );
  }

  return <FormularioNovaSenha />;
}
