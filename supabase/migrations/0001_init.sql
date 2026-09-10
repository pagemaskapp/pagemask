-- PageMask · 0001_init
-- Schema inicial: planos, perfis, assinaturas, projetos, templates, assets,
-- fila de jobs, contas do Instagram, agendamentos, webhooks, auditoria e LGPD.
--
-- Regras que valem para o arquivo inteiro (docs/PLANO.md, "Seguranca e LGPD" §2):
--   * RLS habilitado em TODAS as tabelas de `public`.
--   * Uma politica por comando, sempre referenciando auth.uid().
--   * `plans` e a unica tabela de leitura publica.
--   * O que so o servidor escreve (webhook, worker, auditoria) nao ganha politica
--     de escrita: a chave `sb_secret_` roda como `service_role` e ignora RLS.
--     Sem politica = negado para o cliente, por construcao.

begin;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

create type public.job_status as enum (
  'queued', 'processing', 'done', 'failed', 'rejected', 'canceled'
);

create type public.schedule_status as enum (
  'scheduled', 'publishing', 'published', 'failed', 'deferred'
);

create type public.ig_account_status as enum (
  'active', 'needs_reconnect', 'revoked'
);

create type public.asset_kind as enum ('header', 'logo', 'font');

create type public.webhook_provider as enum ('stripe', 'meta');

create type public.data_request_kind as enum ('deletion', 'export');

create type public.data_request_status as enum (
  'received', 'processing', 'completed', 'failed'
);

-- ---------------------------------------------------------------------------
-- plans — catalogo de planos. Limite de plano sai daqui, nunca de constante.
-- ---------------------------------------------------------------------------

create table public.plans (
  slug            text primary key,
  name            text        not null,
  price_cents     integer     not null check (price_cents >= 0),
  videos_month    integer     not null check (videos_month > 0),
  ig_accounts     integer     not null check (ig_accounts > 0),
  projects        integer     not null check (projects > 0),
  max_mb          integer     not null check (max_mb > 0),
  stripe_price_id text,
  active          boolean     not null default true,
  sort_order      smallint    not null default 0,
  created_at      timestamptz not null default now()
);

comment on table public.plans is
  'Catalogo de planos. Preco em centavos (inteiro), nunca float. Leitura publica.';
comment on column public.plans.max_mb is
  'Tamanho maximo de um arquivo de video enviado, em megabytes.';

-- ---------------------------------------------------------------------------
-- profiles — extensao de auth.users
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  name               text,
  plan_slug          text        not null default 'partida'
                       references public.plans (slug) on update cascade,
  stripe_customer_id text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index profiles_plan_slug_idx on public.profiles (plan_slug);

-- ---------------------------------------------------------------------------
-- subscriptions — estado da assinatura na Stripe + quota consumida
-- ---------------------------------------------------------------------------

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid        not null unique
                           references auth.users (id) on delete cascade,
  stripe_subscription_id text unique,
  status                 text        not null default 'incomplete',
  current_period_end     timestamptz,
  videos_used            integer     not null default 0 check (videos_used >= 0),
  cancel_at_period_end   boolean     not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on column public.subscriptions.videos_used is
  'Quota consumida no periodo. Incrementa ao aceitar o job e devolve o credito se '
  'o job falhar em definitivo. Nunca derivar de count(jobs).';

-- ---------------------------------------------------------------------------
-- templates — padrao visual aplicado ao lote
-- ---------------------------------------------------------------------------

create table public.templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  name       text        not null,
  config     jsonb       not null default '{}'::jsonb,
  version    integer     not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index templates_user_id_idx on public.templates (user_id);

