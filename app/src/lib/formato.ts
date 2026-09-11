/**
 * Formatação para a tela, em pt-BR.
 *
 * Sem `"server-only"` de propósito: o mesmo número precisa sair igual no HTML
 * do servidor e na lista que o navegador monta durante o upload. Duas
 * implementações dariam "1,5 GB" de um lado e "1.5 GB" do outro na mesma tela.
 */

const UNIDADES = ["B", "KB", "MB", "GB"] as const;

/** Tamanho de arquivo em base 1024, que é a conta que o sistema operacional mostra. */
export function bytesEmTexto(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;

  let valor = bytes;
  let unidade = 0;
  while (valor >= 1024 && unidade < UNIDADES.length - 1) {
    valor /= 1024;
    unidade += 1;
  }

  // Uma casa decimal até 100, nenhuma acima: "1,4 MB" ajuda, "347,2 MB" não.
  const casas = valor >= 100 ? 0 : 1;
  return `${valor.toFixed(casas).replace(".", ",")} ${UNIDADES[unidade]}`;
}

/** `m:ss`, ou `h:mm:ss` quando passa de uma hora. */
export function duracaoEmTexto(segundos: number | null | undefined): string {
  if (segundos === null || segundos === undefined || !Number.isFinite(segundos)) {
    return "—";
  }

  const total = Math.round(segundos);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);

  const dois = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${m}:${dois(s)}`;
}

export const dataCurta = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeZone: "America/Sao_Paulo",
});

export const numero = new Intl.NumberFormat("pt-BR");
