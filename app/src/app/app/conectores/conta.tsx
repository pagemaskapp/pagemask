"use client";

import { useActionState } from "react";
import { AtSignIcon } from "lucide-react";

import { desconectarConta } from "@/app/app/conectores/acoes";
import { ConectarInstagram } from "@/app/app/conectores/conectar";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Card, CardContent } from "@/components/ui/card";
import type { EstadoFormulario } from "@/lib/auth/formulario";
import type { IgAccountPublic } from "@/lib/supabase/database.types";

const INICIAL: EstadoFormulario = {};

/**
 * Uma conta na lista.
 *
 * O TIPO DESTA PROP É A GARANTIA DE §3
 * ====================================
 *
 * `IgAccountPublic` é `ig_accounts.Row`, e esse `Row` **não tem**
 * `token_cipher`, `token_iv` nem `token_tag` — é assim desde a Fase 0, de
 * propósito (ver o cabeçalho de `database.types.ts`). Como este é um componente
 * de cliente, tudo que chega por esta prop é serializado para o navegador.
 * Fosse o tipo a linha inteira, o token viajaria junto sem que nada aqui
 * denunciasse.
 *
 * O banco cobra a mesma regra por baixo: o papel `authenticated` não tem
 * privilégio de SELECT nas colunas de token (GRANT por coluna, migration 0001).
 * Tipo e privilégio dizendo a mesma coisa é o que faz isso ser garantia, e não
 * convenção.
 */
export function ContaConectada({
  conta,
  desde,
}: {
  conta: IgAccountPublic;
  /**
   * "conectada há 3 dias", já pronto.
   *
   * Calculado no SERVIDOR e passado como texto, em vez de chamado aqui. Este é
   * um componente de cliente, mas ele também é renderizado no servidor antes de
   * hidratar — e `new Date()` responde coisas diferentes nos dois lugares. Uma
   * conta feita perto da virada do dia, ou um relógio adiantado na máquina de
   * quem acessa, produziria "há 2 dias" no HTML e "há 3 dias" na hidratação:
   * erro de hidratação no console e um trecho de texto piscando.
   */
  desde: string;
}) {
  const [estado, acao] = useActionState(desconectarConta, INICIAL);

  const situacao = SITUACOES[conta.status];

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 py-4">
        <Foto url={conta.profile_picture_url} username={conta.username} />

        <div className="min-w-40 flex-1">
          <p className="font-medium">@{conta.username}</p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {desde}
          </p>
        </div>

        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${situacao.classe}`}
        >
          {situacao.rotulo}
        </span>

        <div className="flex items-center gap-2">
          {/*
            "Reconectar sempre visível" é o item 1 do prompt, e a razão é
            prática: uma conta pode estar `active` no nosso banco e revogada do
            lado do Instagram (a pessoa removeu o app lá). Não temos como saber
            disso até uma publicação falhar — então o botão que resolve precisa
            estar ao alcance mesmo quando, para nós, está tudo bem.
          */}
          <ConectarInstagram reconectar cabeMaisUma motivoDeNaoCaber="" />

          {conta.status === "revoked" ? null : (
            <form action={acao}>
              <input type="hidden" name="conta" value={conta.id} />
              <BotaoEnvio variant="ghost" carregando="Desconectando…">
                Desconectar
              </BotaoEnvio>
            </form>
          )}
        </div>

        {estado.erro || estado.aviso ? (
          <div className="w-full">
            <CampoMensagem erro={estado.erro} aviso={estado.aviso} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const SITUACOES: Record<
  IgAccountPublic["status"],
  { rotulo: string; classe: string }
> = {
  active: {
    rotulo: "Ativa",
    classe: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
  needs_reconnect: {
    rotulo: "Precisa reconectar",
    classe: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  revoked: {
    rotulo: "Revogada",
    classe: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
};

/**
 * A foto do perfil, servida pelo CDN do Instagram.
 *
 * `<img>` e não `next/image`: a URL vem da Meta, expira em horas e aponta para
 * um host de terceiro. Otimizá-la significaria baixar a foto no nosso servidor
 * a cada render e servi-la de novo — custo e superfície para nada, já que ela
 * muda sozinha e o tamanho é 40 pixels.
 *
 * `referrerPolicy="no-referrer"` para não contar ao CDN da Meta em que página
 * do PageMask o cliente está.
 */
function Foto({ url, username }: { url: string | null; username: string }) {
  if (!url) {
    return (
      <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
        <AtSignIcon className="size-5" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={`Foto do perfil de @${username}`}
      width={40}
      height={40}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="bg-muted size-10 shrink-0 rounded-full object-cover"
    />
  );
}
