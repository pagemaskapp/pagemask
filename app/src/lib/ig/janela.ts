/**
 * A janela do OAuth — uma só, para a tela inteira.
 *
 * POR QUE ISSO NÃO MORA NO COMPONENTE
 * ===================================
 *
 * A tela de Conectores desenha um botão que abre essa janela no cabeçalho
 * **e** um "Reconectar" em cada conta da lista. Se cada botão guardasse a
 * própria referência num `useRef`, o componente que ouve o retorno não teria
 * como fechar uma janela que outro botão abriu — e a janela ficaria aberta,
 * mostrando "pode fechar esta janela", esperando alguém.
 *
 * Como o `window.open` usa sempre o mesmo NOME de janela, o navegador já trata
 * todos esses botões como donos da mesma janela. Este módulo só faz o lado do
 * JavaScript concordar com isso.
 *
 * Sem `"server-only"` nem `"use client"`: é um módulo de navegador, importado
 * apenas por componentes de cliente. As funções são resguardadas para nunca
 * tocarem em `window` durante o render do servidor.
 */

const NOME_DA_JANELA = "pagemask-instagram";

let aberta: Window | null = null;

/** `false` quando o navegador barrou o pop-up. */
export function abrirJanelaDeConexao(): boolean {
  if (typeof window === "undefined") return false;

  aberta = window.open(
    "/api/ig/iniciar",
    NOME_DA_JANELA,
    "width=600,height=760,noopener=no",
  );

  // `window.open` devolve `null` quando o bloqueador de pop-up entra. Sem
  // conferir isso, o produto simplesmente não faz nada ao clicar em Continuar
  // — sem erro, sem janela, sem explicação. É o pior defeito possível num
  // botão: o que parece que funcionou.
  return aberta !== null;
}

export function fecharJanelaDeConexao(): void {
  try {
    aberta?.close();
  } catch {
    // Sob `Cross-Origin-Opener-Policy`, a referência pode estar cortada e o
    // `close()` ser inócuo ou lançar. A janela se fecha sozinha pela própria
    // página de retorno; aqui é só o atalho.
  }
  aberta = null;
}
