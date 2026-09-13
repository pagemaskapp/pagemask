/**
 * Os três ícones da landing, em SVG inline.
 *
 * POR QUE NÃO `lucide-react` AQUI, SE O RESTO DO PRODUTO USA
 * ==========================================================
 *
 * Porque no lucide 1.x **todo ícone é `"use client"`** (está no topo de
 * `dist/esm/Icon.mjs`). Um `<CheckIcon />` numa página que não tem mais nada
 * de cliente cria uma fronteira de cliente do nada: o Next passa a mandar o
 * runtime do lucide e o contexto dele para o navegador, e a árvore inteira
 * ganha referências de cliente na carga do RSC. **Medido**: ~16 KB
 * transferidos, num documento que fora isso não tem componente de cliente
 * nenhum.
 *
 * Dentro de `/app/*` esse custo já está pago — são telas com formulário,
 * diálogo e menu, que carregam lucide de qualquer jeito. A landing não, e ela
 * é a página do produto que mais precisa carregar rápido.
 *
 * Os desenhos são os mesmos do lucide (mesma licença ISC, mesmo `viewBox` e
 * mesmos atributos de traço), para os ícones não destoarem do app.
 */

type Props = { className?: string };

function base(className?: string) {
  return {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    // Decoração: quem lê por leitor de tela recebe o texto ao lado, e o
    // resultado de cada checagem tem um `sr-only` próprio.
    "aria-hidden": true,
    className,
  };
}

export function IconeCerto({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconeErrado({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function IconeSeta({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
