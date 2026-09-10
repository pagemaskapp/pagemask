# PageMask

SaaS de edição de vídeo em lote para páginas temáticas do Instagram. Uma pasta de
vídeos entra, um padrão visual é definido uma vez, e o lote inteiro sai editado,
verificado e publicado nas contas conectadas.

O plano de execução é [`docs/PLANO.md`](docs/PLANO.md). As regras de trabalho estão
em [`CLAUDE.md`](CLAUDE.md). **Fase atual: 0 — fundação.** Autenticação, upload e
worker ainda não existem.

---

## O que já existe

```
app/                      Next.js 16 (App Router, TypeScript, Tailwind 4, shadcn/ui)
  src/app/                rotas
  src/lib/env/            variáveis validadas com zod — public.ts e server.ts
  src/lib/supabase/       clientes browser · server · admin · key-role
  scripts/                scan-bundle-secrets.mjs
  src/lib/security-headers.ts
  src/proxy.ts            nonce da CSP por requisição
supabase/migrations/      0001_init.sql (schema + RLS) · 0002_seed_plans.sql
.github/workflows/ci.yml  lint, tipos, audit, gitleaks, varredura do bundle
.githooks/pre-commit      gitleaks antes do commit
```

Ainda não existem: `worker/`, `docs/RUNBOOK.md`, `docs/DADOS.md`, `docs/PRODUCAO.md`.

---

## Pré-requisitos

| Ferramenta | Versão | Para quê |
| --- | --- | --- |
| Node.js | 24 LTS | rodar o app |
| npm | 11+ | vem com o Node |
| gitleaks | qualquer | hook de pre-commit (`winget install gitleaks`) |
| psql | 14+ | aplicar as migrations |

Contas necessárias antes de preencher o `.env.local`: **Supabase** (projeto criado),
**Cloudflare R2** (bucket privado + token restrito ao bucket), **Stripe**, **Sentry**
e um app no **Meta for Developers** com Instagram Login. A Fase 0 só precisa do
Supabase; o resto pode ficar em branco por enquanto.

---

## Rodar local

```bash
git clone <repo> pagemask
cd pagemask

# 1. hook de segredo (uma vez por clone)
git config core.hooksPath .githooks

# 2. dependências
cd app
npm ci

# 3. ambiente
cp ../.env.example .env.local
#    preencha ao menos:
#      NEXT_PUBLIC_SUPABASE_URL
#      NEXT_PUBLIC_SUPABASE_ANON_KEY
#      NEXT_PUBLIC_APP_URL=http://localhost:3000

# 4. app
npm run dev            # http://localhost:3000
```

O `.env.local` mora em `app/`, não na raiz: é o Next que lê o arquivo.
Preenchimento errado quebra no boot com uma mensagem em português dizendo qual
variável está faltando — nunca com um `undefined` silencioso.

### As chaves do Supabase

O projeto ainda usa as chaves **legadas** (formato JWT, `eyJ…`), que ficam em
`Project Settings > API > Project API keys`. O Supabase as descontinua no fim de
2026 e as substitui por `sb_publishable_` / `sb_secret_`; quando aparecerem no
painel, é só trocar o valor das duas linhas — o app aceita os dois formatos.

A armadilha do formato legado: a `anon` e a `service_role` são **as duas `eyJ…`**,
idênticas por fora. Só o claim `role` dentro do token separa uma da outra, e a
`service_role` **ignora a RLS por completo**. Trocá-las de lugar publicaria no
navegador de todo visitante uma chave com acesso irrestrito ao banco.

Por isso a validação não olha prefixo, decodifica o `role`
([`key-role.ts`](app/src/lib/supabase/key-role.ts)):

| Variável | Aceita | Recusa |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `role=anon`, `sb_publishable_…` | `role=service_role`, `sb_secret_…` |
| `SUPABASE_SERVICE_ROLE_KEY` | `role=service_role`, `sb_secret_…` | `role=anon`, `sb_publishable_…` |

