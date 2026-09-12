-- PageMask · 0019_agenda_e_publicacao
--
-- A Fase 5 fecha o fluxo: o video pronto vai para o perfil do Instagram na
-- hora marcada. Este arquivo da a `schedules` o que faltava para ser uma fila
-- de publicacao, e da ao servidor as funcoes dos dois callbacks da Meta.
--
-- QUEM ESCREVE O QUE
-- ==================
--
--   cliente (RLS + GRANT por coluna)   cria, reagenda e cancela o proprio
--                                      agendamento. So `scheduled_at` e
--                                      `caption` sao dele.
--   cron (service_role)                `mark_due_schedules`: vencido vira
--                                      `publishing`.
--   worker (service_role)              `claim_publish` reclama com
--                                      FOR UPDATE SKIP LOCKED, e as funcoes de
--                                      desfecho gravam resultado + auditoria
--                                      NA MESMA TRANSACAO.
--   callbacks da Meta (service_role)   `open_meta_data_deletion` e
--                                      `deauthorize_ig`, idempotentes por
--                                      `webhook_events.event_id`.
--
-- POR QUE O CRON E O WORKER SAO DOIS PASSOS
-- =========================================
--
-- O cron da Vercel roda a cada minuto e nao tem token nenhum: ele so vira o
-- estado. Quem fala com `graph.instagram.com` e o worker, que tem a
-- `TOKEN_ENC_KEY`. Duas execucoes do cron no mesmo minuto nao publicam em
-- dobro por dois motivos independentes: o UPDATE de `mark_due_schedules` so
-- pega `scheduled`/`deferred` (a segunda execucao nao encontra nada) e o
-- `claim_publish` do worker pula linha travada. O cross-check da fase mede os
-- dois.
--
-- `attempts` E A SENHA DE PORTEIRO, como na 0015: toda funcao de desfecho
-- confere `attempts = p_attempt`. Um worker que ficou preso e voltou depois de
-- o claim ter sido refeito por outro (claim expirado) nao consegue mais
-- escrever por cima.
--
-- Codigos de erro desta migration:
--   PM016  (reaproveitado) este agendamento nao esta mais com este worker
--   PM021  agendamento inexistente, de outro usuario ou que nao esta em falha
--   PM022  callback da Meta sem ig_user_id

begin;

-- ---------------------------------------------------------------------------
-- schedules — colunas novas
-- ---------------------------------------------------------------------------

alter table public.schedules
  add column if not exists ig_permalink    text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists claimed_by      text,
  add column if not exists claimed_at      timestamptz,
  add column if not exists updated_at      timestamptz not null default now();

comment on column public.schedules.ig_permalink is
  'Link publico do post no Instagram, lido depois do media_publish.';
comment on column public.schedules.next_attempt_at is
  'Espera entre tentativas. Nulo = imediatamente. So vale para `scheduled`.';
comment on column public.schedules.claimed_by is
  'Worker que reclamou a publicacao. Claim com mais de PUBLISH_STALE_MIN '
  'minutos e considerado abandonado e pode ser reclamado de novo.';

-- A Meta aceita ate 2.200 caracteres de legenda (conferido na referencia de
-- POST /{ig-user-id}/media em 11/09/2026). O contador da tela para no mesmo
-- numero; este check e o que impede um PATCH por fora da tela de gravar mais.
alter table public.schedules
  drop constraint if exists schedules_caption_len;
alter table public.schedules
  add constraint schedules_caption_len
  check (caption is null or length(caption) <= 2200);

drop trigger if exists schedules_touch_updated_at on public.schedules;
create trigger schedules_touch_updated_at
  before update on public.schedules
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------------

drop index if exists public.schedules_due_idx;
create index schedules_due_idx
  on public.schedules (scheduled_at)
  where status in ('scheduled', 'deferred');

create index if not exists schedules_publishing_idx
  on public.schedules (claimed_at nulls first, scheduled_at)
  where status = 'publishing';

