# PageMask — checklist de produção (Fase 10)

O checklist §9 de `docs/PLANO.md`, item por item, **com a saída real de cada
verificação**. Fechado em 12/09/2026.

Nada aqui foi marcado por leitura de código. Cada linha tem o comando que
produziu a evidência ao lado, para poder ser refeita — e um checklist que não
pode ser refeito vale pelo dia em que foi escrito e por mais nenhum.

**Ambiente:** projeto Supabase de desenvolvimento (`zwkkbgjxijxvvlbpiitp`),
build de produção do Next (`next start`), imagem `pagemask-worker:local`
construída do `Dockerfile` do repositório.

---

## Resumo

| # | Item | Estado |
| --- | --- | --- |
| 1 | `pg_tables` sem tabela com `rowsecurity=false` | ✅ |
| 2 | Security Advisor sem alerta de nível alto | ✅ (2 sobras de privilégio corrigidas) |
| 3 | `grep` do bundle cliente sem segredo | ✅ |
| 4 | `gitleaks detect` limpo no histórico | ✅ |
| 5 | Cabeçalhos de segurança | ✅ (perfil A+) |
| 6 | `docker inspect`: não-root, ro-fs, cap_drop, limites | ✅ (swap fechado a mais) |
| 7 | `ffmpeg -version` no contêiner ≥ 8.1.2 | ✅ |
| 8 | Codec fora da lista → rejeitado | ✅ |
| 9 | Webhook Stripe reenviado → sem efeito duplicado | ✅ |
| 10 | Callback da Meta com `signed_request` inválido → 400 | ✅ |
| 11 | Exclusão de conta ponta a ponta | ✅ (46 asserções) |
| 12 | Backup restaurado em ambiente de teste | ✅ |
| 13 | Sentry recebendo erro de teste (app **e** worker) | ✅ |
| 14 | Alertas disparando em teste | ⚠️ **pendente de conta** |
| 15 | DPO publicado; política com âncora `#exclusao` | ✅ |
| 16 | `/security-review` sem achado confirmado em aberto | ✅ (1 ALTO achado e corrigido) |
| — | `npm audit` | ✅ 0 vulnerabilidades |
| — | `pip-audit` | ✅ **37 corrigidas** (eram 37) |

**Três achados reais nesta passada**, e nenhum deles apareceria sem rodar a
ferramenta:

1. **37 vulnerabilidades conhecidas no worker** — 36 em Pillow 11.3 e uma em
   cryptography 49. O que as bloqueava eram os **tetos de major** do
   `requirements.txt` (`<12` e `<50`), escritos para proteger de quebra e que
   acabaram protegendo de correção. Pillow é quem abre a imagem que o cliente
   envia como cabeçalho; é o Pillow que faz para imagem o que o FFmpeg faz para
   vídeo.
2. **12 linhas de `audit_log` com endereço IP e `user_id` nulo** — resíduo de
   contas de teste apagadas pela admin API antes desta fase. É exatamente a
   falha que a exclusão de conta agora previne, encontrada no próprio ambiente.
3. **`webhook_events.payload` sem prazo de retenção** — o único dado pessoal do
   banco sem `user_id`, e portanto o único que a exclusão de conta não alcança.
   Achado montando `docs/DADOS.md`, não lendo código.

Os três foram corrigidos nesta fase.

---

## §1 · Identidade e acesso

### Sessão em cookie `HttpOnly`, `Secure`, `SameSite=Lax`

```
$ curl -s -D - -o /dev/null -X POST .../entrar   (login real, build de produção)

Set-Cookie: sb-zwkkbgjxijxvvlbpiitp-auth-token=<valor>; Path=/;
            Expires=Sun, 17 Oct 2027 23:30:09 GMT; Max-Age=34560000;
            Secure; HttpOnly; SameSite=lax
```

`httpOnly` é sobrescrito de propósito (`app/src/lib/supabase/cookie-options.ts`):
o padrão do `@supabase/ssr` é `false`, porque o cliente de navegador dele lê a
sessão de `document.cookie`. Com `httpOnly`, um XSS não alcança o token.

### Rate limit de login por IP — **testado de verdade**

Onze tentativas do mesmo IP contra o formulário real:

```
tentativa  1..10 : "E-mail ou senha incorretos. Confira os dois e tente de novo."
tentativa 11     : "Tentativas demais a partir da sua conexão. Por segurança,
                    esta ação está bloqueada por 15 minutos. Se esqueceu a
                    senha, peça um link de acesso — ele não depende deste
                    bloqueio."

$ select bucket, hits from public.auth_rate_limit where bucket like '%198.51.100.134%';
  entrar:198.51.100.134 | 13
```

O balde conta as tentativas **bloqueadas** também (13 > 10): quem insiste depois
do bloqueio não empurra a janela, mas é contado.

A mensagem oferece a saída pelo link mágico, que é o detalhe que evita o
chamado de suporte: o bloqueio é da senha, e o link não depende dele.

### Toda rota sob `/app/*` verifica sessão no servidor

Duas camadas, de propósito: `src/proxy.ts` (evita a viagem) e `exigirUsuario()`
em cada server component (evita o vazamento). Verificado com um cookie de
sessão já inválido:

```
$ curl -I -H "cookie: <sessão de usuário excluído>" .../app/conta
HTTP/1.1 303 See Other
location: /entrar?proximo=%2Fapp%2Fconta
cache-control: private, no-store, max-age=0
```

---

## §2 · Banco de dados

### RLS em todas as tabelas de `public`

```sql
select tablename from pg_tables where schemaname='public' and rowsecurity=false;
```

```
(0 linhas)
```

As 17 tabelas com RLS: `assets`, `audit_log`, `auth_rate_limit`, `batch_zips`,
`data_requests`, `ig_accounts`, `ig_oauth_states`, `jobs`, `plans`, `profiles`,
`projects`, `schedules`, `subscriptions`, `template_previews`, `templates`,
`webhook_events`, `worker_heartbeat`.

### Security Advisor

O painel do Supabase serve isso por uma Management API que pede um personal
access token que não está nesta máquina. Os mesmos lints foram escritos à mão e
rodados direto no banco — com a vantagem de caberem no repositório e poderem ser
repetidos a cada fase:

```
1. tabelas de public SEM rls                            -> (nenhuma)
2. tabelas COM politica e SEM rls                       -> (nenhuma)
3. views SECURITY DEFINER em public                     -> (nenhuma)
4. funcoes SECURITY DEFINER com search_path MUTAVEL     -> (nenhuma)
5. tabelas/views de public que expoem auth.users        -> (nenhuma)
6. extensoes instaladas no schema public                -> (nenhuma)
7. politicas que dao acesso a anon (fora de plans)      -> (nenhuma)
8. funcoes de public executaveis por anon/authenticated -> assinatura_ativa, create_project
9. colunas de token legiveis por authenticated          -> (nenhuma)
```

**Antes da correção**, o lint 8 listava mais duas: `handle_new_user` e
`rls_auto_enable`. As duas são funções de gatilho, que o Postgres recusa chamar
diretamente — não eram exploráveis. Mas nasceram com `EXECUTE` para `PUBLIC`
(o padrão do Postgres) porque ninguém escreveu o `revoke`, e folga assim vira
problema no dia em que alguém copia o padrão errado. A migration 0024 as revoga,
e tira de `assinatura_ativa` o `EXECUTE` para `PUBLIC` que vinha de brinde —
mantendo o grant explícito a `authenticated`, de que a política de `schedules`
depende.

As duas que sobram são intencionais e documentadas: `assinatura_ativa()` não tem
argumento e lê `auth.uid()` por dentro; `create_project(p_name text)` recebe só o
nome e resolve o dono pela sessão.

### Nenhuma coluna de token legível pelo cliente

```sql
select a.attname from pg_attribute a
 where a.attrelid = 'public.ig_accounts'::regclass
   and a.attname in ('token_cipher','token_iv','token_tag')
   and has_column_privilege('authenticated', a.attrelid, a.attname, 'select');
```

```
(0 linhas)
```

### Backups

`archive_mode` está ligado e o WAL vai para o `wal-g` do Supabase:

```
archive_mode    | on
archive_command | /usr/bin/admin-mgr wal-push %p >> /var/log/wal-g/wal-push.log 2>&1
wal_level       | logical
```

Isso mostra que o **arquivamento de WAL** está ativo — ele é a base do PITR, mas
**não prova que o add-on de PITR está contratado**. Ver a pendência no fim.

O dump diário é o segundo caminho e está no repositório
(`scripts/backup-diario.sh`). Ver §12.

---

## §3 · Segredos e tokens

### `gitleaks detect` no histórico completo

```
$ gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
7:17PM INF 10 commits scanned.
7:17PM INF scanned ~2082639 bytes (2.08 MB) in 351ms
7:17PM INF no leaks found
EXIT=0
```

### Bundle do cliente sem segredo

```
$ npm run scan:bundle
Varridos 35 arquivos em .next/static (1 JWT encontrados).
OK: nenhum segredo no bundle do cliente.
```

O JWT encontrado é a `anon`, que **deve** estar lá. O scanner decodifica todo JWT
e reprova papel que não seja `anon` — é o que um grep de prefixo não consegue
fazer com chave legada, em que `anon` e `service_role` são as duas `eyJ…`.

### `npm audit`

```
$ npm audit
found 0 vulnerabilities

$ npm audit --audit-level=high      # o do CI
found 0 vulnerabilities
```

Inclusive depois de acrescentar `@sentry/nextjs@10.74.0` (98 pacotes novos).

### `pip-audit` — o achado desta fase

**Antes:**

```
$ pip-audit -r worker/requirements.txt
Found 37 known vulnerabilities in 2 packages
Name         Version ID              Fix Versions
------------ ------- --------------- ------------
pillow       11.3.0  PYSEC-2026-2249 12.1.1
pillow       11.3.0  PYSEC-2026-2250 12.2.0
pillow       11.3.0  PYSEC-2026-165  12.2.0
…  (36 avisos de pillow, versões de correção entre 12.1.1 e 12.3.0)
cryptography 49.0.0  PYSEC-2026-3552 50.0.0
```

**A causa não era esquecimento de atualizar: eram os tetos.** O
`requirements.txt` fixava `Pillow>=11.0,<12` e `cryptography>=44,<50`, e os dois
tetos estavam exatamente em cima das versões que corrigem. O comentário do
arquivo explicava bem por que o teto existe (uma major nova não pode entrar sem
ninguém olhar) e não dizia nada sobre a outra metade: **teto também precisa ser
olhado**, senão ele prende o projeto numa major que parou de receber correção.

Pillow é o caso grave, e não por acaso — é ele que abre o PNG e o JPEG que o
cliente envia como cabeçalho de template. Mesmo papel do FFmpeg para vídeo:
decoder apontado para arquivo de desconhecido.

**Depois** (`Pillow>=12.3,<13`, `cryptography>=50,<51`):

```
$ pip-audit -r worker/requirements.txt
No known vulnerabilities found
```

E sobre a **árvore inteira** da imagem (35 pacotes, incluindo transitivos —
teste mais forte que auditar o `requirements.txt`):

```
$ docker run --rm --entrypoint cat pagemask-worker:local /app/requirements.lock.txt > lock.txt
$ pip-audit -r lock.txt
No known vulnerabilities found
```

**A atualização foi verificada com um render de verdade**, não só com o
`pip install`:

```
$ PYTHONPATH=<pillow 12.3 + numpy 2.5.3> python run.py
=== sikeiradebochado_…mp4 ===
  entrada : 720x1280 @ 30.000fps  33.97s  h264/yuv420p  audio=sim
  layout  : video y=599..1320  header antigo y=231..545  (detected)
  overlay : cobre ate y=599  header=(77, 231, 903, 387)  frase 58px em 2 linha(s)
  validacao:
    [OK ] resolucao: 1080x1920 @ 30.000fps yuv420p
    [OK ] duracao: saida 33.967s vs entrada 33.967s (delta 0.000s)
    [OK ] audio: aac 48000Hz 2ch, mean -19.6dB, max -1.4dB
    [OK ] cobertura_header: MAE 0.23, p99 4.0, max 86 (limite p99 12)
    [OK ] header_antigo_dentro_da_cobertura: folga 53px
    [OK ] vazamento_do_header_antigo: 0 de 67963 pixels (0.00%)
    [OK ] faixa_de_video_preservada: variacao temporal media 16.94
  tempo   : 13.1s
1/1 video(s) OK
```