-- ---------------------------------------------------------------------------
-- projects — uma pasta de videos do cliente
-- ---------------------------------------------------------------------------

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  name        text        not null,
  template_id uuid        references public.templates (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index projects_user_id_idx on public.projects (user_id);
create index projects_template_id_idx on public.projects (template_id);

-- ---------------------------------------------------------------------------
-- assets — cabecalho, logo e fonte enviados pelo usuario
-- ---------------------------------------------------------------------------

create table public.assets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid              not null references auth.users (id) on delete cascade,
  kind       public.asset_kind not null,
  r2_key     text              not null unique,
  mime       text              not null,
  bytes      bigint            not null check (bytes > 0),
  sha256     text,
  created_at timestamptz       not null default now()
);

create index assets_user_id_idx on public.assets (user_id, kind);

-- ---------------------------------------------------------------------------
-- jobs — a fila. Consumida com FOR UPDATE SKIP LOCKED pelo worker.
-- ---------------------------------------------------------------------------

create table public.jobs (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid              not null references public.projects (id) on delete cascade,
  user_id           uuid              not null references auth.users (id) on delete cascade,
  status            public.job_status not null default 'queued',
  progress          smallint          not null default 0
                      check (progress between 0 and 100),
  r2_input_key      text              not null,
  r2_output_key     text,
  bytes_in          bigint            check (bytes_in > 0),
  probe             jsonb,
  template_snapshot jsonb,
  report            jsonb,
  attempts          smallint          not null default 0 check (attempts >= 0),
  error             text,
  queued_at         timestamptz       not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  expires_at        timestamptz       not null default (now() + interval '30 days')
);

comment on column public.jobs.template_snapshot is
  'Copia congelada do template no momento do enfileiramento. Editar o template no '
  'meio do lote nao muda os videos ja na fila.';
comment on column public.jobs.probe is
  'Saida do ffprobe da entrada: prova de que o arquivo passou na lista fechada de '
  'codecs (PLANO §4) e trilha de auditoria depois.';
comment on column public.jobs.expires_at is
  'Combina com o lifecycle de 30 dias do bucket R2: banco e bucket concordam sobre '
  'quando o arquivo some.';

-- Indice do consumidor da fila: o mais antigo em `queued`.
create index jobs_queue_idx on public.jobs (queued_at) where status = 'queued';
create index jobs_user_id_idx on public.jobs (user_id, queued_at desc);
create index jobs_project_id_idx on public.jobs (project_id, queued_at desc);
create index jobs_expires_at_idx on public.jobs (expires_at);

-- ---------------------------------------------------------------------------
-- ig_accounts — contas do Instagram conectadas. Token cifrado em repouso.
-- ---------------------------------------------------------------------------

create table public.ig_accounts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid   not null references auth.users (id) on delete cascade,
  ig_user_id          text   not null,
  username            text   not null,
  profile_picture_url text,
  scopes              text[] not null default '{}',
  token_cipher        bytea,
  token_iv            bytea,
  token_tag           bytea,
  key_version         smallint    not null default 1,
  token_expires_at    timestamptz,
  last_refreshed_at   timestamptz,
  status              public.ig_account_status not null default 'active',
  connected_at        timestamptz not null default now(),
  unique (user_id, ig_user_id)
);

comment on table public.ig_accounts is
  'Token do Instagram cifrado com AES-256-GCM (TOKEN_ENC_KEY, so no servidor e no '
  'worker). As colunas de token NAO sao legiveis pelo papel `authenticated`: ver os '
  'GRANTs por coluna no fim deste arquivo.';
comment on column public.ig_accounts.key_version is
  'Versao da TOKEN_ENC_KEY usada para cifrar. Permite rotacao sem downtime.';

create index ig_accounts_user_id_idx on public.ig_accounts (user_id);
create index ig_accounts_refresh_idx on public.ig_accounts (token_expires_at)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- schedules — publicacao agendada de um job em uma conta
-- ---------------------------------------------------------------------------