-- O mesmo video na mesma conta so pode estar pendente uma vez. Publicado ou
-- falhado nao conta: republicar depois de uma falha e legitimo.
create unique index if not exists schedules_pendente_unico_idx
  on public.schedules (job_id, ig_account_id)
  where status in ('scheduled', 'publishing', 'deferred');

-- ---------------------------------------------------------------------------
-- Politicas do cliente — mais estreitas do que na 0001
-- ---------------------------------------------------------------------------
--
-- A 0001 so conferia dono. Aqui entra o que a fase exige de fato:
--   · so video `done` com saida no R2 pode ser agendado (a Meta baixa o
--     arquivo pela URL assinada — sem saida nao ha o que publicar);
--   · so conta `active` (uma `needs_reconnect` publicaria com token morto);
--   · reagendar e cancelar so enquanto o worker nao pegou (`publishing` e
--     do worker; `published` e historico).
--
-- A conta de outro usuario continua barrada pelo `a.user_id = auth.uid()`,
-- que e o que o cross-check da fase testa.

drop policy if exists "agendamentos proprios: criar"     on public.schedules;
drop policy if exists "agendamentos proprios: reagendar" on public.schedules;
drop policy if exists "agendamentos proprios: cancelar"  on public.schedules;

create policy "agendamentos proprios: criar"
  on public.schedules for insert
  to authenticated
  with check (
    exists (
      select 1 from public.jobs j
       where j.id = job_id
         and j.user_id = (select auth.uid())
         and j.status = 'done'
         and j.r2_output_key is not null
    )
    and exists (
      select 1 from public.ig_accounts a
       where a.id = ig_account_id
         and a.user_id = (select auth.uid())
         and a.status = 'active'
    )
    -- Cinco minutos de folga para o relogio do navegador; o servidor ainda
    -- confere o "no passado" com mensagem propria.
    and scheduled_at > now() - interval '5 minutes'
  );

create policy "agendamentos proprios: reagendar"
  on public.schedules for update
  to authenticated
  using (
    status in ('scheduled', 'deferred')
    and exists (
      select 1 from public.jobs j
       where j.id = job_id and j.user_id = (select auth.uid())
    )
  )
  with check (
    status in ('scheduled', 'deferred')
    and exists (
      select 1 from public.jobs j
       where j.id = job_id and j.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.ig_accounts a
       where a.id = ig_account_id and a.user_id = (select auth.uid())
    )
    and scheduled_at > now() - interval '5 minutes'
  );

create policy "agendamentos proprios: cancelar"
  on public.schedules for delete
  to authenticated
  using (
    status <> 'publishing'
    and exists (
      select 1 from public.jobs j
       where j.id = job_id and j.user_id = (select auth.uid())
    )
  );

-- Os callbacks da Meta chegam com o `ig_user_id` e nada mais. O unico indice
-- que o tinha era o unique `(user_id, ig_user_id)`, com `user_id` na frente —
-- inutil para uma busca so por `ig_user_id`. Um indice proprio faz o callback
-- ser uma busca, e nao uma varredura da tabela inteira sob lock.
create index if not exists ig_accounts_ig_user_id_idx
  on public.ig_accounts (ig_user_id);

-- Os dois callbacks revogam do mesmo jeito. Uma funcao so, para a lista de
-- colunas de token nao divergir entre elas quando ganhar uma setima.
create or replace function public.revoke_ig_accounts_by_ig_user(
  p_ig_user_id text
) returns table (id uuid, user_id uuid, username text)
language sql
security definer
set search_path = ''
as $fn$
  update public.ig_accounts
     set status            = 'revoked',
         token_cipher      = null,
         token_iv          = null,
         token_tag         = null,
         token_expires_at  = null,
         last_refreshed_at = now()
   where ig_user_id = p_ig_user_id
     and status <> 'revoked'
  returning id, user_id, username;
$fn$;

-- ---------------------------------------------------------------------------
-- ig_account_token — o token de UMA conta, para o app consultar o limite
-- ---------------------------------------------------------------------------
-- Mesma razao de `ig_accounts_para_renovar` (0018): o token so sai do banco
-- pelo retorno de uma funcao concedida a `service_role`, nunca por SELECT numa
-- tabela cujo tipo do cliente nao o conhece. O dono chega por parametro e a
-- funcao confere: o servidor preenche com o id da sessao validada.

