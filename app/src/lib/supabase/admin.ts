import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env/public";
import { requireServerEnv } from "@/lib/env/server";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Cliente com a chave **service_role** (JWT legado ou `sb_secret_…`, conforme o
 * projeto). **Ignora a RLS**: toda consulta feita por aqui precisa filtrar o
 * dono na mao.
 *
 * Use so onde nao existe sessao de usuario e a operacao e do sistema:
 *   · webhook da Stripe e callback da Meta
 *   · rotas de cron protegidas por CRON_SECRET
 *   · o servico de fila do worker
 *
 * `import "server-only"` (aqui e em `@/lib/env/server`) faz o build falhar se
 * um componente de cliente importar este arquivo. O passo de grep do CI em
 * `.next/static` e a segunda rede de seguranca.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    requireServerEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
