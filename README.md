# PageMask

SaaS de edição de vídeo em lote para páginas temáticas do Instagram. Uma pasta de
vídeos entra, um padrão visual é definido uma vez, e o lote inteiro sai editado,
verificado e publicado nas contas conectadas.

O plano de execução é [`docs/PLANO.md`](docs/PLANO.md). As regras de trabalho estão
em [`CLAUDE.md`](CLAUDE.md). **Fase atual: 5 — publicação e agenda.** O fluxo
está completo de ponta a ponta: o lote é processado pelo worker, o vídeo pronto
é agendado no calendário e publicado como Reels na conta conectada, na hora
marcada. É o que destrava o App Review da Meta (trilha paralela, itens 7–9).

---

## O que já existe

```
app/                      Next.js 16 (App Router, TypeScript, Tailwind 4, shadcn/ui)
  src/app/(auth)/         entrar, cadastrar, confirmação de e-mail
  src/app/app/            área autenticada (projetos, templates, conectores, agenda, conta)
  src/app/app/agenda/     calendário (mês/semana, arrastar) · agendar-video · historico
  src/app/(publico)/      privacidade (com #exclusao) · exclusao-de-dados (consulta por código)
  src/app/api/meta/       data-deletion · deauthorize — os dois callbacks da Meta
  src/app/api/cron/       ig-tokens (diário) · publicar (a cada minuto)
  src/lib/agenda/         fuso (America/Sao_Paulo ↔ UTC, sem biblioteca) · mensagens
  src/lib/meta/           signed-request (HMAC-SHA256) · codigo (código de confirmação)
  src/lib/legal/          encarregado — o DPO publicado na política
  src/app/auth/confirmar/ troca do link de e-mail por sessão
  src/app/app/templates/  lista · editor com prévia ao vivo (Fase 6)
  src/app/api/templates/  previa (enfileira e consulta) · header/assinar · header/confirmar
  src/app/api/uploads/    assinar (URL pré-assinada PUT) · confirmar (sonda e registra)
  src/app/api/videos/     [id]/baixar — redirect assinado para o vídeo pronto
  src/lib/auth/           sessão, rate limit, mensagens de erro em pt-BR, api.ts
  src/lib/env/            variáveis validadas com zod — public.ts e server.ts
  src/lib/supabase/       clientes browser · server · admin · key-role · cookie-options
  src/lib/r2/             cliente · chaves · assinatura · objetos
  src/lib/video/          codecs (lista fechada) · sonda · veredito · leitor
  src/lib/plano/          limites do plano e códigos de erro do banco
  src/lib/rate-limit/     balde compartilhado pelo limite de auth e de upload
  src/lib/realtime/       token curto que autoriza o progresso ao vivo
  src/lib/template/       esquema (zod, espelho do molde.py) · snapshot (o congelado
                          no job) · header (a imagem conferida) · limite-de-taxa
  src/lib/imagem/         assinatura — PNG/JPG pelos BYTES, nunca pela extensão
  src/lib/ig/             Business Login: api, estado (HMAC), cripto (AES-GCM),
                          mensagens em pt-BR, janela do pop-up, limite de taxa
  src/lib/cron/           autorizacao — a porta das rotas de cron
  src/lib/email/          enviar — aviso de reconexão (opcional, via Resend)
  src/app/api/realtime/   credencial — 204 quando o Realtime está desligado
  src/app/api/ig/         iniciar (abre o OAuth) · callback (grava a conta)
  src/app/api/cron/       ig-tokens — renova os tokens perto de vencer
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
                          0015_fila_do_worker.sql · 0016_realtime_dos_jobs.sql
                          0017_probe_do_worker.sql
                          0018_conectores_do_instagram.sql
                          0019_agenda_e_publicacao.sql
                          0020_editor_de_template.sql
worker/                   pipeline Python de render (FFmpeg + Pillow) + serviço de fila
  service.py              o laço: reclama, processa, conclui · batimento e zelador
  publish.py              a publicação: container REELS → status → media_publish (Fase 5)
  src/servico/previa.py   a fila da prévia do editor: um PNG em segundos (Fase 6)
  src/                    o pipeline, como ele já era (analyze, compose, render, validate)
  src/servico/            o que o transforma em serviço: banco, R2, codecs, molde,
                          progresso, trabalho, ambiente, registro
  scripts/                conferir-ffmpeg.sh — a trava de versão do build
  Dockerfile              FFmpeg ≥ 8.1.2, usuário não-root
  docker-compose.yml      read_only, tmpfs, cap_drop ALL, limites
app/vercel.json           o cron diário de renovação de token
.github/workflows/ci.yml  lint, tipos, audit, gitleaks, varredura do bundle
.githooks/pre-commit      gitleaks antes do commit
```

