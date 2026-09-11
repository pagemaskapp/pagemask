"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { CANAL_DO_RETORNO, type AvisoDoRetorno } from "@/lib/ig/canal";
import { fecharJanelaDeConexao } from "@/lib/ig/janela";

/**
 * Fica sabendo que a janela do OAuth terminou e recarrega a lista.
 *
 * MONTADO UMA VEZ POR PÁGINA, E ISSO É O PONTO
 * ============================================
 *
 * Estes dois ouvintes já moraram dentro do botão de conectar. Como a tela
 * desenha um botão no cabeçalho e mais um por conta, cada volta de foco
 * disparava um `router.refresh()` para CADA instância — quatro re-renderizações
 * do servidor por clique numa aba, com três contas na lista. Um componente
 * sem aparência, montado uma vez pela página, resolve isso pela estrutura.
 *
 * COMO A NOTÍCIA CHEGA
 * ====================
 *
 * Não por `window.opener.postMessage`. O app manda
 * `Cross-Origin-Opener-Policy: same-origin` em toda resposta (Fase 1), e essa
 * política corta o laço entre quem abriu e a janela aberta assim que ela navega
 * para outra origem — `opener` vira `null` e não volta. `popup.closed`, pelo
 * mesmo motivo, também não é confiável.
 *
 * O que atravessa é `BroadcastChannel`: ele é por ORIGEM, não por relação entre
 * janelas, e a página de retorno é do nosso domínio.
 */
export function OuvirRetorno() {
  const router = useRouter();

  useEffect(() => {
    // `BroadcastChannel` não existe em alguns navegadores antigos. Sem ele, o
    // caminho de foco abaixo continua funcionando — só demora o tempo de a
    // pessoa voltar para a aba.
    if (typeof BroadcastChannel === "undefined") return;

    const canal = new BroadcastChannel(CANAL_DO_RETORNO);
    canal.onmessage = (evento: MessageEvent<AvisoDoRetorno>) => {
      if (evento.data?.tipo !== "ig:retorno") return;
      fecharJanelaDeConexao();
      router.refresh();
    };

    return () => canal.close();
  }, [router]);

  useEffect(() => {
    // Quem fecha a janela na mão não gera aviso nenhum. Este é o caminho que
    // cobre isso — e também o caso de o `BroadcastChannel` não existir.
    const aoVoltar = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => document.removeEventListener("visibilitychange", aoVoltar);
  }, [router]);

  return null;
}
