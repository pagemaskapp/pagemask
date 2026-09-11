import "server-only";

import { S3Client } from "@aws-sdk/client-s3";

import { requireServerEnv } from "@/lib/env/server";

/**
 * Cliente S3 apontado para o Cloudflare R2.
 *
 * `import "server-only"` na primeira linha: `R2_SECRET_ACCESS_KEY` é segredo
 * (PLANO §3) e o build precisa quebrar se um componente de cliente encostar
 * neste arquivo, direta ou indiretamente.
 *
 * Três detalhes do R2 que não são opcionais:
 *
 * **`region: "auto"`** — o R2 não tem regiões, mas o protocolo S3 exige uma
 * região na assinatura SigV4. `"auto"` é o valor que a Cloudflare documenta;
 * qualquer outro produz assinatura que não confere.
 *
 * **`forcePathStyle: true`** — com o endpoint `<conta>.r2.cloudflarestorage.com`,
 * o bucket vai no CAMINHO (`/bucket/chave`). No estilo virtual, o SDK montaria
 * `bucket.<conta>.r2.cloudflarestorage.com`, um host que não existe no DNS.
 *
 * **`requestChecksumCalculation: "WHEN_REQUIRED"`** — sem isto o SDK acrescenta
 * `x-amz-checksum-crc32` a todo `PutObject` e o inclui nos cabeçalhos
 * assinados. Numa URL pré-assinada isso é fatal: o navegador não manda esse
 * cabeçalho (não tem como calcular o CRC antes de enviar, e `fetch`/XHR não
 * deixariam), a assinatura não bate e todo upload volta 403 — com uma mensagem
 * do S3 sobre checksum que não sugere em nada onde está o problema.
 */
export function createR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: requireServerEnv("R2_ENDPOINT"),
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: requireServerEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireServerEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export function bucketR2(): string {
  return requireServerEnv("R2_BUCKET");
}
