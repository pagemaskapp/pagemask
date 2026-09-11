import type { Metadata } from "next";
import { LogOutIcon } from "lucide-react";

import { AcoesLgpd } from "@/app/app/conta/acoes-lgpd";
import { sair } from "@/app/(auth)/acoes";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { exigirUsuario } from "@/lib/auth/sessao";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Conta" };

const dinheiro = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const numero = new Intl.NumberFormat("pt-BR");

/** Datas sempre em `America/Sao_Paulo` na exibição; UTC no banco. */
const data = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeZone: "America/Sao_Paulo",
});

export default async function Conta() {
  const usuario = await exigirUsuario("/app/conta");
  const supabase = await createClient();

  // Uma consulta só: o plano vem embutido no perfil pela relação. As duas
  // tabelas passam por RLS com `auth.uid()`, então o `select` já é o do dono.
  const { data: perfil, error: erroPerfil } = await supabase
    .from("profiles")
    .select("name, plan_slug, created_at, plans(name, price_cents, videos_month, ig_accounts, projects)")
    .eq("id", usuario.id)
    .single();

  const { data: assinatura, error: erroAssinatura } = await supabase
    .from("subscriptions")
    .select("videos_used, status, current_period_end")
    .eq("user_id", usuario.id)
    .maybeSingle();

  // Engolir estes erros foi exatamente o que escondeu, por um bom tempo, que a
  // migration de privilégios não tinha sido aplicada: `42501 permission denied`
  // virava uma tela de conta plausível e vazia, sem nada em lugar nenhum. Erro
  // de consulta aqui é problema de configuração, e precisa aparecer no log.
  for (const [origem, erro] of [
    ["profiles", erroPerfil],
    ["subscriptions", erroAssinatura],
  ] as const) {
    if (erro) {
      console.error("[conta] consulta falhou", {
        origem,
        codigo: erro.code,
        mensagem: erro.message,
      });
    }
  }

  const plano = perfil?.plans as
    | {
        name: string;
        price_cents: number;
        videos_month: number;
        ig_accounts: number;
        projects: number;
      }
    | null
    | undefined;

  // Duas falhas diferentes, dois efeitos diferentes. O plano vem de `profiles`;
  // o consumo do mês precisa das DUAS consultas — `videos_used` de
  // `subscriptions` e o limite do plano. Antes só o erro de `profiles` contava,
  // e uma falha em `subscriptions` fazia a tela afirmar "0 de 700 vídeos" como
  // fato, com a barra em 0% — a leitura mais tranquilizadora possível vinda de
  // um dado que ninguém conseguiu ler.
  //
  // O terceiro caso não é erro nenhum e engana igual: a política de RLS de
  // `plans` é `using (active)`, então **desativar um plano o faz sumir do
  // embed** para quem ainda assina. A consulta volta limpa, com `plans` nulo.
  //
  // E `profiles.plan_slug` é `not null default 'partida'` (0001_init.sql): todo
  // perfil aponta para um plano, sempre. Então perfil lido com `plans` vazio
  // significa sempre "existe plano, não consegui lê-lo" — nunca "esta pessoa
  // não tem plano". Não existe tela de "sem plano" para escrever aqui.
  const planoSumiu = !erroPerfil && Boolean(perfil) && !perfil?.plans;
  const usoIndisponivel =
    Boolean(erroPerfil) || Boolean(erroAssinatura) || planoSumiu;

  if (planoSumiu) {
    console.error("[conta] perfil sem plano legível", {
      plan_slug: perfil?.plan_slug,
    });
  }

  const usados = assinatura?.videos_used ?? 0;
  const limite = plano?.videos_month ?? 0;
  // A barra só aparece quando há um limite de verdade: com `limite = 0` ela
  // sairia com `aria-valuemax={0}`, um intervalo vazio que leitor de tela anuncia
  // como porcentagem sem sentido.
  const temBarra = !usoIndisponivel && limite > 0;
  const percentual = temBarra ? Math.min(100, (usados / limite) * 100) : 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Conta
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Seus dados, seu plano e o que você já usou este mês.
        </p>
      </div>

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

      <Card>
        <CardHeader>
          <CardTitle>Plano {plano?.name ?? perfil?.plan_slug ?? "—"}</CardTitle>
          <CardDescription>
            {/*
              Sem terceiro ramo de "nenhum plano": `plano` nulo só acontece
              quando a consulta falhou (`erroPerfil`) ou quando o plano existe e
              não foi possível lê-lo (`planoSumiu`). Uma frase de "você não tem
              plano" aqui seria código morto que um dia alguém acredita.
            */}
            {plano
              ? `${dinheiro.format(plano.price_cents / 100)} por mês · ${numero.format(plano.videos_month)} vídeos, ${plano.ig_accounts} contas do Instagram, ${plano.projects} projetos`
              : "Não conseguimos carregar os detalhes do seu plano agora. Recarregue em instantes — se continuar assim, escreva para o suporte."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {usoIndisponivel ? (
            <p className="text-muted-foreground text-sm">
              Não conseguimos carregar seu uso do mês agora. Recarregue em
              instantes — preferimos não mostrar número nenhum a mostrar um
              número que pode estar errado.
            </p>
          ) : (
            <>
              <div>
                <div className="mb-2 flex items-baseline justify-between text-sm">
                  <span className="text-muted-foreground">Uso do mês</span>
                  <span className="font-medium">
                    {limite > 0
                      ? `${numero.format(usados)} de ${numero.format(limite)} vídeos`
                      : `${numero.format(usados)} vídeos`}
                  </span>
                </div>
                {temBarra ? (
                  <div
                    role="progressbar"
                    aria-valuenow={usados}
                    aria-valuemin={0}
                    aria-valuemax={limite}
                    aria-label="Vídeos usados no mês"
                    className="bg-muted h-2 w-full overflow-hidden rounded-full"
                  >
                    <div
                      className="bg-primary h-full rounded-full transition-[width]"
                      style={{ width: `${percentual}%` }}
                    />
                  </div>
                ) : null}
              </div>

              <p className="text-muted-foreground text-sm">
                {assinatura?.current_period_end
                  ? `O contador zera em ${data.format(new Date(assinatura.current_period_end))}.`
                  : "A cobrança e o contador do período entram na Fase 8. Até lá o uso aparece zerado."}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessão</CardTitle>
          <CardDescription>
            Encerra o acesso neste navegador.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            Um formulário de verdade, renderizado no servidor. O "Sair" do menu
            do topo só existe depois que o JavaScript abre o menu; este funciona
            sempre — e é o único caminho de saída para quem estiver sem JS.
          */}
          <form action={sair}>
            <Button type="submit" variant="outline">
              <LogOutIcon />
              Sair desta conta
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
