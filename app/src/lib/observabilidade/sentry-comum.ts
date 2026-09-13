import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

/**
 * O que o PageMask manda — e o que ele NUNCA manda — para o Sentry (PLANO §7).
 *
 * "Sentry no app e no worker, com `user_id` como contexto (nunca token ou
 * e-mail em breadcrumb)." Este arquivo é a implementação dessa frase, e ele
 * roda nos três ambientes (navegador, Node e edge), por isso não importa nada
 * de Node.
 *
 * POR QUE NÃO BASTA `sendDefaultPii: false`
 * =========================================
 *
 * Essa opção desliga o que o SDK coleta **por iniciativa própria**: IP, cookies,
 * corpo de requisição. Ela não tem opinião nenhuma sobre o que está DENTRO da
 * mensagem de um erro — e é exatamente ali que o segredo aparece na prática:
 *
 *   · uma URL pré-assinada do R2 num `TypeError: Failed to fetch` carrega
 *     `X-Amz-Signature` e `X-Amz-Credential` inteiros;
 *   · um erro da Meta ecoando a query traz `access_token=IGQ…`;
 *   · `PostgrestError` cita o e-mail quando o conflito é no `unique` dele;
 *   · um breadcrumb de `fetch` guarda a URL completa, query e tudo.
 *
 * Nenhum desses passa por `sendDefaultPii`. Por isso aqui a varredura é sobre
 * o evento inteiro, string por string, com uma lista de padrões.
 *
 * A REGRA DE OURO: falso positivo é barato, falso negativo não tem volta.
 * Redigir demais deixa um erro menos legível; redigir de menos publica uma
 * credencial num serviço de terceiro, com retenção de meses e acesso de toda a
 * equipe. Na dúvida, redige.
 */

/**
 * Profundidade e tamanho máximos da varredura — anteparo contra ciclo e evento
 * gigante.
 *
 * 12 e não 8: um span de requisição vive em
 * `evento.spans[n].data["url.full"]`, e a árvore de `contexts` do SDK chega a
 * oito níveis sozinha. Um corte apertado aqui não é "menos detalhe no painel" —
 * é texto **não varrido** saindo daqui, que é o defeito que esta varredura
 * existe para não ter.
 */
const PROFUNDIDADE_MAXIMA = 12;
const CAMPOS_POR_OBJETO = 80;

/**
 * Os padrões. Ordem importa: o mais específico primeiro, porque o texto
 * redigido por um padrão anterior não é mais candidato para os seguintes.
 */
