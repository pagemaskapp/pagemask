import { NextResponse } from "next/server";

import { registrarAuditoria } from "@/lib/auditoria";
import { erroJson, usuarioDaApi } from "@/lib/auth/api";
import {
  esperaEmTexto,
} from "@/lib/uploads/limite-de-taxa";
import { limiteDeExportacao } from "@/lib/conta/limite-de-taxa";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `GET /api/conta/exportar` — o direito de acesso e portabilidade (PLANO §8).
 *
 * Devolve um JSON com tudo que o banco guarda sobre o titular e força o
 * download. Rota, e não server action, porque action responde dados
 * serializados para o React — não um arquivo com nome.
 *
 * **`GET` que faz download, mas não muda estado**: o único efeito colateral é
 * uma linha em `audit_log`, que é registro de acesso a dado pessoal e existe
 * justamente para ficar. Como não altera nada do titular, o `SameSite=Lax` do
 * cookie basta: um `GET` de terceiro não carrega o cookie de sessão, e mesmo
 * que carregasse, a resposta é um arquivo que o site de origem não consegue
 * ler (sem CORS) — só baixar para a própria máquina do titular.
 *
 * O QUE **NÃO** VAI NO ARQUIVO
 * ============================
 *
 * Os vídeos. Um export com os arquivos seria dezenas de gigabytes gerados
 * dentro de uma função com segundos de vida. Eles ficam disponíveis pelo ZIP do
 * lote (Fase 7) enquanto a conta existe, e o JSON traz a chave de cada um — a
 * portabilidade do dado, que é o que a lei pede, sem transformar a rota num
 * empacotador de mídia.
 *
 * E os tokens do Instagram. `export_account_data` os remove no banco (ver a
 * migration 0024): são credencial, não dado pessoal, e não têm o que fazer num
 * arquivo que vai para a pasta de downloads.
 */
export async function GET() {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;
  const { usuario } = sessao;

  const limite = await limiteDeExportacao(usuario.id);
  if (!limite.permitido) {
    return erroJson(
      429,
      "Você pediu exportações demais nesta hora. Espere " +
        `${esperaEmTexto(limite.liberadoEm)} e tente de novo.`,
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("export_account_data", {
    p_user_id: usuario.id,
  });

  if (error || data === null) {
    console.error("[conta/exportar] consulta falhou", {
      codigo: error?.code,
      mensagem: error?.message,
    });
    return erroJson(
      500,
      "Não conseguimos montar sua exportação agora. Tente de novo em instantes.",
    );
  }

  // O e-mail e a data de criação do login moram em `auth.users`, fora do schema
  // `public` — a função do banco não os enxerga, e um export "com tudo" que
  // omite o e-mail do titular seria um documento estranho. Vêm da sessão já
  // validada, que é a fonte certa para eles.
  const completo = {
    ...(typeof data === "object" && data !== null ? data : {}),
    login: {
      email: usuario.email ?? null,
      email_confirmado_em: usuario.email_confirmed_at ?? null,
      criado_em: usuario.created_at,
      ultimo_acesso_em: usuario.last_sign_in_at ?? null,
    },
  };

  await registrarAuditoria({
    userId: usuario.id,
    actor: "user",
    action: "account.exported",
    target: null,
  });

  const dia = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(completo, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // O nome do arquivo é montado só com data — nada que venha do usuário
      // entra num cabeçalho HTTP.
      "Content-Disposition": `attachment; filename="pagemask-meus-dados-${dia}.json"`,
      "Cache-Control": "no-store",
      // Um JSON com dado pessoal não pode ser interpretado como outra coisa por
      // um navegador criativo.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
