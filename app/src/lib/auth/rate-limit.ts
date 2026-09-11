import "server-only";

import { headers } from "next/headers";

import { LIMITE_TENTATIVAS } from "@/lib/auth/formulario";
import { createAdminClient } from "@/lib/supabase/admin";

/** Janela do limite. O número de tentativas vive em @/lib/auth/formulario. */
export const JANELA_AUTH = "15 minutes";

export type ResultadoLimite = {
  permitido: boolean;
  restantes: number;
  liberadoEm: Date;
};

/**
 * IP de quem está chamando, ou `null` quando não dá para saber.
 *
 * A ordem importa e é deliberada: **`x-real-ip` primeiro**. Ele é escrito pela
 * plataforma com um valor só, o do cliente, e não tem para onde o atacante
 * enfiar outro. `x-forwarded-for` é uma lista, e o primeiro item dela é
 * justamente a parte que o cliente pode ter escrito: onde o proxy ACRESCENTA em
 * vez de substituir, ler o item 0 é ler o que o atacante mandou — e aí trocar o
 * cabeçalho a cada tentativa dá um balde novo por tentativa, que é o mesmo que
 * não ter limite. Só quando `x-real-ip` não existe é que o primeiro hop do
 * `x-forwarded-for` serve, e serve como aproximação.
 *
 * Fora de um proxy confiável nenhum dos dois vale nada — e a ordem entre eles
 * não salva ninguém: sob um proxy que ACRESCENTA ao `x-forwarded-for` sem
 * escrever o `x-real-ip` (nginx padrão, por exemplo), as duas ordens leem valor
 * mandado pelo cliente. O que sustenta esta função é a premissa de implantação,
 * escrita aqui para não precisar ser redescoberta: **na Vercel, que é o deploy
 * deste projeto (CLAUDE.md, "Stack"), a plataforma escreve os dois cabeçalhos e
 * descarta o que o cliente tiver mandado.** Sair da Vercel exige revisar isto
 * antes, ou o limite vira decoração: basta um cabeçalho diferente por tentativa.
 *
 * O `null` é deliberado. Antes esta função devolvia `"desconhecido"`, e todo
 * chamador sem IP caía no **mesmo balde**: onde o cabeçalho não existisse, a
 * 11ª tentativa de qualquer pessoa trancava o login de todas as outras por 15
 * minutos — um bloqueio geral que o próprio atacante dispara com onze
 * requisições. Quem decide o que fazer sem IP é `consumirLimiteAuth`.
 */
async function ipDaRequisicao(): Promise<string | null> {
  const h = await headers();

  const real = h.get("x-real-ip")?.trim();
  if (real) return normalizar(real);

  const encaminhado = h.get("x-forwarded-for");
  if (encaminhado) {
    const primeiro = encaminhado.split(",")[0]?.trim();
    if (primeiro) return normalizar(primeiro);
  }

  return null;
}

/**
 * Reduz IPv6 ao prefixo /64 — o balde é por REDE, não por endereço.
 *
 * Em IPv4 um endereço é um recurso escasso e serve de identificador. Em IPv6
 * não: o provedor entrega um /64 inteiro (18 quintilhões de endereços) a um
 * único assinante, e trocar de endereço dentro dele é de graça. Contando por
 * endereço, o limite de 10 tentativas simplesmente não existe para quem tem
 * IPv6 — basta usar um endereço novo a cada tentativa, sem nenhuma ferramenta
 * especial. O contador só vale se a chave for algo que custe trocar.
 *
 * O IPv4 mapeado (`::ffff:1.2.3.4`) volta como o IPv4 que ele é: cortá-lo em
 * quatro grupos misturaria numa chave só todo mundo que chega por esse caminho.
 */
function normalizar(endereco: string): string {
  // `[2001:db8::1]:443` — colchetes e porta, como alguns proxies escrevem.
  const semColchetes = endereco.replace(/^\[(.+)\](?::\d+)?$/, "$1");

  // `1.2.3.4:5678` — IPv4 com a porta colada, que alguns proxies também fazem.
  // Sem tirar a porta, cada requisição do mesmo cliente cairia num balde
  // próprio (a porta de origem muda a cada conexão) e o limite deixaria de
  // existir, em silêncio.
  const comPorta = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(semColchetes);
  if (comPorta) return comPorta[1];

  if (!semColchetes.includes(":")) return semColchetes;

  // IPv4 mapeado, nas duas escritas: `::ffff:1.2.3.4` e a expandida
  // `0:0:0:0:0:ffff:1.2.3.4`. Sem a segunda, a expandida caía no caminho de
  // baixo e virava `0:0:0:0::/64` — um balde só para todo mundo que chegasse
  // assim, que é o bloqueio geral que este arquivo existe para não ter.
  const mapeado = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)(\d+\.\d+\.\d+\.\d+)$/i.exec(
    semColchetes,
  );
  if (mapeado) return mapeado[1];

  const grupos = hextetos(semColchetes);
  if (!grupos) {
    // Forma de IPv6 que este código não soube expandir. Voltar o endereço
    // inteiro dá um balde por endereço, que em IPv6 é o mesmo que não ter
    // limite — então isso precisa aparecer, e não passar em silêncio.
    console.error("[rate-limit] endereço IPv6 não reconhecido; balde por endereço", {
      grupos: semColchetes.split(":").length,
    });
    return semColchetes;
  }

  // Cada hexteto em forma canônica antes de virar chave: `2001:0db8`,
  // `2001:db8` e `2001:DB8` são a MESMA rede, e como texto seriam três baldes
  // diferentes — o agrupamento por /64 se desfaria sem ninguém notar.
  const canonizar = (h: string) => (h.replace(/^0+/, "") || "0").toLowerCase();
  const canonico = grupos.slice(0, 4).map(canonizar).join(":");

  // `::/64` não é rede de cliente nenhum: ali moram o loopback (`::1`), o
  // endereço não especificado (`::`) e as formas embutidas de IPv4. Agrupar por
  // /64 aí juntaria num balde só todo mundo que chegasse por qualquer um deles
  // — o mesmo bloqueio geral de antes, por outra porta. Nesse caso o balde é o
  // endereço inteiro.
  if (canonico === "0:0:0:0") return grupos.map(canonizar).join(":");

  return `${canonico}::/64`;
}

