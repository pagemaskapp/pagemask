import * as Sentry from "@sentry/nextjs";

import { erroJson, okJson } from "@/lib/auth/api";
import { cronAutorizado } from "@/lib/cron/autorizacao";
import { publicEnv } from "@/lib/env/public";
import { limparEvento } from "@/lib/observabilidade/sentry-comum";

/**
 * `POST /api/sentry/teste` — manda um erro de propósito para o Sentry.
 *
 * POR QUE ISTO EXISTE EM PRODUÇÃO
 * ===============================
 *
 * "O Sentry está recebendo?" é uma pergunta que só tem resposta boa de um jeito:
 * provocando um erro e vendo se ele chega. Sem uma rota assim, a resposta vem
 * de esperar um erro de verdade acontecer — e uma configuração quebrada
 * (`NEXT_PUBLIC_SENTRY_DSN` esquecida num deploy, CSP bloqueando a origem de
 * ingestão, DSN do projeto errado) se parece exatamente com um mês tranquilo.
 * É o item "Sentry recebendo erro de teste do app e do worker" do checklist
 * §9, e ele precisa poder ser refeito a cada deploy, não uma vez.
 *
 * PROTEGIDA PELO `CRON_SECRET`, e não pela sessão do usuário. É a mesma porta
 * das rotas de cron (`lib/cron/autorizacao.ts`): comparação em tempo constante,
 * cabeçalho `authorization: Bearer …`. Um endpoint que gera evento no Sentry
 * aberto a qualquer visitante é um jeito barato de encher a cota do plano e
 * afogar o erro de verdade no meio do lixo.
 *
 * `POST` e não `GET`: nada que provoque efeito deve responder a uma navegação,
 * a um prefetch ou a um crawler que resolva seguir o link.
 *
 * O erro levado é sintético e **carrega segredo de mentira de propósito** — um
 * JWT, um token de Instagram, uma URL pré-assinada e um e-mail. Assim a mesma
 * chamada que prova que o Sentry recebe prova também que o scrubber de
 * `lib/observabilidade/sentry-comum.ts` está no caminho: no painel, a mensagem
 * tem que chegar com `[jwt]`, `[token-ig]`, `[redigido]` e `[email]` no lugar
 * deles. Se chegar com os valores, o `beforeSend` não está sendo aplicado.
 */
export async function POST(requisicao: Request) {
  if (!cronAutorizado(requisicao)) {
    return erroJson(401, "Não autorizado.");
  }

  if (!publicEnv.NEXT_PUBLIC_SENTRY_DSN) {
    return erroJson(
      503,
      "NEXT_PUBLIC_SENTRY_DSN não está definida: não há para onde mandar o erro.",
    );
  }

  const marca = `pagemask-teste-${Date.now()}`;

  const erro = new Error(
    `Erro de teste do PageMask (${marca}). ` +
      "Iscas do scrubber, todas falsas: " +
      `jwt=${jwtFalso()} ` +
      "ig=IGQWRPnaoEhUmTokenDeVerdadeSoIscaAAAA " +
      "r2=https://exemplo.r2.cloudflarestorage.com/b/k?X-Amz-Signature=naoEhAssinaturaDeVerdade " +
      "email=titular@exemplo.test",
  );
  erro.name = "ErroDeTesteDoPageMask";

  const id = Sentry.captureException(erro, { tags: { teste: "fase-10" } });

  // `flush` antes de responder: numa função serverless o processo pode ser
  // congelado assim que a resposta sai, e o envio do Sentry é assíncrono. Sem
  // isto, a rota responderia "mandei" e o evento morreria com o processo — a
  // falha mais irônica possível para uma rota cuja única função é provar que o
  // evento chega.
  const entregue = await Sentry.flush(5000);

  return okJson({
    ok: entregue,
    marca,
    evento: id,
    span_redigido: provaDoSpan(),
  });
}

/**
 * A isca de JWT, MONTADA EM TEMPO DE EXECUÇÃO e não escrita como literal.
 *
 * A primeira versão tinha o `eyJhbGciOiJIUzI1NiJ9.…` inteiro no fonte, e o
 * `gitleaks` do pre-commit barrou o commit — corretamente, porque um scanner não
 * tem como saber que aquele JWT é de mentira. A saída fácil seria abrir uma
 * exceção no `.gitleaks.toml`, e o cabeçalho daquele arquivo já diz por que não:
 * "toda exceção aberta aqui é uma exceção que alguém, um dia, usa para deixar
 * passar um segredo de verdade".
 *
 * Montar em tempo de execução resolve sem exceção nenhuma: no repositório não
 * existe nada com forma de JWT, e o que chega ao `beforeSend` continua sendo um
 * JWT bem-formado — que é o que precisa ser testado. O `role` é `service_role`
 * de propósito: é o pior caso que o padrão precisa pegar.
 */
function jwtFalso(): string {
  const b64 = (texto: string) => Buffer.from(texto, "utf8").toString("base64url");
  return [
    b64('{"alg":"HS256","typ":"JWT"}'),
    b64('{"role":"service_role","iss":"isca-do-teste"}'),
    b64("isto-nao-e-uma-assinatura"),
  ].join(".");
}

/**
 * A prova de que o scrubber cobre `event.spans[]`.
 *
 * ESTA FUNÇÃO EXISTE POR CAUSA DE UM BUG REAL, e o formato dela é o remédio.
 *
 * `limparEvento` já foi um scrubber por LISTA de campos — `message`,
 * `exception`, `breadcrumbs`, `extra`, `contexts`, `tags` — e `spans` não
 * estava nela. Span de requisição HTTP guarda a URL inteira, e as URLs deste
 * produto carregam o token do Instagram e a assinatura do R2 na query. O erro
 * de teste acima **não teria detectado isso**: `captureException` produz um
 * evento de ERRO, e evento de erro não tem `spans`. O teste passaria com
 * `[jwt]` e `[token-ig]` bonitos na tela enquanto a transação vazava.
 *
 * Então a rota roda o scrubber sobre um evento de TRANSAÇÃO sintético e devolve
 * o resultado. Quem chamar vê, na resposta, se a assinatura pré-assinada saiu
 * redigida — sem depender de amostragem, de tráfego real ou de olhar o painel.
 * É o que transforma "achamos que cobre" em "olha aqui".
 */
function provaDoSpan(): unknown {
  const transacaoFalsa = {
    type: "transaction",
    transaction: "GET /api/exemplo",
    spans: [
      {
        op: "http.client",
        description: "PUT https://exemplo.r2.cloudflarestorage.com/b/k",
        data: {
          "url.full":
            "https://exemplo.r2.cloudflarestorage.com/b/k?X-Amz-Credential=naoEhCredencial&X-Amz-Signature=naoEhAssinaturaDeVerdade",
          "http.query": "?access_token=IGQWRPnaoEhUmTokenDeVerdadeSoIscaAAAA",
        },
      },
    ],
  };

  const limpo = limparEvento(transacaoFalsa) as typeof transacaoFalsa | null;
  const dados = limpo?.spans?.[0]?.data;

  return {
    "url.full": dados?.["url.full"] ?? null,
    "http.query": dados?.["http.query"] ?? null,
    // `true` é o que se espera. `false` significa que o scrubber voltou a ter
    // um buraco no caminho dos spans — e aí há segredo saindo daqui.
    ok:
      typeof dados?.["url.full"] === "string" &&
      !dados["url.full"].includes("naoEhAssinaturaDeVerdade") &&
      typeof dados?.["http.query"] === "string" &&
      !dados["http.query"].includes("IGQWRPnaoEh"),
  };
}
