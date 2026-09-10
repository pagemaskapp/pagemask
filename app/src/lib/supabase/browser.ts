import { createBrowserClient } from "@supabase/ssr";

import { publicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Cliente do navegador. Usa a chave **anon** (JWT legado ou `sb_publishable_…`,
 * conforme o projeto), que e publica por natureza: quem protege o dado e a RLS,
 * nao o segredo da chave. `@/lib/env/public` confere o papel antes de deixar
 * qualquer valor chegar aqui.
 *
 * Este arquivo pode entrar no bundle do cliente. Por isso ele so importa
 * `@/lib/env/public` — nunca `@/lib/env/server`, nunca `@/lib/supabase/admin`.
 */
export function createClient() {
  return createBrowserClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
