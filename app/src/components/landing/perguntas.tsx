import { IconeSeta } from "@/components/landing/icones";
import { PERGUNTAS } from "@/lib/landing/conteudo";
import { ENCARREGADO } from "@/lib/legal/encarregado";

/**
 * As perguntas frequentes.
 *
 * `<details>` / `<summary>` nativos, sem componente de acordeão e sem
 * JavaScript nenhum. Três ganhos, e nenhum deles é preguiça:
 *
 *   · acessibilidade que já vem pronta — o elemento é um botão de verdade,
 *     anuncia expandido/recolhido e funciona por teclado sem nada escrito
 *     aqui. Acordeão feito à mão erra isso quase sempre;
 *   · o conteúdo está no HTML mesmo fechado, então o Ctrl+F do navegador e o
 *     indexador de busca encontram a resposta;
 *   · zero JavaScript enviado numa página cujo trabalho é carregar rápido.
 *
 * A seta gira com `group-open:`, que é CSS puro sobre o estado do elemento.
 */
export function Perguntas() {
  return (
    <section
      id="perguntas"
      aria-labelledby="perguntas-titulo"
      className="border-b border-border bg-card"
    >
      <div className="mx-auto w-full max-w-3xl px-5 py-20 sm:px-8 sm:py-24">
        <h2
          id="perguntas-titulo"
          className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        >
          Perguntas frequentes
        </h2>

        <div className="divide-border mt-10 divide-y border-t border-b">
          {PERGUNTAS.map((item) => (
            <details key={item.pergunta} className="group">
              <summary className="focus-visible:ring-ring flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium focus-visible:ring-2 focus-visible:outline-none">
                <span>{item.pergunta}</span>
                <IconeSeta className="text-muted-foreground size-5 shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <p className="text-muted-foreground pb-5 leading-relaxed">
                {item.resposta}
              </p>
            </details>
          ))}

          {/*
            A última pergunta é montada aqui, e não em `conteudo.ts`, porque a
            resposta é um dado: o Encarregado sai de `lib/legal/encarregado`,
            que é o arquivo único do produto para isso. Copiá-lo para dentro do
            texto criaria a segunda cópia que muda por ato administrativo.
          */}
          <details className="group">
            <summary className="focus-visible:ring-ring flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium focus-visible:ring-2 focus-visible:outline-none">
              <span>Quem responde pelos meus dados pessoais?</span>
              <IconeSeta className="text-muted-foreground size-5 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <p className="text-muted-foreground pb-5 leading-relaxed">
              O Encarregado de dados (DPO) do PageMask é {ENCARREGADO.nome}, em{" "}
              <a
                href={`mailto:${ENCARREGADO.email}`}
                className="text-primary underline underline-offset-4"
              >
                {ENCARREGADO.email}
              </a>
              . Pedidos de acesso, correção e exclusão passam por ele — e a
              exclusão também está disponível sem contato nenhum, direto na sua
              conta.
            </p>
          </details>
        </div>
      </div>
    </section>
  );
}
