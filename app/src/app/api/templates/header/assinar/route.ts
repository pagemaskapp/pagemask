import { z } from "zod";

import { corpoJson, erroJson, okJson, usuarioDaApi } from "@/lib/auth/api";
import { assinarEnvio } from "@/lib/r2/assinatura";
import { montarChaveDeAsset } from "@/lib/r2/chaves";
import { esperaEmTexto } from "@/lib/uploads/limite-de-taxa";
import { HEADERS_POR_HORA, limiteDeHeader } from "@/lib/template/limite-de-taxa";

/**
 * `POST /api/templates/header/assinar` — autorização de PUT para uma imagem.
 *
 * Mesmo desenho do upload de vídeo (Fase 2), e pela mesma razão: o arquivo vai
 * do navegador direto para o R2, e esta rota só entrega a autorização. O que
 * decide a chave continua sendo do servidor — `user_id` da sessão, UUID
 * sorteado aqui, extensão vinda do tipo declarado.
 *
 * O TIPO DECLARADO PELO CLIENTE VALE PARA UMA COISA SÓ: escolher qual das duas
 * assinaturas pedir ao R2. Ele não é prova de nada, e a conferência de verdade
 * — os bytes do arquivo — acontece na confirmação, depois de o objeto existir.
 * Aqui ele serve porque a assinatura precisa travar um `Content-Type`, e
 * travar é o que faz o R2 recusar um PUT que chegue com outro.
 */

const MAXIMO_BYTES = 5 * 1024 * 1024;

const Pedido = z.object({
  tipo: z.enum(["image/png", "image/jpeg"]),
  bytes: z.number().int().positive(),
});

export async function POST(requisicao: Request) {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  const bruto = await corpoJson(requisicao);
  if (bruto === null) return erroJson(415, "Requisição inválida.");

  const pedido = Pedido.safeParse(bruto);
  if (!pedido.success) {
    return erroJson(400, "Envie uma imagem PNG ou JPG.");
  }

  if (pedido.data.bytes > MAXIMO_BYTES) {
    return erroJson(
      413,
      `A imagem de cabeçalho pode ter até ${MAXIMO_BYTES / (1024 * 1024)} MB. ` +
        "Exporte-a menor e envie de novo.",
    );
  }

  const limite = await limiteDeHeader(usuario.id, "assinar");
  if (!limite.permitido) {
    return erroJson(
      429,
      `Você enviou mais de ${HEADERS_POR_HORA} imagens nesta hora. ` +
        `Tente de novo em ${esperaEmTexto(limite.liberadoEm)}.`,
    );
  }

  const extensao = pedido.data.tipo === "image/png" ? "png" : "jpg";
  const chave = montarChaveDeAsset(usuario.id, extensao);

  const envio = await assinarEnvio({
    chave,
    tipo: pedido.data.tipo,
    bytes: pedido.data.bytes,
  });

  return okJson({ chave, ...envio });
}