A recusa do lado do servidor importa tanto quanto a do cliente: a `anon` colada
ali não daria erro nenhum, o cliente admin subiria normal e toda consulta dele
passaria a respeitar RLS sem `auth.uid()`, devolvendo zero linha em vez de falhar.

### Aplicar as migrations

Da raiz do repositório, na ordem numérica:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0002_seed_plans.sql
```

`SUPABASE_DB_URL` é a connection string de **Project Settings > Database**.
`0002` é idempotente: pode rodar de novo sem duplicar plano.

O `supabase db push` do CLI **não** funciona neste repositório: ele exige um
`supabase/config.toml` (que só existe depois de `supabase init`) e nomes de
arquivo no formato de timestamp dele — e os nossos são `0001`, `0002`. Adotar o
CLI é uma decisão a tomar de propósito, renomeando as migrations, não algo para
descobrir no meio de um deploy.

**Nunca altere o schema pelo painel do Supabase.** Toda mudança nasce como arquivo
em `supabase/migrations/`, senão o banco de produção e o repositório divergem sem
ninguém perceber.

Conferência depois de aplicar:

```sql
-- 3 linhas: partida, ritmo, escala
select slug, name, price_cents from public.plans order by sort_order;

-- precisa vir vazio: RLS ligada em todas as tabelas
select tablename from pg_tables
where schemaname = 'public' and rowsecurity = false;
```

---

## Comandos

| Comando (dentro de `app/`) | O que faz |
| --- | --- |
| `npm run dev` | servidor de desenvolvimento |
| `npm run build` | build de produção |
| `npm run start` | serve o build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run scan:bundle` | procura segredo em `.next/static` (roda depois do build) |

---

## Como a segurança está montada

Detalhe completo em `docs/PLANO.md`, seção "Segurança e LGPD". O que já está no
código:

- **Chave privilegiada nunca no cliente.** `src/lib/env/server.ts` e
  `src/lib/supabase/admin.ts` importam `server-only`: o build falha se um
  componente de cliente os puxar, direta ou indiretamente. Depois do build, o CI
  roda `npm run scan:bundle` sobre `.next/static`.
- **Três clientes Supabase, um propósito cada.** `browser.ts` e `server.ts` usam a
  chave `anon` e passam pela RLS com `auth.uid()` valendo o dono da sessão.
  `admin.ts` usa a `service_role`, ignora RLS, e só entra em webhook, cron e worker.
- **RLS em todas as tabelas**, uma política por comando. `plans` é a única de
  leitura pública. `webhook_events` tem RLS ligada e zero políticas — negado por
  construção. O token do Instagram é protegido por `GRANT` de coluna, não só por
  RLS. Atenção para a Fase 4: com privilégio por coluna, `select *` em
  `ig_accounts` **falha** com `permission denied` em vez de devolver menos
  colunas — toda consulta pelo cliente precisa listar as colunas, e a lista é o
  tipo `IgAccountPublic`.
- **CSP com nonce por requisição.** `src/proxy.ts` gera o nonce e o Next o aplica em
  todo script que emite. Não há `'unsafe-inline'` em `script-src`. Por isso as
  páginas renderizam sob demanda (`connection()` no layout raiz): nonce precisa de
  requisição, e página pré-renderizada não tem uma.
- **HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options, COOP e
  CORP** em `next.config.ts`, com os valores em `src/lib/security-headers.ts`.

Conferir os cabeçalhos com o servidor de produção rodando:

```bash
npm run build && npm run start
curl -sI http://localhost:3000/ | grep -iE 'content-security|strict-transport|x-content-type|referrer|permissions'
```

---

## CI

`.github/workflows/ci.yml` roda em todo push e PR: `npm run lint`,
`npm run typecheck`, `npm audit --audit-level=high`, `npm run build`,
`npm run scan:bundle` e o `gitleaks` sobre o histórico completo.

---

## Próxima fase

Fase 1 — conta e sessão (Supabase Auth, RLS, rate limit de login).
O prompt está em `docs/PLANO.md`.
