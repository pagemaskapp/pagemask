/** Para onde mandar o usuario quando nao ha destino confiavel. */
export const DESTINO_PADRAO = "/app/projetos";

/**
 * Caracteres de controle C0 mais DEL. Escritos como escape unicode de
 * proposito: um caractere de controle literal no fonte e invisivel em revisao
 * de codigo e em diff — que e justamente o que o torna util para atacar.
 */
const CONTROLE = /[\u0000-\u001F\u007F]/;

/**
 * Origem de mentira, so para resolver caminho relativo. Nada sai para a rede
 * com ela: o que interessa e o `pathname` depois de o parser resolver os
 * ponto-segmentos.
 */
const ORIGEM_DE_RESOLUCAO = "http://destino.invalido";

/**
 * Telas de entrada e de recado. Nenhuma delas serve como DESTINO.
 *
 * Mandar alguem que acabou de entrar para `/entrar` e, no melhor caso, uma
 * viagem a toa; no pior, um ciclo: o proxy ve sessao valida numa rota de
 * visitante e redireciona para o `?proximo=`, que aponta para a rota de
 * visitante de novo. Um `?proximo=` aninhado de proposito descasca um nivel por
 * salto e estoura o limite de redirecionamentos do navegador.
 */
const ROTAS_DE_ENTRADA = new Set([
  "/entrar",
  "/cadastrar",
  "/confirme-seu-email",
  "/link-invalido",
  "/indisponivel",
]);

/**
 * Valida o `?proximo=` — o caminho para onde o usuario volta depois de entrar.
 *
 * E entrada nao confiavel: chega pela URL e por campo de formulario, e num caso
 * chega **dentro de um link enviado por e-mail**, que e onde um redirecionamento
 * aberto vale mais para quem ataca — o phishing herda a credibilidade do
 * dominio do PageMask.
 *
 * Checar so `startsWith("/")` e barrar `//` nao basta. O parser de URL do
 * navegador **remove** tab, CR e LF antes de resolver o endereco, entao
 * `"/\t/evil.com"` — que passa nas duas checagens — vira `//evil.com`:
 *
 *     new URL("/\t/evil.com", "https://pagemask.com.br").href
 *     // -> "https://evil.com/"
 *
 * Por isso a regra e lista fechada: comeca com uma barra, nenhum caractere de
 * controle, nenhuma segunda barra em seguida, nenhuma contrabarra.
 */
export function destinoSeguro(
  valor: unknown,
  padrao: string = DESTINO_PADRAO,
): string {
  if (typeof valor !== "string" || valor === "") return padrao;
  if (CONTROLE.test(valor)) return padrao;
  if (!valor.startsWith("/")) return padrao;
  if (valor.startsWith("//")) return padrao;

  // A contrabarra vira barra em varios parsers, entao `/\evil.com` tambem
  // sai do site em navegador que normaliza antes de resolver.
  if (valor.includes("\\")) return padrao;

  // Daqui para baixo vale o caminho RESOLVIDO, e e ele que volta.
  //
  // O parser resolve ponto-segmento — inclusive na forma percent-encoded, que
  // teste de texto nao pega. Medido:
  //
  //     new URL("/app/%2e%2e/entrar", base).pathname  // -> "/entrar"
  //     new URL("/.//entrar",         base).pathname  // -> "//entrar"
  //
  // Conferir o resolvido e devolver o escrito seria o pior dos dois mundos: a
  // segunda linha passa pela lista de rotas de entrada (nao e "/entrar") e o
  // destino final e "//entrar" — que como valor de `Location` deixa de ser
  // caminho e vira endereco de OUTRO site. Por isso o resolvido passa pelas
  // mesmas checagens do escrito antes de ser aceito.
  let resolvida: URL;
  try {
    resolvida = new URL(valor, ORIGEM_DE_RESOLUCAO);
  } catch {
    return padrao;
  }

  const caminho = resolvida.pathname;
  if (!caminho.startsWith("/")) return padrao;
  if (caminho.startsWith("//")) return padrao;

  // `/entrar/` e `/entrar` sao a mesma tela.
  const semBarraFinal = caminho.replace(/\/+$/, "") || "/";
  if (ROTAS_DE_ENTRADA.has(semBarraFinal)) return padrao;

  return `${caminho}${resolvida.search}`;
}

/**
 * Caminho + query do pedido, **sem os parametros internos do Next**.
 *
 * O `?proximo=` e o cabecalho `x-caminho` sao montados a partir da URL pedida.
 * Sem esta limpeza, um pedido de RSC — prefetch ou navegacao pelo cliente, que
 * chegam com `_rsc=<hash>` — carregava esse parametro para dentro do destino:
 * o usuario entrava e ia parar em `/app/conta?_rsc=1f2a3b`, com o hash na barra
 * de enderecos, num link que ele pode salvar ou mandar para alguem.
 *
 * A regra e o sublinhado inicial. Todo parametro interno do Next comeca com
 * `_` (`_rsc`, `_next_hmr_refresh`) e nenhum parametro do PageMask comeca —
 * quando algum precisar, ele nasce sem sublinhado.
 *
 * O que sai daqui ainda passa por `destinoSeguro` antes de virar redirect: esta
 * funcao limpa, ela e quem autoriza.
 */
export function caminhoDoPedido(url: {
  pathname: string;
  searchParams: URLSearchParams;
}): string {
  const query = new URLSearchParams();
  for (const [nome, valor] of url.searchParams) {
    if (!nome.startsWith("_")) query.append(nome, valor);
  }

  const busca = query.toString();
  return busca ? `${url.pathname}?${busca}` : url.pathname;
}