create table public.schedules (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid        not null references public.jobs (id) on delete cascade,
  ig_account_id   uuid        not null references public.ig_accounts (id) on delete cascade,
  scheduled_at    timestamptz not null,
  caption         text,
  status          public.schedule_status not null default 'scheduled',
  ig_container_id text,
  ig_media_id     text,
  error           text,
  attempts        smallint    not null default 0 check (attempts >= 0),
  published_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index schedules_due_idx on public.schedules (scheduled_at)
  where status = 'scheduled';
create index schedules_job_id_idx on public.schedules (job_id);
create index schedules_ig_account_id_idx on public.schedules (ig_account_id);

-- ---------------------------------------------------------------------------
-- webhook_events — idempotencia de Stripe e Meta por construcao
-- ---------------------------------------------------------------------------

create table public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     public.webhook_provider not null,
  event_id     text        not null unique,
  payload      jsonb       not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

comment on table public.webhook_events is
  'O insert acontece ANTES de processar. O segundo evento com o mesmo event_id '
  'falha no unique e e ignorado: e assim que a idempotencia e garantida.';

create index webhook_events_pending_idx on public.webhook_events (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- audit_log — quem fez o que
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        references auth.users (id) on delete set null,
  actor      text        not null default 'user',
  action     text        not null,
  target     text,
  meta       jsonb       not null default '{}'::jsonb,
  ip         inet,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Registrar: conectar/desconectar conta, publicar, mudar plano, excluir conta. '
  'Nunca gravar token nem e-mail em `meta`.';

create index audit_log_user_id_idx on public.audit_log (user_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

-- ---------------------------------------------------------------------------
-- data_requests — LGPD e o Data Deletion Callback da Meta
-- ---------------------------------------------------------------------------

create table public.data_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid        references auth.users (id) on delete set null,
  kind              public.data_request_kind   not null,
  confirmation_code text        not null unique,
  status            public.data_request_status not null default 'received',
  requested_at      timestamptz not null default now(),
  completed_at      timestamptz,
  meta              jsonb       not null default '{}'::jsonb
);

create index data_requests_user_id_idx
  on public.data_requests (user_id, requested_at desc);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================

alter table public.plans          enable row level security;
alter table public.profiles       enable row level security;
alter table public.subscriptions  enable row level security;
alter table public.templates      enable row level security;
alter table public.projects       enable row level security;
alter table public.assets         enable row level security;
alter table public.jobs           enable row level security;
alter table public.ig_accounts    enable row level security;
alter table public.schedules      enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_log      enable row level security;
alter table public.data_requests  enable row level security;

-- --- plans: a unica de leitura publica --------------------------------------

create policy "plans sao publicos para leitura"
  on public.plans for select
  to anon, authenticated
  using (active);

-- Escrita em `plans` e operacao de manutencao: so pela chave secreta.

-- --- profiles ---------------------------------------------------------------

create policy "perfil proprio: ler"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

-- So `name` e editavel pelo dono. `plan_slug` e `stripe_customer_id` sao
-- decididos pelo webhook da Stripe: sem o GRANT por coluna la embaixo, esta
-- politica deixaria qualquer um se promover para o plano Escala de graca.
create policy "perfil proprio: atualizar"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- O insert de `profiles` e feito pelo trigger `handle_new_user` (security
-- definer) no cadastro, e nao pelo cliente. Delete acontece por cascata de
-- auth.users. Nenhuma politica de insert/delete, portanto.

-- --- subscriptions: leitura propria; escrita so pelo webhook da Stripe ------

create policy "assinatura propria: ler"
  on public.subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

-- --- templates --------------------------------------------------------------

create policy "templates proprios: ler"
  on public.templates for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "templates proprios: criar"
  on public.templates for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "templates proprios: atualizar"
  on public.templates for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "templates proprios: apagar"
  on public.templates for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- --- projects ---------------------------------------------------------------

create policy "projetos proprios: ler"
  on public.projects for select
  to authenticated
  using (user_id = (select auth.uid()));

-- `template_id` so pode apontar para template do proprio dono. A RLS de
-- `templates` ja esconde o alheio na leitura, mas nao impede a referencia.
create policy "projetos proprios: criar"
  on public.projects for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      template_id is null
      or exists (
        select 1 from public.templates t
        where t.id = template_id and t.user_id = (select auth.uid())
      )
    )
  );

