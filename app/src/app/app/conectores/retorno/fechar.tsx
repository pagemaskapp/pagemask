"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { CANAL_DO_RETORNO, type AvisoDoRetorno } from "@/lib/ig/canal";

/**
 * Avisa a aba de origem e fecha esta janela.
 *
 * O AVISO VAI ANTES DO FECHAMENTO, E COM UM RESPIRO
 * =================================================
 *
 * `window.close()` derruba o contexto inteiro, inclusive o `BroadcastChannel`
 * que acabou de postar. Postar e fechar na mesma volta do laço de eventos faz a
 * mensagem morrer antes de sair em parte dos navegadores — e o sintoma é o
 * pior possível: funciona na máquina de quem escreveu e não funciona na de
 * quem usa. O `setTimeout` dá a volta que falta.
 *
 * QUANDO O `close()` NÃO FUNCIONA
 * ===============================
 *
 * Só o script que abriu uma janela pode fechá-la. Aqui isso vale — quem abriu
 * foi o `window.open` da tela de conectores. Mas se alguém chegar a esta URL
 * digitando, ou se o navegador recusar, a janela fica. Por isso o botão e o
 * link continuam na tela depois da tentativa: uma janela que não fecha sozinha
 * e não oferece saída nenhuma é um beco.
 */
export function FecharRetorno({ ok }: { ok: boolean }) {
  const [tentouFechar, setTentouFechar] = useState(false);

  useEffect(() => {
    if (typeof BroadcastChannel !== "undefined") {
      const canal = new BroadcastChannel(CANAL_DO_RETORNO);
      const aviso: AvisoDoRetorno = { tipo: "ig:retorno", ok };
      canal.postMessage(aviso);
      // Não fecha o canal aqui: `close()` descarta o que ainda não saiu.
      // Esta janela está de saída de qualquer forma.
    }

    const relogio = window.setTimeout(() => {
      setTentouFechar(true);
      window.close();
    }, 400);

    return () => window.clearTimeout(relogio);
  }, [ok]);

  return (
    <div className="mt-6 flex flex-col items-center gap-3">
      <Button variant="outline" onClick={() => window.close()}>
        Fechar esta janela
      </Button>

      {tentouFechar ? (
        <Link
          href="/app/conectores"
          className="text-muted-foreground text-xs underline"
        >
          Ou volte para os Conectores
        </Link>
      ) : null}
    </div>
  );
}