/**
 * Expande um IPv6 nos seus 8 hextetos, ou `null` se a forma não for
 * reconhecida.
 *
 * Dois detalhes que um `split(":")` ingênuo erra, e os dois aparecem em
 * endereço real:
 *
 *   · `::` comprime uma sequência de zeros, então a posição escrita não é a
 *     posição real — em `2001:db8::1` o "1" é o oitavo hexteto, não o terceiro.
 *   · um IPv4 pode vir colado no fim (`2001:db8::192.0.2.1`) e vale por DOIS
 *     hextetos. Contado como um, o endereço parece ter sete e a expansão falha.
 *     Ele é convertido, e não zerado: para o /64 o valor de fato não importa
 *     (mora nas últimas posições), mas no bloco `::/64` — onde o balde passa a
 *     ser o endereço inteiro — zerar juntaria todo `::a.b.c.d` num balde só.
 */
function hextetos(endereco: string): string[] | null {
  const [esquerda, direita, demais] = endereco.split("::");
  if (demais !== undefined) return null; // dois `::` não é endereço

  const partes = (trecho: string | undefined): string[] => {
    if (!trecho) return [];
    const tokens = trecho.split(":");
    const ultimo = tokens[tokens.length - 1];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ultimo)) return tokens;

    const [a, b, c, d] = ultimo.split(".").map(Number);
    return [
      ...tokens.slice(0, -1),
      ((a << 8) | b).toString(16),
      ((c << 8) | d).toString(16),
    ];
  };

  const inicio = partes(esquerda);
  const fim = partes(direita);

  if (direita === undefined) return inicio.length === 8 ? inicio : null;

  const faltando = 8 - inicio.length - fim.length;
  if (faltando < 1) return null;
  return [...inicio, ...Array(faltando).fill("0"), ...fim];
}

/**
 * Registra uma tentativa e diz se ela passa.
 *
 * Conta **toda** tentativa, não só as que falham. Contar só o erro deixaria de
 * pé o ataque que mais importa: varrer uma lista de e-mails vazados com uma
 * senha só, onde quase toda tentativa acerta o formato e o atacante só precisa
 * de um acerto.
 *
 * Efeito colateral aceito: um escritório inteiro atrás de um NAT divide o mesmo
 * balde. 10 tentativas em 15 minutos ainda é folgado para uso legítimo, e o
 * bloqueio expira sozinho.
 *
 * Falha aberta de propósito. Se o banco não responder, o login continua
 * funcionando — indisponibilidade do contador não pode virar indisponibilidade
 * do produto. A senha continua sendo verificada pelo Supabase, que tem limite
 * próprio; o que se perde aqui é uma camada, não a única.
 */
export async function consumirLimiteAuth(rota: string): Promise<ResultadoLimite> {
  const ip = await ipDaRequisicao();

  if (!ip) {
    // Sem IP não há a quem atribuir a tentativa, e um balde comum para todos os
    // anônimos seria pior que limite nenhum: bastaria uma pessoa gastar as 10
    // tentativas para o login inteiro fechar. Segue a mesma doutrina do resto
    // desta função — falha aberta, nunca calada. Na Vercel o
    // `x-forwarded-for` sempre existe, então este ramo denuncia deploy em
    // infraestrutura que ainda não foi revisada aqui.
    console.error("[rate-limit] requisição sem IP; tentativa não contabilizada", {
      rota,
    });
    return { permitido: true, restantes: LIMITE_TENTATIVAS, liberadoEm: new Date() };
  }

  const bucket = `${rota}:${ip}`;

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("consume_rate_limit", {
      p_bucket: bucket,
      p_limite: LIMITE_TENTATIVAS,
      p_janela: JANELA_AUTH,
    });

    if (error || !data || data.length === 0) {
      // Falha aberta, mas nunca calada. Um limitador quebrado — chave de
      // servico ausente, migration nao aplicada, cache do PostgREST velho,
      // grant faltando — deixa o login sem protecao por tempo indeterminado, e
      // sem este log nada denuncia isso. Na Fase 10 vira alerta no Sentry.
      console.error("[rate-limit] RPC consume_rate_limit falhou", {
        rota,
        // O `bucket` carrega o IP do usuario: fica de fora do log.
        codigo: error?.code,
        mensagem: error?.message,
      });
      return { permitido: true, restantes: LIMITE_TENTATIVAS, liberadoEm: new Date() };
    }

    const linha = data[0];
    return {
      permitido: linha.permitido,
      restantes: linha.restantes,
      liberadoEm: new Date(linha.liberado_em),
    };
  } catch (erro) {
    console.error("[rate-limit] excecao ao consultar o limite", {
      rota,
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return { permitido: true, restantes: LIMITE_TENTATIVAS, liberadoEm: new Date() };
  }
}