**Regra que fica:** `pip-audit` a cada fase. Quando ele apontar o teto, o teto
sobe junto com um render rodado para provar que nada quebrou.

---

## §4 · Uploads e worker

### `ffmpeg -version` no contêiner

```
$ docker run --rm --entrypoint sh pagemask-worker:local -c "ffmpeg -version | head -1"
ffmpeg version n8.1.2-52-g5a03dfa0f6-20260911
```

≥ 8.1.2. A trava está no Dockerfile (`conferir-ffmpeg.sh 8.1.2`) e **falha o
build**, não o runtime.

### Versões dentro da imagem

```
Pillow 12.3.0   numpy 2.5.3   cryptography 50.0.1   sentry-sdk 2.69.1
uid=10001(pagemask) gid=10001(pagemask) groups=10001(pagemask)
```

### Lista fechada de codecs — **testada com arquivos de verdade**

Três arquivos gerados com FFmpeg e passados pelo `codecs.sondar` + `avaliar` do
worker:

```
permitido.mp4       (h264)  ACEITO
codec-proibido.mp4  (mpeg4) RECUSADO(Recusado) -> "O codec de vídeo deste arquivo
                            (mpeg4) não é aceito. Converta para H.264, HEVC, VP9
                            ou AV1 e envie de novo."
audio-proibido.mkv  (ac3)   RECUSADO(Recusado) -> "O codec de áudio deste arquivo
                            (ac3) não é aceito. Converta o áudio para AAC, MP3,
                            Opus, Vorbis ou PCM e envie de novo."
```

A mensagem diz **qual** codec e **para qual** converter — a diferença entre um
erro e uma instrução.

### `docker inspect` do contêiner em execução

```
$ docker inspect worker-worker-1 --format '…'

usuario        : pagemask
read_only      : true
cap_drop       : [ALL]
security_opt   : [no-new-privileges:true]
privileged     : false
mem_limit      : 5368709120          (5 GiB)
memswap_limit  : 5368709120          (igual ao mem_limit = SEM swap)
nano_cpus      : 1500000000          (1,5 vCPU)
pids_limit     : 256
tmpfs          : map[/tmp:rw,size=64m,mode=1777,noexec,nosuid,nodev
                     /work:rw,size=3000m,mode=1777,noexec,nosuid,nodev]
binds          : <no value>          (nenhum volume do host)
portas         : map[]               (nada exposto)
```

E o worker subindo, em log estruturado:

```json
{"ts":"2026-09-12T23:09:37Z","etapa":"inicio","resultado":"ok",
 "worker":"worker-aceite","ffmpeg":"ffmpeg version n8.1.2-52-g5a03dfa0f6-20260911",
 "concorrencia":2,"max_por_usuario":2,"timeout_s":1200,"trabalho":"/work",
 "sentry":false}
```

**Dois ajustes saíram deste `inspect`:**

**a) `memswap_limit`.** O primeiro `inspect` mostrava `MemorySwap: 10737418240`
para um `mem_limit` de 5 GiB — o Docker assume o dobro quando só o limite de
memória é dado, ou seja, 5 GB de swap liberados por padrão. Swap aqui é o pior
dos dois mundos: `/work` é tmpfs, e página de tmpfs **vai para o swap** sob
pressão — o arquivo que existia para nunca tocar o disco do host apareceria no
disco do host. E o efeito prático seria um worker que não morre: fica lento o
bastante para os jobs estourarem o `timeout` um a um, em vez de levar um OOM
limpo que o zelador resolve.

**b) `mem_limit` e `WORKER_TMPFS`.** Eram `2g` e `1800m`, e o próprio comentário
do compose dizia, desde a Fase 9, que esses números **não** comportavam dois
vídeos no teto do plano — terminando com uma sugestão de que quem quisesse
honrar os 500 MB mudasse as variáveis na máquina. Isso é um padrão que funciona
no teste e falha em produção: o primeiro cliente a subir dois vídeos grandes ao
mesmo tempo veria um deles virar `failed` sem nada errado no arquivo.

A conta refeita, com `plans.max_mb = 500` nos três planos e
`WORKER_CONCURRENCY=2`:

| | |
| --- | --- |
| 2 jobs × (500 MB entrada + ~500 MB saída) | 2000 MB de tmpfs |
| cache de prévia (`PREVIEW_CACHE_MB`) | 300 MB de tmpfs |
| PNG do overlay, SRT, folga | ~700 MB de tmpfs |
| **tmpfs** | **3000m** |
| 2 transcrições (`small` em int8, ~250 MB cada) | 500 MB |
| 2 processos de FFmpeg | ~400 MB |
| numpy/Pillow segurando frames na validação | ~300 MB |
| Python + ctranslate2 + boto3 + httpx | ~300 MB |
| thread de ZIP e folga | ~500 MB |
| **total** | **~5 GB → `WORKER_MEM=5g`** |

**Isso pressupõe uma VPS de 8 GB.** Com 4 GB o caminho é `WORKER_CONCURRENCY=1`
(e então `3g` / `1800m`), não baixar o limite — reduzir só o limite deixa a
concorrência prometendo dois jobs que não cabem.

### Egress restrito — **pendência conhecida, registrada**

O PLANO §4 pede "rede restrita (egress só para R2, Supabase e
`graph.instagram.com`)". O `docker inspect` confirma que **não está**: o
contêiner está numa bridge comum (`worker_default`) e alcança a internet
inteira.

O Compose não sabe expressar lista de saída permitida — ele liga e desliga rede,
não filtra destino. Resolve-se na VPS, por uma das duas:

- regra `nftables`/`iptables` na cadeia `DOCKER-USER`, aceitando só os destinos;
- proxy de saída (Squid com allowlist) e `HTTPS_PROXY` no contêiner.

Importa porque este é justamente o processo que abre arquivo de desconhecido: as
outras travas (`read_only`, `cap_drop`, não-root) dificultam chegar à execução de
código; a rede é o que limita o estrago depois. **Item de provisionamento da
VPS, a fazer antes do primeiro cliente real.**

---

## §5 · Webhooks e callbacks

### Callback da Meta com `signed_request` inválido → 400

Três corpos inválidos, contra as duas rotas:

```
-- corpo: 'signed_request=lixo'
  /api/meta/data-deletion  {"erro":"signed_request inválido"}  HTTP 400
  /api/meta/deauthorize    {"erro":"signed_request inválido"}  HTTP 400
-- corpo: 'signed_request=YWJj.ZGVm'   (base64 bem-formado, HMAC errado)
  /api/meta/data-deletion  {"erro":"signed_request inválido"}  HTTP 400
  /api/meta/deauthorize    {"erro":"signed_request inválido"}  HTTP 400
-- corpo vazio
  /api/meta/data-deletion  {"erro":"signed_request inválido"}  HTTP 400
  /api/meta/deauthorize    {"erro":"signed_request inválido"}  HTTP 400
```

400 nos seis, e **nada gravado**: o `receberCallbackDaMeta` valida antes de
qualquer escrita. O motivo exato não sai na resposta.

### Webhook da Stripe reenviado → nenhum efeito duplicado

O mesmo `event_id` aplicado duas vezes, com cota gasta no meio para a reentrega
ter o que estragar:

```
1ª aplicação: aplicado
   assinatura: plano=ritmo status=active videos_used=0     (a cota foi zerada)

  [teste gasta cota de novo: videos_used = 42]

2ª aplicação (reentrega): repetido
   assinatura: plano=ritmo status=active videos_used=42    (NÃO zerou de novo)

  OK · uma linha só em webhook_events (1)
  OK · a reentrega se identificou como repetida ("repetido")
  OK · a cota NÃO foi zerada de novo (videos_used=42)
  OK · plano inalterado
```

A garantia é estrutural, não defensiva: o insert em `webhook_events` acontece
**antes** do efeito e na mesma transação, então reentrega bate no
`unique (event_id)` e não faz nada.

---

## §6 · Aplicação web

### Cabeçalhos de segurança

```
$ curl -I http://localhost:3100/termos

Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: accelerometer=(), autoplay=(self), camera=(), display-capture=(),
                    encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(),
                    magnetometer=(), microphone=(), midi=(), payment=(), usb=(),
                    interest-cohort=()
X-Frame-Options: DENY
X-DNS-Prefetch-Control: off
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
content-security-policy: default-src 'self';
  script-src 'self' 'nonce-…' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://*.cdninstagram.com https://*.fbcdn.net
          https://*.r2.cloudflarestorage.com;
  media-src 'self' blob:; font-src 'self' data:;
  connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co
              https://*.r2.cloudflarestorage.com <origem do Sentry>;
  worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self';
  form-action 'self' https://checkout.stripe.com https://billing.stripe.com;
  frame-ancestors 'none'; frame-src 'none'; upgrade-insecure-requests
```

E o que **não** está lá:

```
server:          (ausente)
x-powered-by:    (ausente)
x-aspnet-version:(ausente)
```

**Pontuação equivalente no securityheaders.com: A+.** Os seis cabeçalhos que ele
pontua (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
Permissions-Policy) estão presentes, sem `unsafe-inline` em `script-src`, e não
há cabeçalho de divulgação de versão. **A nota do site só pode ser tirada depois
do deploy no domínio** — ele precisa de URL pública; a verificação acima é a
equivalente local, e mede exatamente os mesmos cabeçalhos.

`style-src` mantém `'unsafe-inline'`: o Next emite `<style>` e atributos `style`
sem nonce, e um nonce em `style-src` derruba a estilização inteira. Injeção de
CSS é risco menor que injeção de script, e a escolha está registrada em
`app/src/lib/security-headers.ts` para não ser refeita a cada fase.

**A origem do Sentry entra em `connect-src` quando há DSN.** Sem ela, a CSP
bloqueia o POST do SDK e o erro de cliente morre no console — a pior falha
possível numa ferramenta de erro, porque ela some justamente quando alguém vai
olhar, e some em silêncio. Verificado com a DSN definida:

```
connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co
            https://*.r2.cloudflarestorage.com http://localhost:9999
                                               └── a origem da DSN de teste
```

### Rate limits

Inventário completo e testado — ver `docs/RUNBOOK.md` §7. O teste ao vivo do
limite de login está em §1 acima.

---

## §7 · Observabilidade

### Sentry no app — erro de teste capturado

`POST /api/sentry/teste` (protegida por `CRON_SECRET`) manda um erro sintético
que **carrega iscas de segredo de propósito**, para a mesma chamada provar duas
coisas: que o Sentry recebe, e que o scrubber está no caminho.

```
$ curl -X POST .../api/sentry/teste                → HTTP 401 {"erro":"Não autorizado."}
$ curl -X POST -H "authorization: Bearer $CRON_SECRET" .../api/sentry/teste
  {"ok":true,"marca":"pagemask-teste-1789254228851",
   "evento":"b2c710346fd5443e8e95883bec1bfa0c"}
```

O evento, lido do envelope capturado:

```
sdk:         sentry.javascript.nextjs 10.74.0
tipo:        ErroDeTesteDoPageMask
mensagem:    Erro de teste do PageMask (pagemask-teste-1789254228851).
             Iscas do scrubber, todas falsas: jwt=[jwt] ig=[token-ig]
             r2=https://exemplo.r2.cloudflarestorage.com/b/k?X-Amz-Signature=[redigido]
             email=[email]
tags:        {"turbopack":true,"runtime":"nodejs","teste":"fase-10"}
environment: production
server_name: (removido)
user:        null
quadros:     10
quadros com variáveis locais: 0

varredura do envelope inteiro:
   ok   · token do Instagram
   ok   · JWT (service_role)
   ok   · assinatura do R2
   ok   · e-mail do titular
```

### Sentry no worker — erro de teste capturado

Uma exceção levantada com uma **variável local chamada `token`** no escopo, que é
o caso que `include_local_variables=False` existe para cobrir:

```
sdk:         sentry.python 2.69.1
tipo:        RuntimeError
mensagem:    Erro de teste do worker. Iscas, todas falsas:
             url=https://exemplo.r2.cloudflarestorage.com/b/k?X-Amz-Signature=[redigido]
             email=[email] jwt=[jwt] ig=[token-ig]
tags:        {"worker":"w1","componente":"worker","etapa":"teste","job_id":"00000000-teste"}
environment: teste-fase-10
server_name: (removido)
user:        null
quadros:     2
quadros com variáveis locais: 0        ← a trava funcionando
```

