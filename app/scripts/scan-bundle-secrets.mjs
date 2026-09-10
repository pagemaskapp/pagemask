#!/usr/bin/env node
/**
 * Procura segredo no JavaScript que de fato foi servido ao navegador.
 *
 * A trava de verdade é o `import "server-only"`, que quebra o build. Este
 * script é a segunda rede: olha o resultado, não a intenção.
 *
 * Duas passadas, porque uma só não cobre os dois formatos de chave do Supabase:
 *
 *   1. **Prefixo** — pega `sb_secret_…`, `sk_live_…`, `whsec_…` e o nome das
 *      variáveis que nunca deveriam ser referenciadas do lado do cliente.
 *
 *   2. **Papel do JWT** — o projeto ainda usa as chaves legadas do Supabase, e
 *      nelas a `anon` e a `service_role` são as duas `eyJ…`: idênticas por
 *      fora. Uma `service_role` vazada no bundle passaria batida por qualquer
 *      grep de prefixo. Então aqui todo JWT encontrado é decodificado e o claim
 *      `role` é conferido: `anon` pode (é pública por natureza), qualquer coisa
 *      privilegiada reprova.
 *
 * Nunca imprime o valor encontrado — só arquivo, posição e motivo. Um log de CI
 * é público dentro da equipe; não é lugar de reproduzir segredo.
 *
 * Uso: node scripts/scan-bundle-secrets.mjs [diretório]   (padrão: .next/static)
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const alvo = process.argv[2] ?? ".next/static";

/**
 * Chaves por prefixo — e **com corpo**.
 *
 * O `{20,}` depois do prefixo não é firula. Sem ele o script reprova a própria
 * `@supabase/supabase-js`, que carrega um `t.startsWith("sb_secret_")` no
 * código dela: prefixo solto, sem chave nenhuma atrás. Um alarme que dispara em
 * toda build limpa é pior que alarme nenhum, porque ensina a ignorá-lo.
 * Chave de verdade sempre tem corpo; checagem de prefixo nunca tem.
 */
const CHAVES = [
  { re: /sb_secret_[A-Za-z0-9_-]{20,}/, motivo: "chave secreta do Supabase (formato novo)" },
  { re: /sk_live_[A-Za-z0-9]{20,}/, motivo: "chave secreta de produção da Stripe" },
  { re: /sk_test_[A-Za-z0-9]{20,}/, motivo: "chave secreta de teste da Stripe" },
  { re: /whsec_[A-Za-z0-9]{20,}/, motivo: "segredo de webhook da Stripe" },
];

/**
 * Nomes de variável que nunca deveriam ser referenciados do lado do cliente.
 * Aqui a ocorrência solta é o próprio sinal: o Next troca `process.env.X` por
 * `undefined` no bundle quando `X` não é `NEXT_PUBLIC_*`, então ver o nome
 * inteiro significa que alguém o escreveu de outro jeito.
 */
const NOMES = [
  { padrao: "SUPABASE_SERVICE_ROLE_KEY", motivo: "nome da variável privilegiada" },
  { padrao: "TOKEN_ENC_KEY", motivo: "nome da chave de cifra de token" },
  { padrao: "R2_SECRET_ACCESS_KEY", motivo: "nome da chave secreta do R2" },
  { padrao: "IG_APP_SECRET", motivo: "nome do app secret do Instagram" },
];

/**
 * JWT: três segmentos base64url, com cabeçalho e payload começando em `eyJ`
 * (que é `{"` em base64).
 *
 * O terceiro segmento é deliberadamente frouxo (`{1,}`). Assinatura de JWT real
 * é longa, mas exigir tamanho aqui já deixou passar um token de teste com
 * assinatura curta — e o que importa é o payload, não a assinatura, que este
 * script nem verifica. Frouxo demais gera aviso; restrito demais gera silêncio.
 */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;

/** Papéis do Supabase que podem aparecer no navegador. */
const PAPEIS_PUBLICOS = new Set(["anon"]);

function decodePayload(token) {
  try {
    const bruto = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const comPadding = bruto.padEnd(
      bruto.length + ((4 - (bruto.length % 4)) % 4),
      "=",
    );
    return JSON.parse(Buffer.from(comPadding, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function* arquivos(dir) {
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) yield* arquivos(caminho);
    else yield caminho;
  }
}

if (!existsSync(alvo)) {
  console.error(`::error::${alvo} não existe — o build não gerou bundle de cliente.`);
  process.exit(1);
}

const achados = [];
let lidos = 0;
let jwtsVistos = 0;

for await (const caminho of arquivos(alvo)) {
  if (!/\.(js|mjs|cjs|css|map|json|txt)$/.test(caminho)) continue;

  const conteudo = await readFile(caminho, "utf8");
  lidos += 1;
  const rel = relative(process.cwd(), caminho);

  for (const { re, motivo } of CHAVES) {
    const m = re.exec(conteudo);
    if (m) {
      achados.push({ arquivo: rel, pos: m.index, motivo });
    }
  }

  for (const { padrao, motivo } of NOMES) {
    const pos = conteudo.indexOf(padrao);
    if (pos !== -1) {
      achados.push({ arquivo: rel, pos, motivo: `${motivo} ("${padrao}")` });
    }
  }

  for (const match of conteudo.matchAll(JWT)) {
    jwtsVistos += 1;
    const payload = decodePayload(match[0]);
    const role = payload?.role;

    if (typeof role !== "string") {
      // JWT que não é chave do Supabase. Não reprova, mas fica registrado:
      // token no bundle merece um olhar humano.
      console.warn(
        `::warning file=${rel}::JWT sem claim "role" no bundle do cliente ` +
          `(posição ${match.index}). Confira se não é segredo.`,
      );
      continue;
    }

    if (!PAPEIS_PUBLICOS.has(role)) {
      achados.push({
        arquivo: rel,
        pos: match.index,
        motivo: `JWT do Supabase com role="${role}" — essa chave ignora RLS`,
      });
    }
  }
}

console.log(
  `Varridos ${lidos} arquivos em ${alvo} (${jwtsVistos} JWT encontrados).`,
);

if (achados.length > 0) {
  console.error("");
  console.error("SEGREDO NO BUNDLE DO CLIENTE:");
  for (const { arquivo, pos, motivo } of achados) {
    console.error(`::error file=${arquivo}::${motivo} — posição ${pos}`);
  }
  console.error("");
  console.error(
    `${achados.length} ocorrência(s). O valor não é impresso de propósito: ` +
      "abra o arquivo na posição indicada.",
  );
  process.exit(1);
}

console.log("OK: nenhum segredo no bundle do cliente.");
