# PageMask — runbook

O que fazer quando algo quebra. Escrito para ser lido às três da manhã, por
alguém com sono, que não escreveu este código.

**Regra que vale para todos os procedimentos abaixo:** primeiro estanque, depois
entenda. Um worker parado enquanto alguém lê log é fila crescendo; um token
vazado enquanto alguém procura a causa é dano aumentando.

## Índice

| Situação | Seção |
| --- | --- |
| O worker caiu e não volta | [1](#1-o-worker-caiu-e-não-reinicia) |
| A Meta está recusando tudo | [2](#2-a-meta-devolvendo-erro-em-massa) |
| Um token vazou | [3](#3-token-vazou--o-procedimento-de-emergência) |
| Preciso restaurar o banco | [4](#4-restaurar-backup-do-banco) |
| O webhook da Stripe está falhando | [5](#5-webhook-da-stripe-falhando) |
| Trocar um segredo sem downtime | [6](#6-rotação-de-segredos-sem-downtime) |
| Os limites de taxa, e como mexer | [7](#7-limites-de-taxa) |
| Alertas: o que cada um significa | [8](#8-alertas-e-o-que-fazer-com-cada-um) |
| Incidente com dado pessoal (ANPD) | [9](#9-incidente-de-segurança-com-dado-pessoal) |
| Excluir uma conta no manual | [10](#10-exclusão-de-conta-no-manual) |

---

## Como está montado (leia uma vez, com calma)

```
  navegador ──► Vercel (Next.js)  ──► Supabase (Postgres + Auth)
                      │                      ▲
                      │                      │ fila: FOR UPDATE SKIP LOCKED
                      ▼                      │
                 Cloudflare R2 ◄──── VPS: Docker + worker (Python + FFmpeg)
                                             │
                                             └──► graph.instagram.com
```

Três processos, e cada um falha de um jeito:

- **Vercel** — as rotas do app e os dois crons. Cai junto com a Vercel; não há o
  que fazer além de esperar e avisar.
- **Supabase** — banco, auth e a fila. É o ponto único de falha do produto: sem
  ele nada funciona, nem o login.
- **worker (VPS)** — render, prévia, ZIP e publicação. **Pode ficar horas fora
  sem que o cliente perceba**, desde que a fila volte a andar depois: os jobs
  esperam em `queued` e o zelador devolve para a fila o que ficou preso.

**Acessos que este runbook pressupõe:** painel do Supabase, painel da Vercel,
SSH na VPS, painel da Cloudflare, painel da Stripe, painel de apps da Meta,
painel do Sentry.

---

## 1. O worker caiu e não reinicia

**Sintoma:** jobs parados em `queued`, o alerta de batimento disparou, ou o
cliente diz que "o lote não sai do zero".

### Confirme antes de mexer

```bash
ssh <vps>
cd /opt/pagemask/worker            # ou onde o compose mora
docker compose ps
docker compose logs --tail=200 worker
```

E, do seu computador, o batimento no banco:

```sql
select worker, beat_at, now() - beat_at as parado_ha, jobs_done, ffmpeg
  from public.worker_heartbeat order by beat_at desc;
```

`parado_ha` acima de 5 minutos = o worker não está batendo.

### Os quatro motivos, em ordem de frequência

**a) Configuração inválida.** O log diz `configuracao invalida: <VARIÁVEL> nao
esta definida` e o contêiner sai com código 2. Um `.env` truncado num deploy é a
causa mais comum. Conferir o `.env` ao lado do `docker-compose.yml` contra o
`.env.example` da raiz, e subir de novo.

**b) OOM.** `docker inspect worker-worker-1 --format '{{.State.OOMKilled}}'`
responde `true`. A conta de memória está escrita no `docker-compose.yml`, no
comentário do `mem_limit`; o resumo é: com `WORKER_CONCURRENCY=2` e vídeos no
teto do plano (500 MB), são **5 GB** de `mem_limit` e **3000m** de tmpfs, o que
pressupõe uma VPS de 8 GB.

> **Numa VPS de 4 GB o caminho não é baixar o `mem_limit`** — é baixar
> `WORKER_CONCURRENCY` para 1 (e então `WORKER_MEM=3g`, `WORKER_TMPFS=1800m`).
> Reduzir só o limite deixa a concorrência prometendo dois jobs que não cabem, e
> o segundo morre no meio.

**c) tmpfs cheio.** O log mostra `No space left on device` em `/work`. Mesma
conta: `WORKER_TMPFS` precisa caber a entrada **e** a saída de cada job
simultâneo, mais o cache de prévia (`PREVIEW_CACHE_MB`). Subir um sem o outro é
o caminho para isto.

**d) FFmpeg abaixo do mínimo.** O log diz `FFmpeg abaixo do minimo exigido` e o
processo sai com 2. Só acontece se alguém editou o Dockerfile. Rebuild:
`docker compose build --no-cache`.

### Estancar

```bash
docker compose up -d --force-recreate
docker compose logs -f worker      # o `inicio` tem que aparecer com resultado "ok"
```

**Se não subir de jeito nenhum**, a fila não se perde. Os jobs ficam em `queued`
e `processing`; ao voltar, o zelador devolve os travados. Para confirmar que
nada se perdeu:

```sql
select status, count(*) from public.jobs group by status order by 2 desc;
select id, status, attempts, started_at, now() - started_at as ha
  from public.jobs where status = 'processing' order by started_at limit 20;
```

Job em `processing` há mais de `WORKER_STALE_MIN` (30 min) volta sozinho na
primeira zeladoria depois que o worker subir. **Não mexa neles na mão** — mudar
`status` por fora do `claim_job` é o jeito de fazer dois workers renderizarem o
mesmo vídeo.

### Se a VPS inteira se foi

O produto continua **parcialmente de pé**: login, upload, editor de template e
a tela de projetos funcionam; o que para é render, prévia, ZIP e publicação.
Suba o worker em qualquer máquina com Docker e as mesmas variáveis — ele não
guarda estado nenhum localmente, tudo vive no Postgres e no R2. Dois workers ao
mesmo tempo também é seguro: a fila é `FOR UPDATE SKIP LOCKED` e o limite por
usuário é contado no banco, não no processo.

---

## 2. A Meta devolvendo erro em massa

**Sintoma:** agendamentos indo para `failed` em série, ou muitos
`needs_reconnect` aparecendo de uma vez.

### Separe os três casos — o tratamento é diferente

```sql
select status, count(*), max(error) as exemplo
  from public.schedules
 where created_at > now() - interval '6 hours'
 group by status;
```

| Código da Meta | O que é | O que fazer |
| --- | --- | --- |
| `190` / `102` | **o token daquela conta morreu** | é por conta, não em massa. O app já marca `needs_reconnect` e manda e-mail. Nada a fazer |
| `4` / `17` / `32` / `613` | **limite de taxa do app** | ver abaixo |
| `1` / `2` / 5xx | **a Meta está fora do ar** | esperar. O `defer_publish` já reagenda |

### Se for limite de taxa

O limite é **por app**, não por conta — então uma conta movimentada atrasa todas
as outras. Confirme a cota real:

```
GET https://graph.instagram.com/v25.0/{ig_user_id}/content_publishing_limit
    ?fields=quota_usage,config
```

Se `quota_usage` está perto de `config.quota_total` (100 por 24 h), não há
conserto técnico: é esperar a janela. **Não tente reenfileirar** — cada tentativa
recusada conta e empurra a recuperação para mais longe.

Para parar a sangria enquanto isso, pause a thread de publicação sem derrubar o
render:

```bash
docker compose stop worker
# tire TOKEN_ENC_KEY do .env  (a thread de publicação não sobe sem ela)
docker compose up -d
```

O render continua; a agenda para. Os agendamentos vencidos ficam em `scheduled`
e saem quando a chave voltar.

### Se a Meta mudou o contrato

Sintoma diferente: erros de **formato** (`resposta sem access_token`, `perfil sem
user_id`) em vez de códigos. A versão do Graph está presa em
`app/src/lib/ig/api.ts` (`VERSAO = "v25.0"`) e em `IG_GRAPH_VERSION` no worker —
as duas precisam mudar juntas, depois de ler o changelog da Meta.

---

## 3. Token vazou — o procedimento de emergência

**Quando usar:** `TOKEN_ENC_KEY` apareceu num log, num commit, numa captura de
tela, ou a VPS foi comprometida. Também vale para "não tenho certeza" — o custo
de rodar isto à toa é uma reconexão por cliente; o de não rodar é acesso de
terceiro às contas do Instagram deles.

> **A ordem importa.** Revogar antes de rotacionar deixa o atacante com uma
> chave que não abre mais nada. Rotacionar antes de revogar deixa os tokens
> vivos na Meta e ilegíveis para nós — ou seja, sem como revogá-los.

### Passo 1 — pare a publicação (1 minuto)

```bash
ssh <vps> && cd /opt/pagemask/worker
docker compose stop worker
```

### Passo 2 — revogue TUDO na Meta (o passo que de fato conta)

Enquanto a chave antiga ainda decifra. Do seu computador, com
`SUPABASE_SERVICE_ROLE_KEY` e a `TOKEN_ENC_KEY` **antiga** no ambiente, para cada
conta ativa:

```
DELETE https://graph.instagram.com/v25.0/{ig_user_id}/permissions
Authorization: Bearer {token decifrado}
```

É a mesma chamada que `revogarPermissoes` faz em `app/src/lib/ig/api.ts`; a
maneira mais rápida e menos sujeita a erro de digitação é rodar aquele caminho —
ver a nota no fim desta seção.

### Passo 3 — apague os tokens do banco

```sql
update public.ig_accounts
   set token_cipher = null, token_iv = null, token_tag = null,
       status = 'needs_reconnect'
 where token_cipher is not null;
```

`needs_reconnect` e não `revoked`: a tela pede reconexão em vez de dizer que a
conta sumiu, e o cliente resolve sozinho em dois cliques.

### Passo 4 — gere a chave nova

```bash
openssl rand -base64 32
```

Troque `TOKEN_ENC_KEY` **nos três lugares**, e conferindo que são o mesmo valor:

1. Vercel → Environment Variables → Production (e Preview, se usar);
2. `.env` do worker na VPS;
3. o cofre onde a equipe guarda segredo.

Suba `key_version` para 2 no código (`app/src/lib/ig/cripto.ts`,
`VERSAO_DA_CHAVE`) — a coluna `key_version` existe para isto. Com todo token
apagado no passo 3 não há o que decifrar com a chave velha, então a rotação é
limpa; a versão serve para o próximo vazamento, quando talvez haja.

### Passo 5 — volte e avise

```bash
docker compose up -d
```

E-mail para todo cliente com conta conectada, **no mesmo dia**. Modelo:

> **Assunto:** Ação necessária: reconecte seu Instagram no PageMask
>
> Identificamos [dia/hora] um risco de exposição das credenciais de acesso que o
> PageMask usava para publicar nas suas contas do Instagram. Por precaução:
>
> · revogamos todas as autorizações junto à Meta e apagamos as credenciais;
> · trocamos a chave de criptografia do sistema.
>
> **Nenhum vídeo, dado de cadastro ou dado de pagamento foi afetado**, e não há
> indício de publicação indevida. Para voltar a publicar, entre em
> pagemask.com.br e reconecte sua conta em Conectores — leva dois cliques.
>
> Qualquer dúvida, responda este e-mail ou escreva para
> privacidade@pagemask.com.br.

Se houver **indício de acesso efetivo** (e não só de exposição), isto é incidente
de segurança com dado pessoal → siga também a [seção 9](#9-incidente-de-segurança-com-dado-pessoal).

### Passo 6 — feche a porta por onde saiu

Vazou em commit? `gitleaks detect --source . --redact` sobre o histórico, e
**rotacione mesmo que o commit tenha sido removido** — o histórico do git não
encolhe. Vazou em log? Ache a linha e corrija o `console.log`; a regra é `§3`: o
nome da variável pode aparecer, o valor nunca.

> **Nota sobre automatizar o passo 2.** Não há script pronto no repositório, de
> propósito: um comando que revoga todos os tokens de todos os clientes é
> perigoso demais para ficar guardado esperando um Enter distraído. O caminho é
> escrever o laço na hora, usando `ig_account_tokens` (migration 0024) +
> `revogarPermissoes` — as duas peças que a exclusão de conta já usa.

---

## 4. Restaurar backup do banco

Há duas fontes, e **a pergunta que escolhe entre elas é "o projeto ainda
existe?"**

| | PITR (Supabase) | Dump (`scripts/backup-diario.sh`) |
| --- | --- | --- |
| Volta para | qualquer instante da janela | o momento do último dump |
| Cobre | erro de operação, `delete` sem `where` | perder o projeto inteiro |
| Depende de | o projeto existir e a conta estar ativa | nada do Supabase |
| Onde | painel do Supabase | o arquivo, onde você o guardou |

### Caso A — apagou dado sem querer, o projeto está de pé

**Use PITR.** Painel do Supabase → Database → Backups → Point in Time Recovery →
escolha o instante **imediatamente anterior** ao estrago.

> **PITR restaura o projeto INTEIRO, não uma tabela.** Tudo que aconteceu depois
> daquele instante some — inclusive uploads e publicações legítimas. Para
> recuperar uma tabela só, use o caminho B com o dump e restaure apenas o que
> precisa (`pg_restore --table=...`).

Antes: confira em Settings → Add-ons que o PITR está **ativo** e qual a janela de
retenção. Sem o add-on, o botão não existe e só resta o caminho B.

### Caso B — restaurar de um dump

```bash
# 1. valide o dump ANTES de precisar dele (isto não toca em produção)
scripts/restaurar-teste.sh backups/pagemask-AAAA-MM-DD-HHMM.dump
```

Ele sobe um Postgres 17 descartável, restaura, confere e destrói o contêiner. A
conferência imprime contagem de tabelas, políticas de RLS, funções e linhas —
compare com a origem antes de confiar no arquivo.

Para restaurar **em produção** (projeto novo, ou o mesmo depois de um desastre):

```bash
# papéis e funções do Supabase precisam existir antes — ver restaurar-teste.sh
pg_restore --no-owner --no-privileges -d "$SUPABASE_DB_URL" arquivo.dump

# uma tabela só:
pg_restore --no-owner --no-privileges --data-only \
           --table=schedules -d "$SUPABASE_DB_URL" arquivo.dump
```

> **O dump não tem os arquivos.** Vídeo, imagem e ZIP estão no R2, que tem
> versionamento e lifecycle próprios. Restaurar o banco e não o bucket produz
> linhas de `jobs` apontando para objetos que não existem — o cliente vê o vídeo
> na lista e o download falha. Se o R2 também se perdeu, o correto é marcar os
> jobs afetados como `failed` e avisar, não deixar a lista mentindo.

### O que sempre conferir depois de qualquer restore

```sql
select tablename from pg_tables where schemaname='public' and rowsecurity=false;
-- tem que voltar VAZIO. Um restore que perdeu RLS é pior que não ter restaurado:
-- o produto funciona e todo mundo lê os dados de todo mundo.

select count(*) from public.plans;              -- 3
select count(*) from public.profiles;
select status, count(*) from public.jobs group by status;
```

### Rotina

`scripts/backup-diario.sh` roda uma vez por dia numa máquina que não seja a VPS
do worker (um backup que mora no que pode queimar não é backup). Copie o
arquivo para fora — Drive, S3, o que for — **cifrado**: um dump tem e-mail de
todo cliente e a trilha de auditoria inteira.

**Teste o restore uma vez por mês.** É a única forma de descobrir que o backup
parou de servir antes de precisar dele.

---

## 5. Webhook da Stripe falhando

**Sintoma:** painel da Stripe mostrando entregas com erro, ou cliente que pagou e
continua sem acesso.

### Diagnóstico em três consultas

```sql
-- chegou?
select event_id, received_at, processed_at, error
  from public.webhook_events
 where provider = 'stripe' order by received_at desc limit 20;

-- travou no meio? (chegou e não processou)
select count(*) from public.webhook_events
 where provider = 'stripe' and processed_at is null;

-- o estado que o cliente vê
select user_id, status, payment_state, plan_slug, current_period_end
  from public.subscriptions where user_id = '<uuid>';
```

| O que você vê | O que é | O que fazer |
| --- | --- | --- |
| a Stripe mostra 400 e `webhook_events` está vazio | **assinatura recusada** | `STRIPE_WEBHOOK_SECRET` errado na Vercel. Pegue o `whsec_…` do endpoint no painel da Stripe e troque |
| a Stripe mostra 500 | erro no processamento | log da Vercel na rota `/api/stripe/webhook` |
| a Stripe mostra 200 e nada mudou | evento de tipo que não tratamos | normal. Ver `app/src/lib/stripe/eventos.ts` |
| chegou, `processed_at` nulo | travou no meio | reenviar pelo painel da Stripe |

### Reenviar é seguro

Stripe → Developers → Webhooks → o evento → **Resend**. A idempotência é por
construção: o insert em `webhook_events` acontece **antes** do efeito e na mesma
transação, então reentrega bate no `unique (event_id)` e não faz nada. Verificado
na Fase 10 — a segunda aplicação do mesmo evento devolve `repetido`, não zera a
cota de novo e não duplica linha.

### Se o cliente pagou e está sem acesso agora

Não espere o webhook. Conserte o estado e depois entenda:

```sql
update public.subscriptions
   set status = 'active', payment_state = 'ok',
       current_period_end = now() + interval '31 days'
 where user_id = '<uuid>';

update public.profiles set plan_slug = '<slug>' where id = '<uuid>';
```

E registre o que foi feito na mão:

```sql
insert into public.audit_log (user_id, actor, action, target, meta)
values ('<uuid>', 'system', 'billing.manual_fix', null,
        jsonb_build_object('motivo', 'webhook falhou', 'por', '<seu nome>'));
```

---

## 6. Rotação de segredos sem downtime

Exigido pelo PLANO §3. Regra geral: **primeiro adicione o novo, depois remova o
velho** — nunca troque em cima.

| Segredo | Como trocar | Downtime |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | painel do Supabase → API → Reset. Trocar na Vercel **e** no `.env` do worker, nessa ordem, e redeployar | segundos entre as duas |
| `SUPABASE_JWT_SECRET` | painel → JWT Settings. **Invalida toda sessão ativa**: todo mundo é deslogado | avisar antes |
| `R2_SECRET_ACCESS_KEY` | Cloudflare → R2 → API Tokens. **Crie o novo antes de apagar o velho**; troque nos dois lugares; só então apague | zero |
| `STRIPE_SECRET_KEY` | painel → Developers → API keys → Roll. A Stripe mantém a antiga viva por 12 h | zero |
| `STRIPE_WEBHOOK_SECRET` | só muda ao recriar o endpoint | a janela do deploy |
| `IG_APP_SECRET` | painel da Meta → Configurações básicas → Reset. **Invalida a troca de code por token**, não os tokens já emitidos | zero para quem já conectou |
| `TOKEN_ENC_KEY` | [seção 3](#3-token-vazou--o-procedimento-de-emergência) | publicação parada por minutos |
| `CRON_SECRET` | gere (`openssl rand -base64 32`), troque na Vercel, redeploy | um ciclo de cron |
| `RESEND_API_KEY` | painel do Resend | zero (e-mail não é caminho crítico) |

**Depois de qualquer rotação**, confira que o segredo velho não ficou em lugar
nenhum:

```bash
gitleaks detect --source . --redact --no-banner
cd app && npm run build && npm run scan:bundle
```

---

## 7. Limites de taxa

Todos usam o mesmo contador (`public.auth_rate_limit`, via `consume_rate_limit`)
e todos **falham abertos**: se o Postgres não responder, a rota continua
funcionando e o log registra. Indisponibilidade do contador não pode virar
indisponibilidade do produto — mas um limitador quebrado em silêncio deixaria a
rota sem proteção por tempo indeterminado, e é por isso que a falha é sempre
registrada.

| O quê | Limite | Janela | Chave | Onde |
| --- | --- | --- | --- | --- |
| Entrar | 10 | 15 min | IP | `lib/auth/rate-limit.ts` |
| Cadastrar | 10 | 15 min | IP | idem |
| Link mágico / reenvio | 10 | 15 min | IP | idem |
| Emitir URL de upload | 60 | 1 h | usuário | `lib/uploads/limite-de-taxa.ts` |
| Confirmar upload | 120 | 1 h | usuário | idem |
| Prévia de template | 30 | 10 min | usuário | `lib/template/limite-de-taxa.ts` |
| Cabeçalho (assinar/confirmar) | 30 | 1 h | usuário | idem |
| Conectar Instagram | 10 | 1 h | usuário | `lib/ig/limite-de-taxa.ts` |
| Pacote ZIP | 20 | 1 h | usuário | `lib/projetos/limite-de-taxa.ts` |
| Gravar legenda | 60 | 1 h | usuário | `lib/legenda/limite-de-taxa.ts` |
| Callback da Meta | 120 | 1 h | IP | `lib/meta/callback.ts` |
| Exportar meus dados | 10 | 1 h | usuário | `lib/conta/limite-de-taxa.ts` |
| Excluir minha conta | 5 | 1 h | usuário | idem |

**A publicação não tem limite nosso, e é de propósito:** quem limita é a Meta
(100 publicações por 24 h por conta, lido de `content_publishing_limit` antes de
agendar). Um segundo limite nosso por cima só criaria um teto invisível mais
baixo que o real, e o cliente veria "não deu" sem explicação.

### Destravar alguém que se trancou fora

```sql
select bucket, hits, janela_iniciada_em from public.auth_rate_limit
 where bucket like '%<ip ou uuid>%';

delete from public.auth_rate_limit where bucket = 'entrar:203.0.113.7';
```

### Mudar um limite

Edite a constante no arquivo da tabela acima e faça deploy. **Não** existe
configuração em banco para isso de propósito: limite é decisão de código, e
mudá-lo por `update` numa tabela é o tipo de alteração que ninguém encontra
depois.

---

## 8. Alertas, e o que fazer com cada um

Configurados no Sentry (Alerts → Create Alert). Os quatro do PLANO §7, com o que
cada um significa na prática:

### a) Worker sem batimento há 5 min

- **Condição:** nenhum evento `etapa=batimento` do worker em 5 minutos, **ou**
  (melhor) um monitor externo consultando `worker_heartbeat`.
- **Por que 5 min:** o batimento é a cada 30 s (`WORKER_HEARTBEAT_S`), então 5
  minutos são dez batidas perdidas — não é oscilação.
- **O que fazer:** [seção 1](#1-o-worker-caiu-e-não-reinicia).

> **Este alerta precisa de um observador FORA do worker.** Um alerta que depende
> do worker mandar evento não dispara quando o worker morre — que é exatamente
> quando ele precisa disparar. Use o Cron Monitoring do Sentry (o worker faz
> check-in; a ausência do check-in é que alerta) ou um monitor externo batendo
> numa rota que leia `worker_heartbeat`.

### b) Job `queued` há mais de 30 min

- **Condição:** consulta agendada —
  `select count(*) from jobs where status='queued' and queued_at < now() - interval '30 minutes'`
  maior que zero.
- **O que significa:** ou o worker está fora (ver (a)), ou está ocupado demais.
  Compare com `select count(*) from jobs where status='processing'`: se houver
  `processing` andando, é capacidade — suba `WORKER_CONCURRENCY` (lendo a conta
  de memória antes) ou um segundo worker.

### c) Taxa de `failed` acima de 5% na hora

- **Condição:** `failed / (failed + done)` na última hora > 5%.
- **O que significa:** quase sempre **uma mudança nossa**, não um cliente com
  vídeo estranho. Falha de render é normalmente concentrada: um template novo,
  um FFmpeg novo, uma fonte que sumiu da imagem.
- **Primeiro passo:** `select error, count(*) from jobs where status='failed' and
  finished_at > now() - interval '1 hour' group by error order by 2 desc;` — se
  um erro domina, é ele.

### d) Renovação de token do Instagram falhando

- **Condição:** o cron diário `/api/cron/ig-tokens` devolvendo `falhas > 0` em
  dois dias seguidos.
- **Por que dois dias:** uma falha isolada é oscilação da Meta e se resolve
  sozinha na execução seguinte. Duas seguidas na mesma conta indicam autorização
  morrendo — e o token só tem 60 dias antes de não voltar mais.
- **O que fazer:** [seção 2](#2-a-meta-devolvendo-erro-em-massa). A conta afetada
  já foi marcada `needs_reconnect` e o cliente já recebeu e-mail.

### Testar que os alertas funcionam

```bash
# erro de teste do app (e do scrubber junto)
curl -X POST -H "authorization: Bearer $CRON_SECRET" \
     https://pagemask.com.br/api/sentry/teste

# worker: derrube e espere o alerta de batimento
docker compose stop worker
```

> Um alerta nunca testado é uma suposição. Teste os quatro depois de configurar,
> e de novo a cada mudança de infraestrutura.

---

## 9. Incidente de segurança com dado pessoal

**Quando:** acesso não autorizado a dado de cliente — banco, bucket, token, ou
conta de administrador comprometida. Na dúvida, trate como incidente.

### Nas primeiras 2 horas

1. **Estanque.** Rotacione o que vazou ([seção 6](#6-rotação-de-segredos-sem-downtime));
   se houver token envolvido, [seção 3](#3-token-vazou--o-procedimento-de-emergência).
2. **Preserve.** Log da Vercel, log do worker, `audit_log`, log do Postgres.
   Exporte **antes** de qualquer limpeza — investigação depois de faxina não
   investiga nada.
3. **Delimite.** Quais titulares, quais campos, qual janela de tempo. `audit_log`
   é a principal fonte:
   ```sql
   select * from public.audit_log
    where created_at between '<início>' and '<fim>' order by created_at;
   ```
4. **Avise o Encarregado.** Arthur Lima — privacidade@pagemask.com.br.

### Comunicação à ANPD

A LGPD (art. 48) obriga a comunicar a ANPD e os titulares quando houver **risco
ou dano relevante**. O prazo da Resolução CD/ANPD nº 15/2024 é de **3 dias úteis**
a contar do conhecimento — confira a redação vigente antes de enviar, porque essa
regra mudou recentemente e pode mudar de novo.

Comunique pelo formulário do site da ANPD, com:

- descrição da natureza dos dados afetados;
- informações sobre os titulares envolvidos (número, categorias);
- indicação das medidas técnicas e de segurança adotadas;
- riscos relacionados ao incidente;
- motivos da demora, se a comunicação não foi imediata;
- medidas adotadas para reverter ou mitigar.

### Comunicação aos titulares

Mesmo prazo. Em português claro, sem eufemismo: o que aconteceu, quais dados,
o que já foi feito, o que o titular deve fazer. O modelo da
[seção 3](#3-token-vazou--o-procedimento-de-emergência) serve de ponto de
partida.

### Depois

Registre em `audit_log` (`actor='system'`, `action='security.incident'`), escreva
o que falhou e o que mudou para não repetir, e **atualize este runbook** — um
incidente que não vira procedimento é um incidente que vai acontecer de novo.

---

## 10. Exclusão de conta no manual

O caminho normal é o cliente mesmo, em `/app/conta` → Excluir minha conta. Este
procedimento é para quando ele não consegue: pedido por e-mail de quem perdeu o
acesso, ou uma exclusão que falhou no meio.

### Se falhou no meio

```sql
select confirmation_code, status, requested_at, meta
  from public.data_requests
 where kind = 'deletion' and status in ('processing', 'failed')
 order by requested_at desc;
```

O campo `meta.falha` diz onde parou:

| `meta.falha` começa com | O que aconteceu | O que fazer |
| --- | --- | --- |
| `r2:` | objetos não saíram do bucket | **o banco não foi tocado e o Instagram não foi revogado** — o R2 é o primeiro passo justamente por isso. Mas **parte dos arquivos já foi apagada** antes da falha, e isso não volta. Resolva o R2 e peça ao cliente para repetir |
| `auth:` | banco e arquivos limpos, login não removido | apague o usuário no painel do Supabase → Authentication |
| outro | falhou depois do R2 | ver abaixo: o estado é incerto, refaça na mão a partir do passo 2 |

### Refazer na mão

Com `SUPABASE_SERVICE_ROLE_KEY`, **na mesma ordem do código** — e a ordem existe
porque cada passo destrói o que o seguinte precisaria.

**1. Apague os arquivos no R2** — os cinco prefixos, não só o primeiro:

```
{user_id}/            saida/{user_id}/      previas/{user_id}/
pacotes/{user_id}/    legendas/{user_id}/
```

(`{user_id}/` cobre a entrada **e** `assets/`.)

**2. Revogue as contas do Instagram.** Só agora, porque uma falha no passo 1
ainda deixava a conta utilizável:

```sql
-- os tokens, enquanto as linhas existem (guarde o resultado)
select * from public.ig_account_tokens('<uuid do usuário>');
```

Revogue cada uma na Meta: `DELETE /{ig_user_id}/permissions`, com o token
decifrado no `Authorization: Bearer`.

**3. O purge**, que também anonimiza a auditoria:

```sql
select public.purge_account('<uuid>', '<código ou uma marca sua>');
```

**4. Apague o usuário** em Authentication → Users.

> **Nunca apague o usuário no painel do Supabase como primeiro passo.** O
> cascade limpa as tabelas, mas `audit_log` e `data_requests` são
> `on delete set null`: o `user_id` vira nulo e o **IP, o `target` e a `meta`
> ficam** — dado pessoal de alguém que pediu para ser esquecido, agora sem a
> coluna que permitiria encontrá-lo. É exatamente a falha que `purge_account`
> existe para evitar, e ela já aconteceu neste projeto (12 linhas com IP no
> ambiente de desenvolvimento, achadas na Fase 10 e limpas pela migration 0024).
>
> Se acontecer de novo, a faxina é:
> ```sql
> update public.audit_log set ip = null, target = null, meta = '{}'::jsonb
>  where user_id is null and action <> 'account.deleted'
>    and (ip is not null or target is not null or meta <> '{}'::jsonb);
> ```

### Verificar que terminou

```sql
select
  (select count(*) from public.jobs        where user_id = '<uuid>') as jobs,
  (select count(*) from public.ig_accounts where user_id = '<uuid>') as contas,
  (select count(*) from public.profiles    where id      = '<uuid>') as perfil,
  (select count(*) from public.audit_log   where user_id = '<uuid>') as auditoria;
-- tudo zero.
```

E no R2, que os seis prefixos não devolvem objeto nenhum.