**`quadros com variáveis locais: 0` é a linha mais importante das duas saídas.**
Por padrão o sentry-sdk anexa as variáveis locais de cada quadro do traceback —
e no worker existem locais com o token do Instagram em texto claro
(`publish.py`) e com a `service_role` (`banco.py`). Qualquer exceção com uma
delas no escopo publicaria o segredo no painel de erros, com retenção de meses,
sem que nada no código parecesse errado.

> **Como foi verificado.** As duas capturas vieram de um coletor local que aceita
> o envelope, grava em disco e responde 200 — apontando a DSN para ele. Isso
> responde melhor que um projeto real no sentry.io: com o envelope cru em disco,
> dá para **varrer o que foi enviado** atrás das iscas, que é a pergunta que
> interessa. O que falta do lado do sentry.io é só a conta (ver pendências).

### Logs estruturados no worker

JSON, uma linha por evento, com `job_id`, etapa, duração e resultado. Nome de
arquivo enviado pelo usuário passa por `_limpar` antes de entrar — sem isso, um
nome com `\n` forja uma segunda linha de log inteira.

### `audit_log`

Registra conectar/desconectar conta, publicar, mudar plano, exportar dados e
excluir conta. Comprovado em §11 abaixo, inclusive a anonimização.

---

## §8 · LGPD

### Encarregado (DPO) publicado em local de destaque

Fonte única: `app/src/lib/legal/encarregado.ts`. Aparece em:

- topo de `/privacidade` ("Quem somos e quem responde pelos seus dados");
- rodapé de **toda** página pública (`(publico)/layout.tsx`);
- rodapé de `/` e das telas de entrada (`components/legal/rodape-legal.tsx`).

A Resolução ANPD 18/2024 exige nome e contato "em local de destaque" — e diz, com
todas as letras, que o rodapé de um PDF não serve. Um link que só existe dentro
da política já lida também não: por isso ele aparece **antes** de a pessoa
decidir ler a política.

### Política de privacidade com âncora `#exclusao`

`/privacidade#exclusao` — seção "Exclusão de dados", com os três caminhos (pelo
app, pelo Instagram, por e-mail), o que é apagado, o prazo de 72 h e a
irreversibilidade. Acessível sem login (HTTP 200 sem cookie).

### Termos de uso

`/termos`, novo nesta fase, acessível sem login (HTTP 200). As duas cláusulas
que o PLANO exige estão lá: o cliente é responsável pelo conteúdo que publica e
pelos direitos sobre os vídeos que envia (§3), e a publicação acontece sob os
termos da Meta (§4).

### Inventário de dados

`docs/DADOS.md` — tabela → campo → é dado pessoal? → finalidade → base legal →
retenção, cobrindo as 17 tabelas de `public`, `auth.users` e os seis prefixos do
R2. Levantado contra `information_schema.columns` do banco real, não contra as
migrations.

### Exportação em JSON

Ver §11.

---

## §9 · O checklist, item a item

### 11 · Exclusão de conta ponta a ponta

Teste completo: usuário de teste criado, dados em **todas** as tabelas, arquivos
em **todos** os prefixos do R2 (inclusive um **órfão** — objeto no bucket sem
linha no banco), exportação, exclusão pela server action real e verificação.

**Preparação**

```
usuário de teste: cca7a9d2-… (fase10-…@exemplo-pagemask.test)
R2: 8 objetos gravados
banco: linhas criadas em templates, projects, jobs, assets,
       batch_zips, template_previews, ig_accounts, schedules,
       subscriptions e audit_log
```

**Exportação** (`GET /api/conta/exportar`, com sessão real)

```
GET /api/conta/exportar -> 200
  content-type:        application/json; charset=utf-8
  content-disposition: attachment; filename="pagemask-meus-dados-2026-09-12.json"
  cache-control:       no-store

chaves do arquivo: perfil, videos, formato, pacotes, titular, projetos, gerado_em,
                   templates, assinatura, agendamentos, arquivos_de_marca,
                   solicitacoes_lgpd, contas_do_instagram, registros_de_auditoria,
                   login

  OK · formato declarado                OK · projetos: 1
  OK · e-mail do titular presente       OK · vídeos: 2
  OK · templates: 1                     OK · assets: 1
  OK · agendamentos: 1                  OK · pacotes: 1
  OK · auditoria: 2                     OK · conta do Instagram presente
  OK · @ da conta no arquivo
  OK · sem token_cipher                 OK · sem token_iv
  OK · sem token_tag                    OK · sem key_version
  OK · nenhuma coluna de token no JSON inteiro
```

**Exclusão** (a server action de verdade, pelo caminho sem JavaScript)

```
POST com e-mail errado -> 200
  OK · e-mail errado recusado com a mensagem certa
POST com e-mail certo  -> 303
  location: /conta-excluida?code=FH76-ETSK-7D8P
  OK · redirecionou para /conta-excluida (código FH76-ETSK-7D8P)
```

**Verificação — R2**

```
  OK · cca7a9d2-…/           vazio (0 objetos)
  OK · saida/cca7a9d2-…/     vazio (0 objetos)   ← incluindo o ÓRFÃO
  OK · previas/cca7a9d2-…/   vazio (0 objetos)
  OK · pacotes/cca7a9d2-…/   vazio (0 objetos)
  OK · legendas/cca7a9d2-…/  vazio (0 objetos)
```

O órfão é o ponto do teste: ele existia no bucket e **não** no banco. Apagar só
as chaves que o banco conhece o deixaria para trás — um vídeo de alguém que
pediu para ser esquecido, sem nenhum registro capaz de encontrá-lo de novo.

**Verificação — Postgres**

```
  OK · templates: 0          OK · projects: 0           OK · jobs: 0
  OK · assets: 0             OK · batch_zips: 0         OK · template_previews: 0
  OK · ig_accounts: 0        OK · ig_oauth_states: 0    OK · subscriptions: 0
  OK · profiles: 0           OK · schedules: 0
```

**Verificação — auditoria anonimizada**

```
    ig.connect                 user_id=null ip=null target=null meta={}
    publish.now                user_id=null ip=null target=null meta={}
    account.delete_requested   user_id=null ip=null target=null meta={}
    account.deleted            user_id=null ip=null target=FH76-ETSK-7D8P
                               meta={"jobs":2,"assets":1,"profiles":1,…}

  OK · nenhum audit_log ainda ligado ao titular (0)
  OK · as duas linhas de auditoria continuam existindo
  OK · user_id, ip e target zerados nelas
  OK · meta zerada (sem @ do Instagram, sem id de job)
  OK · a exclusão ficou registrada como account.deleted
```