create or replace function public.ig_account_token(
  p_user_id    uuid,
  p_account_id uuid
) returns table (
  id               uuid,
  ig_user_id       text,
  username         text,
  status           public.ig_account_status,
  cipher_hex       text,
  iv_hex           text,
  tag_hex          text,
  key_version      smallint,
  token_expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $fn$
  select a.id, a.ig_user_id, a.username, a.status,
         encode(a.token_cipher, 'hex'),
         encode(a.token_iv,     'hex'),
         encode(a.token_tag,    'hex'),
         a.key_version, a.token_expires_at
    from public.ig_accounts as a
   where a.id = p_account_id
     and a.user_id = p_user_id;
$fn$;

-- ---------------------------------------------------------------------------
-- mark_due_schedules — o cron de cada minuto
-- ---------------------------------------------------------------------------

create or replace function public.mark_due_schedules(
  p_max integer default 200
) returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_quantos integer;
begin
  with vencidos as (
    select s.id
      from public.schedules as s
     where s.status in ('scheduled', 'deferred')
       and s.scheduled_at <= now()
       and (s.next_attempt_at is null or s.next_attempt_at <= now())
     order by s.scheduled_at
       for update skip locked
     limit greatest(1, coalesce(p_max, 200))
  ),
  marcados as (
    update public.schedules as s
       set status          = 'publishing',
           claimed_by      = null,
           claimed_at      = null,
           next_attempt_at = null
      from vencidos as v
     where s.id = v.id
    returning 1
  )
  select count(*) into v_quantos from marcados;

  return v_quantos;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- claim_publish — o worker reclama UMA publicacao
-- ---------------------------------------------------------------------------
-- Devolve tudo que o worker precisa numa viagem so: o agendamento, a chave da
-- saida no R2 e o token cifrado da conta. Claim abandonado (worker morto no
-- meio da espera pelo container) volta a ficar disponivel depois de
-- `p_stale_min`; `attempts` sobe a cada claim, e e o worker que decide, pelo
-- teto de tentativas, quando parar de insistir.

create or replace function public.claim_publish(
  p_worker    text,
  p_stale_min integer default 15
) returns table (
  schedule_id     uuid,
  job_id          uuid,
  user_id         uuid,
  ig_account_id   uuid,
  scheduled_at    timestamptz,
  caption         text,
  attempts        smallint,
  ig_container_id text,
  r2_output_key   text,
  filename        text,
  ig_user_id      text,
  username        text,
  account_status  public.ig_account_status,
  cipher_hex      text,
  iv_hex          text,
  tag_hex         text,
  key_version     smallint
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  if p_worker is null or length(btrim(p_worker)) = 0 then
    raise exception 'worker sem identificacao' using errcode = 'PM014';
  end if;

  select s.id into v_id
    from public.schedules as s
   where s.status = 'publishing'
     and (
       s.claimed_at is null
       or s.claimed_at < now() - make_interval(mins => greatest(1, coalesce(p_stale_min, 15)))
     )
   order by s.scheduled_at
     for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  update public.schedules as s
     set claimed_by = left(btrim(p_worker), 120),
         claimed_at = now(),
         attempts   = s.attempts + 1
   where s.id = v_id;

  return query
  select s.id, s.job_id, j.user_id, s.ig_account_id, s.scheduled_at, s.caption,
         s.attempts, s.ig_container_id, j.r2_output_key, j.filename,
         a.ig_user_id, a.username, a.status,
         encode(a.token_cipher, 'hex'),
         encode(a.token_iv,     'hex'),
         encode(a.token_tag,    'hex'),
         a.key_version
    from public.schedules   as s
    join public.jobs        as j on j.id = s.job_id
    join public.ig_accounts as a on a.id = s.ig_account_id
   where s.id = v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- publish_container — o container foi criado; guarda o id e renova o claim
-- ---------------------------------------------------------------------------
-- Renovar `claimed_at` aqui e o batimento do worker durante a espera pelo
-- FINISHED (ate 10 min): sem isso um container lento faria o claim parecer
-- abandonado e outro worker criaria um segundo container para o mesmo video.

create or replace function public.publish_container(
  p_id           uuid,
  p_attempt      integer,
  p_container_id text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_linhas integer;
begin
  update public.schedules
     set ig_container_id = coalesce(p_container_id, ig_container_id),
         claimed_at      = now()
   where id = p_id
     and status = 'publishing'
     and attempts = p_attempt;

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- finish_publish — publicado
-- ---------------------------------------------------------------------------

create or replace function public.finish_publish(
  p_id        uuid,
  p_attempt   integer,
  p_media_id  text,
  p_permalink text default null
) returns public.schedules
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_agenda public.schedules;
  v_user   uuid;
  v_conta  text;
begin
  update public.schedules
     set status          = 'published',
         ig_media_id     = p_media_id,
         ig_permalink    = p_permalink,
         published_at    = now(),
         error           = null,
         claimed_by      = null,
         claimed_at      = null,
         next_attempt_at = null
   where id = p_id
     and status = 'publishing'
     and attempts = p_attempt
  returning * into v_agenda;

  if not found then
    raise exception 'este agendamento nao esta mais com este worker' using errcode = 'PM016';
  end if;

  select j.user_id into v_user from public.jobs as j where j.id = v_agenda.job_id;
  select a.username into v_conta from public.ig_accounts as a where a.id = v_agenda.ig_account_id;

  -- PLANO §7: `audit_log` em toda publicacao. Na mesma transacao do estado,
  -- entao nao existe "publicou mas nao registrou".
  insert into public.audit_log (user_id, actor, action, target, meta)
  values (
    v_user, 'worker', 'publish.ok', v_agenda.id::text,
    jsonb_build_object(
      'job_id', v_agenda.job_id,
      'ig_account_id', v_agenda.ig_account_id,
      'username', v_conta,
      'ig_media_id', p_media_id,
      'permalink', p_permalink,
      'attempts', v_agenda.attempts
    )
  );

  return v_agenda;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- fail_publish — deu errado: tenta de novo ou desiste
-- ---------------------------------------------------------------------------
-- Um lugar so decide entre "de novo" e "acabou", como `fail_job` na 0015. A
-- nova tentativa volta para `scheduled` com `next_attempt_at` no futuro — o
-- cron a marca de novo quando chegar a hora — e a definitiva vira `failed`,
-- que e o que a tela mostra com o botao "Tentar de novo".

-- `p_limpar_container`: quando o container da Meta terminou em ERROR ele e
-- terminal — a proxima tentativa com o mesmo id so repetiria o erro e gastaria
-- as tres tentativas contra um objeto morto. Nesse caso o id e apagado e a
-- tentativa seguinte cria outro. Container ainda IN_PROGRESS (orcamento de 10
-- min estourado) e mantido: ele pode terminar sozinho ate a proxima vez.
drop function if exists public.fail_publish(uuid, integer, text, boolean, integer, integer);

create or replace function public.fail_publish(
  p_id               uuid,
  p_attempt          integer,
  p_mensagem         text,
  p_definitivo       boolean default false,
  p_max              integer default 3,
  p_espera_s         integer default 0,
  p_limpar_container boolean default false
) returns public.schedules
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_agenda public.schedules;
  v_ultima boolean;
  v_user   uuid;
begin
  select * into v_agenda
    from public.schedules
   where id = p_id
     and status = 'publishing'
     and attempts = p_attempt
     for update;

  if not found then
    raise exception 'este agendamento nao esta mais com este worker' using errcode = 'PM016';
  end if;

  v_ultima := coalesce(p_definitivo, false) or v_agenda.attempts >= coalesce(p_max, 3);

  if v_ultima then
    update public.schedules
       set status          = 'failed',
           error           = left(coalesce(p_mensagem, 'Falha na publicacao.'), 2000),
           claimed_by      = null,
           claimed_at      = null,
           next_attempt_at = null
     where id = p_id
    returning * into v_agenda;
  else
    update public.schedules
       set status          = 'scheduled',
           error           = left(coalesce(p_mensagem, 'Falha na publicacao.'), 2000),
           ig_container_id = case when coalesce(p_limpar_container, false) then null else ig_container_id end,
           claimed_by      = null,
           claimed_at      = null,
           next_attempt_at = now() + make_interval(secs => greatest(0, coalesce(p_espera_s, 0)))
     where id = p_id
    returning * into v_agenda;
  end if;

  select j.user_id into v_user from public.jobs as j where j.id = v_agenda.job_id;

  insert into public.audit_log (user_id, actor, action, target, meta)
  values (
    v_user, 'worker',
    case when v_ultima then 'publish.failed' else 'publish.retry' end,
    v_agenda.id::text,
    jsonb_build_object(
      'job_id', v_agenda.job_id,
      'ig_account_id', v_agenda.ig_account_id,
      'attempts', v_agenda.attempts,
      'error', v_agenda.error,
      'next_attempt_at', v_agenda.next_attempt_at
    )
  );

  return v_agenda;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- defer_publish — limite da Meta atingido: adia sem gastar tentativa
-- ---------------------------------------------------------------------------
-- Adiar nao e falhar. A cota de 100 posts em 24 h e um limite da conta, e
-- pode levar horas para abrir vaga; se cada adiamento contasse como tentativa,
-- tres horas de cota cheia virariam `failed`. Por isso o `attempts` volta.

create or replace function public.defer_publish(
  p_id       uuid,
  p_attempt  integer,
  p_ate      timestamptz,
  p_mensagem text
) returns public.schedules
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_agenda public.schedules;
  v_user   uuid;
begin
  update public.schedules
     set status          = 'deferred',
         scheduled_at    = greatest(p_ate, now() + interval '1 minute'),
         error           = left(coalesce(p_mensagem, 'Publicacao adiada.'), 2000),
         attempts        = greatest(attempts - 1, 0),
         claimed_by      = null,
         claimed_at      = null,
         next_attempt_at = null
   where id = p_id
     and status = 'publishing'
     and attempts = p_attempt
  returning * into v_agenda;

  if not found then
    raise exception 'este agendamento nao esta mais com este worker' using errcode = 'PM016';
  end if;

  select j.user_id into v_user from public.jobs as j where j.id = v_agenda.job_id;

  insert into public.audit_log (user_id, actor, action, target, meta)
  values (
    v_user, 'worker', 'publish.deferred', v_agenda.id::text,
    jsonb_build_object(
      'job_id', v_agenda.job_id,
      'ig_account_id', v_agenda.ig_account_id,
      'scheduled_at', v_agenda.scheduled_at,
      'error', v_agenda.error
    )
  );

  return v_agenda;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- retry_schedule — o botao "Tentar de novo" da tela
-- ---------------------------------------------------------------------------
-- Passa pelo servidor porque `status` e `attempts` nao sao colunas do cliente
-- (GRANT por coluna da 0001). O dono chega por parametro, validado da sessao.

create or replace function public.retry_schedule(
  p_user_id uuid,
  p_id      uuid
) returns public.schedules
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_agenda public.schedules;
begin
  update public.schedules as s
     set status          = 'scheduled',
         scheduled_at    = now(),
         attempts        = 0,
         error           = null,
         ig_container_id = null,
         next_attempt_at = null,
         claimed_by      = null,
         claimed_at      = null
   where s.id = p_id
     and s.status = 'failed'
     and exists (
       select 1 from public.jobs as j
        where j.id = s.job_id and j.user_id = p_user_id
     )
     and exists (
       select 1 from public.ig_accounts as a
        where a.id = s.ig_account_id and a.user_id = p_user_id and a.status = 'active'
     )
  returning s.* into v_agenda;

  if not found then
    raise exception 'agendamento inexistente, de outro usuario ou que nao esta em falha'
      using errcode = 'PM021';
  end if;

  insert into public.audit_log (user_id, actor, action, target, meta)
  values (
    p_user_id, 'user', 'publish.retry_manual', v_agenda.id::text,
    jsonb_build_object('job_id', v_agenda.job_id, 'ig_account_id', v_agenda.ig_account_id)
  );

  return v_agenda;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- open_meta_data_deletion — o Data Deletion Request Callback (PLANO §5)
-- ---------------------------------------------------------------------------
-- Idempotente por `webhook_events.event_id` (o hash do `signed_request`): a
-- Meta pode reenviar o mesmo pedido, e o segundo precisa devolver o MESMO
-- codigo de confirmacao, nao abrir outra solicitacao.
--
-- O que acontece na hora: toda conta com aquele `ig_user_id` perde o token e
-- vira `revoked`, e a solicitacao nasce `received`. Apagar o resto (arquivos,
-- perfil) e o fluxo de exclusao da Fase 10, que le `data_requests`.
--
-- `user_id` pode ser nulo: a Meta pode pedir exclusao de alguem que nunca
-- chegou a conectar (autorizou e fechou a janela). A solicitacao e registrada
-- do mesmo jeito, porque o codigo precisa existir para a pessoa consultar.

create or replace function public.open_meta_data_deletion(
  p_ig_user_id text,
  p_code       text,
  p_event_id   text
) returns table (confirmation_code text, user_id uuid, ja_existia boolean)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid;
  v_evt  uuid;
begin
  if p_ig_user_id is null or length(btrim(p_ig_user_id)) = 0 then
    raise exception 'ig_user_id ausente' using errcode = 'PM022';
  end if;

  select a.user_id into v_user
    from public.ig_accounts as a
   where a.ig_user_id = p_ig_user_id
   order by a.connected_at desc
   limit 1;

  insert into public.webhook_events (provider, event_id, payload, processed_at)
  values (
    'meta', p_event_id,
    jsonb_build_object(
      'tipo', 'data_deletion',
      'ig_user_id', p_ig_user_id,
      'confirmation_code', p_code,
      'user_id', v_user
    ),
    now()
  )
  on conflict (event_id) do nothing
  returning id into v_evt;

  if v_evt is null then
    -- Ja tratado: devolve o que foi gravado da primeira vez.
    return query
    select w.payload ->> 'confirmation_code',
           (w.payload ->> 'user_id')::uuid,
           true
      from public.webhook_events as w
     where w.event_id = p_event_id;
    return;
  end if;

  perform public.revoke_ig_accounts_by_ig_user(p_ig_user_id);

  insert into public.data_requests (user_id, kind, confirmation_code, meta)
  values (
    v_user, 'deletion', p_code,
    jsonb_build_object('origem', 'meta', 'ig_user_id', p_ig_user_id)
  );

  insert into public.audit_log (user_id, actor, action, target, meta)
  values (
    v_user, 'meta', 'meta.data_deletion', p_code,
    jsonb_build_object('ig_user_id', p_ig_user_id)
  );

  return query select p_code, v_user, false;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- deauthorize_ig — o Deauthorize Callback: a pessoa removeu o app no Instagram
-- ---------------------------------------------------------------------------
-- Devolve quantas contas foram revogadas; -1 quando o evento ja tinha sido
-- tratado. O token e apagado, nao so marcado: depois da desautorizacao ele
-- esta morto na Meta de qualquer forma, e nao ha por que guardar segredo
-- morto.

create or replace function public.deauthorize_ig(
  p_ig_user_id text,
  p_event_id   text
) returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_evt     uuid;
  v_quantos integer;
  v_user    uuid;
begin
  if p_ig_user_id is null or length(btrim(p_ig_user_id)) = 0 then
    raise exception 'ig_user_id ausente' using errcode = 'PM022';
  end if;

  insert into public.webhook_events (provider, event_id, payload, processed_at)
  values (
    'meta', p_event_id,
    jsonb_build_object('tipo', 'deauthorize', 'ig_user_id', p_ig_user_id),
    now()
  )
  on conflict (event_id) do nothing
  returning id into v_evt;

  if v_evt is null then
    return -1;
  end if;

  with revogadas as (
    select r.id, r.user_id, r.username
      from public.revoke_ig_accounts_by_ig_user(p_ig_user_id) as r
  ),
  auditadas as (
    insert into public.audit_log (user_id, actor, action, target, meta)
    select r.user_id, 'meta', 'ig.deauthorized', r.id::text,
           jsonb_build_object('ig_user_id', p_ig_user_id, 'username', r.username)
      from revogadas as r
    returning 1
  )
  select count(*) into v_quantos from auditadas;

  -- Sem conta nenhuma para revogar, ainda vale registrar que a Meta avisou.
  if v_quantos = 0 then
    select a.user_id into v_user
      from public.ig_accounts as a
     where a.ig_user_id = p_ig_user_id
     limit 1;

    insert into public.audit_log (user_id, actor, action, target, meta)
    values (v_user, 'meta', 'ig.deauthorized', null,
            jsonb_build_object('ig_user_id', p_ig_user_id, 'contas', 0));
  end if;

  return v_quantos;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- data_request_status — a consulta publica por codigo
-- ---------------------------------------------------------------------------
-- Devolve so o que a pagina mostra. O codigo tem 12 caracteres aleatorios
-- (~60 bits): nao e adivinhavel, e o que ele revela e "existe uma solicitacao
-- neste estado" — sem e-mail, sem id de usuario.

create or replace function public.data_request_status(
  p_code text
) returns table (
  kind         public.data_request_kind,
  status       public.data_request_status,
  requested_at timestamptz,
  completed_at timestamptz
)
language sql
security definer
set search_path = ''
as $fn$
  select d.kind, d.status, d.requested_at, d.completed_at
    from public.data_requests as d
   where d.confirmation_code = p_code;
$fn$;

-- ===========================================================================
-- Privilegios: tudo aqui e do servidor
-- ===========================================================================

revoke all on function public.revoke_ig_accounts_by_ig_user(text)               from public, anon, authenticated;
revoke all on function public.ig_account_token(uuid, uuid)                       from public, anon, authenticated;
revoke all on function public.mark_due_schedules(integer)                        from public, anon, authenticated;
revoke all on function public.claim_publish(text, integer)                       from public, anon, authenticated;
revoke all on function public.publish_container(uuid, integer, text)             from public, anon, authenticated;
revoke all on function public.finish_publish(uuid, integer, text, text)          from public, anon, authenticated;
revoke all on function public.fail_publish(uuid, integer, text, boolean, integer, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.defer_publish(uuid, integer, timestamptz, text)    from public, anon, authenticated;
revoke all on function public.retry_schedule(uuid, uuid)                         from public, anon, authenticated;
revoke all on function public.open_meta_data_deletion(text, text, text)          from public, anon, authenticated;
revoke all on function public.deauthorize_ig(text, text)                         from public, anon, authenticated;
revoke all on function public.data_request_status(text)                          from public, anon, authenticated;

grant execute on function public.revoke_ig_accounts_by_ig_user(text)            to service_role;
grant execute on function public.ig_account_token(uuid, uuid)                    to service_role;
grant execute on function public.mark_due_schedules(integer)                     to service_role;
grant execute on function public.claim_publish(text, integer)                    to service_role;
grant execute on function public.publish_container(uuid, integer, text)          to service_role;
grant execute on function public.finish_publish(uuid, integer, text, text)       to service_role;
grant execute on function public.fail_publish(uuid, integer, text, boolean, integer, integer, boolean)
  to service_role;
grant execute on function public.defer_publish(uuid, integer, timestamptz, text) to service_role;
grant execute on function public.retry_schedule(uuid, uuid)                      to service_role;
grant execute on function public.open_meta_data_deletion(text, text, text)       to service_role;
grant execute on function public.deauthorize_ig(text, text)                      to service_role;
grant execute on function public.data_request_status(text)                       to service_role;

commit;