Ainda não existem: `docs/RUNBOOK.md`, `docs/DADOS.md`, `docs/PRODUCAO.md`.

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

São dezenove, e a ordem importa:

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
| `0015_fila_do_worker.sql` | a fila: `claim_job` (com `FOR UPDATE SKIP LOCKED` **e** trava consultiva por usuário, que é o que de fato segura o limite de 2 simultâneos), `enqueue_project`, `finish_job`, `fail_job`, `reject_job`, `requeue_stale_jobs`, `worker_beat`, `jobs.next_attempt_at` e a tabela `worker_heartbeat` |
| `0016_realtime_dos_jobs.sql` | publica `jobs` no Realtime com **lista de colunas** — sem ela, cada tique de progresso reenviaria `probe`, `report` e `template_snapshot` inteiros a cada assinante |
| `0017_probe_do_worker.sql` | `job_probe`: o `ffprobe` vai para a coluna assim que é conhecido, antes do render, para sobreviver a um job que falhe depois |
| `0018_conectores_do_instagram.sql` | `ig_oauth_states` e as sete funções do Business Login (conectar, desconectar, renovar) — token cifrado só sai por função `service_role` |
| `0019_agenda_e_publicacao.sql` | `schedules` vira fila de publicação: colunas de claim e permalink, políticas mais estreitas (só vídeo `done` em conta `active`; reagendar só antes do worker pegar), `mark_due_schedules` (cron), `claim_publish` (`FOR UPDATE SKIP LOCKED`), desfechos com `audit_log` na mesma transação, `retry_schedule`, e os dois callbacks da Meta idempotentes por `webhook_events.event_id` |

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

---

### Rodar o worker

O worker não roda na Vercel e não é um processo do `app/`: é um contêiner à
parte, que fala com o Supabase e com o R2 por variável de ambiente e com mais
ninguém.

```bash
cd worker
cp ../.env.example .env      # mantenha só o que o worker usa (lista abaixo)
docker compose up --build
```

Ele precisa de seis variáveis, e nenhuma delas tem valor padrão:

| Variável | De onde vem |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | a mesma do app (o compose a repassa como `SUPABASE_URL`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings > API. É ela que autoriza as funções da fila |
| `R2_ENDPOINT`, `R2_BUCKET` | as mesmas do app |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | as mesmas do app |

E aceita estas, todas opcionais:

| Variável | Padrão | O que muda |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | 2 | jobs em paralelo **neste** contêiner |
| `WORKER_MAX_POR_USUARIO` | 2 | jobs simultâneos por usuário — contado no banco, não aqui |
| `WORKER_TIMEOUT_S` | 1200 | prazo de um job (mínimo aceito: 30) |
| `WORKER_STALE_MIN` | 30 | minutos até um job `processing` ser considerado abandonado |
| `WORKER_MAX_TENTATIVAS` | 3 | tentativas antes de desistir e devolver o crédito |
| `WORKER_HEARTBEAT_S` | 30 | intervalo do batimento em `worker_heartbeat` |
| `WORKER_NAME` | hostname | identifica o contêiner no batimento e no log |
| `WORKER_GRACA_S` | 280 | quanto o worker espera os jobs em voo ao receber SIGTERM |
| `WORKER_MEM` / `WORKER_TMPFS` / `WORKER_CPUS` | 2g / 1500m / 1.5 | os limites do contêiner |
| `TOKEN_ENC_KEY` | — | **Fase 5.** A mesma chave do app. Sem ela a thread de publicação não sobe e o log avisa |
| `IG_GRAPH_VERSION` | v25.0 | versão presa do Graph (`graph.instagram.com`) |
| `PUBLISH_POLL_S` | 5 | intervalo entre reclamações de publicação |
| `PUBLISH_MAX_TENTATIVAS` | 3 | tentativas antes de `failed` com "Tentar de novo" |
| `PUBLISH_STALE_MIN` | 15 | minutos até um claim de publicação ser considerado abandonado (mínimo 11: a espera pelo container vai até 10) |
| `PUBLISH_URL_VALIDADE_S` | 7200 | validade da URL pré-assinada que a Meta baixa (2 h) |

**A conta de memória não fecha nos padrões, e é melhor saber disso antes.** O
`tmpfs` de `/work` é memória e conta contra o `mem_limit`. Cada job segura ao
mesmo tempo a entrada baixada e a saída renderizada, então dois jobs no teto do
plano (`plans.max_mb` = 500) pedem ~2 GB só de tmpfs, mais o que numpy e Pillow
usam na validação. Os números acima são os do PLANO §4 e servem para arquivos
de tamanho típico; para honrar os 500 MB com dois jobs em paralelo, a máquina
precisa de `WORKER_MEM=5g` e `WORKER_TMPFS=3500m` — ou de
`WORKER_CONCURRENCY=1`. Estourando, o job vira `failed` com o crédito devolvido,
ou o OOM killer derruba o worker e o zelador devolve os jobs para a fila:
trabalho perdido, dado nenhum.

**Dois contêineres não brigam.** O limite por usuário é decidido pelo banco, em
`claim_job` — cada worker só informa o número. Subir uma segunda máquina é
copiar o `.env` e mudar `WORKER_NAME`.

O log é uma linha de JSON por evento, com `etapa`, `resultado`, `job_id` e
`duracao_s`. É o que o `docker compose logs` mostra e o que um coletor lê sem
regex.

#### O que o worker faz com cada arquivo

```
baixar → ffprobe (lista fechada) → montar o template → detectar layout
       → compor o overlay → renderizar → validar (7 + 9) → subir → done
```

E três destinos diferentes para "deu errado", que dizem coisas diferentes ao
usuário:

| Estado | Quando | Crédito | Entrada no R2 |
| --- | --- | --- | --- |
| `rejected` | o arquivo foi lido e o codec/container não está na lista | volta | **apagada** |
| `failed` | não deu para ler o arquivo, o template não serve, a validação reprovou, o prazo estourou | volta | preservada |
| volta para a fila | o problema foi do caminho (rede, R2, FFmpeg morto) | não mexe | preservada |

Só o terceiro tem nova tentativa — até 3, com espera de 30 s, 60 s e 120 s. Os
dois primeiros são determinísticos: o mesmo arquivo com o mesmo template dá o
mesmo resultado, e insistir só ocuparia a fila.

#### A validação de Reels

Além das 7 checagens do pipeline (que perguntam "o render fez o que devia?"),
o worker roda 9 que perguntam outra coisa: "o Instagram aceita este arquivo?".
`moov` no início, sem edit list, H.264 com GOP fechado, AAC ≤ 48 kHz e ≤ 2
canais, 23–60 fps, largura ≤ 1920, 3 s a 15 min, ≤ 300 MB, ≤ 25 Mbps.

Duas delas exigiram mudar o comando do FFmpeg, e a mudança está comentada em
`worker/src/render.py`: `-use_editlist 0` sozinho desalinha o áudio em 66 ms, e
é `+negative_cts_offsets` que devolve o sincronismo sem edit list.

O "GOP fechado" não existe como campo em lugar nenhum do MP4. O que a checagem
faz é comparar duas contagens que só batem em GOP fechado: pacotes marcados
como quadro-chave contra NALs do tipo 5 (IDR). **Medido nos dois sentidos:** na
saída do PageMask, 2 e 2; num arquivo codificado de propósito com `open-gop=1`,
4 quadros-chave contra 1 IDR.

#### Progresso ao vivo (opcional)

A lista de vídeos se atualiza sozinha a cada 8 segundos — sempre, sem
configurar nada. Preenchendo `SUPABASE_JWT_SECRET` no `app/.env.local`, ela
passa a receber cada mudança em milissegundos pelo Supabase Realtime.

O token que autoriza essa conexão **não** é o da sessão. O cookie de sessão é
`HttpOnly` desde a Fase 1, justamente para ficar fora do alcance de JavaScript;
o que vai para o navegador é um JWT assinado no servidor que vale 5 minutos,
carrega só `sub` e `role`, e não tem como ser renovado sem passar de novo por
uma rota que exige a sessão.

**O que isso custa, dito inteiro:** não existe escopo "só Realtime" no
Supabase. Dentro desses 5 minutos o token também vale contra o PostgREST, nos
limites da RLS daquele usuário, e sair da conta não o invalida. Ou seja: um XSS
no app passaria a render um token de API, além da sessão. A CSP da Fase 1
(nonce, `strict-dynamic`, sem `unsafe-inline`) é o que segura esse risco.
Deixar `SUPABASE_JWT_SECRET` em branco elimina o risco por completo —
`/api/realtime/credencial` responde `204`, nenhum token chega ao navegador, e a
tela continua correta, só mais lenta.

---

### Conectar contas do Instagram (Fase 4)

O PageMask publica pelo **Business Login for Instagram** (Instagram API with
Instagram Login), em `graph.instagram.com`. Não há Página do Facebook no
caminho, e não é o Facebook Login.

**No painel da Meta** (developers.facebook.com > seu app > Instagram > *API setup
with Instagram login*):

1. Copie o **Instagram app ID** e o **Instagram app secret** para `IG_APP_ID` e
   `IG_APP_SECRET`.
2. Em *OAuth redirect URIs*, cadastre exatamente o valor de `IG_REDIRECT_URI` —
   caractere por caractere, com a barra final igual. Essa string entra na
   assinatura da troca do `code`, e uma diferença ali falha com uma mensagem que
   não menciona a `redirect_uri`.
3. Enquanto o app estiver em revisão, convide a conta de teste como **tester**
   em *Roles*. Só contas convidadas conseguem autorizar; é isso que a faixa na
   tela de Conectores avisa (`IG_APP_MODE=development`).
4. A conta a conectar precisa ser **Profissional** (Empresa ou Criador de
   conteúdo). A tela de um passo, antes do pop-up, mostra o caminho exato no app
   do Instagram.

**A Meta exige HTTPS na `redirect_uri`, inclusive em `localhost`.** O servidor
de desenvolvimento precisa subir com TLS, e `NEXT_PUBLIC_APP_URL` precisa
combinar com ele — as duas origens têm que ser a mesma, senão o cookie de sessão
não acompanha a volta do OAuth e o pop-up não consegue avisar a aba que o abriu:

```bash
# app/.env.local
NEXT_PUBLIC_APP_URL=https://localhost:3000
IG_REDIRECT_URI=https://localhost:3000/api/ig/callback

# e o servidor:
npm run dev -- --experimental-https
```

O Next gera um certificado autoassinado na primeira execução (ele baixa o
`mkcert` e pode pedir elevação para instalar a autoridade local). Se essa
elevação não for possível, gere o par você mesmo e aponte para ele:

```bash
mkdir -p app/certificates && cd app/certificates
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30   -keyout localhost-key.pem -out localhost.pem   -subj "//CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

cd ../ && npx next dev --experimental-https   --experimental-https-key certificates/localhost-key.pem   --experimental-https-cert certificates/localhost.pem
```

#### O token, em repouso e na renovação

O token longo do Instagram vale **60 dias** e é gravado cifrado com AES-256-GCM
(`TOKEN_ENC_KEY`), com IV novo a cada gravação e o `ig_user_id` como dado
associado — um texto cifrado movido para a linha de outra conta não decifra.
As colunas `token_cipher`, `token_iv` e `token_tag` **não** são legíveis pelo
papel `authenticated` (GRANT por coluna, migration 0001) e não existem no tipo
TypeScript que a tela recebe.

A renovação é o cron diário `GET /api/cron/ig-tokens`, declarado em
`app/vercel.json` e protegido por `CRON_SECRET`. Ele pega quem vence em menos de
10 dias. Para disparar na mão:

```bash
curl -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/ig-tokens
```

Dois detalhes do lado da Meta que mudam o comportamento e estão no código:
um token só pode ser renovado depois de ter **24 horas de vida** (antes disso a
recusa não é falha da conta), e um token que passa 60 dias sem renovação morre
de vez — só reautorizando.

Falha em que a Meta de fato recusa o token marca a conta como
`needs_reconnect`, registra em `audit_log` e manda um e-mail ao dono (se
`RESEND_API_KEY` e `EMAIL_REMETENTE` estiverem preenchidas). Falha de rede
**não** marca nada: a conta continua na fila e a execução do dia seguinte tenta
de novo.

---

### Publicar e agendar (Fase 5)

A aba **Agenda** (`/app/agenda`) é um calendário mensal/semanal em
`America/Sao_Paulo` (no banco, tudo UTC). Agendar pede conta, vídeo `done`, data,
hora e legenda (contador até 2.200, o limite da Meta). Ao escolher a conta, a
tela consulta `content_publishing_limit` e mostra "X de Y publicações usadas nas
últimas 24 h"; se o horário não couber, a action devolve o próximo horário livre.
Arrastar um item para outro dia mantém a hora e persiste na mesma hora; o
detalhe do item tem os campos de data e hora para quem não usa mouse.

Quem publica é o **worker**, não o app:

```
cron (a cada minuto)   /api/cron/publicar → mark_due_schedules: vencido vira `publishing`
worker (publish.py)    claim_publish (FOR UPDATE SKIP LOCKED) → URL pré-assinada GET de 2 h
                       → POST /media (REELS) → GET status_code (5, 10, 20, 40 s… até 10 min)
                       → FINISHED: POST /media_publish → GET permalink → finish_publish
```

Cada desfecho grava `audit_log` **na mesma transação** (`publish.ok`,
`publish.retry`, `publish.failed`, `publish.deferred`). O que cada erro da Meta
vira está em `worker/publish.py` (`classificar`): token recusado (`190`) marca a
conta `needs_reconnect` e o agendamento `failed` com a mensagem de reconectar;
limite de 24 h (`code 9`) vira `deferred` reagendado +1 h sem gastar tentativa;
container `EXPIRED` é refeito uma vez; erro de arquivo é `failed` de vez; rede e
5xx voltam para a fila até 3 tentativas. O histórico (`/app/agenda/historico`)
lista publicados (com link), adiados e com falha (botão **Tentar de novo**).

O cron por minuto (`app/vercel.json`) é recurso do plano **Pro** da Vercel. Fora
dela, qualquer agendador serve:

```bash
curl -H "x-cron-secret: $CRON_SECRET" https://pagemask.com.br/api/cron/publicar
```

**Medido no aceite:** um Reel real publicado na conta de teste com a legenda
certa; token invalidado → conta `needs_reconnect` e agendamento `failed` com
mensagem tratada; arrastar no calendário persiste (`schedule.reschedule` na
auditoria); duas execuções do cron no mesmo instante marcam o agendamento uma
vez só; URL pré-assinada vence de fato (`403` depois do prazo); usuário
tentando agendar em `ig_account_id` de outro recebe `42501` da RLS.

#### As páginas públicas e os callbacks da Meta

O App Review exige duas URLs públicas, e a LGPD exige o Encarregado publicado:

| Rota | O que é |
| --- | --- |
| `/privacidade` | política em pt-BR, com o DPO no topo e a seção **Exclusão de dados** em `#exclusao` |
| `/exclusao-de-dados` | instruções (pelo app, pelo Instagram, por e-mail) e consulta de estado por código |
| `POST /api/meta/data-deletion` | Data Deletion Request Callback: valida `signed_request` (HMAC-SHA256 com `IG_APP_SECRET`), revoga as contas daquele `ig_user_id`, abre `data_requests` e responde `{ url, confirmation_code }` |
| `POST /api/meta/deauthorize` | Deauthorize Callback: apaga o token e marca `revoked` |

Os dois callbacks são idempotentes por `webhook_events.event_id` (hash do
`signed_request`): o mesmo pedido reenviado devolve o mesmo código. Assinatura
inválida é `400` e **nada é gravado** — medido. No painel da Meta, cadastre as
duas URLs em *Business login settings* e as duas páginas em *App Review*.

O nome e o e-mail do Encarregado ficam em `app/src/lib/legal/encarregado.ts` e
**precisam de confirmação** antes do App Review (a nomeação formal é item da
trilha paralela). Apagar os dados de fato (arquivos, perfil, usuário) é a Fase
10; aqui a solicitação nasce `received` e o token já morre na hora.

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
| `npm run dev -- --experimental-https` | servidor em HTTPS, necessário para o OAuth do Instagram |

| Comando (dentro de `worker/`) | O que faz |
| --- | --- |
| `docker compose up --build` | sobe o worker (lê `worker/.env`) |
| `docker compose logs -f` | acompanha o log JSON |
| `docker compose down` | para o worker |
| `python run.py input/ --report reports/lote.json` | roda o pipeline sem fila, direto em arquivos locais |
| `python publish.py` | só o laço de publicação (o `service.py` já o inclui) |
| `scripts/conferir-ffmpeg.sh 8.1.2` | a trava de versão, fora do build |

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

Da Fase 3, o worker:

- **O `ffprobe` de verdade é quem autoriza o render.** Container `mp4|mov|webm|mkv`,
  vídeo `h264|hevc|vp9|av1`, áudio `aac|mp3|opus|vorbis|pcm_*` — nada fora disso
  chega a um decoder. A sondagem da Fase 2, no app, barra o óbvio cedo e lendo
  algumas dezenas de KB; esta roda o arquivo inteiro e é a que vale. **Medido:**
  um `.mp4` que por dentro era Matroska com MagicYUV (o `CVE-2026-8461` do PLANO)
  vira `rejected` com o codec citado na mensagem, e o worker segue vivo.
- **O `template_snapshot` é tratado como entrada hostil**, embora hoje quem o
  escreva seja o servidor — na Fase 6 quem o escreve passa a ser o usuário.
  `worker/src/servico/molde.py` **não valida o dicionário que chega: monta outro
  do zero** e copia só as chaves de uma lista, cada uma com faixa fechada. Imagem
  e fonte nunca são caminho de arquivo: são referência resolvida dentro de pastas
  permitidas. **Medido:** sete tentativas (caminho absoluto, `../../`, asset de
  outra conta, fonte por caminho, número absurdo, escala absurda, injeção na cor)
  viram `failed` com mensagem em pt-BR, sem render e sem derrubar o worker.
- **As funções da fila são `service_role` e só.** No PostgREST, um `grant … to
  authenticated` transforma função em rota pública. **Medido:** as nove respondem
  `42501 permission denied` para a chave `anon`, e `worker_heartbeat` também.
- **O limite de 2 jobs simultâneos por usuário é do banco, não do worker.** Com
  dois contêineres, cada um contaria os seus dois e o usuário teria quatro. Em
  `claim_job`, o `FOR UPDATE SKIP LOCKED` impede dois workers de pegarem o MESMO
  job, mas não impede dois de pegarem jobs diferentes do mesmo usuário contando
  "zero rodando" no mesmo instante — quem fecha isso é uma trava consultiva por
  usuário. **Medido:** 5 jobs enfileirados, máximo observado de 2 em `processing`.
- **A saída vai para um prefixo diferente da entrada.** `saida/{user}/{projeto}/
  {job}.mp4`, com a chave derivada dos ids do próprio job. A rota de download só
  assina `r2_output_key`: o arquivo cru enviado pelo usuário nunca volta pelo
  PageMask sem ter passado pelo pipeline (PLANO §4).
- **O contêiner é o processo mais hostilizado do sistema** e está fechado como
  tal. **Medido com `docker inspect`:** `User=pagemask` (uid 10001),
  `ReadonlyRootfs: true`, `CapDrop: ["ALL"]`, `no-new-privileges`, 2 GB, 1,5 CPU,
  256 pids, `/work` em tmpfs — e `touch /app/x` responde "Read-only file system".
- **O binário do FFmpeg é fixado e conferido.** A URL aponta para uma release
  datada (imutável) e o `sha256` é obrigatório — build sem soma, ou com soma
  errada, não gera imagem. **Medido nos dois sentidos.** A primeira versão
  usava a tag `latest` com conferência opcional, e isso era pior do que
  parece: o `ffmpeg` é justamente o binário que abre arquivo de desconhecido, e
  ele roda com a `service_role` e as credenciais do R2 no ambiente. Um build
  trojanizado não seria contido por `read_only` nem por `cap_drop` — ele seria
  o processo legítimo.
- **O build falha com FFmpeg abaixo de 8.1.2.** A trava está em
  `worker/scripts/conferir-ffmpeg.sh`, em arquivo e não embutida no `RUN`,
  justamente para poder ser rodada contra uma versão antiga. **Medido nos dois
  sentidos:** a imagem real fecha com n8.1.2; o mesmo script sobre o `ffmpeg` do
  Debian bookworm derruba o build com "FFmpeg 5.1.9 e menor que o minimo
  exigido 8.1.2".

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

Pendente desde a Fase 5: **gravar o screencast e submeter o App Review**
(trilha paralela, itens 7–9) — é o que destrava o relógio da Meta.

Fase 7 — entrega: download individual por URL assinada, ZIP do lote gerado no
worker, e a tela do projeto com concluídos, falhados e pendentes. O prompt está
em `docs/PLANO.md`.