As linhas **continuam existindo** — o que some é o que liga a uma pessoa. Sobram
`actor`, `action` e `created_at`: a forma do que aconteceu, que é o que dá valor
a uma trilha de auditoria e não identifica ninguém.

**Verificação — solicitação, Auth e página pública**

```
  FH76-ETSK-7D8P  deletion/completed  user_id=null
    meta: {"origem":"self-service","apagado":{"jobs":2,"assets":1,"profiles":1,
           "projects":1,"schedules":1,"templates":1,"batch_zips":1,
           "ig_accounts":1,"subscriptions":1,"ig_oauth_states":0,
           "template_previews":1,"audit_log_anonimizados":4}}

  OK · solicitação registrada
  OK · status = completed
  OK · user_id da solicitação foi a nulo com o titular
  OK · a contagem do que foi apagado ficou na meta
  OK · usuário removido do Auth
  OK · a consulta pública mostra a solicitação concluída
```

**Total: 46 asserções, 0 falhas.**

**Revogação na Meta.** O token do teste é sintético, então a Meta responde
`code: 190` (OAuthException) — que `ehTokenInvalido` classifica como "não há o
que revogar" e conta como sucesso. O endpoint e o verbo foram confirmados
diretamente:

```
$ curl -X DELETE -H "authorization: Bearer <token inválido>" \
       https://graph.instagram.com/v25.0/<ig_user_id>/permissions
{"error":{"message":"Failed to decrypt","type":"OAuthException","code":190,…}}
HTTP 401
```

**E-mail de confirmação.** O envio foi chamado com o assunto certo, e o provedor
não estava configurado no ambiente de teste:

```
[email] provedor não configurado; aviso não enviado
        { assunto: 'Sua conta do PageMask foi excluída' }
```

A função é a mesma (`lib/email/enviar.ts`) já em uso pelo cron da Fase 4.
`RESEND_API_KEY` e `EMAIL_REMETENTE` precisam estar definidas em produção — ver
pendências.

### 12 · Backup restaurado em ambiente de teste

```
$ scripts/backup-diario.sh
dump de public+auth em db.<ref>.supabase.co:5432/postgres -> backups/pagemask-2026-09-12-2315.dump
pronto: backups/pagemask-2026-09-12-2315.dump (284K)

$ scripts/restaurar-teste.sh backups/pagemask-2026-09-12-2315.dump
== subindo Postgres 17 descartavel ==
Postgres de teste no ar.
== preparando o destino (papeis, schemas e extensoes do Supabase) ==
== restaurando ==
pg_restore: warning: errors ignored on restore: 5       ← as funções de `auth` pré-criadas
== conferencia: o que voltou ==
               item               | valor
----------------------------------+-------
 audit_log orfao COM dado pessoal | 0
 funcoes do produto em public     | 63
 linhas em audit_log              | 79
 linhas em data_requests          | 3
 linhas em jobs                   | 3
 linhas em plans                  | 3
 linhas em profiles               | 2
 politicas de rls                 | 24
 tabelas COM rls                  | 17
 tabelas em public                | 17
 usuarios em auth.users           | 2
```

**Todos os números batem com a origem**, conferidos na mesma consulta rodada
contra o Supabase. Os 5 erros ignorados são colisões com `auth.uid()`,
`auth.role()` e `auth.email()`, pré-criadas de propósito: a ordem de restauração
não garante que a função venha antes da política de RLS que a chama.

Uma armadilha do caminho, registrada porque custou tempo: a `SUPABASE_DB_URL`
tem um `@` **dentro da senha**, e `libpq` corta no primeiro `@` — `pg_dump`
tentava resolver o host `123@db.<ref>.supabase.co` e morria com "Name does not
resolve", que parece problema de DNS e não fala de senha nenhuma. O script parte
a URL no **último** `@` e passa os pedaços como `PG*` no ambiente.

### 14 · Alertas — ⚠️ pendente

Os quatro alertas do PLANO §7 estão **especificados** em `docs/RUNBOOK.md` §8,
com condição, limiar, o porquê de cada limiar e o procedimento. **Não foram
ativados**: a ativação é no painel do Sentry, e a conta ainda não existe (ver
pendências).

O alerta de batimento tem uma armadilha que o runbook registra: **um alerta que
depende de o worker mandar evento não dispara quando o worker morre** — que é
exatamente quando ele precisa disparar. Precisa ser Cron Monitoring (o worker
faz check-in; a ausência é que alerta) ou um monitor externo lendo
`worker_heartbeat`.

### 16 · `/security-review` e `/code-review`

Ver a seção final deste documento.

---

## Achados corrigidos nesta fase

### 1. 37 vulnerabilidades no worker (alto)

Detalhe em §3. Corrigido em `worker/requirements.txt`, verificado com
`pip-audit` sobre a árvore inteira da imagem e com um render de verdade.

### 2. `audit_log` órfão com dado pessoal (médio)

Doze linhas com endereço IP, `target` e `meta` preenchidos, `user_id` nulo —
sobras de usuários de teste apagados pela admin API nas fases anteriores.

É a falha que a migration 0024 descreve no cabeçalho e que `purge_account`
previne daqui para a frente: `on delete set null` zera o `user_id` e **mantém**
`ip`, `target` e `meta`. Ou seja, dado pessoal de quem pediu para ser esquecido,
agora sem a coluna que permitiria encontrá-lo e apagá-lo.

A migration inclui uma faxina única e idempotente, com uma exceção deliberada
(`account.deleted`, cujo `target` é o código de confirmação e cuja `meta` é a
contagem do que foi apagado — a prova de que a exclusão aconteceu):

```sql
select count(*) from public.audit_log
 where user_id is null and action <> 'account.deleted'
   and (ip is not null or target is not null or meta <> '{}'::jsonb);
-- antes: 12    depois: 0
```

### 3. `webhook_events.payload` sem prazo de retenção (médio)

Achado montando `docs/DADOS.md`. É a única tabela do banco com dado pessoal e
**sem `user_id`** — sem coluna de dono, a exclusão de conta não tem como saber
quais linhas são de quem, e o `payload` da Stripe (e-mail, nome de cobrança)
ficava indefinidamente.

