import "server-only";

import { NextResponse } from "next/server";

import { publicEnv } from "@/lib/env/public";

/**
 * O que as duas rotas de cobrança que redirecionam para a Stripe (checkout e
 * portal) têm em comum.
 *
 * As duas são `<form method="post">` de verdade, e não `fetch`. A razão é a
 * mesma que fez o "Sair" da página de conta ser um formulário: sem JavaScript
 * o botão continua funcionando. O preço disso é que elas precisam se defender
 * como formulário se defende.
 *
 * **CSRF, duas trancas.** O cookie de sessão é `SameSite=Lax`, o que já barra
 * POST vindo de outro site — essa é a primeira e a mais forte. A segunda é a
 * conferência de `Origin` aqui: ela cobre o caso de um navegador antigo sem
 * `SameSite` e deixa a intenção escrita no código, em vez de depender de um
 * atributo definido em outro arquivo. Um POST forjado nestas rotas não roubaria
 * dinheiro de ninguém (o pior que faz é abrir um checkout que a vítima não
 * pediu), mas rota que muda estado e não confere origem é o tipo de coisa que
 * vira precedente.
 */
export function origemConfere(requisicao: Request): boolean {
  const origem = requisicao.headers.get("origin");
  // Alguns clientes não mandam `Origin` em navegação de formulário same-origin
  // antiga. Sem o cabeçalho, o `SameSite=Lax` do cookie é quem responde — e ele
  // já respondeu, senão não haveria sessão para chegar até aqui.
  if (!origem) return true;

  try {
    return new URL(origem).origin === new URL(publicEnv.NEXT_PUBLIC_APP_URL).origin;
  } catch {
    return false;
  }
}

/**
 * Volta para uma tela nossa com um recado.
 *
 * `303` e não `302`: o método precisa virar GET. Com 302 alguns clientes
 * repetem o POST no destino, e o destino é uma página.
 */
export function voltarCom(caminho: string, aviso?: string): NextResponse {
  const url = new URL(caminho, publicEnv.NEXT_PUBLIC_APP_URL);
  if (aviso) url.searchParams.set("aviso", aviso);
  return NextResponse.redirect(url, {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Redireciona para a Stripe. Mesmo 303, mesma razão. */
export function irParaStripe(url: string): NextResponse {
  return NextResponse.redirect(url, {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * O corpo de um POST de formulário **ou** de JSON.
 *
 * Os dois porque a tela usa formulário e os testes usam JSON — e escrever a
 * rota só para um dos dois obrigaria a testar por um caminho que ninguém usa.
 */
export async function campos(
  requisicao: Request,
): Promise<Record<string, string>> {
  const tipo = (requisicao.headers.get("content-type") ?? "").toLowerCase();

  if (tipo.startsWith("application/json")) {
    try {
      const bruto: unknown = await requisicao.json();
      if (typeof bruto !== "object" || bruto === null) return {};
      return Object.fromEntries(
        Object.entries(bruto as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      );
    } catch {
      return {};
    }
  }

  try {
    const form = await requisicao.formData();
    return Object.fromEntries(
      Array.from(form.entries())
        .filter((par): par is [string, string] => typeof par[1] === "string")
        .map(([k, v]) => [k, v]),
    );
  } catch {
    return {};
  }
}
