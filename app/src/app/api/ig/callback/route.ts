import { NextResponse, type NextRequest } from "next/server";

import { publicEnv } from "@/lib/env/public";
import {
  buscarPerfil,
  ESCOPOS,
  trocarCodePorTokenCurto,
  trocarPorTokenLongo,
} from "@/lib/ig/api";
import { cifrar } from "@/lib/ig/cripto";
import { lerEstado, VALIDADE_EM_MINUTOS } from "@/lib/ig/estado";
import {
  ehProfissional,
  motivoDoErroDaMeta,
  type MotivoDaFalha,
} from "@/lib/ig/mensagens";
import { codigoDoErro } from "@/lib/plano/erros";
import { usuarioAtual } from "@/lib/auth/sessao";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * `GET /api/ig/callback` — a volta do Business Login.
 *
 * DUAS FAMÍLIAS DE DESFECHO, E ELAS NÃO SE PARECEM
 * ================================================
 *
 * **400, com uma página simples.** Quando o `state` não confere: forjado,
 * vencido, de outro usuário, ou já usado. Isso não é um usuário com problema —
 * é alguém tentando fazer a vítima conectar uma conta alheia (*login CSRF*),
 * ou o mesmo callback chegando duas vezes. Não há "tente de novo" a oferecer, e
 * o status precisa dizer o que é: o cross-check da fase confere exatamente este
 * 400.
 *
 * **303 para `/app/conectores/retorno?r=…`.** Todo o resto — o usuário negou, a
 * conta não é Profissional, o plano está cheio, a Meta recusou. São situações
 * legítimas com um recado em pt-BR e uma ação possível, e a página de retorno é
 * quem os mostra e fecha o popup.
 *
 * A ORDEM DAS CONFERÊNCIAS É A SEGURANÇA
 * ======================================
 *
 * Assinatura, depois sessão, depois nonce, e só então a Meta. Cada etapa é mais
 * cara que a anterior, e nenhuma chamada externa acontece antes de estar
 * provado que este callback pertence a este usuário. Inverter a ordem
 * transformaria a rota num jeito de qualquer um gastar a cota de OAuth do app.
 */