create policy "projetos proprios: atualizar"
  on public.projects for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      template_id is null
      or exists (
        select 1 from public.templates t
        where t.id = template_id and t.user_id = (select auth.uid())
      )
    )
  );

create policy "projetos proprios: apagar"
  on public.projects for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- --- assets -----------------------------------------------------------------

create policy "assets proprios: ler"
  on public.assets for select
  to authenticated
  using (user_id = (select auth.uid()));

-- A chave R2 tem que comecar pelo id do dono: `{user_id}/…` (PLANO §4). Sem
-- isso o usuario cria uma linha apontando para o objeto de outro e passa a ler
-- o arquivo alheio por uma URL pre-assinada legitima.
create policy "assets proprios: criar"
  on public.assets for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and r2_key like (select auth.uid())::text || '/%'
  );

-- Asset nao se edita: trocar arquivo e criar linha nova e apagar a velha.
-- Sem politica de update, portanto.

create policy "assets proprios: apagar"
  on public.assets for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- --- jobs -------------------------------------------------------------------
-- O usuario le e cancela os proprios jobs. Quem muda status, progresso e
-- resultado e o worker, com a chave secreta: sem politica de update aqui.

create policy "jobs proprios: ler"
  on public.jobs for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Alem do dono e do projeto, dois cuidados:
--   · a chave de entrada precisa comecar pelo id do dono, senao da para
--     enfileirar um job que le o video de outro cliente;
--   · `status` nasce em `queued`. O GRANT por coluna la embaixo impede que o
--     cliente escolha `done` na hora do insert e fabrique um job pronto.
create policy "jobs proprios: enfileirar"
  on public.jobs for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and r2_input_key like (select auth.uid())::text || '/%'
    and exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = (select auth.uid())
    )
  );

create policy "jobs proprios: apagar"
  on public.jobs for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- --- ig_accounts ------------------------------------------------------------
-- A conexao (insert) e a renovacao (update) passam pelo servidor, que e quem
-- tem a TOKEN_ENC_KEY. O cliente le (sem as colunas de token) e desconecta.

create policy "contas IG proprias: ler"
  on public.ig_accounts for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "contas IG proprias: desconectar"
  on public.ig_accounts for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- --- schedules --------------------------------------------------------------
-- Dono via jobs.user_id. Quem publica e o worker, com a chave secreta.

create policy "agendamentos proprios: ler"
  on public.schedules for select
  to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = (select auth.uid())
    )
  );

create policy "agendamentos proprios: criar"
  on public.schedules for insert
  to authenticated
  with check (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.ig_accounts a
      where a.id = ig_account_id and a.user_id = (select auth.uid())
    )
  );

-- O `with check` repete a checagem da conta IG que o insert faz. Sem ela o
-- usuario reaponta um agendamento proprio para a conta de Instagram de outro
-- cliente e publica no perfil alheio.
create policy "agendamentos proprios: reagendar"
  on public.schedules for update
  to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.ig_accounts a
      where a.id = ig_account_id and a.user_id = (select auth.uid())
    )
  );

create policy "agendamentos proprios: cancelar"
  on public.schedules for delete
  to authenticated
  using (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.user_id = (select auth.uid())
    )
  );

-- --- webhook_events: nenhuma politica ---------------------------------------
-- RLS ligado e zero politicas = negado para anon e authenticated em todos os
-- comandos. So a chave secreta escreve e le. Isso e intencional.

-- --- audit_log --------------------------------------------------------------

create policy "auditoria propria: ler"
  on public.audit_log for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Escrita de auditoria e sempre do servidor: sem politica de insert.

-- --- data_requests ----------------------------------------------------------

create policy "solicitacoes proprias: ler"
  on public.data_requests for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "solicitacoes proprias: abrir"
  on public.data_requests for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- ===========================================================================