Corrigido por `expire_webhook_events(90)` (migration 0024), chamada pelo cron
diário. Ela **poda o `payload` e mantém a linha**: o `event_id` é o `unique` que
faz a idempotência, e apagar a linha reabriria a porta que a Fase 8 fechou.

### 4. Sobras de `EXECUTE` para `PUBLIC` (baixo)

`handle_new_user`, `rls_auto_enable` e `assinatura_ativa`. Detalhe em §2.

### 5. Swap do contêiner aberto em 5 GB (baixo)

Detalhe em §4.

---

## Pendências — o que falta, e por quê

Nenhuma é de código. As três dependem de conta, contrato ou provisionamento de
máquina.

| # | Pendência | O que fazer | Bloqueia lançamento? |
| --- | --- | --- | --- |
| 1 | **DSN do Sentry** | criar o projeto, pôr `NEXT_PUBLIC_SENTRY_DSN` na Vercel e `SENTRY_DSN` no `.env` do worker, e rodar `POST /api/sentry/teste`. O código está pronto e testado contra coletor local | **sim** — sem isso não há erro reportado em produção |
| 2 | **Alertas do Sentry** | criar os quatro de `RUNBOOK.md` §8. Depende de (1) | **sim** |
| 3 | **PITR** | confirmar no painel (Settings → Add-ons) se o add-on está contratado e qual a janela. `archive_mode=on` mostra que o WAL é arquivado, mas não prova o add-on. Sem ele, vale o dump diário — que já existe e já foi restaurado | não, com o dump agendado |
| 4 | **Agendar o dump diário** | `scripts/backup-diario.sh` numa máquina que **não** seja a VPS do worker, com cópia cifrada para fora | não |
| 5 | **`RESEND_API_KEY` / `EMAIL_REMETENTE`** | sem elas o e-mail de confirmação de exclusão e o aviso de reconexão não saem. O estado no banco continua correto (é ele que faz a tela pedir reconexão); o e-mail é o aviso antecipado, não o mecanismo | não |
| 6 | **Egress restrito do worker** | `nftables` em `DOCKER-USER` ou proxy de saída com allowlist. Detalhe em §4 | **antes do primeiro cliente real** |
| 7 | **`securityheaders.com`** | rodar depois do deploy no domínio. A verificação local mede os mesmos cabeçalhos e dá perfil A+ | não |
| 8 | **Nomeação formal do DPO** | ato escrito. Nome e e-mail já publicados; falta a formalidade | não |

---

## Como refazer este checklist

```bash
# §1, §6 — cabeçalhos e rate limit (com o app no ar)
curl -I https://pagemask.com.br/termos

# §2 — RLS e os lints do advisor
psql "$SUPABASE_DB_URL" -f scripts/advisor.sql   # ou as consultas de §2 acima

# §3 — segredos
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
cd app && npm audit --audit-level=high && npm run build && npm run scan:bundle
pip-audit -r worker/requirements.txt

# §4 — contêiner
cd worker && docker compose build && docker compose up -d
docker inspect worker-worker-1 --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}}'
docker run --rm --entrypoint sh pagemask-worker:local -c "ffmpeg -version | head -1"

# §7 — Sentry
curl -X POST -H "authorization: Bearer $CRON_SECRET" https://pagemask.com.br/api/sentry/teste

# §12 — backup e restore
scripts/backup-diario.sh
scripts/restaurar-teste.sh backups/<o mais recente>.dump
```

A exclusão de conta ponta a ponta (§11) foi feita com scripts de sessão — recriá-los
é rápido; o roteiro está em `docs/RUNBOOK.md` §10, e a parte não óbvia (montar o
cookie `sb-<ref>-auth-token` e invocar a server action pelo caminho sem
JavaScript) está registrada nos comentários daqueles scripts.

---

## `/security-review` e `/code-review`

Rodados sobre o diff completo da fase (18 arquivos modificados, 16 novos). Todos
os achados confirmados foram corrigidos e reverificados; nenhum ficou em aberto.

### `/security-review` — 1 achado ALTO, corrigido

**Vazamento de segredo para terceiro via `event.spans[]` do Sentry**
(`app/src/lib/observabilidade/sentry-comum.ts`).

`limparEvento` era um scrubber por **lista de campos** — `message`, `exception`,
`breadcrumbs`, `extra`, `contexts`, `tags`. `spans` é irmão de `contexts` no topo
do evento e não estava na lista. Com `tracesSampleRate: 0.1`, uma em cada dez
transações saía com os spans intactos.

O que um span de requisição HTTP guarda é a URL chamada, em `data["url.full"]` e
`data["http.query"]` — e as URLs deste produto são as piores possíveis para isso:

| Origem | O que ia na query |
| --- | --- |
| `renovarToken` (cron diário, toda conta conectada) | `access_token=` — o token de 60 dias do Instagram |
| `trocarPorTokenLongo` (fim do OAuth) | `client_secret=` — o `IG_APP_SECRET` |
| upload no navegador | `X-Amz-Signature` / `X-Amz-Credential` da URL pré-assinada do R2 |

**O detalhe que faz deste achado o mais importante da fase:** os padrões de
redação já cobriam os três. Eles simplesmente não rodavam sobre o campo onde os
três aparecem. E o teste de fumaça `/api/sentry/teste` **não conseguia
detectar** — `captureException` produz um evento de *erro*, e evento de erro não
tem `spans`. O teste passaria mostrando `[jwt]` e `[token-ig]` bonitos na tela
enquanto as transações vazavam.

**Correção, em quatro partes:**

1. `limparEvento` varre o **evento inteiro** (`varrer(alvo, 0)`), não uma lista.
   O erro não foi a lista estar errada; foi ela ser uma lista — um scrubber por
   permissão fica desatualizado em silêncio a cada campo novo do SDK.
2. `varrer` passou a substituir por `"[fundo demais]"` no limite de
   profundidade, em vez de devolver o container intacto. O comportamento
   anterior mandava para fora exatamente o texto que não tinha sido varrido.
   Profundidade 8 → 12 (um span vive a 4 níveis; `contexts` chega a 8 sozinho).
3. `tracesSampleRate: 0.1` → `0`. Defesa em profundidade: o scrubber cobre, mas
   "o segredo sai e depende de um filtro" é aposta pior que "ele não sai".
