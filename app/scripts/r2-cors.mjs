/**
 * A política de CORS do bucket R2 — operação de infraestrutura, uma vez por
 * ambiente.
 *
 *   node scripts/r2-cors.mjs            # imprime a regra deste ambiente
 *   node scripts/r2-cors.mjs --aplicar  # tenta gravar (exige token de admin)
 *
 * O token de `R2_ACCESS_KEY_ID` deste projeto tem escopo **Object Read & Write**
 * (`.env.example` manda criá-lo assim, e está certo: é o mínimo de que o app
 * precisa em produção). CORS, porém, é configuração de BUCKET, não de objeto —
 * com esse token, tanto ler quanto gravar a política voltam `AccessDenied` 403.
 * **Medido.**
 *
 * Então o caminho normal é: rodar sem argumento, copiar o JSON que sai daqui e
 * colar em R2 > (bucket) > Settings > CORS policy. O `--aplicar` existe para
 * quem tiver um token de Admin Read & Write em mãos.
 *
 * POR QUE ISTO EXISTE, se o lifecycle é configurado no painel
 *
 * O lifecycle é uma decisão de retenção: 30 dias, escrito em `docs/PRODUCAO.md`,
 * conferido a olho no painel. Não muda com o código.
 *
 * O CORS é o contrário — ele é uma consequência direta do código. A origem
 * permitida é a `NEXT_PUBLIC_APP_URL` do ambiente, os métodos são exatamente os
 * que `lib/r2/assinatura.ts` assina, e o cabeçalho permitido é o `Content-Type`
 * que a assinatura trava. Trocar qualquer um desses no código sem trocar aqui
 * quebra o upload — e quebra de um jeito particularmente ruim: o navegador
 * bloqueia a requisição ANTES de ela sair, o servidor não vê nada, e o que
 * aparece no console é um erro de CORS que não menciona assinatura nenhuma.
 *
 * Por isso ele mora no repositório, versionado junto do código que depende
 * dele, em vez de virar um formulário preenchido à mão.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

function lerEnvLocal() {
  const env = { ...process.env };
  try {
    const texto = readFileSync(join(RAIZ, ".env.local"), "utf8");
    for (const linha of texto.split(/\r?\n/)) {
      const limpa = linha.trim();
      if (!limpa || limpa.startsWith("#") || !limpa.includes("=")) continue;
      const corte = limpa.indexOf("=");
      const nome = limpa.slice(0, corte).trim();
      const valor = limpa.slice(corte + 1).trim();
      // O ambiente de verdade vence o arquivo: em CI as variáveis vêm de lá.
      if (valor && !env[nome]) env[nome] = valor;
    }
  } catch {
    // Sem `.env.local` — em CI é o esperado.
  }
  return env;
}

const env = lerEnvLocal();

for (const obrigatoria of [
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "NEXT_PUBLIC_APP_URL",
]) {
  if (!env[obrigatoria]) {
    console.error(`Falta ${obrigatoria}. Veja .env.example.`);
    process.exit(1);
  }
}

const origem = new URL(env.NEXT_PUBLIC_APP_URL).origin;

const REGRAS = [
  {
    AllowedOrigins: [origem],
    // PUT é o upload. GET e HEAD porque o download assinado sai do mesmo
    // bucket, e um `<video>` com `preload` faz `HEAD` antes do `GET`.
    AllowedMethods: ["PUT", "GET", "HEAD"],
    // Só o que a assinatura trava. Um `*` aqui deixaria o navegador mandar
    // qualquer cabeçalho — inclusive um que mudasse o objeto gravado.
    //
    // `if-none-match` é o que faz a URL pré-assinada valer uma vez só (ver
    // `lib/r2/assinatura.ts`). Sem ele na lista, o preflight falha e NENHUM
    // envio acontece — o erro aparece como CORS, sem mencionar o cabeçalho.
    AllowedHeaders: ["content-type", "if-none-match"],
    // O `ETag` é o único que o cliente precisa ler de volta.
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  },
];

const cliente = new S3Client({
  region: "auto",
  endpoint: env.R2_ENDPOINT,
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const negado = (erro) => erro?.name === "AccessDenied" || erro?.Code === "AccessDenied";

console.log(`Bucket: ${env.R2_BUCKET}`);
console.log(`Origem deste ambiente: ${origem}`);
console.log("\nRegra de CORS (cole em R2 > bucket > Settings > CORS policy):");
console.log(JSON.stringify(REGRAS, null, 2));

if (process.argv.includes("--aplicar")) {
  try {
    await cliente.send(
      new PutBucketCorsCommand({
        Bucket: env.R2_BUCKET,
        CORSConfiguration: { CORSRules: REGRAS },
      }),
    );
    console.log(`\nGravado no bucket ${env.R2_BUCKET}.`);
  } catch (erro) {
    if (!negado(erro)) throw erro;
    console.error(
      "\nAccessDenied ao gravar. O token do .env.local tem escopo de OBJETO, e " +
        "CORS e configuracao de BUCKET: use o painel, com o JSON acima.",
    );
    process.exitCode = 1;
  }
}

try {
  const atual = await cliente.send(new GetBucketCorsCommand({ Bucket: env.R2_BUCKET }));
  console.log("\nConfiguracao que esta no bucket agora:");
  console.log(JSON.stringify(atual.CORSRules, null, 2));
} catch (erro) {
  if (erro?.name === "NoSuchCORSConfiguration" || erro?.Code === "NoSuchCORSConfiguration") {
    console.log("\nO bucket ainda nao tem CORS configurado.");
  } else if (negado(erro)) {
    console.log(
      "\nNao da para LER a politica atual com este token (escopo de objeto). " +
        "Confira no painel do R2.",
    );
  } else {
    throw erro;
  }
}
