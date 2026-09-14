import type { Metadata } from "next";

import { FormularioEntrar } from "@/app/(auth)/entrar/formulario";
import { destinoSeguro } from "@/lib/auth/destino";
import type { EstadoFormulario } from "@/lib/auth/formulario";

export const metadata: Metadata = { title: "Entrar" };

/**
 * O que o `?saida=` pode dizer — lista fechada, escrita aqui.
 *
 * Nada do que vem na URL é impresso na tela: o parâmetro só escolhe uma frase
 * desta tabela. É a mesma regra do `?email=` em `/confirme-seu-email` — sem
 * ela, um link preparado por terceiro estampa o texto que quiser dentro de uma
 * tela do PageMask, com a credibilidade do domínio junto.
 */
const MENSAGENS_DE_SAIDA: Record<string, EstadoFormulario> = {
  ok: { aviso: "Você saiu da sua conta." },
  global: {
    aviso:
      "Encerramos o acesso em todos os aparelhos. Entre de novo em cada um " +
      "que você ainda usa.",
  },
  parcial: {
    erro:
      "Encerramos o acesso neste navegador, mas não conseguimos confirmar a " +
      "saída com o servidor. Se você estava num computador compartilhado, " +
      "entre de novo e troque sua senha.",
  },
};

export default async function Entrar({ searchParams }: PageProps<"/entrar">) {
  const params = await searchParams;
  // `Object.hasOwn` e não `MENSAGENS_DE_SAIDA[chave]`: indexar um objeto comum
  // alcança o que ele herda de `Object.prototype`, então `?saida=constructor`
  // (ou `toString`, `valueOf`, `hasOwnProperty`) devolvia uma **função** — que
  // o React recusa a serializar para o componente de cliente, derrubando a tela
  // de login inteira com 500. Medido: os quatro davam HTTP 500.
  const saida =
    typeof params.saida === "string" &&
    Object.hasOwn(MENSAGENS_DE_SAIDA, params.saida)
      ? MENSAGENS_DE_SAIDA[params.saida]
      : undefined;

  return (
    <FormularioEntrar proximo={destinoSeguro(params.proximo)} mensagem={saida} />
  );
}
