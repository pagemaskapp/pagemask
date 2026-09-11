import type { Metadata } from "next";
import Link from "next/link";
import { CloudOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { destinoSeguro } from "@/lib/auth/destino";

export const metadata: Metadata = { title: "Serviço indisponível" };

/**
 * Mostrada quando não foi possível **conferir** a sessão — rede caída ou
 * Supabase fora do ar.
 *
 * Existe como rota, e não como fronteira de erro, porque um `error.tsx` não
 * captura o que o `layout.tsx` de um segmento lança durante o SSR: o que sai é
 * a tela genérica do Next, com 500. Verificado em dev e em produção. Redirect,
 * ao contrário, funciona de qualquer lugar.
 *
 * A diferença para `/entrar` importa: mandar a pessoa para o login diria que
 * ela foi desconectada, e ela tentaria entrar de novo contra um serviço que
 * está fora do ar. O cookie dela continua válido.
 */
export default async function Indisponivel({
  searchParams,
}: PageProps<"/indisponivel">) {
  const params = await searchParams;
  // Volta para onde a pessoa estava indo, não para a porta de entrada. Uma
  // instabilidade de dez segundos não deveria custar o lugar em que ela estava.
  // `destinoSeguro` porque o valor chega pela URL como qualquer outro.
  const destino = destinoSeguro(params.proximo);

  return (
    <div className="text-center">
      <CloudOffIcon className="text-muted-foreground mx-auto mb-4 size-10" />
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Não conseguimos confirmar seu acesso agora
      </h1>
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        Você continua conectado — o problema é do nosso lado, ao verificar a
        sessão. Não é preciso entrar de novo.
      </p>
      <p className="text-muted-foreground mt-3 text-sm text-balance">
        Tente de novo em instantes. Se persistir por mais de alguns minutos,
        escreva para o suporte.
      </p>
      <Button asChild className="mt-6 w-full">
        <Link href={destino}>Tentar de novo</Link>
      </Button>
    </div>
  );
}
