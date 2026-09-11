# PageMask

SaaS de edição de vídeo em lote para páginas temáticas do Instagram. Uma pasta de
vídeos entra, um padrão visual é definido uma vez, e o lote inteiro sai editado,
verificado e publicado nas contas conectadas.

O plano de execução é [`docs/PLANO.md`](docs/PLANO.md). As regras de trabalho estão
em [`CLAUDE.md`](CLAUDE.md). **Fase atual: 2 — projetos e upload para o R2.**
O worker ainda não existe: o vídeo enviado fica em `uploaded` e espera a Fase 3.

---

## O que já existe

```
app/                      Next.js 16 (App Router, TypeScript, Tailwind 4, shadcn/ui)
  src/app/(auth)/         entrar, cadastrar, confirmação de e-mail
  src/app/app/            área autenticada (projetos, templates, conectores, agenda, conta)
  src/app/auth/confirmar/ troca do link de e-mail por sessão
  src/app/api/uploads/    assinar (URL pré-assinada PUT) · confirmar (sonda e registra)
  src/app/api/videos/     [id]/baixar — redirect assinado para o vídeo pronto
  src/lib/auth/           sessão, rate limit, mensagens de erro em pt-BR, api.ts
  src/lib/env/            variáveis validadas com zod — public.ts e server.ts
  src/lib/supabase/       clientes browser · server · admin · key-role · cookie-options
  src/lib/r2/             cliente · chaves · assinatura · objetos
  src/lib/video/          codecs (lista fechada) · sonda · veredito · leitor
  src/lib/plano/          limites do plano e códigos de erro do banco
  src/lib/rate-limit/     balde compartilhado pelo limite de auth e de upload
  scripts/                scan-bundle-secrets.mjs · r2-cors.mjs
  src/lib/security-headers.ts
  src/proxy.ts            CSP com nonce · refresh de sessão · proteção de /app/*
supabase/migrations/      0001_init.sql (schema + RLS) · 0002_seed_plans.sql
                          0003_auth_rate_limit.sql · 0004_grants.sql
                          0005_auth_rate_limit_expurgo.sql
                          0006_job_status_uploaded.sql · 0007_fase2_upload.sql
                          0008_funcoes_so_do_servidor.sql
                          0009_projects_e_idempotencia.sql
                          0010_projects_update_por_coluna.sql
                          0011_idempotencia_depois_da_trava.sql
                          0012_ordem_das_travas.sql
                          0013_discard_project_apaga_antes.sql
                          0014_confirmacao_nunca_devolve_nulo.sql
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

### Configurar o Supabase Auth (painel)

Três coisas que o código **não** consegue impor sozinho. Sem elas a Fase 1 fica
funcionando pela metade, e de um jeito que não dá erro — só fica menos segura.

| Onde | O quê | Por quê |
| --- | --- | --- |
| Authentication > Sign In / Providers > Email | **Confirm email** ligado | Sem isso `signUp` já devolve sessão e qualquer um cria conta com e-mail alheio. O código detecta e segue, mas contraria o PLANO §1. |
| Authentication > Sign In / Providers > Email | **Minimum password length: 10** | O app já valida no servidor. Ligar no painel fecha o caminho de quem chamar a API do Supabase direto. |
| Authentication > URL Configuration | **Site URL** e, em **Redirect URLs**, `http://localhost:3000/auth/confirmar**` e a URL de produção com o mesmo `**` no fim | O link do e-mail só volta para uma URL cadastrada. O `**` não é enfeite: os links saem com `?proximo=…`, a comparação do Supabase é glob sobre a URL inteira, e `*` só casa até o próximo `.` ou `/`. **Medido:** com o endereço fora da lista, o Supabase descarta o destino sem erro nenhum e joga o usuário na Site URL — onde não há rota que troque o código por sessão, e a confirmação simplesmente não acontece. |

Os templates de e-mail (Authentication > Emails) também valem uma passada: os
padrões estão em inglês, e a interface do PageMask é toda em pt-BR.

### Aplicar as migrations

Da raiz do repositório, na ordem numérica:

```bash
for m in supabase/migrations/*.sql; do
  echo "→ $m"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$m" || { echo "PAROU em $m"; break; }
done
```

O `break` não é zelo: `ON_ERROR_STOP=1` interrompe **aquele** `psql`, não o laço.
Sem ele, uma `0001` que falha no meio não impede a `0004` e a `0005` de rodarem —
e a `0005`, que é `create or replace`, instala a função de limite sobre uma
tabela que não existe. O limitador passa a falhar aberto, calado, num banco que
parece pronto.

São quatorze, e a ordem importa:

