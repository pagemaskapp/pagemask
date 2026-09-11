import Link from "next/link";
import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { AcaoMensagem } from "@/lib/auth/formulario";

/**
 * Erro e aviso dos formulários de autenticação.
 *
 * `role="alert"` para o leitor de tela anunciar a mensagem: um erro que só
 * aparece visualmente deixa quem usa leitor de tela preso num formulário sem
 * entender o porquê.
 *
 * **Sem `aria-live="polite"` junto.** Ele parecia reforço e era o contrário:
 * sobrescreve o `assertive` implícito do `role="alert"` e rebaixa o anúncio.
 * Pior aqui do que em geral, porque este componente devolve `null` quando não
 * há mensagem — ou seja, ele nasce já com o texto dentro, e região polida
 * recém-inserida costuma não ser anunciada nenhuma vez.
 */
export function CampoMensagem({
  erro,
  aviso,
  acao,
}: {
  erro?: string;
  aviso?: string;
  acao?: AcaoMensagem;
}) {
  if (!erro && !aviso) return null;

  const destrutivo = Boolean(erro);

  return (
    <Alert
      variant={destrutivo ? "destructive" : "default"}
      role="alert"
      className="mb-4"
    >
      {destrutivo ? <AlertCircleIcon /> : <CheckCircle2Icon />}
      <AlertDescription>
        <span>{erro ?? aviso}</span>
        {/*
          `block` com margem: o `AlertDescription` é um `div` comum, sem grid
          nem gap, e o JSX come a quebra de linha entre os dois elementos — em
          linha, o link sai colado no fim da frase ("…peça outro.Pedir outro
          link de confirmação").
        */}
        {acao ? (
          <Link href={acao.href} className="mt-2 block font-medium">
            {acao.rotulo}
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
