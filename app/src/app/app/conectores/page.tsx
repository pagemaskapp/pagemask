import type { Metadata } from "next";
import { AtSignIcon, InfoIcon } from "lucide-react";

import { ConectarInstagram } from "@/app/app/conectores/conectar";
import { ContaConectada } from "@/app/app/conectores/conta";
import { OuvirRetorno } from "@/app/app/conectores/ouvir-retorno";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { exigirUsuario } from "@/lib/auth/sessao";
import { getServerEnv } from "@/lib/env/server";
import { conectadaHa } from "@/lib/formato";
import { limitesDoUsuario } from "@/lib/plano/limites";
import { createClient } from "@/lib/supabase/server";
import type { IgAccountPublic } from "@/lib/supabase/database.types";

export const metadata: Metadata = { title: "Conectores" };

/**
 * `/app/conectores` — as contas do Instagram em que o PageMask publica.
 *
 * A CONSULTA LISTA AS COLUNAS UMA A UMA
 * =====================================
 *
 * E não pode ser `select("*")`. O papel `authenticated` tem privilégio de
 * SELECT só em algumas colunas de `ig_accounts` (GRANT por coluna, migration
 * 0001) — e privilégio por coluna não FILTRA o `*`, ele o RECUSA: o Postgres
 * responde "permission denied for table ig_accounts" e a tela vem vazia, como
 * se o usuário não tivesse conta nenhuma. Esse detalhe está escrito no
 * cabeçalho de `database.types.ts` justamente para a Fase 4 não ser pega por
 * ele.
 *
 * A lista de colunas aqui é, por construção, a mesma de `IgAccountPublic`.
 *
 * E ela é uma string LITERAL, sem concatenação: o `postgrest-js` infere o tipo
 * do resultado a partir do texto do `select`, e um `"a" + "b"` chega nele como
 * `string` genérico. O resultado vira `GenericStringError[]` e o erro aparece
 * longe daqui, no `.map` da lista.
 */
const COLUNAS =
  "id, user_id, ig_user_id, username, profile_picture_url, scopes, token_expires_at, last_refreshed_at, status, connected_at";

export default async function Conectores() {
  const usuario = await exigirUsuario("/app/conectores");

  const supabase = await createClient();
  const [limites, consulta] = await Promise.all([
    limitesDoUsuario(usuario.id),
    supabase
      .from("ig_accounts")
      .select(COLUNAS)
      .eq("user_id", usuario.id)
      .order("connected_at", { ascending: false }),
  ]);

  if (consulta.error) {
    // Mesma lição das outras telas: erro de consulta engolido aqui vira uma
    // lista vazia perfeitamente plausível — e foi assim que a falta de uma
    // migration de privilégios passou dias sem ser notada.
    console.error("[conectores] consulta falhou", {
      codigo: consulta.error.code,
      mensagem: consulta.error.message,
    });
  }

  const contas = (consulta.data ?? []) as IgAccountPublic[];

  // `revoked` é histórico: não ocupa vaga, exatamente como em
  // `connect_ig_account`. As duas contagens precisam concordar, senão a tela
  // diz "cabe mais uma" e o banco recusa.
  const ocupadas = contas.filter((c) => c.status !== "revoked").length;
  const teto = limites.plano.ig_accounts;
  const cabeMaisUma = ocupadas < teto;

  const emRevisao = (getServerEnv().IG_APP_MODE ?? "development") === "development";

  // Um "agora" só para a página inteira: duas contas conectadas no mesmo
  // instante não podem sair com textos diferentes porque o relógio virou no
  // meio do laço.
  const agora = new Date();

  return (
    <div className="mx-auto max-w-3xl">
      {/* Sem aparência: ouve o fim do fluxo do OAuth. Montado UMA vez aqui, e
          não dentro de cada botão de conectar — ver `ouvir-retorno.tsx`. */}
      <OuvirRetorno />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Conectores
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {ocupadas} de {teto} contas do Instagram do plano {limites.plano.name}
          </p>
        </div>

        <ConectarInstagram
          cabeMaisUma={cabeMaisUma}
          motivoDeNaoCaber={
            `Seu plano ${limites.plano.name} permite ${teto} contas. ` +
            "Desconecte uma ou mude de plano em Conta."
          }
        />
      </div>

      {emRevisao ? (
        <Alert className="mb-4">
          <InfoIcon />
          <AlertDescription>
            Enquanto o app está em revisão, só contas convidadas como tester
            conseguem conectar.
          </AlertDescription>
        </Alert>
      ) : null}

      {consulta.error ? (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertDescription>
            Não conseguimos carregar suas contas agora. Recarregue a página em
            alguns instantes.
          </AlertDescription>
        </Alert>
      ) : null}

      {!consulta.error && contas.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AtSignIcon className="text-muted-foreground size-8" />
            <div>
              <p className="font-medium">Nenhuma conta conectada ainda</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Conecte a conta do Instagram em que o PageMask vai publicar. Ela
                precisa ser Profissional (Empresa ou Criador).
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        {contas.map((conta) => (
          <ContaConectada
            key={conta.id}
            conta={conta}
            desde={conectadaHa(conta.connected_at, agora)}
          />
        ))}
      </div>
    </div>
  );
}
