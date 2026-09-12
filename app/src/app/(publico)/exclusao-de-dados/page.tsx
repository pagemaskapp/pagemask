import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2Icon, ClockIcon, SearchIcon, XCircleIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ENCARREGADO, PRAZO_DE_EXCLUSAO_HORAS } from "@/lib/legal/encarregado";
import { normalizarCodigo } from "@/lib/meta/codigo";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DataRequestStatus } from "@/lib/supabase/database.types";

export const metadata: Metadata = {
  title: "Exclusão de dados",
  description:
    "Como pedir a exclusão dos seus dados no PageMask e como acompanhar um pedido pelo código de confirmação.",
  robots: { index: true, follow: true },
};

const dataHora = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

const ESTADOS: Record<
  DataRequestStatus,
  { rotulo: string; texto: string; Icone: typeof ClockIcon }
> = {
  received: {
    rotulo: "Recebida",
    texto: `Registramos o pedido. A exclusão acontece em até ${PRAZO_DE_EXCLUSAO_HORAS} horas a partir dele; o token do Instagram já foi apagado.`,
    Icone: ClockIcon,
  },
  processing: {
    rotulo: "Em andamento",
    texto: "Estamos apagando os dados agora. Volte aqui em algumas horas.",
    Icone: ClockIcon,
  },
  completed: {
    rotulo: "Concluída",
    texto: "Tudo que guardávamos sobre essa conta foi apagado.",
    Icone: CheckCircle2Icon,
  },
  failed: {
    rotulo: "Não concluída",
    texto: `Algo impediu a exclusão automática. Escreva para ${ENCARREGADO.email} citando o código: resolvemos no manual, dentro do mesmo prazo.`,
    Icone: XCircleIcon,
  },
};

/**
 * `/exclusao-de-dados` — as instruções que o App Review exige e a consulta
 * por código (`?code=…`), que é a URL que o callback da Meta devolve.
 *
 * A consulta usa o cliente admin porque a página é pública: quem chega aqui
 * pelo e-mail da Meta não tem sessão. O que sai da função do banco é só o
 * estado e as datas — nunca e-mail, id ou o que foi apagado.
 */
