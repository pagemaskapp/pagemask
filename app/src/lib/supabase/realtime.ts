import { createClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * O cliente do Realtime — e **só** do Realtime.
 *
 * POR QUE NÃO DÁ PARA USAR `@/lib/supabase/browser` AQUI
 * =====================================================
 *
 * O cliente comum do navegador é anônimo por construção (a Fase 1 desligou
 * `persistSession` e deixou o cookie `HttpOnly`). A tentação é chamar
 * `supabase.realtime.setAuth(token)` nele e seguir a vida. Isso **funciona por
 * uns 30 segundos** e depois para, em silêncio, sem erro no console e sem
 * nenhuma mensagem chegando.
 *
 * O motivo está dentro do `supabase-js`: ele sempre entrega ao `RealtimeClient`
 * um `accessToken: this._getAccessToken.bind(this)`, e o `realtime-js` trata
 * esse callback como **fonte da verdade** — a cada heartbeat ele pergunta de
 * novo e sobrescreve o que o `setAuth` manual tinha posto. E
 * `_getAccessToken()`, sem sessão no navegador, devolve `this.supabaseKey`, ou
 * seja, a chave `anon`. O resultado: a inscrição volta a ser anônima, a RLS de
 * `jobs` passa a filtrar tudo, e a tela simplesmente deixa de receber eventos.
 *
 * É uma falha que só aparece meio minuto depois de tudo parecer certo — o tipo
 * que passa por qualquer teste curto.
 *
 * A FORMA CERTA é a que este arquivo usa: construir um cliente **com** a opção
 * `accessToken`. Aí o callback passa a ser o nosso, o heartbeat pergunta a nós,
 * e o token curto continua valendo enquanto a página estiver aberta.
 *
 * De brinde, o `supabase-js` desliga o cliente de auth quando recebe
 * `accessToken`: qualquer acesso a `.auth` neste cliente **lança**. Ou seja, a
 * regra "este cliente é só para Realtime" deixa de ser um comentário e passa a
 * ser imposta pela biblioteca.
 */
export function createRealtimeClient(buscarToken: () => Promise<string | null>) {
  return createClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      // Chamado na conexão, a cada heartbeat e em toda reinscrição. Devolver a
      // `anon` quando não há token mantém o socket de pé sem autorizar nada —
      // a RLS filtra, ninguém recebe evento de ninguém.
      //
      // O `try` não é decoração: este callback é chamado pelo `realtime-js` a
      // cada heartbeat, e uma falha de rede na busca do token o rejeitaria em
      // vez de cair no `?? anon`. O resultado seria a conexão seguir com o
      // token VELHO, que expira em 5 minutos — e a partir daí nenhum evento
      // chega, sem erro visível em lugar nenhum.
      accessToken: async () => {
        try {
          return (await buscarToken()) ?? publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        } catch {
          return publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        }
      },
      realtime: {
        // O worker escreve progresso no máximo uma vez por segundo por job, e
        // a tela mostra poucos jobs de cada vez. Este teto existe para o caso
        // patológico: um lote grande terminando de uma vez não vira uma
        // avalanche de re-renderizações.
        params: { eventsPerSecond: 5 },
      },
    },
  );
}
