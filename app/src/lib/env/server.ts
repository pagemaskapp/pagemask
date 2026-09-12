import "server-only";

import { z } from "zod";

import { isPrivilegedRole, supabaseKeyRole } from "@/lib/supabase/key-role";

/**
 * Variaveis de servidor. `import "server-only"` na primeira linha faz o build
 * falhar se qualquer arquivo com `"use client"` importar este modulo — direta
 * ou indiretamente. E a trava que garante que `SUPABASE_SERVICE_ROLE_KEY`,
 * `STRIPE_SECRET_KEY`, `R2_SECRET_ACCESS_KEY`, `IG_APP_SECRET` e
 * `TOKEN_ENC_KEY` nunca entrem no bundle do cliente (PLANO §3).
 *
 * A validacao e preguicosa de proposito: `next build` roda em CI sem segredo
 * nenhum, e so quem de fato usa uma variavel precisa que ela exista. Cada fase
 * seguinte estreita o que e obrigatorio.
 */

const base64With32Bytes = (value: string) => {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
};

const serverEnvSchema = z.object({
  // --- Supabase -----------------------------------------------------------
  // Opcional no schema, obrigatoria no ponto de uso (`requireServerEnv`). Quem
  // ainda nao chegou na fase que fala com o banco nao deve ser barrado por uma
  // variavel que nao usa.
  //
  // A checagem e o espelho da que existe em `./public.ts`: aqui so passa chave
  // COM privilegio. Colar a `anon` neste lugar seria uma falha silenciosa das
  // caras — o cliente admin subiria normalmente e toda consulta dele passaria a
  // respeitar RLS sem `auth.uid()` nenhum, devolvendo zero linha em vez de erro.
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1)
    .refine((value) => isPrivilegedRole(supabaseKeyRole(value)), {
      error:
        "SUPABASE_SERVICE_ROLE_KEY precisa ser a chave `service_role` (JWT com " +
        "role=service_role) ou a `sb_secret_…`. A chave anon nao serve aqui: " +
        "ela nao ignora RLS.",
    })
    .optional(),
  SUPABASE_DB_URL: z.string().min(1).optional(),

  // Segredo HS256 do projeto (Project Settings > API > JWT Settings > JWT
  // Secret). Serve a UM proposito: assinar o token de 5 minutos que autoriza o
  // Realtime no navegador (`@/lib/realtime/credencial`). Opcional de proposito
  // — sem ela a lista de videos se atualiza por recarga periodica em vez de ao
  // vivo, e nenhum token chega ao navegador.
  //
  // Nao confundir com a `anon` nem com a `service_role`: este e o segredo que
  // ASSINA as duas. Vazar ele e pior do que vazar a `service_role`, porque
  // permite forjar qualquer identidade do projeto.
  //
  // O minimo de 32 nao e numero redondo: este e o unico segredo do projeto
  // cujo PRODUTO (um JWT assinado com ele) e entregue ao navegador. Quem tiver
  // um token em maos pode atacar a chave off-line, sem limite de tentativas e
  // sem deixar rastro — e recuperar esta chave permite forjar `service_role`,
  // ou seja, ignorar a RLS inteira. O segredo que o Supabase gera passa de 40
  // caracteres; o piso existe para barrar um valor digitado a mao.
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),

  // --- Cloudflare R2 ------------------------------------------------------
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ENDPOINT: z.url().optional(),

  // --- Stripe -------------------------------------------------------------
  // Aqui o prefixo VALE como validacao, ao contrario do que acontece com as
  // chaves do Supabase (ver CLAUDE.md, "Chaves do Supabase"): a Stripe publica
  // `sk_test_`/`sk_live_` para a secreta, `pk_` para a publicavel e `whsec_`
  // para o segredo do webhook, e nunca reaproveitou um prefixo entre papeis
  // diferentes. Colar a publicavel no lugar da secreta e um erro de copiar e
  // colar comum, e sem esta checagem ele viraria um 401 da Stripe no meio do
  // checkout de um cliente em vez de um erro na subida do processo.
  STRIPE_SECRET_KEY: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("sk_") || v.startsWith("rk_"), {
      error:
        "STRIPE_SECRET_KEY precisa ser a chave secreta (`sk_test_…`, " +
        "`sk_live_…`) ou uma chave restrita (`rk_…`). A publicavel (`pk_…`) " +
        "nao serve: ela nao cria Checkout Session.",
    })
    .optional(),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("whsec_"), {
      error:
        "STRIPE_WEBHOOK_SECRET e o `whsec_…` do endpoint (Dashboard > " +
        "Webhooks, ou a saida do `stripe listen`). Sem ele nao ha " +
        "`constructEvent`, e sem `constructEvent` qualquer um posta um evento " +
        "falso.",
    })
    .optional(),

  // Pix Automatico so entra no checkout quando a conta da Stripe tem Pix
  // liberado (no Brasil o acesso e por solicitacao ao suporte). Passar `pix`
  // em `payment_method_types` sem a liberacao faz a criacao da sessao falhar
  // inteira — inclusive o cartao, que funcionava. Por isso a chave e um
  // interruptor explicito e o padrao e desligado.
  STRIPE_PIX_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  // Configuracao do Billing Portal (`bpc_…`), impressa por
  // `npm run stripe:sync`. Opcional: sem ela vale a configuracao padrao do
  // Dashboard. Com ela, o portal sabe listar os tres planos para troca — o
  // script e quem sabe disso, porque e ele que acabou de criar os Prices.
  STRIPE_PORTAL_CONFIGURATION_ID: z
    .string()
    .startsWith("bpc_", "STRIPE_PORTAL_CONFIGURATION_ID comeca com `bpc_`.")
    .optional(),

  // --- Instagram ----------------------------------------------------------
  IG_APP_ID: z.string().min(1).optional(),
  IG_APP_SECRET: z.string().min(1).optional(),
  IG_REDIRECT_URI: z.url().optional(),

  // Em qual modo o app está no painel da Meta. Serve a uma coisa só: a faixa
  // que avisa que, em revisão, apenas contas convidadas como testadoras
  // conseguem conectar (prompt da Fase 4, item 7).
  //
  // Vem de variável de ambiente, e não de uma consulta à Meta, porque não
  // existe endpoint que diga isso sem um app access token — e pendurar a
  // renderização da página numa chamada externa para decidir o texto de um
  // aviso é caro e frágil. O padrão é `development`: avisar demais custa uma
  // faixa a mais; avisar de menos custa o suporte de alguém tentando conectar
  // uma conta que nunca ia funcionar.
  IG_APP_MODE: z.enum(["development", "live"]).optional(),

  // --- Seguranca ----------------------------------------------------------
  TOKEN_ENC_KEY: z
    .string()
    .refine(base64With32Bytes, {
      error:
        "TOKEN_ENC_KEY precisa ser 32 bytes em base64 " +
        "(`openssl rand -base64 32`) — AES-256-GCM.",
    })
    .optional(),
  CRON_SECRET: z.string().min(32).optional(),

  // --- E-mail transacional ------------------------------------------------
  // Usado pelo cron quando a renovação de um token falha em definitivo: sem
  // aviso, o cliente só descobre que precisa reconectar quando uma publicação
  // falha (PLANO, Fase 4, item 5).
  //
  // Opcional, e a ausência é tratada como "não há provedor": o cron registra o
  // aviso no log e segue. O que NÃO pode acontecer é a falta do e-mail impedir
  // a marcação de `needs_reconnect` — o estado no banco é o que faz a tela
  // pedir a reconexão, e ele vale mesmo sem aviso nenhum.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_REMETENTE: z.string().min(3).optional(),

  // --- Sentry -------------------------------------------------------------
  SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
  SENTRY_ORG: z.string().min(1).optional(),
  SENTRY_PROJECT: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Trata `R2_ACCOUNT_ID=` (linha presente, valor vazio) como "nao definida".
 *
 * E exatamente o que sai de `cp .env.example .env.local`: para o zod a chave
 * existe e vale `""`, entao `.min(1).optional()` reprova e o app quebra inteiro
 * por causa de uma variavel de fase futura. Vazio e ausente sao a mesma coisa
 * num arquivo `.env`.
 */