export default async function ExclusaoDeDados({
  searchParams,
}: PageProps<"/exclusao-de-dados">) {
  const params = await searchParams;
  const bruto = typeof params.code === "string" ? params.code : null;
  const codigo = normalizarCodigo(bruto);
  const consulta = bruto ? await consultar(codigo) : null;

  return (
    <article className="space-y-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Exclusão de dados
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Como pedir que o PageMask apague tudo que guarda sobre você — e como
          acompanhar o pedido.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          Consultar um pedido
        </h2>
        <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="code">Código de confirmação</Label>
            <Input
              id="code"
              name="code"
              defaultValue={bruto ?? ""}
              placeholder="ABCD-EFGH-JKMN"
              autoComplete="off"
              maxLength={20}
              className="font-mono uppercase"
            />
          </div>
          <Button type="submit" variant="outline">
            <SearchIcon />
            Consultar
          </Button>
        </form>

        {bruto && !codigo ? (
          <Alert variant="destructive" role="alert">
            <XCircleIcon />
            <AlertDescription>
              Esse código não tem o formato esperado. Ele tem 12 letras e
              números em três grupos, como <code>ABCD-EFGH-JKMN</code>.
            </AlertDescription>
          </Alert>
        ) : null}

        {consulta?.tipo === "indisponivel" ? (
          <Alert variant="destructive" role="alert">
            <XCircleIcon />
            <AlertDescription>
              Não conseguimos consultar agora. Tente de novo em instantes.
            </AlertDescription>
          </Alert>
        ) : null}

        {consulta?.tipo === "inexistente" ? (
          <Alert role="alert">
            <SearchIcon />
            <AlertDescription>
              Não encontramos nenhum pedido com o código{" "}
              <code className="font-mono">{codigo}</code>. Confira o código no
              e-mail que você recebeu, ou escreva para{" "}
              <a className="underline underline-offset-4" href={`mailto:${ENCARREGADO.email}`}>
                {ENCARREGADO.email}
              </a>
              .
            </AlertDescription>
          </Alert>
        ) : null}

        {consulta?.tipo === "ok" ? (
          <Estado codigo={codigo ?? ""} {...consulta} />
        ) : null}
      </section>

      <section className="space-y-3 text-sm leading-relaxed">
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          Como pedir a exclusão
        </h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Pelo PageMask:</strong> entre na sua conta e vá em{" "}
            <Link href="/app/conta" className="text-primary underline underline-offset-4">
              Conta › Excluir minha conta
            </Link>
            .
          </li>
          <li>
            <strong>Pelo Instagram:</strong> abra Configurações › Segurança ›{" "}
            <em>Apps e sites</em> e remova o PageMask. O Instagram nos avisa
            na hora; nós apagamos o token de acesso, abrimos um pedido de
            exclusão e o Instagram mostra a você um código de confirmação com
            um link para esta página.
          </li>
          <li>
            <strong>Por e-mail:</strong> escreva para{" "}
            <a className="text-primary underline underline-offset-4" href={`mailto:${ENCARREGADO.email}`}>
              {ENCARREGADO.email}
            </a>{" "}
            a partir do e-mail cadastrado no PageMask.
          </li>
        </ol>
      </section>

      <section className="space-y-3 text-sm leading-relaxed">
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          O que acontece depois
        </h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>O token do Instagram é apagado imediatamente e revogado na Meta.</li>
          <li>
            Em até {PRAZO_DE_EXCLUSAO_HORAS} horas, apagamos vídeos, projetos,
            templates, agendamentos e a conta, e anonimizamos os registros de
            auditoria.
          </li>
          <li>Você recebe um e-mail de confirmação quando terminar.</li>
          <li>
            A exclusão é irreversível. Registros fiscais de cobrança ficam pelo
            prazo que a lei exige, desvinculados da conta.
          </li>
        </ul>
        <p className="text-muted-foreground">
          Detalhes em{" "}
          <Link href="/privacidade#exclusao" className="text-primary underline underline-offset-4">
            Política de privacidade › Exclusão de dados
          </Link>
          .
        </p>
      </section>
    </article>
  );
}

type Consulta =
  | { tipo: "inexistente" }
  | { tipo: "indisponivel" }
  | {
      tipo: "ok";
      status: DataRequestStatus;
      requestedAt: string;
      completedAt: string | null;
    };

async function consultar(codigo: string | null): Promise<Consulta> {
  if (!codigo) return { tipo: "inexistente" };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("data_request_status", { p_code: codigo });

  if (error) {
    console.error("[exclusao] consulta falhou", {
      codigo: error.code,
      mensagem: error.message,
    });
    return { tipo: "indisponivel" };
  }

  const linha = data?.[0];
  if (!linha) return { tipo: "inexistente" };

  return {
    tipo: "ok",
    status: linha.status,
    requestedAt: linha.requested_at,
    completedAt: linha.completed_at,
  };
}

function Estado({
  codigo,
  status,
  requestedAt,
  completedAt,
}: {
  codigo: string;
  status: DataRequestStatus;
  requestedAt: string;
  completedAt: string | null;
}) {
  const estado = ESTADOS[status];
  const Icone = estado.Icone;

  return (
    <div className="bg-card rounded-xl border p-5">
      <div className="flex items-start gap-3">
        <Icone className="text-primary mt-0.5 size-5 shrink-0" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            Pedido <code className="font-mono">{codigo}</code>: {estado.rotulo}
          </p>
          <p className="text-muted-foreground">{estado.texto}</p>
          <p className="text-muted-foreground">
            Recebido em {dataHora.format(new Date(requestedAt))}
            {completedAt ? ` · concluído em ${dataHora.format(new Date(completedAt))}` : ""}.
          </p>
        </div>
      </div>
    </div>
  );
}
