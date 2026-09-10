import { z } from "zod";

import { isPublicRole, supabaseKeyRole } from "@/lib/supabase/key-role";

/**
 * Variaveis publicas: viajam para o bundle do cliente. Nada aqui pode ser
 * segredo. A contraparte secreta mora em `./server.ts`, que importa
 * `server-only` e por isso quebra o build se alguem a puxar de um componente
 * de cliente.
 *
 * `process.env.NEXT_PUBLIC_*` precisa aparecer escrito por extenso: o Next
 * substitui a expressao literal no bundle, entao indexar dinamicamente
 * (`process.env[nome]`) devolve `undefined` no navegador.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    error: "NEXT_PUBLIC_SUPABASE_URL precisa ser a URL do projeto Supabase.",
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY nao pode ficar vazia.")
    // Aceita a `anon` legada (JWT) e a `sb_publishable_` nova, e barra
    // qualquer chave privilegiada.
    //
    // Validar por prefixo nao bastaria: no formato legado a `anon` e a
    // `service_role` sao as duas `eyJ…`, iguais por fora. Quem separa as duas e
    // o claim `role` do payload — e e por isso que a checagem decodifica o
    // token em vez de olhar o comeco da string.
    //
    // Colar a `service_role` aqui publicaria no bundle de todo navegador uma
    // chave que ignora RLS por completo.
    .refine((value) => isPublicRole(supabaseKeyRole(value)), {
      error:
        "NEXT_PUBLIC_SUPABASE_ANON_KEY precisa ser a chave `anon` (JWT com " +
        "role=anon) ou a `sb_publishable_…`. Chave com privilegio de " +
        "service_role nunca em NEXT_PUBLIC_*: ela ignora a RLS.",
    }),
  NEXT_PUBLIC_APP_URL: z.url({
    error: "NEXT_PUBLIC_APP_URL precisa ser uma URL absoluta.",
  }),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
});

const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
});

if (!parsed.success) {
  const detalhe = parsed.error.issues
    .map((issue) => `  · ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Variaveis de ambiente publicas invalidas.\n${detalhe}\n` +
      "Copie .env.example para app/.env.local e preencha.",
  );
}

export const publicEnv = parsed.data;