const PADROES: { regex: RegExp; troca: string }[] = [
  // Parâmetro de query cujo NOME denuncia o valor. Cobre a URL pré-assinada do
  // R2 (`X-Amz-Signature`, `X-Amz-Credential`), o `?access_token=` da Meta, o
  // `?code=` do OAuth e o `apikey=` do PostgREST de uma vez só. O nome fica, o
  // valor some: "qual parâmetro estava na URL" é informação de depuração; o
  // valor dele nunca é.
  {
    regex:
      /([?&#][^=&\s]*(?:token|secret|signature|credential|password|senha|apikey|api_key|key|code|sig)[^=&\s]*=)[^&\s"']+/gi,
    troca: "$1[redigido]",
  },
  // JWT. Pega a `anon`, a `service_role`, o access token do Supabase e o token
  // de Realtime. Três segmentos base64url separados por ponto, começando em
  // `eyJ` — que é `{"` em base64 e portanto o início de todo cabeçalho JWT.
  { regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, troca: "[jwt]" },
  // Token do Instagram. Os longos começam com `IGQ`; o curto, com `IGA`.
  { regex: /\bIG[A-Z][A-Za-z0-9_-]{20,}/g, troca: "[token-ig]" },
  // Chaves da Stripe e as novas do Supabase, que têm prefixo próprio e estável.
  { regex: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, troca: "[chave-stripe]" },
  { regex: /\bwhsec_[A-Za-z0-9]{8,}/g, troca: "[whsec]" },
  { regex: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, troca: "[chave-supabase]" },
  // E-mail. O PLANO o cita junto do token, e com razão: num serviço de erros
  // ele é o identificador que liga tudo a uma pessoa. `user_id` faz o mesmo
  // trabalho para depurar e não identifica ninguém fora do nosso banco.
  { regex: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, troca: "[email]" },
];

/**
 * Teto do texto que entra em `redigir`.
 *
 * O padrão de e-mail (`[\w.+-]+@…`) volta atrás quadraticamente numa sequência
 * longa de caracteres de palavra que nunca chega a um `@` — medido: 1 000
 * caracteres custam 0,9 ms, 4 000 custam 14 ms e 16 000 custam 255 ms. Como o
 * scrubber agora varre o evento inteiro, ele alcança strings que o cliente
 * influencia (a mensagem de uma exceção que ecoa um nome de arquivo, por
 * exemplo), e `maxValueLength` não tem padrão no SDK: sem teto, a mensagem
 * chega aqui do tamanho que for.
 *
 * Cortar antes de redigir é seguro na direção certa: perde texto, nunca
 * deixa de redigir. E o corte é visível.
 */
const TETO_DO_TEXTO = 16_384;

export function redigir(texto: string): string {
  let saida =
    texto.length > TETO_DO_TEXTO
      ? `${texto.slice(0, TETO_DO_TEXTO)}…[truncado]`
      : texto;

  for (const { regex, troca } of PADROES) {
    // `lastIndex` zerado a cada uso: são regex globais e vivem no módulo, então
    // duas chamadas seguidas sobre textos diferentes pulariam trechos.
    regex.lastIndex = 0;
    saida = saida.replace(regex, troca);
  }
  return saida;
}

/**
 * Aplica `redigir` em toda string alcançável a partir de `valor`.
 *
 * No limite de profundidade o valor é **substituído**, não devolvido como
 * estava. A diferença importa: devolver o objeto intacto manda para fora
 * exatamente o texto que não foi varrido, e sem nada denunciando isso. Assim,
 * quando o limite for baixo demais, o que aparece no painel é a marca
 * `[fundo demais]` — um defeito visível em vez de um vazamento silencioso.
 */
function varrer(valor: unknown, profundidade = 0): unknown {
  if (typeof valor === "string") return redigir(valor);
  if (valor === null || valor === undefined) return valor;
  if (typeof valor !== "object") return valor;

  if (profundidade >= PROFUNDIDADE_MAXIMA) return "[fundo demais]";

  if (Array.isArray(valor)) {
    return valor.map((item) => varrer(item, profundidade + 1));
  }

  const entrada = valor as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  let contados = 0;
  for (const chave of Object.keys(entrada)) {
    // `modules` escapa do teto de campos, e só ele.
    //
    // A `modulesIntegration` do Node monta esse objeto a partir do
    // `require.cache` — são centenas de pacotes num servidor Next, e o corte em
    // 80 transformava o inventário de dependências do deploy numa amostra
    // arbitrária. É justamente o campo que alguém abre para responder "qual
    // versão de X subiu neste deploy?", e uma resposta pela metade ali é pior
    // que nenhuma, porque parece completa.
    //
    // Deixar passar é seguro: é um mapa `nome → semver` gerado por máquina, e
    // nenhum dos padrões de `PADROES` casa com qualquer um dos dois.
    if (chave === "modules" && profundidade === 0) {
      saida[chave] = entrada[chave];
      continue;
    }
    if (contados >= CAMPOS_POR_OBJETO) break;
    contados += 1;
    saida[chave] = varrer(entrada[chave], profundidade + 1);
  }
  return saida;
}

/**
 * Cabeçalhos que podem ir para o Sentry. Lista de PERMISSÃO, não de bloqueio:
 * cabeçalho é o lugar onde uma integração nova entra sem avisar, e uma lista de
 * bloqueio só conhece o que já existia quando foi escrita. `cookie` e
 * `authorization` são os óbvios; `x-forwarded-for` é IP, que é dado pessoal.
 */
const CABECALHOS_PERMITIDOS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "referer",
  "user-agent",
]);

/**
 * A limpeza de um evento, antes de ele sair da máquina.
 *
 * Genérica sobre `E` e não escrita contra `ErrorEvent | TransactionEvent` de
 * propósito: `TransactionEvent` **não é reexportado** por `@sentry/nextjs`
 * (só por `@sentry/core`, que é dependência transitiva e não nossa), e
 * escrever o tipo contra um pacote que não está no `package.json` funciona só
 * enquanto o npm resolver a árvore do jeito que resolve hoje. O corpo trata o
 * evento como o saco de propriedades que ele é, e o tipo de saída acompanha o
 * de entrada — que é o que `beforeSend` e `beforeSendTransaction` exigem, cada
 * um com o seu.
 *
 * Devolve `null` para descartar o evento inteiro — hoje ninguém usa isso, mas o
 * tipo permite, e é onde entraria um filtro de ruído.
 */
