import type { Metadata } from "next";
import { LogOutIcon, ShieldOffIcon } from "lucide-react";

import { AcoesLgpd } from "@/app/app/conta/acoes-lgpd";
import { sairDeTodosOsAparelhos } from "@/app/app/conta/acoes";
import { Assinatura } from "@/app/app/conta/assinatura";
import { sair } from "@/app/(auth)/acoes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { avisoDaCobranca } from "@/lib/cobranca/avisos";
import { estadoDaCobranca } from "@/lib/cobranca/estado";
import { exigirUsuario } from "@/lib/auth/sessao";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Conta" };

/** Datas sempre em `America/Sao_Paulo` na exibição; UTC no banco. */
const data = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeZone: "America/Sao_Paulo",
});

export default async function Conta({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string; cobranca?: string }>;
}) {
  const usuario = await exigirUsuario("/app/conta");
  const supabase = await createClient();

  const [perfilConsulta, estado, parametros] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, created_at")
      .eq("id", usuario.id)
      .maybeSingle(),
    estadoDaCobranca(usuario.id),
    searchParams,
  ]);

  // Engolir este erro foi exatamente o que escondeu, por um bom tempo, que a
  // migration de privilégios não tinha sido aplicada: `42501 permission denied`
  // virava uma tela de conta plausível e vazia, sem nada em lugar nenhum. Erro
  // de consulta aqui é problema de configuração, e precisa aparecer no log.
  if (perfilConsulta.error) {
    console.error("[conta] consulta de perfil falhou", {
      codigo: perfilConsulta.error.code,
      mensagem: perfilConsulta.error.message,
    });
  }

  const perfil = perfilConsulta.data;

  // O plano vem de `profiles`; o consumo do período precisa dele E de
  // `subscriptions`. Antes só o erro de `profiles` contava, e uma falha em
  // `subscriptions` fazia a tela afirmar "0 de 700 vídeos" como fato, com a
  // barra em 0% — a leitura mais tranquilizadora possível vinda de um dado que
  // ninguém conseguiu ler.
  //
  // O terceiro caso não é erro nenhum e engana igual: a política de RLS de
  // `plans` é `using (active)`, então **desativar um plano o faz sumir do
  // embed** para quem ainda assina. A consulta volta limpa, com `plans` nulo. E
  // `profiles.plan_slug` é `not null default 'partida'` (0001): todo perfil
  // aponta para um plano, sempre. Então plano ilegível significa sempre "existe
  // plano, não consegui lê-lo" — nunca "esta pessoa não tem plano".
  //
  // `estado.indisponivel` é a parte que faltava e sem a qual esta tela voltava a
  // mentir: a falha de leitura de `subscriptions` é tratada dentro de
  // `estadoDaCobranca`, então ela não aparece em `perfilConsulta.error` — e o
  // resultado era "0 de 700 vídeos" com a barra em 0%, afirmado como fato, mais
  // um "700 de 700 ainda cabem" logo abaixo. Exatamente a regressão que o
  // comentário acima diz ter consertado.
  const usoIndisponivel =
    Boolean(perfilConsulta.error) || estado.indisponivel || !estado.plano;
  if (!estado.plano && !estado.indisponivel) {
    console.error("[conta] perfil sem plano legível", {
      plan_slug: estado.planSlug,
    });
  }

  const aviso = avisoDaCobranca(parametros.aviso, parametros.cobranca);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Conta
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Seus dados, seu plano e o que você já usou neste período.
        </p>
      </div>

      {aviso ? (
        <Alert variant={aviso.tom === "erro" ? "destructive" : "default"}>
          <AlertTitle>{aviso.titulo}</AlertTitle>
          <AlertDescription>{aviso.detalhe}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Seus dados</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">E-mail</dt>
              <dd className="mt-0.5 font-medium break-all">{usuario.email}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Nome</dt>
              <dd className="mt-0.5 font-medium">
                {perfil?.name ?? (
                  <span className="text-muted-foreground font-normal">
                    não informado
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Conta criada em</dt>
              <dd className="mt-0.5 font-medium">
                {perfil?.created_at
                  ? data.format(new Date(perfil.created_at))
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">E-mail confirmado</dt>
              <dd className="mt-0.5 font-medium">
                {usuario.email_confirmed_at ? "Sim" : "Ainda não"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Assinatura estado={estado} usoIndisponivel={usoIndisponivel} />

      <Card>
        <CardHeader>
          <CardTitle>Sessão</CardTitle>
          <CardDescription>
            Encerra o acesso aqui, ou em todos os aparelhos de uma vez.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          {/*
            Dois formulários de verdade, renderizados no servidor. O "Sair" do
            menu do topo só existe depois que o JavaScript abre o menu; estes
            funcionam sempre — e são o único caminho de saída para quem estiver
            sem JS.

            Os dois botões existem porque são respostas a perguntas diferentes.
            "Sair desta conta" é `scope: "local"`: encerra o acesso neste
            navegador, e sair do celular não pode deslogar o computador de
            surpresa. "Sair de todos" é `scope: "global"`: revoga todo refresh
            token do usuário, que é o que se quer depois de perder um aparelho
            ou desconfiar de acesso indevido — e é destrutivo o bastante para
            não poder ser o comportamento padrão do botão de sair.
          */}
          <form action={sair}>
            <Button type="submit" variant="outline">
              <LogOutIcon />
              Sair desta conta
            </Button>
          </form>
          <form action={sairDeTodosOsAparelhos}>
            <Button type="submit" variant="ghost">
              <ShieldOffIcon />
              Sair de todos os aparelhos
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Seus dados, suas regras</CardTitle>
          <CardDescription>
            Você pode levar seus dados embora ou apagar a conta a qualquer
            momento.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AcoesLgpd />
        </CardContent>
      </Card>
    </div>
  );
}
