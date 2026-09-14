# PageMask — Plano de execução · Revisão 2

> **Revisão 2 · 02/09/2026.** Substitui a Revisão 1 (31/08/2026), preservada em
> `docs/PLANO-rev1.md`. O que mudou e por quê está em
> [Registro de revisões](#registro-de-revisões) e resumido logo abaixo.

---

## Resumo executivo

Leia só esta seção se tiver cinco minutos. O resto do documento é o detalhe de cada
ponto, na mesma ordem.

### O produto

- **PageMask** é um SaaS por assinatura para páginas temáticas do Instagram: o
  cliente sobe uma pasta de vídeos, define um padrão visual uma vez, e recebe o lote
  inteiro editado, verificado e publicado nas contas conectadas.
- O motor de edição **já existe e está validado** (`worker/`): FFmpeg + Pillow, 34 s de
  vídeo em ~20 s de CPU, sete validações automáticas por arquivo. Ele não é reescrito
  em nenhuma fase — vira serviço.
- O diferencial defensável não é volume (os concorrentes já brigam por isso): é
  **detecção automática do layout + prova de que o cabeçalho antigo foi coberto**.
  Nem Viralyzer nem MyPageFlow oferecem isso.

### Decisões registradas — confirme antes da Fase 0

| Decisão | Registrado | Observação |
| --- | --- | --- |
| Nome | **PageMask** | domínio `pagemask.com.br` a registrar na Fase 0 |
| Escopo da v1 | **com publicação automática no Instagram** | por isso as fases de conector e publicação foram antecipadas |
| Cobrança | **Stripe** | cartão no lançamento; Pix depende de liberação (ver abaixo) |

### O que mudou da Revisão 1 para a 2

- **Conexão do Instagram sem Página do Facebook.** A Rev 1 usava Facebook Login +
  Páginas (5 permissões, cliente precisa ter Página vinculada). A Rev 2 usa
  **Instagram API with Instagram Login** (Business Login for Instagram): o cliente
  clica, abre a janela do Instagram, autoriza, pronto. Duas permissões, zero Página.
  É o que você pediu — e é oficialmente suportado pela Meta para publicar Reels.
- **Storage sai do Supabase e vai para Cloudflare R2.** Egress zero. A Rev 1 já
  apontava banda como maior custo e mantinha a solução cara. Supabase fica só com
  banco e login, onde é ótimo.
- **Pix na Stripe é só por convite para empresas no Brasil** (verificado na página
  oficial em 02/09/2026). Lançamento com cartão; pedido de acesso ao Pix no dia 1;
  Asaas como plano B para Pix se a Stripe não liberar antes do lançamento.
- **Segurança e LGPD entram como seção própria e como cross-check em cada fase.**
  A Rev 1 tinha três regras soltas. A Rev 2 tem regras por camada, um protocolo de
  verificação por fase (`/security-review` + `/code-review` obrigatórios) e a
  adequação à LGPD com encarregado nomeado.
- **Fases reordenadas.** Conector e publicação sobem para logo depois do worker,
  porque o App Review da Meta (≈20 dias em 2026, rejeição comum na primeira) só pode
  ser submetido com o fluxo funcionando de ponta a ponta. Cada dia que isso atrasa é
  um dia a mais de espera no fim.
- **Validação contra a especificação oficial de Reels** entra no worker: moov no
  início, sem edit list, H.264 closed GOP, AAC ≤ 48 kHz, 23–60 fps, ≤ 1920 px de
  largura, 3 s a 15 min, ≤ 300 MB, ≤ 25 Mbps. O que o pipeline já gera passa; a
  validação garante que continue passando.
- **Limite de publicação** deixa de ser o número fixo 50: a documentação da Meta se
  contradiz (50 e 100). O app consulta `content_publishing_limit` por conta e
  mostra o consumo real. Além disso: 400 containers por 24 h e containers expiram
  em 24 h.
- **Legendas no Docker:** o filtro `whisper` está no FFmpeg do seu Windows, mas não
  vem nas imagens Linux comuns. O worker usa `faster-whisper` (pip) — mesma
  qualidade, sem depender de build customizado.
- **FFmpeg ≥ 8.1.2 obrigatório** no container: corrige o CVE-2026-8461 (PixelSmash),
  execução remota via arquivo de mídia malicioso. Uploads são entrada não confiável.

### Stack final

| Camada | Escolha | Por quê |
| --- | --- | --- |
| App web + API | Next.js (App Router), TypeScript, Tailwind, shadcn/ui | Claude Code é muito produtivo aqui; um só projeto para UI e API |
| Banco + login | Supabase (Postgres + Auth), chaves novas `sb_publishable_` / `sb_secret_` | RLS nativo; chaves legadas são descontinuadas no fim de 2026 |
| Arquivos | Cloudflare R2 (S3-compatível), buckets privados, URLs pré-assinadas | Egress R$ 0; upload direto do navegador, sem passar pela Vercel |
| Fila | Tabela `jobs` no Postgres com `FOR UPDATE SKIP LOCKED` | Sem Redis; transacional; menos uma peça para pagar e vigiar |
| Worker | Python 3.12 + FFmpeg ≥ 8.1.2, Docker, não-root, limites de CPU/memória/tempo | Reaproveita 100% do pipeline; isola entrada não confiável |
| Publicação | Instagram API with Instagram Login (`graph.instagram.com`) | Sem Página do Facebook; suporta Reels |
| Cobrança | Stripe Billing — cartão; Pix Automático quando liberado | Recorrência nativa, portal do cliente, webhooks confiáveis |
| Deploy app | Vercel | Limite de 4,5 MB por requisição não afeta: arquivos vão direto ao R2 |
| Deploy worker | VPS com Docker Compose (Hetzner ou similar, 4 vCPU) | ~R$ 60–120/mês; escala horizontal = mais um container |
| Observabilidade | Sentry (app + worker), logs estruturados, alerta de worker parado | Erro silencioso é o pior erro num produto de fila |

### Ordem das fases — e por que essa ordem

| Fase | Entrega | Semana |
| --- | --- | --- |
| 0 | Fundação do repo · contas · **trilha Meta e LGPD começa hoje** | 1 |
| 1 | Conta e sessão (Supabase Auth, RLS) | 1–2 |
| 2 | Projetos e upload em lote direto para o R2 | 2 |
| 3 | Worker e fila — o pipeline vira serviço | 3 |
| 4 | **Conectores do Instagram** (Instagram Login, tokens cifrados, renovação) | 4 |
| 5 | **Publicação e agenda** — fluxo completo → grava o screencast → **submete App Review** | 4–5 |
| 6 | Editor visual de template com preview em 2 s | 5–6 |
| 7 | Entrega: download individual e ZIP gerado no worker | 6 |
| 8 | Cobrança Stripe, quotas e portal do cliente | 7 |
| 9 | Legendas automáticas (faster-whisper) | 8 |
| 10 | **Endurecimento de segurança e produção** (checklist, monitoramento, backups, LGPD ponta a ponta) | 9 |
| 11 | Landing, páginas legais e lançamento | 10 |
| 12 | Anti-duplicidade — opcional, decisão sua com risco registrado | — |

Estimativa realista com o Claude Code: **9 a 12 semanas até a Fase 11**. A espera da
Meta corre em paralelo desde a semana 1; se a aprovação atrasar, o produto vende
sem publicação automática e liga depois.

### O relógio da Meta

- **Verificação de negócio** (CNPJ + comprovante) começa **hoje**. É a fila mais longa
  e não depende de código.
- **App Review** exige: fluxo funcionando, screencast do uso real, política de
  privacidade com seção de exclusão de dados (com âncora), URL de callback de exclusão
  de dados devolvendo JSON `{url, confirmation_code}`. Rejeição por instruções vagas
  de exclusão é a causa mais comum.
- Em **modo de desenvolvimento** o app publica em contas que tenham papel no app
  (testers). Isso permite **3 a 5 clientes-piloto pagantes** enquanto o review corre —
  e o screencast sai desse uso real.

### Segurança — as regras que valem em todas as fases

- RLS ativo em **toda** tabela do schema `public`, com política por comando
  (SELECT/INSERT/UPDATE/DELETE) referenciando `auth.uid()`. Tabelas criadas por SQL
  não ganham RLS sozinhas — verificar.
- Chave secreta do Supabase e da Stripe **só no servidor e no worker**; nunca em
  `NEXT_PUBLIC_*`, nunca em log, nunca em resposta de erro.
- Token do Instagram cifrado em repouso (AES-256-GCM), chave em variável de ambiente
  com plano de rotação; nunca trafega para o navegador.
- OAuth com `state` assinado e validado; `redirect_uri` em lista fechada.
- Todo webhook verifica assinatura e é idempotente por `event_id`.
- Todo upload é entrada não confiável: `ffprobe` com **lista fechada de codecs** antes
  de qualquer processamento; worker em container não-root, sistema de arquivos
  somente leitura, sem rede além de R2, Supabase e Meta, `timeout` por job, limites de
  CPU e memória, orçamento de processamento por conta.
- Rate limit em login, emissão de URL de upload, preview e publicação.
- Cabeçalhos: CSP, HSTS, `X-Content-Type-Options`, cookies `Secure`/`HttpOnly`/`SameSite`.
- Dependências: `npm audit` e `pip-audit` no CI; `gitleaks` no pre-commit.
- **Ao fim de cada fase:** `/security-review` e `/code-review` no Claude Code, com
  as falhas corrigidas antes de avançar. Isso não é opcional.
- LGPD: encarregado (DPO) nomeado por ato escrito e publicado no site com e-mail;
  política de privacidade em português; exclusão de conta self-service que revoga
  tokens e apaga arquivos; inventário de dados; retenção de 30 dias para vídeos.

### Custo e capacidade

- 1 VPS de 4 vCPU com 3 workers: ~15.000 vídeos/dia. Custo de CPU por vídeo abaixo
  de R$ 0,01 contra R$ 0,10 praticado no mercado.
- R2: US$ 0,015/GB/mês de armazenamento, **egress zero**. Com 50 clientes e
  expiração de 30 dias, ~500 GB armazenados ≈ US$ 7,50/mês. O problema de banda da
  Rev 1 deixa de existir.
- Custo fixo estimado até 100 clientes: Vercel (grátis a US$ 20) + Supabase (US$ 25)
  + VPS (R$ 60–120) + R2 (US$ 10) + Sentry (grátis) ≈ **R$ 400/mês**.

### Riscos que podem matar o projeto

| Risco | Mitigação já no plano |
| --- | --- |
| App Review negado ou lento | começa na semana 1; produto vende sem ele; pilotos como testers |
| Pix não liberado pela Stripe | cartão no lançamento; pedido no dia 1; Asaas como plano B |
| Upload malicioso derrubar ou invadir o worker | FFmpeg ≥ 8.1.2, lista fechada de codecs, container isolado com limites |
| Vazamento de token de Instagram | cifrado em repouso, nunca no cliente, rotação de chave, auditoria |
| Cobrança em dobro por webhook repetido | idempotência por `event_id` em tabela própria |
| Token vencer em silêncio e o cliente parar de publicar | renovação diária automática, estado `needs_reconnect` visível e e-mail |
| Storage crescer sem controle | lifecycle de 30 dias no R2 desde a Fase 2 |
| Direito autoral e termos das plataformas (anti-duplicidade) | fora do MVP; se entrar, desligado por padrão e sem manchete |

### Primeiro passo, hoje

1. Meta Business Suite → criar o Business com o CNPJ → **enviar verificação de negócio**.
2. Meta for Developers → app tipo Business → produto **Instagram** → configurar
   **Business Login for Instagram** (não Facebook Login).
3. Stripe → criar conta BR → **solicitar acesso ao Pix**.
4. Registrar `pagemask.com.br`. Criar projeto Supabase, bucket R2, projeto Vercel.
5. Nomear o encarregado de dados (pode ser você) e reservar `privacidade@pagemask.com.br`.
6. Colar o prompt da **Fase 0** no Claude Code.

---

## Como usar este plano com o Claude Code

O modelo de trabalho é o mesmo em toda fase. Não pule etapas.

1. **Abra a sessão no repo `insteira/`.** O `CLAUDE.md` é lido automaticamente e
   carrega as regras (stack, convenções, segurança).
2. **Cole o bloco `Prompt` da fase.** Ele é autocontido: referencia este arquivo
   quando precisa de detalhe.
3. **Rode o `Aceite funcional`** exatamente como escrito — de verdade, não presumido.
   Se algo falhar, peça a correção com a saída real do erro.
4. **Rode o `Cross-check de segurança`** da fase. São verificações concretas
   (comandos, consultas, tentativas de burlar).
5. **Rode `/security-review` e depois `/code-review`** no Claude Code. Corrija o que
   for apontado como confirmado. Repita até limpar.
6. **Preencha a `Definição de pronto`** (checklist no fim da fase) e faça o commit
   com a mensagem `fase N: <entrega>`.
7. Só então cole o prompt da fase seguinte.

Regras que valem sempre:

- O Claude Code deve **dizer o que falhou com a saída real**, nunca seguir com aceite
  quebrado. Isso está no `CLAUDE.md`.
- Quando uma fase tocar em API externa (Meta, Stripe, R2), o prompt manda **conferir
  a documentação oficial atual antes de codar**. Endpoints e parâmetros deste plano
  foram verificados em 02/09/2026, mas mudam.
- Uma fase pode ser dividida em prompts menores se a sessão ficar longa. O aceite é
  o mesmo.

---

## Arquitetura

```
                       ┌────────────────────────┐
  navegador ──────────►│  Next.js · Vercel       │◄──── Stripe (webhook assinado)
      │                │  UI + API + cron        │◄──── Meta (data deletion callback)
      │  upload direto │                         │
      │  (URL          └───────┬─────────────────┘
      │  pré-assinada)         │
      ▼                        ▼
  Cloudflare R2          Supabase Postgres + Auth
  (privado,              tabela jobs = fila · RLS em tudo
   30 dias)                    │  FOR UPDATE SKIP LOCKED
      ▲                        ▼
      │                ┌─────────────────────────┐
      └────────────────│  Worker Python · Docker  │──► graph.instagram.com
        entrada/saída  │  FFmpeg ≥ 8.1.2 + Pillow │    (container → status → publish)
                       │  não-root · ro-fs        │
                       │  timeout · cpu/mem       │
                       └─────────────────────────┘
```

- O vídeo **nunca passa pela Vercel**: sobe do navegador para o R2 com URL
  pré-assinada (multipart acima de 100 MB) e desce do R2 para o cliente do mesmo jeito.
- A Meta baixa o vídeo por HTTPS a partir de uma URL pré-assinada do R2 com validade
  de 2 h (o container pode demorar minutos para processar).
- O worker é o único que fala com `graph.instagram.com` para publicar; o app só fala
  para conectar contas (OAuth) e consultar limite.

---

## Modelo de dados

```
plans                  slug, name, price_cents, videos_month, ig_accounts, projects,
                       max_mb, stripe_price_id, active
profiles               ← auth.users. name, plan_slug, stripe_customer_id, created_at
subscriptions          user_id, stripe_subscription_id, status, current_period_end,
                       videos_used, cancel_at_period_end
projects               user_id, name, template_id, created_at
templates              user_id, name, config jsonb, version, created_at
assets                 user_id, kind (header|logo|font), r2_key, mime, bytes, sha256
jobs                   project_id, user_id, status, progress, r2_input_key,
                       r2_output_key, bytes_in, probe jsonb, template_snapshot jsonb,
                       report jsonb, attempts, error, queued_at, started_at,
                       finished_at, expires_at
ig_accounts            user_id, ig_user_id, username, profile_picture_url,
                       scopes text[], token_cipher bytea, token_iv bytea,
                       token_expires_at, last_refreshed_at,
                       status (active|needs_reconnect|revoked), connected_at
schedules              job_id, ig_account_id, scheduled_at, caption, status
                       (scheduled|publishing|published|failed|deferred),
                       ig_container_id, ig_media_id, error, attempts, published_at
webhook_events         provider (stripe|meta), event_id UNIQUE, payload jsonb,
                       received_at, processed_at
audit_log              user_id, actor, action, target, meta jsonb, ip, created_at
data_requests          user_id, kind (deletion|export), confirmation_code UNIQUE,
                       status, requested_at, completed_at
```

Decisões que evitam dor depois:

- **`template_snapshot` no job.** Cópia congelada do template no momento do enfileiramento.
  Editar o template no meio do lote não muda os vídeos já na fila.
- **Quota em `subscriptions.videos_used`, não em `count(jobs)`.** Incrementa ao aceitar
  o job; devolve o crédito se falhar em definitivo.
- **`webhook_events.event_id UNIQUE`.** Idempotência de Stripe e Meta por construção:
  o segundo evento igual falha no insert e é ignorado.
- **`probe jsonb` no job.** Guarda o `ffprobe` da entrada: é a prova de que o arquivo
  passou na lista fechada de codecs e permite auditoria depois.
- **`expires_at` no job** e lifecycle de 30 dias no R2: o banco e o bucket concordam
  sobre quando o arquivo some.
- **Token cifrado com IV próprio por linha.** AES-256-GCM; a chave `TOKEN_ENC_KEY` fica
  só no servidor e no worker. Rotação: coluna `key_version` quando houver a segunda chave.

---

## Segurança e LGPD — o que vale em todas as fases

Esta seção é a fonte da verdade. Cada fase tem um cross-check que aponta para itens
daqui. A Fase 10 é a passada final de endurecimento, não o único momento de segurança.

### 1. Identidade e acesso

- Supabase Auth com e-mail/senha (mínimo 10 caracteres, verificação de e-mail
  obrigatória). Sem login social por enquanto — menos superfície.
- **Revisado em 13/09/2026 — o magic link saiu.** Ele constava aqui desde a
  Revisão 2 e chegou a existir em `/entrar`. Dois caminhos de entrada para o
  mesmo lugar dobravam a superfície a defender (dois baldes de limite, duas
  respostas neutras a calibrar) sem resolver o problema que os justificava:
  quem esqueceu a senha. Isso agora tem caminho próprio — `/recuperar-senha`.
- A verificação de e-mail é por **código numérico digitado**, não por link.
  `verifyOtp` com o par `(e-mail, código)`, onde o e-mail vem de um cookie
  `httpOnly` escrito pelo servidor, nunca do formulário nem da URL — o porquê
  está em `app/src/lib/auth/cadastro-pendente.ts`. O link continua sendo o
  caminho da recuperação de senha, ali com PKCE.
- Rate limit de login e cadastro (Supabase já limita; adicionar limite por IP no
  middleware para as rotas de auth).
- Sessão via cookies `HttpOnly`, `Secure`, `SameSite=Lax`, pelo pacote `@supabase/ssr`.
- Toda rota sob `/app/*` verifica sessão no servidor (middleware + server components),
  nunca só no cliente.

### 2. Banco de dados

- RLS ativo em **todas** as tabelas de `public`. Verificação obrigatória:
  `select tablename from pg_tables where schemaname='public' and rowsecurity=false;`
  deve retornar vazio.
- Uma política por comando por tabela. `plans` é a única leitura pública.
- Chave secreta (`sb_secret_…`) só em `process.env` no servidor e no worker. `grep -r`
  no bundle do cliente (`.next/static`) não pode encontrá-la — esse grep está no CI.
- Rodar o **Security Advisor** do Supabase ao fim de cada fase que mexe no schema.
- Migrations versionadas em `supabase/migrations/`; nunca alterar pelo painel.
- Backups: PITR ligado no Supabase (plano Pro) ou dump diário automatizado.

### 3. Segredos e tokens

- Nenhum segredo em `NEXT_PUBLIC_*`, em log, em mensagem de erro ou em commit.
  `gitleaks` no pre-commit e no CI.
- Token de Instagram: cifrado (AES-256-GCM) antes de gravar; decifrado só no momento
  do uso, no servidor ou no worker; nunca serializado para o cliente (o tipo TS da
  `ig_accounts` exposta ao front **não tem** os campos de token).
- `TOKEN_ENC_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `IG_APP_SECRET`,
  `R2_SECRET_ACCESS_KEY`, `SUPABASE_SECRET_KEY` em variáveis de ambiente por ambiente
  (dev/prod separados; chaves diferentes).
- Rotação: documentar em `docs/RUNBOOK.md` como trocar cada segredo sem downtime.

### 4. Uploads e worker (entrada não confiável)

- O navegador só recebe uma URL pré-assinada **PUT** para uma chave R2 que o servidor
  escolheu (`{user_id}/{project_id}/{uuid}.{ext}`), com `Content-Type` e tamanho
  máximo fixados na assinatura, validade de 15 min.
- Antes de qualquer render, `ffprobe` com **lista fechada**: container `mp4|mov|webm|mkv`,
  vídeo `h264|hevc|vp9|av1`, áudio `aac|mp3|opus|vorbis|pcm_*`. Qualquer outro
  codec → `rejected` com mensagem clara. Isso fecha a maior parte da superfície de
  ataque de decoders exóticos (o CVE-2026-8461 era no MagicYUV).
- FFmpeg **≥ 8.1.2** no container (verificado no build: `ffmpeg -version` no Dockerfile
  falha o build se menor).
- Container: usuário não-root, `read_only: true` com `tmpfs` para trabalho, `cap_drop: ALL`,
  `no-new-privileges`, `mem_limit`, `cpus`, `pids_limit`, rede restrita (egress só para
  R2, Supabase e `graph.instagram.com`).
- `timeout` por job (padrão 20 min) e `ulimit` de arquivo; job que estoura vira `failed`.
- Orçamento por conta: no máximo N jobs simultâneos por usuário e tempo de CPU por dia
  proporcional ao plano — evita que uma conta monopolize o worker.
- Saída gravada em prefixo diferente da entrada; a entrada nunca é servida ao cliente
  de volta sem passar pelo pipeline.

### 5. Webhooks e callbacks

- Stripe: `stripe.webhooks.constructEvent` com o segredo; insert em `webhook_events`
  antes de processar; processamento idempotente.
- Meta **Data Deletion Request Callback**: verifica `signed_request` (HMAC-SHA256 com
  o app secret), grava em `data_requests`, agenda a exclusão, responde JSON
  `{ "url": "https://pagemask.com.br/exclusao-de-dados?code=…", "confirmation_code": "…" }`.
  A página do código mostra o estado da solicitação. Meta **Deauthorize Callback**:
  marca a `ig_account` como `revoked` e apaga o token.
- Cron interno (renovação de token, publicação agendada, expiração): rota protegida
  por `CRON_SECRET` no header; disparo pelo Vercel Cron.

### 6. Aplicação web

- Validação de toda entrada com `zod` nos server actions e route handlers.
- Cabeçalhos via `next.config` / middleware: CSP restritiva (sem `unsafe-inline` para
  scripts), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`.
- Rate limit (Upstash Ratelimit ou tabela própria) em: emissão de URL de upload,
  preview de template, enfileirar lote, conectar conta, publicar agora.
- Erros para o usuário em pt-BR, sem stack trace; detalhe vai para o Sentry.
- `npm audit --audit-level=high` e `pip-audit` no CI; Dependabot ligado.

### 7. Observabilidade e resposta a incidente

- Sentry no app e no worker, com `user_id` como contexto (nunca token ou e-mail em
  breadcrumb).
- Logs estruturados (JSON) no worker: job_id, fase, duração, resultado.
- Alertas: worker sem heartbeat há 5 min; fila com job `queued` há mais de 30 min;
  taxa de `failed` acima de 5% na hora; renovação de token falhando.
- `audit_log` para: conectar/desconectar conta, publicar, mudar plano, excluir conta.
- `docs/RUNBOOK.md`: o que fazer quando o worker cai, quando a Meta devolve erro em
  massa, quando um token vaza (rotacionar `TOKEN_ENC_KEY`, revogar todos, avisar).

### 8. LGPD

- **Encarregado (DPO)** nomeado por ato escrito, com nome e e-mail publicados em
  local de destaque no site (Resolução ANPD 18/2024 — o rodapé de um PDF não serve).
- **Política de privacidade** em português: o que é coletado (e-mail, vídeos,
  token de acesso ao Instagram, dados de cobrança via Stripe), finalidade, base legal
  (execução de contrato), prazo de retenção (vídeos 30 dias; conta enquanto ativa),
  compartilhamento (Supabase, Cloudflare, Stripe, Meta, Sentry), direitos do titular
  e **como excluir** — seção própria com âncora `#exclusao`.
- **Exclusão self-service** em `/app/conta`: revoga tokens na Meta, apaga `ig_accounts`,
  apaga objetos no R2, anonimiza `audit_log`, apaga o usuário no Auth. Executa em até
  72 h, com e-mail de confirmação.
- **Exportação** dos dados do titular (JSON) na mesma tela.
- **Inventário de dados** em `docs/DADOS.md`: tabela → campo → finalidade → retenção.
- **Incidente**: em caso de acesso não autorizado, comunicar ANPD e titulares
  conforme a resolução vigente; o runbook tem o modelo.
- Termos de uso deixam claro que o cliente é responsável pelo conteúdo que publica e
  pelos direitos sobre os vídeos que envia.

### 9. Checklist de produção (fechado na Fase 10)

- [ ] `pg_tables` sem tabela com `rowsecurity=false`
- [ ] Security Advisor do Supabase sem alerta de nível alto
- [ ] `grep` do bundle cliente sem `sb_secret`, `sk_live`, `whsec`
- [ ] `gitleaks detect` limpo no histórico
- [ ] Cabeçalhos verificados em `securityheaders.com` (nota A)
- [ ] Container do worker: `docker inspect` mostra não-root, ro-fs, cap_drop ALL, limites
- [ ] `ffmpeg -version` no container ≥ 8.1.2
- [ ] Tentativa de upload de arquivo com codec fora da lista → rejeitado
- [ ] Webhook Stripe reenviado → nenhum efeito duplicado
- [ ] Callback de exclusão da Meta testado com `signed_request` inválido → 400
- [ ] Exclusão de conta ponta a ponta: tokens revogados, R2 vazio, usuário removido
- [ ] Backups restaurados uma vez em ambiente de teste
- [ ] Sentry recebendo erro de teste do app e do worker
- [ ] Alertas disparando em teste (matar o worker → alerta em 5 min)
- [ ] DPO publicado no site; política de privacidade com âncora `#exclusao`
- [ ] `/security-review` da Fase 10 sem achado confirmado em aberto

---

## Trilha paralela — Meta e LGPD (começa no dia 1)

Nada aqui é tarefa do Claude Code. É burocracia externa e leva semanas.

### Semana 1

1. **Meta Business Suite**: criar o Business com o CNPJ da agência.
2. **Verificação de negócio**: enviar cartão CNPJ e comprovante de endereço.
3. **App no Meta for Developers**, tipo Business. Adicionar o produto **Instagram** e
   configurar **API setup with Instagram login** (é uma opção distinta de
   "with Facebook login" — escolha a de Instagram). Anotar **Instagram App ID** e
   **Instagram App Secret** (são diferentes do App ID do Facebook).
4. Configurar **Business Login for Instagram**: `redirect_uri` de dev
   (`http://localhost:3000/api/ig/callback`) e de prod; **Deauthorize callback URL** e
   **Data deletion request URL** (podem apontar para prod mesmo antes de existir; a
   Fase 5 entrega).
5. **Stripe**: conta BR; **solicitar acesso ao Pix** pelo suporte. Enquanto não
   liberar, cartão.
6. **DPO**: ato escrito nomeando o encarregado; e-mail `privacidade@pagemask.com.br`.

### Semana 4–5 (depois da Fase 5)

7. **Adicionar testers**: no app da Meta, papel *Instagram Tester* para as contas dos
   pilotos; cada um aceita o convite dentro do Instagram (Configurações → Site e
   aplicativos → Convites de tester). Em modo de desenvolvimento, só essas contas
   conectam.
8. **Screencast** para o App Review (3–5 min, sem cortes): tela de login pública →
   entrar com as credenciais de teste fornecidas → aba Conectores → clicar em
   Conectar Instagram → janela da Meta com as permissões → aceitar → conta aparece →
   agendar um vídeo → publicar → mostrar o Reel no perfil. Uma ação humana por clique;
   nada automático "acontecendo sozinho" na tela.
9. **Submeter App Review** para `instagram_business_basic` e
   `instagram_business_content_publish`, com: descrição de uso de cada permissão em
   inglês, credenciais de teste, URL da política de privacidade, URL de instruções de
   exclusão de dados. Prazo típico em 2026: ~20 dias. Rejeição na primeira é comum;
   responder o motivo e reenviar.

---

## Fase 0 — Fundação e o relógio da Meta

### Objetivo

Esqueleto do repo com as regras carregadas, schema versionado, contas criadas.

### Antes do prompt

Itens 1–6 da trilha paralela. Criar: projeto Supabase, bucket R2 (privado) com token
de API restrito ao bucket, projeto Vercel vazio, conta Sentry.

### Prompt

```
Inicie o projeto PageMask. Leia CLAUDE.md e docs/PLANO.md (seção Fase 0) antes.

1. app/: Next.js (última estável) com App Router, TypeScript, Tailwind e shadcn/ui.
2. Clientes Supabase separados: browser (chave publishable) e server (chave secret),
   usando @supabase/ssr. A chave secret nunca é importada por arquivo que vá para o
   bundle do cliente.
3. supabase/migrations/0001_init.sql com as tabelas de docs/PLANO.md (Modelo de
   dados). RLS habilitado em todas, com políticas por comando referenciando
   auth.uid(). plans é a única de leitura pública. Inclua a tabela webhook_events
   com event_id UNIQUE e a audit_log.
4. Seed: Partida R$97 (700 vídeos, 3 contas IG, 3 projetos, 500 MB), Ritmo R$149,90
   (1500, 6, 6, 500 MB), Escala R$239,90 (2500, 10, 10, 500 MB). Preços em centavos.
5. .env.example com todas as variáveis (Supabase, R2, Stripe, IG, TOKEN_ENC_KEY,
   CRON_SECRET, SENTRY_DSN) e comentário de onde cada uma vem.
6. Cabeçalhos de segurança no next.config (CSP, HSTS, nosniff, referrer, permissions).
7. CI (GitHub Actions): lint, typecheck, npm audit --audit-level=high, gitleaks, e um
   passo que faz grep em .next/static por 'sb_secret' e 'sk_live' e falha se achar.
8. Página inicial mínima com o nome e link de entrar. Sem landing ainda.
9. README com os passos para rodar local.

Não implemente auth, upload nem worker agora.
```

### Aceite funcional

- `npm run dev` sobe sem erro; a migration aplica; `select * from plans` devolve 3 linhas.
- CI verde no primeiro push.

### Cross-check de segurança

- `select tablename from pg_tables where schemaname='public' and rowsecurity=false;` → vazio.
- Com a chave publishable, `select * from profiles` → 0 linhas (não erro, mas vazio).
- `curl -I` na home mostra CSP, HSTS e nosniff.
- Commitar um arquivo com `sk_live_teste123` de propósito → gitleaks bloqueia.

### Definição de pronto

- [ ] aceite e cross-check rodados com saída real
- [ ] `/security-review` e `/code-review` sem achado confirmado em aberto
- [ ] commit `fase 0: fundação`

---

## Fase 1 — Conta e sessão

### Prompt

```
Implemente autenticação com Supabase Auth, seguindo docs/PLANO.md (Segurança §1).

- Cadastro e login por e-mail e senha (mínimo 10 caracteres, verificação de e-mail
  obrigatória por código numérico digitado — ver §1; o magic link saiu do plano
  em 13/09/2026).
- Trigger no Postgres que cria a linha em profiles quando nasce um auth.users.
- Middleware protegendo /app/*; visitante sem sessão vai para /entrar. A verificação
  de sessão também acontece nos server components, não só no middleware.
- Rate limit por IP nas rotas de auth (10 tentativas / 15 min).
- Layout autenticado: barra lateral com Projetos, Templates, Conectores, Agenda e
  Conta; menu de usuário com sair.
- /app/conta: e-mail, plano atual, uso do mês, e os botões "Exportar meus dados" e
  "Excluir minha conta" (por enquanto só abrem um modal explicando que chega na
  Fase 10 — mas o lugar já existe).

Interface em pt-BR. Erros dizem o que houve e o que fazer.
```

### Aceite funcional

- Criar conta, confirmar e-mail, sair, entrar de novo; `/app` deslogado redireciona.
- A linha em `profiles` nasceu sozinha.

### Cross-check de segurança

- Com duas contas, a A tenta `select * from profiles` → só vê a própria.
- 11 tentativas de login erradas → bloqueio com mensagem em pt-BR.
- Cookie de sessão tem `HttpOnly`, `Secure`, `SameSite` (ver nas DevTools).
- Abrir `/app/projetos` com o cookie apagado → redireciona (não renderiza nada antes).

### Definição de pronto

- [ ] aceite e cross-check rodados
- [ ] `/security-review` e `/code-review` limpos
- [ ] commit `fase 1: auth`

---

## Fase 2 — Projetos e upload em lote (R2)

### Prompt

```
Implemente projetos e upload em lote direto para o Cloudflare R2, seguindo
docs/PLANO.md (Segurança §4). Confira a documentação atual do R2 sobre URLs
pré-assinadas e multipart antes de codar.

- CRUD de projetos em /app/projetos, respeitando o limite do plano.
- Upload múltiplo (seleção ou arrastar). Fluxo: o cliente pede ao servidor uma URL
  pré-assinada PUT por arquivo; o servidor valida extensão e tamanho contra max_mb do
  plano, escolhe a chave {user_id}/{project_id}/{uuid}.{ext}, fixa Content-Type e
  tamanho na assinatura, validade 15 min. Acima de 100 MB, multipart com partes de
  10 MB. O arquivo nunca passa pela Vercel.
- Rate limit: 60 URLs de upload por usuário por hora.
- Ao concluir, o cliente confirma e o servidor grava em jobs com status 'uploaded',
  bytes_in e expires_at = now() + 30 dias. Configure lifecycle de 30 dias no bucket.
- Lista de vídeos do projeto com nome, tamanho, duração (nula por enquanto) e status.
  Remover apaga do R2 e do banco.
- Progresso por arquivo, cancelar, e retomar multipart se a aba recarregar.
```

### Aceite funcional

- Subir 5 vídeos de uma vez, um deles acima de 100 MB; todos aparecem com tamanho certo.
- Arquivo acima do limite do plano é recusado antes de começar, com mensagem clara.
- Recarregar a página mantém tudo; remover some do bucket e do banco.

### Cross-check de segurança

- URL do objeto sem assinatura → 403.
- Reutilizar uma URL pré-assinada depois de 15 min → falha.
- Editar a requisição para pedir chave de outro `user_id` → servidor ignora e usa o próprio.
- Tentar assinar um `Content-Type: text/html` → recusado (só vídeo).
- 61ª URL na mesma hora → 429 com mensagem em pt-BR.

### Definição de pronto

- [ ] aceite e cross-check rodados
- [ ] lifecycle de 30 dias visível no painel do R2
- [ ] `/security-review` e `/code-review` limpos
- [ ] commit `fase 2: upload r2`

---

## Fase 3 — Worker e fila

O coração. O pipeline que já existe vira serviço.

### Antes do prompt

```bash
cp -r "C:/Users/User/Downloads/video-pipeline" "C:/Users/User/Downloads/insteira/worker"
```

### Prompt

```
Transforme worker/ em um serviço de fila, seguindo docs/PLANO.md (Segurança §4).
O pipeline de render já funciona: leia worker/README.md e NÃO reescreva a lógica de
detecção, composição ou validação.

1. worker/service.py: laço que reclama um job com
   UPDATE jobs SET status='running', started_at=now(), attempts=attempts+1
   WHERE id = (SELECT id FROM jobs WHERE status='queued'
               ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *;
2. Por job: baixar o input do R2 para tmpfs; rodar ffprobe e aplicar a LISTA FECHADA
   de codecs de docs/PLANO.md §4 — fora da lista, status 'rejected' com mensagem em
   pt-BR e crédito devolvido; gravar o probe em jobs.probe; renderizar com o
   template_snapshot; validar (as 7 checagens existentes + a validação de Reels da
   seção abaixo); subir a saída para o R2 em prefixo separado; gravar report; 'done'.
3. Validação de Reels (nova, em worker/src/validate.py): moov atom no início, sem
   edit list, H.264 com closed GOP, AAC ≤ 48 kHz e ≤ 2 canais, 23–60 fps, largura
   ≤ 1920, duração 3 s–15 min, ≤ 300 MB, bitrate ≤ 25 Mbps. Falha vira 'failed' com
   o motivo.
4. Progresso real com -progress do ffmpeg, atualizando jobs.progress ≤ 1×/s.
5. Falha: 'error' com mensagem; até 3 tentativas com espera crescente; na terceira,
   'failed' e crédito devolvido. Job 'running' há > 30 min volta para 'queued'.
6. timeout de 20 min por job; no máximo 2 jobs simultâneos por usuário.
7. Dockerfile: imagem com FFmpeg ≥ 8.1.2 (o build FALHA se a versão for menor),
   usuário não-root. docker-compose.yml com read_only, tmpfs em /work, cap_drop ALL,
   no-new-privileges, mem_limit 2g, cpus 1.5, pids_limit 256, WORKER_CONCURRENCY=2.
8. Heartbeat: o worker grava now() numa tabela worker_heartbeat a cada 30 s.
9. UI: botão "Processar lote" que muda os jobs para 'queued' (verificando quota) e
   lista com progresso ao vivo via Supabase Realtime.

O worker usa a chave secret do Supabase e as credenciais do R2 só por variável de
ambiente. Logs em JSON com job_id, etapa, duração e resultado.
```

### Aceite funcional

- `docker compose up`; clicar em Processar; ver a barra andar de verdade.
- A saída baixa e passa nas 7 validações + Reels no `report`.
- Matar o worker no meio e reiniciar → job travado volta para a fila.

### Cross-check de segurança

- Subir um arquivo `.mp4` que na verdade é um `.avi` com codec `magicyuv` → `rejected`,
  worker continua vivo.
- Subir um arquivo de 1 KB corrompido → `failed` com mensagem legível.
- `docker inspect` do container: `User` não é root, `ReadonlyRootfs: true`, `CapDrop: ALL`.
- `docker exec … ffmpeg -version` → ≥ 8.1.2.
- Enfileirar 5 jobs do mesmo usuário → no máximo 2 em `running` ao mesmo tempo.
- Um job com `sleep` artificial de 25 min → `failed` por timeout aos 20.

### Definição de pronto

- [ ] aceite e cross-check rodados
- [ ] `/security-review` e `/code-review` limpos
- [ ] commit `fase 3: worker`

---

## Fase 4 — Conectores do Instagram

A aba que você descreveu: clicar, abrir a janela do Instagram, autorizar, pronto.
Sem Página do Facebook.

### Antes do prompt

Itens 3–4 da trilha paralela concluídos (App ID e App Secret do Instagram em mãos,
`redirect_uri` de dev cadastrado). Sua própria conta de Instagram convertida para
Profissional e adicionada como tester.

### Prompt

```
Implemente a aba Conectores com Business Login for Instagram (Instagram API with
Instagram Login), seguindo docs/PLANO.md (Segurança §3 e §5). ANTES de codar, confira
na documentação oficial da Meta os endpoints atuais de: autorização
(www.instagram.com/oauth/authorize), troca do code por token curto
(api.instagram.com/oauth/access_token), troca por token longo
(graph.instagram.com/access_token?grant_type=ig_exchange_token), renovação
(graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token) e perfil
(graph.instagram.com/me?fields=user_id,username,profile_picture_url,account_type).
Escopos: instagram_business_basic e instagram_business_content_publish.

Fluxo:
1. /app/conectores lista as contas com foto, @, "conectada há N dias", estado
   (ativa / precisa reconectar / revogada) e botão Reconectar sempre visível.
2. Botão "Conectar Instagram". Antes de abrir a janela, uma tela de um passo:
   "Sua conta precisa estar como Profissional (Business ou Creator)" com o caminho
   exato no app do Instagram e o botão Continuar.
3. Continuar abre a URL de autorização em popup, com state assinado (HMAC do
   user_id + nonce + timestamp, validade 10 min). O callback /api/ig/callback valida
   o state, troca o code por token curto e depois por token longo (60 dias), busca o
   perfil, cifra o token (AES-256-GCM com TOKEN_ENC_KEY, IV por linha) e grava em
   ig_accounts. Respeita o limite de contas do plano. Registra em audit_log.
4. Se a conta não for Profissional ou o usuário negar, a página mostra a mensagem em
   pt-BR com o que fazer — nunca um erro cru.
5. Cron diário (rota protegida por CRON_SECRET, Vercel Cron): renova tokens com menos
   de 10 dias de validade. Falha → status 'needs_reconnect' e e-mail ao usuário.
6. Desconectar: apaga o token, marca 'revoked', audit_log.
7. Em modo de desenvolvimento da Meta, mostrar faixa: "Enquanto o app está em
   revisão, só contas convidadas como tester conseguem conectar."

O tipo TypeScript de ig_accounts exposto ao cliente NÃO contém token_cipher nem
token_iv. Nenhum token aparece em log.
```

### Aceite funcional

- Conectar a sua conta de teste: popup do Instagram, autorizar, voltar com foto e @.
- Desconectar e reconectar funciona; o limite do plano bloqueia a 4ª conta no Partida.
- Rodar o cron manualmente com um token editado para vencer em 5 dias → renovado.

### Cross-check de segurança

- Chamar `/api/ig/callback` com `state` forjado → 400, nada gravado.
- Reutilizar o mesmo `code` duas vezes → segunda falha sem efeito.
- `select token_cipher from ig_accounts` com a chave publishable → vazio (RLS), e o JSON
  da API do app nunca inclui o campo.
- `grep -r token_cipher .next/static` → nada.
- Chamar o cron sem `CRON_SECRET` → 401.

### Definição de pronto

- [ ] aceite e cross-check rodados
- [ ] `/security-review` e `/code-review` limpos
- [ ] commit `fase 4: conectores ig`

---

## Fase 5 — Publicação e agenda

Ao fim desta fase o fluxo está completo de ponta a ponta: **grave o screencast e
submeta o App Review**. É o que destrava o relógio da Meta.

### Prompt

```
Implemente agenda e publicação via Instagram API with Instagram Login (Content
Publishing), seguindo docs/PLANO.md (Segurança §4 e §5). ANTES de codar, confira na
documentação oficial: POST /{ig_user_id}/media (media_type=REELS, video_url,
caption, share_to_feed), GET /{container_id}?fields=status_code,status,
POST /{ig_user_id}/media_publish (creation_id) e
GET /{ig_user_id}/content_publishing_limit?fields=quota_usage,config.

Agenda:
- /app/agenda: calendário mensal e semanal com arrastar para reagendar.
- Agendar um vídeo 'done': conta, data, hora, legenda (contador de caracteres, limite
  da Meta). Grava em schedules. Fuso America/Sao_Paulo na tela, UTC no banco.
- Antes de gravar: consultar content_publishing_limit da conta e mostrar "X de Y
  publicações usadas nas últimas 24 h". Se não couber, oferecer o próximo horário
  livre.

Publicação (no worker, worker/publish.py):
- Cron a cada minuto (CRON_SECRET) marca schedules vencidos como 'publishing' e o
  worker os consome pela mesma fila (FOR UPDATE SKIP LOCKED).
- Por post: gerar URL pré-assinada GET do R2 com validade de 2 h; criar o container
  REELS; consultar status_code com espera crescente (5, 10, 20, 40 s… até 10 min);
  em FINISHED, media_publish; gravar ig_media_id e o permalink.
- Erro da Meta: traduzir os códigos comuns para pt-BR (token inválido → 'needs_reconnect'
  na conta; limite atingido → 'deferred' e reagenda +1 h; container EXPIRED → refaz).
  Até 3 tentativas; depois 'failed' com botão Tentar de novo.
- Histórico em /app/agenda/historico: publicados (com link), adiados, com falha.
- audit_log em toda publicação.

Duas páginas públicas agora, porque o App Review exige: /privacidade (com seção
'Exclusão de dados' e âncora #exclusao) e /exclusao-de-dados (instruções + consulta
de status por código). E dois endpoints: POST /api/meta/data-deletion (valida
signed_request com HMAC-SHA256 do IG_APP_SECRET, grava em data_requests, responde
JSON {url, confirmation_code}) e POST /api/meta/deauthorize (marca a conta 'revoked').
```

### Aceite funcional

- Publicar um Reel real na conta de teste; aparece no perfil com a legenda certa.
- Simular token vencido (editar `token_expires_at` no passado e invalidar) → conta
  marcada para reconectar, agendamento vira `failed` com mensagem tratada.
- Arrastar um agendamento no calendário persiste.
- `/privacidade#exclusao` existe e o callback de exclusão responde o JSON exigido.

### Cross-check de segurança

- `POST /api/meta/data-deletion` com `signed_request` inválido → 400, nada gravado.
- URL pré-assinada do vídeo usada pela Meta expira em 2 h (testar após).
- Duas execuções do cron no mesmo minuto não publicam em dobro (SKIP LOCKED).
- Um usuário tenta agendar em `ig_account_id` de outro → RLS bloqueia.

### Definição de pronto

- [x] aceite e cross-check rodados (11/09/2026 — Reel real publicado, token
      inválido → `needs_reconnect` + `failed`, arrasto persistido, cron em dobro
      marca uma vez, URL pré-assinada vence, RLS bloqueia conta alheia)
- [ ] **screencast gravado e App Review submetido** (trilha paralela, itens 7–9)
- [x] `/security-review` (sem High/Medium; o Low foi corrigido) e `/code-review`
      (achados de reúso/eficiência aplicados; ver commit)
- [ ] commit `fase 5: publicação`

---

## Fase 6 — Editor de template

### Prompt

```
Construa o editor visual de templates. Ele monta o mesmo JSON que o worker consome
(campos em worker/config/template.pretamente.json) — a UI é uma casca sobre ele,
validada com zod no servidor antes de salvar.

Controles: imagem de header (upload para assets via R2, PNG/JPG até 5 MB, validado
por assinatura de bytes, não só extensão), frase com contador, fonte (lista fechada
de fontes embarcadas no worker), corpo em px com autofit, cor, alinhamento do header
(auto ou fixo com offset), enquadramento (fit, cover, blur) e cor da faixa de
cobertura.

Preview: endpoint que enfileira um job 'preview' (o worker roda --dry-run sobre um
vídeo do projeto e devolve o PNG). Debounce de 600 ms, estado de carregando, rate
limit de 30 previews por usuário por 10 min. O PNG de preview expira em 1 h no R2.

Salvar como template nomeado e versionado; aplicar ao projeto inteiro ou a itens
selecionados; o job recebe template_snapshot.
```

### Aceite funcional

- Mudar a frase e ver o preview em segundos; salvar, abrir outro projeto e reaplicar.
- O lote renderizado sai igual ao preview.
- Um header PNG novo é detectado e posicionado sozinho.

### Cross-check de segurança

- Subir um `.png` que é um `.html` renomeado → recusado pela assinatura de bytes.
- Enviar `config` com campo extra ou fonte fora da lista → zod recusa.
- 31º preview em 10 min → 429.

### Definição de pronto

- [x] aceite e cross-check rodados (12/09/2026 — frase trocada com prévia nova
      em ~5 s (2,9 s no worker, o resto é debounce + poll); template salvo,
      reaplicado em outro projeto e lote processado; o quadro do meio do MP4
      entregue bate com o PNG da prévia (RMS 1,67/255, só ruído de H.264 na
      faixa de vídeo); header PNG novo detectado e posicionado sozinho.
      Cross-check: `.html` renomeado para `.png` recusado em `confirmar` (415)
      e o objeto apagado; 7 configs recusadas pelo zod (campo extra, fonte fora
      da lista, caminho no header, número fora de faixa, cor inválida, asset de
      outra conta); 31ª prévia em 10 min → 429)
- [x] `/security-review` (um Medium confirmado e corrigido: `authenticated`
      tinha `insert` em `assets` desde a 0001, então dava para gravar bytes
      arbitrários no R2, pular `/header/confirmar` e inserir a linha pelo
      PostgREST — a assinatura de bytes virava opcional. A 0020 fecha:
      `register_header_asset` é a única porta e o cliente perdeu o INSERT) e
      `/code-review` (6 achados, todos corrigidos: campo hexadecimal que não
      aceitava digitação, `.parcial` órfão no tmpfs, expurgo capaz de matar a
      thread de zeladoria, seleção que não podava com o Realtime, conclusão da
      prévia fora do `try`, e o `42501` do `with check` tratado como falha
      genérica)
- [ ] commit `fase 6: editor`

---

## Fase 7 — Entrega

### Prompt

```
Implemente a entrega dos resultados.

- Download individual por URL pré-assinada GET do R2, validade 15 min.
- ZIP do lote gerado no worker (job 'zip'), gravado no R2 com expires_at de 7 dias,
  entregue por URL pré-assinada. Um lote de 200 vídeos não passa pela Vercel.
- Página do projeto: concluídos, com falha, pendentes; reprocessar os que falharam
  sem duplicar job; apagar o lote inteiro (R2 + banco).
```

### Aceite funcional

- ZIP com 10 vídeos abre e todos tocam; reprocessar um item com falha não duplica.

### Cross-check de segurança

- URL do ZIP expirada → 403; URL de outro usuário (chave adivinhada) → 403.

### Definição de pronto

- [ ] aceite e cross-check rodados · `/security-review` e `/code-review` limpos
- [ ] commit `fase 7: entrega`

> **Aqui há um produto usável de ponta a ponta.** Coloque os 3–5 pilotos (já testers
> da Meta) usando de verdade. O que eles reclamarem reordena as fases 8–11.

---

## Fase 8 — Cobrança com Stripe

### Prompt

```
Integre a Stripe para assinatura recorrente, seguindo docs/PLANO.md (Segurança §5).
Confira a documentação atual de Stripe Billing e, se o Pix já estiver liberado na
conta, de Pix Automático (mandato, débito em ciclo + 3 dias).

- Produtos e prices espelhando plans; gravar stripe_price_id.
- Checkout Session: cartão sempre; Pix só se STRIPE_PIX_ENABLED=true.
- Webhook /api/stripe/webhook: constructEvent com o segredo; insert em
  webhook_events (event_id UNIQUE) antes de processar; tratar
  checkout.session.completed, customer.subscription.updated/deleted,
  invoice.paid, invoice.payment_failed. Reentrega do mesmo evento não tem efeito.
- Com Pix Automático: o débito ocorre 3 dias após o ciclo; manter o acesso durante
  'processing' e só rebaixar em 'failed' definitivo.
- Billing Portal para trocar de plano e cancelar.
- Gate de quota ao enfileirar: bloqueia se videos_used + selecionados > videos_month,
  dizendo quanto falta e oferecendo upgrade. Reset de videos_used dirigido por
  invoice.paid.
- Centavos inteiros. Nunca float.
```

### Aceite funcional

- Assinar em modo teste com cartão de teste; quota aparece; estourar bloqueia com
  mensagem correta; cancelar rebaixa no fim do período.

### Cross-check de segurança

- Reenviar o mesmo evento pela CLI da Stripe → nenhuma duplicação.
- Evento com assinatura inválida → 400, nada gravado.
- Alterar o `price_id` no cliente antes do checkout → servidor usa o do plano escolhido.

### Definição de pronto

- [ ] aceite e cross-check rodados · `/security-review` e `/code-review` limpos
- [ ] commit `fase 8: cobrança`

---

## Fase 9 — Legendas

### Prompt

```
Adicione legendas automáticas ao worker com faster-whisper (pip), modelo 'small'
por padrão, idioma pt. NÃO dependa do filtro whisper do ffmpeg — ele não existe na
imagem Linux.

- Etapa opcional por template: transcrever e gerar SRT; guardar no R2; editar o texto
  na UI antes de queimar.
- Queimar com estilo configurável (fonte da lista fechada, corpo, cor, contorno,
  posição), respeitando a faixa de vídeo detectada para não invadir o header.
- A transcrição é a única etapa não determinística: salvar o SRT antes do render,
  para o render seguir reproduzível a partir dele.
- Limite de duração transcrita por plano (evita CPU ilimitada): registrar segundos
  transcritos em subscriptions.
```

### Aceite funcional

- Vídeo com fala em português gera SRT coerente; editar uma linha e renderizar reflete.
- A legenda não invade o header nem sai do quadro.

### Cross-check de segurança

- SRT com HTML/`{\an}` malicioso → escapado, não interpretado como estilo.
- Vídeo de 15 min → transcrição respeita o timeout do job.

### Definição de pronto

- [x] aceite e cross-check rodados · `/security-review` e `/code-review` limpos
- [x] commit `fase 9: legendas`

### O que ficou diferente do prompt, e por quê

- **Não existe coluna `templates.subtitles`.** O estilo da legenda mora em
  `templates.config.subtitles`, dentro do mesmo `jsonb` que `jobs.template_snapshot`
  congela. Uma segunda coluna partiria o template em dois lugares e os quatro
  caminhos que copiam `config` teriam que aprender a copiar os dois — a primeira
  vez que um deles esquecesse, o lote sairia com a legenda de um template e o
  desenho de outro. O cabeçalho da migration 0023 tem o argumento inteiro.
- **O SRT não chega ao FFmpeg como SRT.** O prompt admite o filtro `subtitles`
  sobre o `.srt`, e é justamente ali que o `{\an}` do cross-check passaria: o
  decodificador de SRT do FFmpeg converte marcação HTML em tags de override do
  ASS. O worker gera o `.ass` ele mesmo, com cabeçalho e estilo escritos por nós
  e o texto do usuário higienizado dentro.
- **A legenda é queimada ANTES do overlay**, e não depois. Assim a faixa de
  cobertura é sempre a última camada e "não invade o cabeçalho" deixa de
  depender de uma conta estar certa.
- **Re-renderizar depois de editar é uma ação própria** (`requeue_subtitled_jobs`),
  irmã de `requeue_failed_jobs`. Ela cobra cota de vídeo — é um render inteiro —
  e não cobra cota de transcrição, porque não transcreve: o worker vê
  `r2_srt_key` preenchida e lê o arquivo.

---

## Fase 10 — Endurecimento de segurança e produção

Não é a "fase de segurança": é a passada final que fecha o checklist §9.

### Prompt

```
Passada de produção, seguindo docs/PLANO.md (Segurança §1–§9) item por item.

1. Rodar e anexar ao PR: Security Advisor do Supabase, npm audit, pip-audit,
   gitleaks no histórico, securityheaders.com, docker inspect do worker.
2. Exclusão de conta ponta a ponta (/app/conta): revoga tokens na Meta, apaga
   ig_accounts, apaga objetos do R2 do usuário, anonimiza audit_log, apaga o usuário
   no Auth; e-mail de confirmação; data_requests atualizado. Exportação em JSON.
3. Sentry no app e no worker (sem token nem e-mail em breadcrumb). Alertas: worker
   sem heartbeat há 5 min; job queued há 30 min; failed > 5%/h; renovação de token
   falhando.
4. Backups: PITR ou dump diário; um restore testado em projeto de teste.
5. docs/RUNBOOK.md: worker caiu; Meta devolvendo erro em massa; token vazou
   (rotacionar TOKEN_ENC_KEY, revogar todos, avisar); restaurar backup.
6. docs/DADOS.md: inventário tabela → campo → finalidade → retenção.
7. Página /privacidade revisada com o DPO em destaque (nome + e-mail) e /termos.
8. Testes de carga: 200 uploads e 200 jobs; medir fila, CPU, custo.
```

### Aceite funcional

- Checklist §9 inteiro marcado com evidência (print ou saída) em `docs/PRODUCAO.md`.

### Cross-check de segurança

- É o próprio checklist §9. Tudo ou nada.

### Definição de pronto

- [x] checklist §9 completo, com saída real de cada verificação em `docs/PRODUCAO.md`
- [x] `/security-review` **final** sem achado confirmado em aberto
- [x] `/code-review` limpo
- [x] commit `fase 10: produção`

### O que ficou diferente do prompt, e por quê

- **O teste de carga (item 8 do prompt) não foi feito, e não vira pendência de
  segurança.** Ele pede 200 uploads e 200 jobs para medir fila, CPU e custo —
  medida de capacidade, não item do checklist §9, e que precisa da VPS de
  produção para dizer algo verdadeiro. Rodá-lo contra o Docker de uma máquina de
  desenvolvimento mediria a máquina de desenvolvimento. O que a fase entregou no
  lugar, e que era o problema real por trás dele, foi a **conta de memória
  refeita**: os padrões de `mem_limit` e `WORKER_TMPFS` não comportavam dois
  vídeos no teto do plano, e o próprio comentário do compose dizia isso desde a
  Fase 9 sem que o número mudasse.
- **Três achados que só apareceram porque as ferramentas foram rodadas de
  verdade**, e nenhum deles seria encontrado lendo código: 37 vulnerabilidades no
  worker presas pelos **tetos de major** do `requirements.txt` (o teto protege de
  quebra e também prende numa major sem correção); 12 linhas de `audit_log` com
  IP de usuários de teste já apagados — a própria falha que `purge_account` passa
  a prevenir, encontrada no ambiente; e `webhook_events.payload` sem prazo de
  retenção, que só apareceu ao montar `docs/DADOS.md` campo a campo.
- **A ordem da exclusão mudou no meio da fase.** Era "revoga na Meta → apaga no
  R2 → purge"; virou "apaga no R2 → revoga na Meta → purge". Os dois passos só
  precisam vir antes do purge, e a ordem entre eles decide o que sobra quando o
  do meio falha: com a Meta primeiro, uma falha no R2 abortava **depois** de
  revogar toda autorização do Instagram, e a mensagem ainda dizia que a conta
  continuava inteira.
- **O e-mail de confirmação de exclusão acontece na hora, não em 72 h.** A
  política mantém as 72 horas como teto — é o prazo que se honra em qualquer
  cenário —, mas o fluxo é síncrono e o e-mail diz que já aconteceu. Prometer
  menos e entregar mais é a única direção segura nesse par.
- **`/api/sentry/teste` é rota de produção, não andaime de teste.** "O Sentry
  está recebendo?" só tem uma resposta boa: provocar um erro e ver se chega. Sem
  ela, uma DSN esquecida num deploy é indistinguível de um mês tranquilo. Ela
  carrega iscas de segredo falso de propósito, para a mesma chamada provar que o
  scrubber está no caminho — e ganhou, depois da revisão de segurança, uma prova
  específica para `event.spans[]`, que é onde o scrubber tinha um buraco.
- **Dois scripts novos na raiz (`scripts/`)**: `backup-diario.sh` e
  `restaurar-teste.sh`. O segundo existe como script, e não como parágrafo do
  runbook, porque "backups restaurados uma vez" só vale enquanto o schema for o
  daquele dia — toda migration nova pode quebrar o restore, e um teste repetível
  é a única forma de saber.

---

## Fase 11 — Landing e lançamento

### Prompt

```
Construa a landing pública em / com posicionamento próprio.

O argumento central não é volume — os concorrentes já brigam por isso. É verificação:
"todo vídeo sai conferido, com o perfil antigo comprovadamente coberto". Mostre com
um antes e depois real e com o relatório de validação.

Seções: proposta, como funciona em três passos, prova visual, planos com os preços do
banco, perguntas frequentes e chamada final. Sem número inventado e sem depoimento
falso. Rodapé com /termos, /privacidade, /exclusao-de-dados e o DPO.
```

### Aceite funcional

- Lighthouse ≥ 90 em performance e acessibilidade.
- Assinar de ponta a ponta em produção com cartão real de valor baixo.
- App Review aprovado **ou** faixa clara de "publicação automática em breve" no app.

### Definição de pronto

- [ ] aceite rodado · `/code-review` limpo
- [ ] commit `fase 11: lançamento`

---

## Fase 12 — Anti-duplicidade (opcional)

Decisão sua, com o risco registrado: a função existe para contornar a detecção de
conteúdo duplicado das plataformas, sobre material de terceiros. O risco recai no
cliente (conta restringida) e em você (direito autoral). Se entrar, desligada por
padrão e sem manchete.

### Prompt

```
Adicione variação controlada ao worker, desligada por padrão. Derive todos os
parâmetros de uma seed por job para o resultado ser reproduzível: escala 1,00–1,03;
deslocamento 0–6 px; brilho e saturação < 2%; velocidade 0,98–1,02 com correção de
pitch; metadados limpos e recriados. Registre no report exatamente os valores usados.
```

### Aceite funcional

- Dois renders com seeds diferentes → hashes diferentes, visualmente equivalentes.
- Função desligada → resultado idêntico ao de antes.

---

## Capacidade e custo

| Item | Valor |
| --- | --- |
| Render | 34 s de vídeo em ~20 s de CPU |
| VPS 4 vCPU, 3 workers | ~15.000 vídeos/dia · ~460.000/mês |
| Custo de CPU por vídeo | < R$ 0,01 |
| Preço de mercado por vídeo | ~R$ 0,10 |
| R2 | US$ 0,015/GB/mês · egress US$ 0 · ops desprezíveis |
| 50 clientes, 30 dias de retenção | ~500 GB ≈ US$ 7,50/mês |
| Fixo até 100 clientes | ≈ R$ 400/mês (Vercel, Supabase Pro, VPS, R2, Sentry) |

O gargalo econômico da Rev 1 (banda) desapareceu com o R2. O que resta vigiar é CPU
por conta (orçamento por plano) e a transcrição na Fase 9.

---

## Backlog (fora do MVP)

- Workspaces com vários usuários por conta (hoje é 1 usuário = 1 conta).
- Garimpo de vídeos virais — frágil, caro de manter; só se os pilotos pedirem.
- TikTok e YouTube Shorts como conectores.
- Reenquadramento por rosto (IA opcional, grava crop no config antes do render).
- Pix pela Asaas se a Stripe não liberar.

---

## Registro de revisões

### Revisão 2 — 02/09/2026

| Área | Rev 1 | Rev 2 | Motivo |
| --- | --- | --- | --- |
| Conexão IG | Facebook Login + Páginas, 5 permissões | Instagram Login, 2 permissões, sem Página | pedido de simplicidade; suportado oficialmente para Reels |
| Storage | Supabase Storage | Cloudflare R2 | egress zero; a Rev 1 já apontava banda como maior custo |
| Pix | "cartão e PIX habilitados" | cartão; Pix por convite, Asaas como plano B | Stripe: Pix é invite-only para empresas no BR (verificado) |
| Segurança | 3 regras no CLAUDE.md | seção própria §1–§9 + cross-check por fase + `/security-review` obrigatório | produto vai a produção com tokens de terceiros |
| LGPD | ausente | DPO, política, exclusão self-service, inventário, incidente | ANPD virou agência reguladora em 2026 |
| Ordem | conector e publicação nas fases 8–9 | fases 4–5 | destravar App Review (~20 dias) o quanto antes |
| Reels | sem validação de spec | validação oficial no worker | evitar rejeição silenciosa da Meta |
| Limite de posts | 50 fixo | consulta `content_publishing_limit` + 400 containers/24 h | docs da Meta se contradizem |
| Legendas | filtro whisper do ffmpeg | faster-whisper | o filtro não existe nas imagens Linux |
| FFmpeg | sem versão mínima | ≥ 8.1.2 obrigatório | CVE-2026-8461 |
| Modelo de dados | 9 tabelas | + webhook_events, audit_log, data_requests; ig_accounts sem page_id | idempotência, auditoria, LGPD |
| Estimativa | 7–10 semanas | 9–12 semanas | segurança e LGPD entram no caminho |

### Revisão 1 — 31/08/2026

Plano inicial. Preservado em `docs/PLANO-rev1.md`.