type Requisicao = {
  cookies?: unknown;
  data?: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  query_string?: unknown;
};

export function limparEvento<E>(evento: E): E | null {
  const alvo = evento as {
    user?: { id?: string | number } | null;
    server_name?: string;
    request?: Requisicao;
    message?: unknown;
    exception?: unknown;
    breadcrumbs?: unknown;
    extra?: unknown;
    contexts?: unknown;
    tags?: unknown;
  };

  // O `user`: fica o `id`, some o resto. É literalmente o que o PLANO pede.
  //
  // E há um motivo a mais, que não é óbvio e não está coberto por este arquivo:
  // o SDK também emite **envelopes de sessão** (`browserSessionIntegration` e
  // `processSessionIntegration` estão nas listas padrão), e esses NÃO passam
  // por `beforeSend` — não existe gancho de usuário para eles. O que uma sessão
  // carrega é `did`, que o SDK monta como `user.id || user.email ||
  // user.username`, mais `ip_address` e `user_agent` tirados do mesmo `user`.
  //
  // Hoje isso é inofensivo porque **nada neste projeto chama `Sentry.setUser`**
  // — o `user` do evento vem sempre nulo. Se algum dia chamar: passe SÓ `id`.
  // `setUser({ id, email })` publica o e-mail do titular num envelope que esta
  // função não tem como limpar.
  if (alvo.user) {
    alvo.user = { id: alvo.user.id };
  }

  // `server_name` é o hostname da máquina, e o SDK o preenche sozinho. Na
  // Vercel é um id de contêiner que não diz nada; rodando localmente é o nome
  // do computador de quem desenvolve (medido: `DESKTOP-…`), que é dado pessoal
  // de graça num serviço de terceiro. A informação que resolveria a mesma
  // pergunta — onde isso rodou — já vai na etiqueta `runtime`.
  delete alvo.server_name;

  if (alvo.request) {
    delete alvo.request.cookies;
    delete alvo.request.data;

    if (alvo.request.headers) {
      const filtrados: Record<string, string> = {};
      for (const [chave, valor] of Object.entries(alvo.request.headers)) {
        if (CABECALHOS_PERMITIDOS.has(chave.toLowerCase())) {
          filtrados[chave] = redigir(String(valor));
        }
      }
      alvo.request.headers = filtrados;
    }

    if (alvo.request.url) alvo.request.url = redigir(alvo.request.url);
    if (alvo.request.query_string !== undefined) {
      alvo.request.query_string = varrer(alvo.request.query_string);
    }
  }

  // E ENTÃO O EVENTO INTEIRO, e não uma lista de campos.
  //
  // Esta linha já foi uma lista — `{ message, exception, breadcrumbs, extra,
  // contexts, tags }` — e a lista tinha um buraco que só apareceu numa revisão
  // de segurança: **`event.spans[]`**, que é irmão de `contexts` no topo do
  // evento e não estava nela. Span de requisição HTTP carrega a URL COMPLETA em
  // `data["url.full"]` e a query em `data["http.query"]`, e as URLs deste
  // produto são as piores possíveis para isso:
  //
  //   · `renovarToken` chama a Meta com `?access_token=<token de 60 dias>`;
  //   · `trocarPorTokenLongo`, com `?client_secret=<IG_APP_SECRET>`;
  //   · o navegador faz `PUT` na URL pré-assinada do R2, com `X-Amz-Signature`.
  //
  // Ou seja: os padrões de `PADROES` teriam pegado os três — eles simplesmente
  // não rodavam sobre o campo onde os três aparecem. O erro não foi a lista
  // estar errada; foi ela ser uma lista. Um scrubber por permissão fica
  // desatualizado em silêncio a cada campo novo do SDK, e o sintoma é um
  // segredo no painel de terceiro, não um erro de compilação.
  //
  // Varrer o evento inteiro custa alguns milissegundos por evento e não tem
  // essa classe de falha. `user`, `request` e `server_name` já foram tratados
  // acima; passar de novo por eles é inofensivo.
  return varrer(alvo, 0) as E;
}

