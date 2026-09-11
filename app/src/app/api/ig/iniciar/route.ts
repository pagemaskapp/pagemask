import { NextResponse } from "next/server";

import { usuarioDaApi } from "@/lib/auth/api";
import { publicEnv } from "@/lib/env/public";
import { urlDeAutorizacao } from "@/lib/ig/api";
import { montarEstado, novoNonce } from "@/lib/ig/estado";
import { limiteDeConexao } from "@/lib/ig/limite-de-taxa";
import type { MotivoDaFalha } from "@/lib/ig/mensagens";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `GET /api/ig/iniciar` — abre o fluxo e manda o popup para o Instagram.
 *
 * POR QUE UMA ROTA, E NÃO UM `window.open(url)` NO CLIENTE
 * =======================================================
 *
 * A URL de autorização precisa do `state` assinado, e assinar é do servidor.
 * Se o cliente tivesse que buscá-la antes de abrir a janela, o `window.open`
 * aconteceria DEPOIS de um `await` — e aí o navegador não o trata mais como
 * resposta direta ao clique e o bloqueador de pop-up o barra. É um bug que só
 * aparece em parte dos navegadores e em parte das vezes.
 *
 * Abrindo a janela direto nesta rota, o `window.open` é síncrono com o clique,
 * o `state` nasce no servidor e o `IG_APP_ID` nunca precisa chegar ao cliente.
 *
 * O redirect é **303**: a janela deve BUSCAR o Instagram com GET, e não repetir
 * nada. E `no-store` porque a resposta carrega um `state` de uso único — um
 * cache que a guardasse serviria o mesmo `state` a duas pessoas, e a segunda
 * cairia num nonce já queimado.
 */
export async function GET() {
  const sessao = await usuarioDaApi();
  if ("resposta" in sessao) return sessao.resposta;

  const usuario = sessao.usuario;

  // Conectar conta está na lista de rotas com limite de taxa do PLANO §6. Sem
  // ele, um laço de cliques enche `ig_oauth_states` e bate no limite da própria
  // Meta, que responde barrando o app inteiro — não só aquele usuário.
  const limite = await limiteDeConexao(usuario.id);
  if (!limite.permitido) {
    // Para a PÁGINA DE RETORNO, não para `/app/conectores`.
    //
    // Esta rota só é carregada dentro do pop-up. Mandá-la para a tela de
    // conectores desenharia o app inteiro — barra lateral e tudo — numa janela
    // de 600x760 que não se fecha e não avisa a aba de origem. A página de
    // retorno é a única feita para caber ali: ela mostra o recado e fecha.
    return paraRetorno("limite-de-taxa");
  }

  let destino: string;
  try {
    const nonce = novoNonce();

    // O nonce é gravado ANTES de o usuário sair daqui. Gravar depois, no
    // callback, não serviria para nada: o ponto é que o callback reconheça um
    // fluxo que este servidor começou.
    const supabase = createAdminClient();
    const { error } = await supabase.rpc("start_ig_connect", {
      p_user_id: usuario.id,
      p_nonce: nonce,
    });
    if (error) throw error;

    destino = urlDeAutorizacao(montarEstado(usuario.id, nonce));
  } catch (erro) {
    // Falta de `IG_APP_ID`/`IG_APP_SECRET`/`IG_REDIRECT_URI` cai aqui. O
    // usuário não tem o que fazer com isso, então a tela recebe um código e o
    // motivo real fica no log.
    console.error("[ig] não foi possível iniciar a conexão", {
      mensagem: erro instanceof Error ? erro.message : String(erro),
    });
    return paraRetorno("config");
  }

  return NextResponse.redirect(destino, {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Manda o pop-up para a tela de retorno com um motivo da lista fechada. */
function paraRetorno(motivo: MotivoDaFalha): NextResponse {
  const url = new URL("/app/conectores/retorno", requisicaoBase());
  url.searchParams.set("r", "erro");
  url.searchParams.set("motivo", motivo);
  return NextResponse.redirect(url, {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * A origem do próprio app, para montar destinos absolutos.
 *
 * `NEXT_PUBLIC_APP_URL` e não o `Host` da requisição: o cabeçalho vem do
 * cliente e um `Host` forjado transformaria estes redirects em *open redirect*
 * — um link do nosso domínio que leva a pessoa para outro site.
 */
function requisicaoBase(): string {
  return publicEnv.NEXT_PUBLIC_APP_URL;
}
