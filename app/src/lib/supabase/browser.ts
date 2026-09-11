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
 *
 * **Este cliente e anonimo, sempre.** O cookie de sessao e `HttpOnly`
 * (`@/lib/supabase/cookie-options`), entao nenhum JavaScript da pagina o le —
 * inclusive este. Serve para o que e publico: ler `plans`, por exemplo. O que
 * depende de quem esta logado vive em server component, server action ou route
 * handler, com `@/lib/supabase/server`.
 */
export function createClient() {
  return createBrowserClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      // "Anonimo sempre" precisa ser imposto, nao so escrito no comentario
      // acima. Sem isto o cliente guarda sessao por padrao, e como a chave do
      // armazenamento e a mesma do servidor (`sb-<ref>-auth-token`), a primeira
      // chamada de auth feita daqui gravaria por cima do cookie `HttpOnly` uma
      // versao legivel por JavaScript — desfazendo, em silencio e sem erro, a
      // protecao inteira descrita em `@/lib/supabase/cookie-options`.
      //
      // `detectSessionInUrl` desligado pela mesma razao: a troca do link de
      // e-mail por sessao acontece no servidor, em `/auth/confirmar`. Um token
      // capturado da URL aqui viraria sessao no navegador, fora do cookie
      // `HttpOnly`.
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
