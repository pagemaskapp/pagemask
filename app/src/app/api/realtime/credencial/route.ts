import { NextResponse } from "next/server";

import { usuarioDaApi } from "@/lib/auth/api";
import { credencialDeRealtime } from "@/lib/realtime/credencial";

/**
 * `GET /api/realtime/credencial` — o token de 5 minutos do Realtime.
 *
 * Só existe para a lista de vídeos do projeto acompanhar o progresso ao vivo.
 * O porquê de emitir um token em vez de reaproveitar a sessão está inteiro em
 * `@/lib/realtime/credencial`.
 *
 * `204` quando o projeto não tem `SUPABASE_JWT_SECRET` configurada. Não é
 * erro: é o modo sem Realtime, e a tela sabe cair na atualização periódica.
 * Responder `500` aqui encheria o console de quem escolheu não usar Realtime.
 *
 * `no-store` não é zelo de performance. Sem ele, um proxy ou o próprio Next
 * poderiam guardar esta resposta — e entregar a credencial de um usuário para
 * o próximo que pedisse.
 */
export async function GET() {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const credencial = credencialDeRealtime(sessao.usuario.id);
  if (!credencial) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store, private" },
    });
  }

  return NextResponse.json(credencial, {
    headers: { "Cache-Control": "no-store, private" },
  });
}