function semVazios(fonte: NodeJS.ProcessEnv): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const chave of Object.keys(serverEnvSchema.shape)) {
    const valor = fonte[chave];
    if (typeof valor === "string" && valor.trim() === "") continue;
    if (valor === undefined) continue;
    saida[chave] = valor;
  }
  return saida;
}

let cached: ServerEnv | null = null;

/**
 * Le e valida as variaveis de servidor uma vez por processo. Chame no ponto de
 * uso, nunca no topo de um modulo compartilhado com o cliente.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(semVazios(process.env));
  if (!parsed.success) {
    const detalhe = parsed.error.issues
      .map((issue) => `  · ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // A mensagem cita o nome da variavel, nunca o valor: erro de configuracao
    // nao pode virar vazamento de segredo no log.
    throw new Error(`Variaveis de ambiente de servidor invalidas.\n${detalhe}`);
  }

  cached = parsed.data;
  return cached;
}

/** Le uma variavel obrigatoria no ponto de uso, com erro que diz o que falta. */
export function requireServerEnv<K extends keyof ServerEnv>(
  key: K,
): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (value === undefined || value === "") {
    throw new Error(
      `${String(key)} nao esta definida. Veja .env.example para saber de onde ela vem.`,
    );
  }
  return value as NonNullable<ServerEnv[K]>;
}