| Arquivo | O que faz |
| --- | --- |
| `0001_init.sql` | tabelas, RLS, políticas, privilégios por coluna, triggers |
| `0002_seed_plans.sql` | catálogo de planos (idempotente) |
| `0003_auth_rate_limit.sql` | contador de tentativas + `consume_rate_limit` |
| `0004_grants.sql` | **privilégios de tabela** |
| `0005_auth_rate_limit_expurgo.sql` | o contador passa a apagar os baldes parados há mais de um dia — IP não fica guardado além do que serve para contar |
| `0006_job_status_uploaded.sql` | acrescenta o estado `uploaded` ao enum `job_status` — **sozinha de propósito**: `alter type … add value` não pode conviver com o uso do valor novo na mesma transação |
| `0007_fase2_upload.sql` | `jobs.filename`; tira INSERT e DELETE de `jobs` do cliente; cria `create_project`, `register_upload_job`, `discard_job` e `discard_project` |
| `0008_funcoes_so_do_servidor.sql` | tira do cliente o `EXECUTE` das três funções que têm passo de servidor em volta — com `grant … to authenticated`, uma função vira rota pública no PostgREST, e dava para pular a sondagem de codec chamando-a direto |
| `0009_projects_e_idempotencia.sql` | tira INSERT e DELETE de `projects` do cliente (o mesmo esquecimento, do outro lado); índice único em `jobs.r2_input_key` e confirmação idempotente |
| `0010_projects_update_por_coluna.sql` | o UPDATE de `projects` passa a alcançar só `name` e `template_id` — trocar o `id` pelo PATCH deixaria todo objeto do projeto órfão no R2, porque o id está dentro da chave |
| `0011_idempotencia_depois_da_trava.sql` | inverte duas instruções da `register_upload_job`: a trava da assinatura vem antes da checagem de idempotência, senão uma corrida com a cota no limite apaga o arquivo do job que acabou de ser gravado |
| `0012_ordem_das_travas.sql` | `register_upload_job` passa a travar `projects` antes de `subscriptions`, na mesma ordem da `discard_project`. **Medido:** com a ordem anterior, apagar um projeto enquanto uma confirmação de upload estava em voo dava `40P01 deadlock detected` — e as duas ações ficam na mesma tela |
| `0013_discard_project_apaga_antes.sql` | o mesmo impasse pelo outro par (`discard_job` × `discard_project`), **também medido**: a correção é apagar os jobs antes de mexer na cota e tirar a contagem do próprio `DELETE … RETURNING`, o que de quebra elimina a devolução de crédito em dobro |
| `0014_confirmacao_nunca_devolve_nulo.sql` | um `if not found` no tratador de conflito: `select … into` do plpgsql não levanta erro quando não acha nada, e a função devolvia um `jobs` de campos nulos que a tela lia como "Enviado" |

**Pular a 0004 quebra tudo em silêncio:** toda consulta de usuário autenticado
volta `42501 permission denied`, inclusive em `plans`, e o `service_role` fica
sem DML nenhum. RLS não concede acesso — ela só filtra linhas de quem já tem o
privilégio de tabela, e o Supabase parou de conceder isso automaticamente para
tabela nova em `public`. Sem a 0003, o rate limit falha aberto sem avisar.

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

### Configurar o bucket R2 (painel)

Duas coisas que **não** estão no código e sem as quais a Fase 2 não funciona por
inteiro. As duas são operação de bucket, e o token de `R2_ACCESS_KEY_ID` tem
escopo de objeto — ele não consegue nem ler nem gravar nenhuma das duas
(**medido**: `AccessDenied` 403 nas duas).

| Onde | O quê | Por quê |
| --- | --- | --- |
| R2 > (bucket) > Settings > **CORS policy** | a regra que `node app/scripts/r2-cors.mjs` imprime | O upload vai do navegador direto para o bucket. Sem CORS o navegador bloqueia o `PUT` **antes de ele sair**, o servidor não vê nada, e o que aparece no console é um `Failed to fetch` que não menciona CORS. Medido: sem a regra, o preflight `OPTIONS` volta 403. A lista de `AllowedHeaders` precisa ter `content-type` **e `if-none-match`** — o segundo é o que faz a URL de envio valer uma vez só. |
| R2 > (bucket) > Settings > **Object lifecycle rules** | apagar objetos com mais de **30 dias** | É a contraparte de `jobs.expires_at`, que já nasce com `now() + 30 dias`. Banco e bucket precisam concordar sobre quando o arquivo some — senão um dos dois mente. Também é o que recolhe os órfãos: upload interrompido no meio, e objeto cuja remoção no bucket falhou depois de a linha já ter sido apagada. |