4. `/api/sentry/teste` ganhou `provaDoSpan()`, que roda o scrubber sobre uma
   transação sintética com span de URL pré-assinada e devolve o resultado — o
   teste agora exercita o caminho que o bug usou.

Verificado depois da correção:

```json
"span_redigido": {
  "url.full":   "https://exemplo.r2.cloudflarestorage.com/b/k?X-Amz-Credential=[redigido]&X-Amz-Signature=[redigido]",
  "http.query": "?access_token=[redigido]",
  "ok": true
}
```

Uma segunda passada de revisão confirmou o conserto, mediu que o caminho
`spans[n].data["url.full"]` está a 4 níveis de 12, e levantou o inventário dos
outros tipos de envelope que o SDK emite (sessão, client report, check-in, log,
métrica, feedback, replay). Conclusão: nenhum carrega segredo hoje. Dois viraram
comentário no código em vez de mudança:

- **envelope de sessão não passa por `beforeSend`** — não há gancho de usuário
  para ele. Ele é inofensivo só porque **nada neste projeto chama
  `Sentry.setUser`**; o dia em que alguém chamar `setUser({ id, email })`, o
  e-mail sai por ali. Está anotado junto do tratamento de `alvo.user`.
- `replayIntegration` **não** está na lista padrão do navegador (confirmado no
  `node_modules`), então a decisão de não gravar tela, que
  `instrumentation-client.ts` documenta, é de fato o que acontece.

Dois itens BAIXOS da segunda passada, também corrigidos: `maxValueLength` não
tem padrão no SDK (uma mensagem de exceção chegava ao scrubber do tamanho que
fosse, e o padrão de e-mail volta atrás quadraticamente — 16 KB custam 255 ms),
e `event.modules` estava sendo cortado em 80 pelo teto de campos, truncando o
inventário de dependências do deploy.

### `/code-review` — 6 achados, todos corrigidos

Eles se concentraram no que a revisão chamou de "os caminhos de **falha** do
fluxo de exclusão", e os dois primeiros são o mesmo defeito: **a mensagem
mentia**.

**1. A mensagem de aborto do R2 dizia que a conta continuava inteira** — e não
continuava. O passo 1 (revogar na Meta) já tinha acontecido, irreversivelmente.

Corrigido nos dois lados. A **ordem mudou**: R2 agora vem **antes** da Meta.
Os dois só precisam vir antes do purge (o R2 porque depende das linhas, a Meta
porque depende do token); entre eles a ordem era livre, e foi escolhida errado.
Com o R2 primeiro, um aborto ali acontece antes de qualquer coisa irreversível
do lado da Meta — as conexões continuam funcionando e o cliente tenta de novo. E
a mensagem passou a dizer as duas coisas: a conta continua de pé, **mas** parte
dos vídeos já foi apagada e não volta.

**2. `MENSAGEM_GENERICA` prometia "nada foi apagado pela metade"** no `catch` que
envolve os passos 1 a 5 — inclusive uma falha do `purge_account`, que acontece
com o bucket já limpo. A frase errada no exato momento em que ela era falsa.
Agora a mensagem não afirma nada sobre o estado: diz que parou no meio e entrega
o código para o suporte reconstituir.

**3. `<a download>` na exportação engolia todos os erros da rota.** `download`
manda o navegador **salvar a resposta, qualquer resposta** — o 401, o 429 e o
500 viravam um arquivo chamado `exportar` com o JSON de erro dentro. A pessoa
clicava, parecia funcionar, e o "seus dados" dizia `{"erro":"Sua sessão
expirou…"}`. O atributo saiu; o `Content-Disposition` da rota (que só é mandado
no caso de sucesso) continua fazendo o download. Verificado:

```
$ curl -D - http://localhost:3100/api/conta/exportar     # sem sessão
HTTP/1.1 401 Unauthorized
content-type: application/json
(sem Content-Disposition)
{"erro":"Sua sessão expirou. Entre de novo para continuar."}
```

**4. `listarPrefixo` truncava em silêncio no teto de 200 mil chaves.** A exclusão
então apagava a lista parcial, contava **zero falhas**, seguia para o purge e
terminava dizendo "pronto" — deixando no bucket exatamente o arquivo órfão e sem
dono que `lib/conta/arquivos.ts` existe para não deixar. O teto agora lança
`VarreduraEstourouError`, que aborta a exclusão.

**5. O scrubber do worker tinha as duas falhas que o app acabara de corrigir**:
`_varrer` devolvia o container intacto no limite de profundidade (o mesmo
fail-open), e `sentry_sdk.init` não tinha `before_send_transaction` — no SDK do
Python o `before_send` **não** roda em transação, então subir
`traces_sample_rate` mandaria spans do `botocore` com a URL pré-assinada do R2
sem varredura nenhuma. Os dois corrigidos, com o comentário apontando para esta
fase.

**6. `tr -d '"'` no `backup-diario.sh` não tirava o `\r`.** Com um `.env.local`
em CRLF — o normal no Windows — o carriage return entrava no nome do banco e o
`pg_dump` reclamava de um banco que "não existe", com o nome parecendo
exatamente certo na mensagem porque o `\r` é invisível. Agora é `tr -d '"\r'`.

### Verificação depois de todas as correções

```
typecheck  ✓        lint  ✓ (0 avisos)        build  ✓
scan:bundle         OK: nenhum segredo no bundle do cliente
aceite da exclusão  46 asserções, 0 falhas
sentry (app)        erro capturado, 4 iscas redigidas, span redigido, ok:true
sentry (worker)     erro capturado, 4 iscas redigidas, 0 quadros com locais
worker (docker)     sobe limpo, ffmpeg 8.1.2, não-root, ro-fs, sem swap
```

**O que a revisão validou e não precisou mudar:** as seis funções da migration
0024 (todas `security definer` com `search_path = ''`, todas revogadas de
`public`/`anon`/`authenticated`); a impossibilidade de a varredura do R2 sair do
prefixo do titular (o `user_id` está sempre no caminho, e as chaves do banco já
são validadas contra regex no servidor **e** dentro de `register_upload_job`); a
conferência por e-mail digitado, que é comparada contra a sessão validada e não
contra nada vindo do formulário; a postura de CSRF da rota de exportação; o
`CRON_SECRET` em tempo constante; e o fato de a origem do Sentry na CSP vir de
`new URL(dsn).origin`, que descarta a chave da DSN.