export async function GET(requisicao: NextRequest) {
  const parametros = requisicao.nextUrl.searchParams;

  // ---------------------------------------------------------------------
  // 1. O usuário negou, ou a Meta abortou antes de emitir o `code`
  // ---------------------------------------------------------------------
  const erroDaMeta = parametros.get("error");
  if (erroDaMeta) {
    console.warn("[ig] autorização não concluída", {
      erro: erroDaMeta,
      razao: parametros.get("error_reason"),
    });
    const negou =
      parametros.get("error_reason") === "user_denied" ||
      erroDaMeta === "access_denied";
    return paraRetorno(negou ? "negado" : "meta");
  }

  // ---------------------------------------------------------------------
  // 2. O `state` — assinatura e prazo, sem tocar no banco
  // ---------------------------------------------------------------------
  const estado = lerEstado(parametros.get("state"));
  if (!estado) {
    console.warn("[ig] callback com state inválido ou vencido");
    return pagina400();
  }

  const code = parametros.get("code");
  if (!code) {
    console.warn("[ig] callback sem `code`");
    return pagina400();
  }

  // ---------------------------------------------------------------------
  // 3. A sessão precisa ser a MESMA que começou o fluxo
  // ---------------------------------------------------------------------
  // A assinatura já prova que o `state` saiu daqui. Esta conferência prova a
  // outra metade: que quem voltou é quem saiu. Sem ela, um `state` legítimo
  // capturado do usuário A serviria para gravar uma conta na sessão de B.
  const usuario = await usuarioAtual().catch(() => null);
  if (!usuario) return paraRetorno("sem-sessao");
  if (usuario.id !== estado.userId) {
    console.warn("[ig] callback com state de outro usuário");
    return pagina400();
  }

  // ---------------------------------------------------------------------
  // 4. O nonce, de uso único
  // ---------------------------------------------------------------------
  const supabase = createAdminClient();
  const { data: valeu, error: erroDoEstado } = await supabase.rpc(
    "consume_ig_state",
    {
      p_nonce: estado.nonce,
      p_user_id: usuario.id,
      p_minutos: VALIDADE_EM_MINUTOS,
    },
  );

  if (erroDoEstado) {
    console.error("[ig] falha ao consumir o state", {
      codigo: erroDoEstado.code,
      mensagem: erroDoEstado.message,
    });
    return paraRetorno("interno");
  }
  if (valeu !== true) {
    // Segunda chegada do mesmo callback: recarregar a página de retorno, um
    // clique duplo, ou um reenvio. Nada foi gravado na primeira nem aqui.
    console.warn("[ig] state já usado ou vencido");
    return pagina400();
  }

  // ---------------------------------------------------------------------
  // 5. Daqui para baixo, a Meta
  // ---------------------------------------------------------------------
  try {
    const curto = await trocarCodePorTokenCurto(code);
    const longo = await trocarPorTokenLongo(curto.accessToken);
    const perfil = await buscarPerfil(longo.accessToken);

    if (!ehProfissional(perfil.tipoDeConta)) {
      console.warn("[ig] conta não profissional recusada", {
        tipo: perfil.tipoDeConta,
      });
      return paraRetorno("nao-profissional");
    }

    const cifrado = cifrar(longo.accessToken, perfil.igUserId);

    const { data: conta, error } = await supabase.rpc("connect_ig_account", {
      p_user_id: usuario.id,
      p_ig_user_id: perfil.igUserId,
      p_username: perfil.username,
      p_picture: perfil.fotoUrl,
      // O que a Meta CONCEDEU, não o que pedimos: o usuário pode desmarcar uma
      // permissão na tela de autorização, e gravar o pedido no lugar da
      // concessão faria a Fase 5 tentar publicar com um escopo que não tem.
      p_scopes: curto.permissoes.length > 0 ? curto.permissoes : [...ESCOPOS],
      p_cipher_hex: cifrado.cipherHex,
      p_iv_hex: cifrado.ivHex,
      p_tag_hex: cifrado.tagHex,
      p_expires_at: longo.expiraEm.toISOString(),
      p_key_version: cifrado.keyVersion,
    });

    if (error) {
      if (codigoDoErro(error) === "PM018") return paraRetorno("limite");
      console.error("[ig] falha ao gravar a conta", {
        codigo: error.code,
        mensagem: error.message,
      });
      return paraRetorno("interno");
    }

    await registrar(supabase, {
      userId: usuario.id,
      acao: "ig.connect",
      alvo: conta?.id ?? null,
      meta: {
        username: perfil.username,
        ig_user_id: perfil.igUserId,
        scopes: curto.permissoes,
        account_type: perfil.tipoDeConta,
      },
      ip: ipDaRequisicao(requisicao),
    });

    return paraRetorno(null);
  } catch (erro) {
    // A mensagem da Meta vai para o log; para a tela vai um código. O token
    // nunca aparece em nenhum dos dois: `lib/ig/api.ts` o remove antes.
    console.error("[ig] a troca com a Meta falhou", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return paraRetorno(motivoDoErroDaMeta(erro));
  }
}

/** `null` = deu certo. Qualquer outro valor é um dos motivos fechados. */
function paraRetorno(motivo: MotivoDaFalha | null): NextResponse {
  const url = new URL("/app/conectores/retorno", publicEnv.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("r", motivo ? "erro" : "ok");
  if (motivo) url.searchParams.set("motivo", motivo);

  return NextResponse.redirect(url, {
    status: 303,
    headers: { "Cache-Control": "no-store, private" },
  });
}

/**
 * O 400 do `state` inválido.
 *
 * HTML fixo, sem nenhum script e sem nada vindo da requisição — uma resposta de
 * route handler não recebe o nonce da CSP, então script inline aqui seria
 * bloqueado pelo navegador, e refletir qualquer parâmetro seria dar a palavra a
 * quem montou a URL.
 */
function pagina400(): NextResponse {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pedido de conexão inválido</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 2.5rem 1.5rem; color: #0f172a; background: #f0fdf4;">
<main style="max-width: 34rem; margin: 0 auto;">
<h1 style="font-size: 1.25rem; margin: 0 0 .75rem;">Este pedido de conexão não vale mais</h1>
<p style="margin: 0 0 .75rem; line-height: 1.6;">
Por segurança, cada pedido para conectar uma conta do Instagram vale por
${VALIDADE_EM_MINUTOS} minutos e só pode ser usado uma vez. Este já foi usado ou passou do prazo.
</p>
<p style="margin: 0; line-height: 1.6;">
Feche esta janela e clique em <strong>Conectar Instagram</strong> outra vez. Nenhuma conta foi alterada.
</p>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
}

/**
 * `audit_log` (PLANO §7: conectar/desconectar conta entram aqui).
 *
 * Falha de auditoria **não derruba a conexão**: a conta já está gravada e
 * funcionando, e desfazer isso por causa de um insert de log seria trocar um
 * problema pequeno por um grande. Mas ela também não some — vai para o log do
 * servidor, que é onde alguém percebe que a auditoria parou.
 */
async function registrar(
  supabase: ReturnType<typeof createAdminClient>,
  entrada: {
    userId: string;
    acao: string;
    alvo: string | null;
    meta: Json;
    ip: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("audit_log").insert({
    user_id: entrada.userId,
    actor: "user",
    action: entrada.acao,
    target: entrada.alvo,
    meta: entrada.meta,
    ip: entrada.ip,
  });

  if (error) {
    console.error("[ig] auditoria não registrada", {
      acao: entrada.acao,
      codigo: error.code,
      mensagem: error.message,
    });
  }
}

/**
 * O IP de quem chamou, para a auditoria.
 *
 * `x-forwarded-for` é uma lista e o primeiro item é o cliente — mas só quando
 * quem escreve o cabeçalho é o nosso proxy. Em produção (Vercel) é. Rodando
 * localmente o cabeçalho não existe e o campo fica nulo, que é melhor que
 * gravar um valor que o próprio cliente escolheu.
 */
function ipDaRequisicao(requisicao: NextRequest): string | null {
  const encaminhado = requisicao.headers.get("x-forwarded-for");
  if (!encaminhado) return null;
  const primeiro = encaminhado.split(",")[0]?.trim();
  return primeiro && primeiro.length > 0 ? primeiro : null;
}
