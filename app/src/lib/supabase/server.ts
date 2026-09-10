import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { publicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Cliente de servidor **com a sessao do usuario**, lida dos cookies. Usa a
 * chave publishable de proposito: as consultas continuam passando pela RLS, com
 * `auth.uid()` valendo o dono da sessao. E este o cliente de server component,
 * server action e route handler comum.
 *
 * Nunca reaproveitar entre requisicoes: um cliente por render.
 * Para o que precisa furar a RLS (webhook, worker, cron), use
 * `@/lib/supabase/admin` — e so ali.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server component nao pode escrever cookie. O refresh de sessao
            // acontece no `proxy.ts`, que escreve na resposta — entao ignorar
            // aqui e o comportamento correto, nao um erro engolido.
          }
        },
      },
    },
  );
}