-- Privilegios por coluna
-- ===========================================================================
-- RLS decide QUAIS LINHAS. GRANT decide QUAIS COLUNAS. As duas coisas sao
-- necessarias: uma politica `user_id = auth.uid()` autoriza a linha inteira,
-- inclusive campos que so o servidor deveria escrever (o plano contratado, o
-- status de um job, a chave de saida no R2).
-- ===========================================================================
-- RLS filtra linhas, nao colunas. Sem isto, um `select *` autenticado traria
-- token_cipher/token_iv/token_tag do proprio usuario para o navegador.
--
-- Consequencia pratica, para a Fase 4 nao ser pega de surpresa: com privilegio
-- por coluna, `select *` em `ig_accounts` nao devolve menos colunas — ele da
-- "permission denied for table ig_accounts". Toda consulta a esta tabela pelo
-- cliente precisa listar as colunas. `IgAccountPublic`, em
-- `app/src/lib/supabase/database.types.ts`, e a lista.

revoke select on public.ig_accounts from anon, authenticated;

grant select (
  id, user_id, ig_user_id, username, profile_picture_url, scopes,
  token_expires_at, last_refreshed_at, status, connected_at
) on public.ig_accounts to authenticated;

revoke insert, update on public.ig_accounts from anon, authenticated;

-- --- profiles: o dono muda o nome, e so ---------------------------------
-- `plan_slug` e `stripe_customer_id` sao consequencia do webhook da Stripe.
-- Editaveis pelo cliente, viravam upgrade de plano gratuito.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (name) on public.profiles to authenticated;

-- --- jobs: o cliente enfileira, o worker executa -------------------------
-- Sem esta lista, o insert do cliente poderia trazer `status = done`,
-- `report`, `r2_output_key` ou um `expires_at` de dez anos.
revoke insert, update on public.jobs from anon, authenticated;
grant insert (project_id, user_id, r2_input_key, bytes_in)
  on public.jobs to authenticated;

-- --- assets: metadados do arquivo que o proprio usuario acabou de subir ---
revoke insert, update on public.assets from anon, authenticated;
grant insert (user_id, kind, r2_key, mime, bytes, sha256)
  on public.assets to authenticated;

-- --- schedules: quando publicar, onde e com que legenda ------------------
-- `ig_container_id`, `ig_media_id`, `status`, `attempts` e `published_at` sao
-- resultado da publicacao, escritos pelo worker.
revoke insert, update on public.schedules from anon, authenticated;
grant insert (job_id, ig_account_id, scheduled_at, caption)
  on public.schedules to authenticated;
grant update (scheduled_at, caption) on public.schedules to authenticated;

-- --- templates e projects: o dono e dono mesmo ---------------------------
-- Nao ha coluna de sistema nessas duas alem de id/created_at/updated_at, que
-- tem default e trigger. Nada a revogar por coluna.

-- `plans` e catalogo: leitura para todo mundo, escrita so pela chave secreta.
revoke insert, update, delete on public.plans from anon, authenticated;

-- Tabelas escritas apenas pelo servidor.
revoke all on public.webhook_events from anon, authenticated;
revoke insert, update, delete on public.audit_log from anon, authenticated;
revoke insert, update, delete on public.subscriptions from anon, authenticated;
revoke insert, update, delete on public.data_requests from anon, authenticated;
-- O titular abre a solicitacao; `status` e `completed_at` sao do processo.
grant insert (user_id, kind, confirmation_code)
  on public.data_requests to authenticated;

-- ===========================================================================
-- profiles ← auth.users
-- ===========================================================================

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user is
  'Cria a linha de `profiles` no cadastro. `security definer` com search_path '
  'vazio: a funcao roda com privilegio do dono e nao pode ser sequestrada por '
  'um schema no caminho de busca.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- updated_at
-- ===========================================================================

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

create trigger templates_touch_updated_at
  before update on public.templates
  for each row execute function public.touch_updated_at();

create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

commit;