A regra de CORS depende de `NEXT_PUBLIC_APP_URL`, então **produção e
desenvolvimento têm origens diferentes** — rode o script em cada ambiente e
some as duas origens na política do bucket de cada um.

O `connect-src` da CSP também precisa alcançar o R2, mas isso é código e já
está em `app/src/lib/security-headers.ts`. Sem ele o navegador bloqueia o envio
exatamente como faria sem CORS — foi assim que este bloqueio apareceu no aceite
da Fase 2.

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
| `node scripts/r2-cors.mjs` | imprime a política de CORS que o bucket precisa ter |

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
- **O upload nunca passa pelo servidor, e a autorização é estreita e de uso
  único.** O navegador recebe uma URL pré-assinada de `PUT` com `Content-Type`,
  `Content-Length` **e `If-None-Match: *`** dentro da assinatura, válida por 15
  minutos, para uma chave que o servidor escolheu:
  `{user_id}/{project_id}/{uuid}.{ext}`. O nome do arquivo enviado não entra na
  chave — ele vira `jobs.filename`, que é dado, e nunca caminho.
  A escrita condicional fecha uma janela que existia: URL pré-assinada vale até
  expirar e **não se invalida ao ser usada**, então dava para enviar um H.264
  legítimo, deixar a sondagem aprovar e gravar o `probe` como prova, e depois
  regravar a mesma chave com outro conteúdo do mesmo tamanho e tipo.
  Medido contra o R2: outro `Content-Type` → 403; mais bytes do que o assinado
  → 403; URL vencida → 403; **mesma URL usada duas vezes → 412
  `PreconditionFailed`**; sem o `If-None-Match` → 403.
- **Lista fechada de codecs na porta de entrada.** `src/lib/video/sonda.ts` lê o
  cabeçalho do objeto por `Range` (dezenas de KB, não o arquivo inteiro) e
  `veredito.ts` aplica a lista do PLANO §4. Fora dela, o job nasce `rejected`
  com o motivo em pt-BR e o objeto é apagado do bucket. O `ffprobe` de verdade
  continua sendo o da Fase 3, dentro do contêiner isolado: são duas camadas com
  papéis diferentes, não redundância.
- **`jobs` é somente leitura para o cliente** (migration 0007). Toda escrita
  passa por função `security definer` que decide a partir de `auth.uid()`.
  É o que impede criar job sem sondagem e sem consumir cota — e o que faz a
  checagem de cota e o consumo acontecerem na mesma transação, com a linha da
  assinatura travada.
- **Sessão em cookie `HttpOnly`.** O padrão do `@supabase/ssr` é `httpOnly:
  false`, porque o cliente de navegador dele lê a sessão de `document.cookie`.
  `src/lib/supabase/cookie-options.ts` inverte isso. A consequência precisa ser
  lembrada: `@/lib/supabase/browser` **não enxerga a sessão** — é um cliente
  anônimo, e tudo que depende de identidade passa pelo servidor. Quando a Fase 3
  precisar de Realtime autenticado, o token dessa conexão terá que ser emitido
  pelo servidor, não lido de um cookie.
- **Sessão conferida duas vezes.** O proxy barra `/app/*` antes de renderizar; o
  layout e cada página chamam `exigirUsuario()` de novo. Não é redundância: o
  proxy é uma peça só, e um `matcher` errado ou uma rota nova fora do padrão
  bastam para furá-lo. Testado desligando a proteção do proxy — o layout continua
  redirecionando.
- **`getUser()`, nunca `getSession()`**, para decidir acesso. `getSession()` lê o
  cookie sem validar nada.
- **Rate limit de 10 tentativas por 15 minutos por IP e rota**, numa tabela
  Postgres (`0003_auth_rate_limit.sql`). O contador é um `insert … on conflict do
  update` só, então duas requisições simultâneas não perdem contagem — verificado
  com 20 conexões paralelas: exatamente 10 passaram. Falha aberta de propósito: se
  o banco não responder, o login continua funcionando.
- **Sem redirecionamento aberto.** O `?proximo=` só aceita caminho interno, tanto
  na server action quanto no callback do e-mail. `https://…`, `//host` e `/\host`
  caem para `/app/projetos`.
- **Mensagens de erro por código**, não pela string em inglês do Supabase
  (`src/lib/auth/mensagens.ts`). Nenhuma delas revela se um e-mail tem conta.

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

Fase 3 — o worker: fila em Postgres com `FOR UPDATE SKIP LOCKED`, render
determinístico com FFmpeg e o `ffprobe` de verdade sobre a lista fechada.
O prompt está em `docs/PLANO.md`.