/**
 * A limpeza de um breadcrumb, que é o caminho por onde o segredo mais vaza.
 *
 * Breadcrumb de `fetch` guarda a URL inteira, e no PageMask as URLs mais
 * interessantes de depurar são justamente as pré-assinadas do R2. Breadcrumb de
 * `console` guarda os argumentos do `console.error`, que no servidor carregam o
 * objeto de erro do Supabase inteiro.
 */
export function limparBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // O breadcrumb de UI guarda o seletor CSS do elemento clicado, e o `value` de
  // um input pode entrar junto em alguns navegadores. Nenhum dos dois vale o
  // risco: o que importa para depurar é que houve um clique, não onde.
  if (breadcrumb.category === "ui.input") return null;

  return varrer(breadcrumb) as Breadcrumb;
}

/**
 * As opções que valem nos três ambientes.
 *
 * Erro vai inteiro (`sampleRate` padrão, 1.0); traço de performance não vai —
 * ver `tracesSampleRate` abaixo, que é uma decisão de superfície de exposição e
 * não de custo.
 */
export const OPCOES_COMUNS = {
  // A opção que desliga o que o SDK coleta sozinho: IP, cookie, corpo. É o
  // piso, não o teto — o teto são os ganchos acima.
  sendDefaultPii: false,

  // Teto do tamanho de `exception.values[].value`. **O SDK não tem padrão para
  // isto**: sem a linha, a mensagem de uma exceção chega ao `beforeSend` do
  // tamanho que for, e o scrubber tem que varrer tudo. `redigir` já corta por
  // conta própria; esta é a mesma trava um passo antes, no lugar onde ela
  // também reduz o que trafega.
  maxValueLength: 4096,

  // TRAÇO DE PERFORMANCE DESLIGADO (era 0.1).
  //
  // Não é economia de cota: é a superfície. Span de requisição HTTP existe para
  // guardar a URL chamada, e neste produto as URLs chamadas carregam o token do
  // Instagram, o `IG_APP_SECRET` e a assinatura pré-assinada do R2 na query
  // (ver o comentário longo em `limparEvento`). O scrubber agora cobre isso,
  // mas "o dado sensível sai daqui e depende de um filtro para não vazar" é uma
  // aposta pior que "ele não sai".
  //
  // E o que se ganharia em troca é pouco: o worker já mede cada etapa no log em
  // JSON, e o app não tem volume que justifique amostragem de performance.
  //
  // QUEM FOR RELIGAR ISTO: confira antes que `/api/sentry/teste` ainda emita
  // uma transação com span de URL pré-assinada, e que o envelope capturado
  // chegue redigido. É o único jeito de saber que o scrubber acompanha o SDK.
  tracesSampleRate: 0,
  // O SDK avisa no console quando a DSN falta ou o envio falha. Em produção
  // isso é ruído; em desenvolvimento é como se descobre que a configuração
  // está errada.
  debug: false,
  beforeSend: (evento: ErrorEvent) => limparEvento(evento),
  beforeSendTransaction: <T>(evento: T) => limparEvento(evento),
  // `beforeSendSpan` cobre o span que sai FORA do envelope de transação, e
  // portanto fora do alcance de `beforeSendTransaction`.
  //
  // Há um efeito colateral que vale saber, porque ele é o oposto do que o nome
  // sugere: no SDK 10 a `spanStreamingIntegration` entra sozinha nos clientes
  // de servidor, e ela **desliga o streaming** quando existe um
  // `beforeSendSpan` que não foi embrulhado em `withStreamedSpan`. Ou seja,
  // esta linha hoje não "filtra o streaming" — ela o impede. O resultado é
  // seguro dos dois jeitos, mas quem um dia puser `traceLifecycle: "stream"`
  // precisa embrulhar esta função com `withStreamedSpan`, senão liga o
  // streaming e perde o scrubber junto.
  beforeSendSpan: <T>(span: T) => varrer(span) as T,
  beforeBreadcrumb: (breadcrumb: Breadcrumb) => limparBreadcrumb(breadcrumb),
} as const;

/**
 * O ambiente, para separar erro de produção de erro de desenvolvimento no
 * painel. `VERCEL_ENV` existe na Vercel (`production`, `preview`,
 * `development`); fora dela vale o `NODE_ENV`.
 */
export function ambienteDoSentry(): string {
  return process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}
