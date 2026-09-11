-- PageMask · 0015_fila_do_worker
-- A tabela `jobs` vira fila de verdade, e o worker ganha as funcoes que
-- precisa. Nenhuma delas e chamavel por `authenticated` — vale aqui a mesma
-- regra da 0008: uma funcao so continua exposta quando chama-la DIRETO pelo
-- PostgREST e equivalente a chama-la pelo app. Nao e o caso de nenhuma: todas
-- decidem estado de job a partir de um `p_user_id` ou de um identificador de
-- worker que o cliente nao tem como provar.
--
-- DUAS DIFERENCAS ENTRE O PROMPT DA FASE E O SCHEMA REAL, resolvidas aqui:
--
--   · o prompt diz `status='running'`; o enum (0001) tem **`processing`**. Fica
--     `processing`. Acrescentar `running` criaria dois nomes para o mesmo
--     estado e quebraria a guarda `status in ('queued','processing')` que a
--     0013 usa em `discard_project`.
--
--   · o prompt diz "falha: `'error'` com mensagem". `error` nao e estado, e
--     **coluna**. Falha recuperavel grava a mensagem em `jobs.error` e devolve
--     o job para `queued`; so a ultima tentativa vira `failed`. E a unica
--     leitura compativel com "ate 3 tentativas" na mesma frase.
--
-- ORDEM DAS TRAVAS — a mesma da 0012/0013, e pelo mesmo motivo:
--
--     projects  →  jobs  →  subscriptions
--
-- Toda funcao nova deste arquivo respeita essa ordem. Quem inverter traz o
-- `40P01` de volta, agora entre o worker e um botao da tela.

begin;

-- ---------------------------------------------------------------------------
-- Espera crescente entre tentativas
-- ---------------------------------------------------------------------------
--
-- Coluna nova em vez de empurrar `queued_at` para o futuro. `queued_at` diz
-- QUANDO o job entrou na fila e a tela mostra isso; reescreve-lo a cada falha
-- transformaria o campo numa mentira crescente, e a ordenacao da fila deixaria
-- de ser "chegou primeiro, roda primeiro".
alter table public.jobs
  add column if not exists next_attempt_at timestamptz;

comment on column public.jobs.next_attempt_at is
  'Quando este job pode ser reclamado de novo. Nulo = imediatamente.';

-- ---------------------------------------------------------------------------
-- Indices da fila
-- ---------------------------------------------------------------------------
--
-- Parciais de proposito: a fila pergunta sempre pelo mesmo recorte minusculo
-- ("o que esta em `queued`", "quantos deste usuario estao em `processing`") de
-- uma tabela que cresce com todo video ja processado. Indice parcial guarda so
-- as linhas do recorte, entao ele nao engorda junto com o historico.
create index if not exists jobs_fila_idx
  on public.jobs (next_attempt_at nulls first, queued_at)
  where status = 'queued';

create index if not exists jobs_rodando_por_usuario_idx
  on public.jobs (user_id)
  where status = 'processing';

-- ---------------------------------------------------------------------------
-- worker_heartbeat — o worker prova que esta vivo
-- ---------------------------------------------------------------------------
--
-- Sem isto, worker morto e fila vazia sao indistinguiveis de fora: nos dois
-- casos os jobs simplesmente nao andam. Com isto, "nenhum batimento ha 2 min"
-- e um alarme.
create table if not exists public.worker_heartbeat (
  worker     text        primary key,
  beat_at    timestamptz not null default now(),
  started_at timestamptz not null default now(),
  jobs_done  integer     not null default 0 check (jobs_done >= 0),
  ffmpeg     text,
  check (length(worker) between 1 and 120)
);

-- RLS ligada e **nenhuma politica**: e isso que deixa a tabela invisivel para
-- `anon` e `authenticated`. O `service_role` ignora RLS e continua escrevendo.
-- (PLANO §2 exige RLS em toda tabela de `public`; a consulta de verificacao
-- reprova tabela sem ela.)
alter table public.worker_heartbeat enable row level security;

-- ---------------------------------------------------------------------------
-- enqueue_project — o botao "Processar lote"
-- ---------------------------------------------------------------------------
--
-- SOBRE "VERIFICANDO QUOTA": o credito ja foi cobrado no upload
-- (`register_upload_job` incrementa `videos_used` ao aceitar o arquivo). Cobrar
-- de novo aqui contaria o mesmo video duas vezes. O que esta funcao confere e
-- outra coisa: se o plano AINDA comporta o que ja foi aceito — o caso real e
-- downgrade de plano entre o upload e o clique em Processar.
create or replace function public.enqueue_project(
  p_user_id    uuid,
  p_project_id uuid,
  p_snapshot   jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_limite  integer;
  v_usados  integer;
  v_quantos integer;
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'template invalido' using errcode = 'PM013';
  end if;

  -- Primeira trava: `projects`.
  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
       for update
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  select pl.videos_month into v_limite
    from public.plano_do_usuario(p_user_id) as pl;
  if v_limite is null then
    raise exception 'plano nao encontrado' using errcode = 'PM004';
  end if;

  select videos_used into v_usados
    from public.subscriptions where user_id = p_user_id;

  if coalesce(v_usados, 0) > v_limite then
    raise exception 'quota de videos do plano atingida (%)', v_limite
      using errcode = 'PM002';
  end if;

  -- Segunda trava: `jobs`, pelo proprio UPDATE.
  --
  -- `template_snapshot` e gravado AQUI, no enfileiramento, e nao lido do
  -- template na hora do render: e a copia congelada que o PLANO pede. Editar o
  -- template com o lote na fila nao muda o que ja foi enfileirado.
  with mudados as (
    update public.jobs
       set status            = 'queued',
           template_snapshot = p_snapshot,
           queued_at         = now(),
           next_attempt_at   = null,
           progress          = 0,
           attempts          = 0,
           error             = null
     where project_id = p_project_id
       and user_id    = p_user_id
       and status     = 'uploaded'
    returning 1
  )
  select count(*) into v_quantos from mudados;

  return v_quantos;
end;
$fn$;

revoke execute on function public.enqueue_project(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_project(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- claim_job — reclamar um job da fila
-- ---------------------------------------------------------------------------
--
-- O `for update skip locked` do PLANO resolve UM problema: dois workers nunca
-- pegam o mesmo job. Ele nao resolve o outro, que o cross-check da fase mede —
-- **no maximo 2 jobs simultaneos por usuario**.
--
-- Por que o `skip locked` sozinho nao basta: duas reclamacoes concorrentes do
-- mesmo usuario escolhem linhas DIFERENTES (cada uma pula a que a outra
-- travou), e ai as duas contam "0 rodando" no mesmo instante e as duas passam.
-- O limite vira 2+N silenciosamente, que e exatamente o que a conta de
-- capacidade do PLANO nao suporta.
--
-- A trava consultiva por usuario fecha isso. Ela e por transacao, e a
-- transacao aqui dura o tempo de um UPDATE. Escolhi consultiva, e nao uma
-- trava de linha em `subscriptions`, por causa da ordem: `subscriptions` e a
-- ULTIMA tabela da ordem combinada, e trava-la antes de `jobs` fecharia o
-- ciclo com `discard_project` — o `40P01` que a 0012 acabou de tirar. Trava
-- consultiva nao participa desse grafo.
--
-- Uma so trava consultiva por transacao, sempre. Se a recontagem reprovar, a
-- funcao devolve NULL em vez de tentar outro usuario: pegar a segunda trava
-- abriria a chance de dois workers as pegarem em ordem oposta. O custo de
-- devolver NULL e um ciclo de poll.
create or replace function public.claim_job(
  p_worker           text,
  p_max_por_usuario  integer default 2
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id      uuid;
  v_user    uuid;
  v_rodando integer;
  v_job     public.jobs;
begin
  if p_worker is null or length(btrim(p_worker)) = 0 then
    raise exception 'worker sem identificacao' using errcode = 'PM014';
  end if;

  if p_max_por_usuario is null or p_max_por_usuario < 1 then
    raise exception 'limite por usuario invalido' using errcode = 'PM014';
  end if;

  -- Candidato: o mais antigo da fila cujo dono ainda tem vaga. O filtro por
  -- usuario aqui e otimizacao, nao garantia — a garantia vem depois da trava.
  -- Sem ele, um usuario com a cota de execucao cheia seguraria a cabeca da fila
  -- e ninguem mais rodaria.
  select j.id, j.user_id into v_id, v_user
    from public.jobs as j
   where j.status = 'queued'
     and (j.next_attempt_at is null or j.next_attempt_at <= now())
     and (
       select count(*) from public.jobs as r
        where r.user_id = j.user_id and r.status = 'processing'
     ) < p_max_por_usuario
   order by j.next_attempt_at nulls first, j.queued_at
     for update skip locked
   limit 1;

  if not found then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  select count(*) into v_rodando
    from public.jobs
   where user_id = v_user and status = 'processing';

  if v_rodando >= p_max_por_usuario then
    return null;
  end if;

  update public.jobs
     set status          = 'processing',
         started_at      = now(),
         attempts        = attempts + 1,
         progress        = 0,
         next_attempt_at = null
   where id = v_id
     and status = 'queued'
  returning * into v_job;

  if not found then
    return null;
  end if;

  return v_job;
end;
$fn$;

revoke execute on function public.claim_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_job(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- job_progress — a barra andando
-- ---------------------------------------------------------------------------
--
-- `p_attempt` e senha de porteiro, e ela aparece em todas as funcoes de
-- conclusao daqui para baixo. O caso: um worker trava, o zelador devolve o job
-- para a fila (attempts vira N+1 na proxima reclamacao), outro worker o pega —
-- e entao o primeiro volta a si e escreve. Sem a conferencia, ele sobrescreve o
-- progresso, o resultado ou o erro de um trabalho que nao e mais dele.
create or replace function public.job_progress(
  p_job_id   uuid,
  p_attempt  integer,
  p_progress integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- Inteiro, e nao boolean. `GET DIAGNOSTICS ... = ROW_COUNT` devolve um
  -- inteiro, e o plpgsql o converteria para boolean pela via textual —
  -- '1' vira true, '0' vira false, e qualquer outro valor levanta erro de
  -- sintaxe de boolean. Funciona aqui porque o UPDATE e por chave primaria,
  -- mas e uma dependencia invisivel entre o tipo da variavel e a cardinalidade
  -- da clausula WHERE. Explicito custa uma linha.
  v_linhas integer;
begin
  update public.jobs
     set progress = greatest(0, least(100, coalesce(p_progress, 0)))::smallint
   where id = p_job_id
     and status = 'processing'
     and attempts = p_attempt;

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$fn$;

revoke execute on function public.job_progress(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.job_progress(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- finish_job — deu certo
-- ---------------------------------------------------------------------------
create or replace function public.finish_job(
  p_job_id     uuid,
  p_attempt    integer,
  p_output_key text,
  p_report     jsonb,
  p_probe      jsonb default null
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_job public.jobs;
begin
  if p_output_key is null or length(btrim(p_output_key)) = 0 then
    raise exception 'saida sem chave' using errcode = 'PM015';
  end if;

  update public.jobs
     set status        = 'done',
         progress      = 100,
         r2_output_key = p_output_key,
         report        = p_report,
         probe         = coalesce(p_probe, probe),
         error         = null,
         finished_at   = now()
   where id = p_job_id
     and status = 'processing'
     and attempts = p_attempt
  returning * into v_job;

  if not found then
    raise exception 'este job nao esta mais com este worker' using errcode = 'PM016';
  end if;

  return v_job;
end;
$fn$;

revoke execute on function public.finish_job(uuid, integer, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_job(uuid, integer, text, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- fail_job — deu errado
-- ---------------------------------------------------------------------------
--
-- Um lugar so decide entre "tenta de novo" e "acabou", porque essa decisao
-- anda junto com a devolucao do credito e as duas precisam ser a mesma
-- transacao. O credito volta **uma vez so**, no momento em que o job vira
-- `failed` — `discard_job` (0008) so devolve para status `uploaded`, entao
-- apagar um job ja falhado depois nao devolve de novo.
create or replace function public.fail_job(
  p_job_id     uuid,
  p_attempt    integer,
  p_mensagem   text,
  p_definitivo boolean default false,
  p_max        integer default 3,
  p_espera_s   integer default 0
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_job    public.jobs;
  v_ultima boolean;
begin
  -- Primeira trava: `jobs`. `subscriptions` so depois, e so no ramo definitivo.
  select * into v_job
    from public.jobs
   where id = p_job_id
     and status = 'processing'
     and attempts = p_attempt
     for update;

  if not found then
    raise exception 'este job nao esta mais com este worker' using errcode = 'PM016';
  end if;

  v_ultima := coalesce(p_definitivo, false) or v_job.attempts >= coalesce(p_max, 3);

  if v_ultima then
    update public.jobs
       set status          = 'failed',
           error           = left(coalesce(p_mensagem, 'Falha no processamento.'), 2000),
           finished_at     = now(),
           next_attempt_at = null
     where id = p_job_id
    returning * into v_job;

    -- Segunda trava: `subscriptions`. O credito volta porque o video nao foi
    -- entregue — cobrar por vaga que o PageMask nao conseguiu usar e cobrar
    -- pelo proprio defeito.
    update public.subscriptions
       set videos_used = greatest(videos_used - 1, 0)
     where user_id = v_job.user_id;
  else
    update public.jobs
       set status          = 'queued',
           error           = left(coalesce(p_mensagem, 'Falha no processamento.'), 2000),
           progress        = 0,
           started_at      = null,
           next_attempt_at = now() + make_interval(secs => greatest(0, coalesce(p_espera_s, 0)))
     where id = p_job_id
    returning * into v_job;
  end if;

  return v_job;
end;
$fn$;

revoke execute on function public.fail_job(uuid, integer, text, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.fail_job(uuid, integer, text, boolean, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- reject_job — o arquivo nao passou na lista fechada
-- ---------------------------------------------------------------------------
--
-- Separada de `fail_job` porque a natureza e outra e o usuario precisa ver a
-- diferenca: `failed` e "tentamos e nao deu", `rejected` e "este arquivo nao
-- entra". Recusa nao tem tentativa numero dois — o arquivo nao vai mudar.
create or replace function public.reject_job(
  p_job_id   uuid,
  p_attempt  integer,
  p_mensagem text,
  p_probe    jsonb default null
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_job public.jobs;
begin
  select * into v_job
    from public.jobs
   where id = p_job_id
     and status = 'processing'
     and attempts = p_attempt
     for update;

  if not found then
    raise exception 'este job nao esta mais com este worker' using errcode = 'PM016';
  end if;

  update public.jobs
     set status          = 'rejected',
         error           = left(coalesce(p_mensagem, 'Arquivo recusado.'), 2000),
         probe           = coalesce(p_probe, probe),
         progress        = 0,
         finished_at     = now(),
         next_attempt_at = null
   where id = p_job_id
  returning * into v_job;

  update public.subscriptions
     set videos_used = greatest(videos_used - 1, 0)
   where user_id = v_job.user_id;

  return v_job;
end;
$fn$;

revoke execute on function public.reject_job(uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.reject_job(uuid, integer, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- requeue_stale_jobs — o zelador
-- ---------------------------------------------------------------------------
--
-- Worker morto no meio do render deixa o job preso em `processing` para
-- sempre: ninguem mais o reclama (a fila so olha `queued`) e o usuario ve
-- "Processando" ate o fim dos tempos. Esta funcao e o que faz o aceite
-- "matar o worker e reiniciar" terminar com o job de volta na fila.
--
-- O teto de tentativas vale aqui tambem. Sem ele, um job que derruba o worker
-- a cada execucao seria devolvido para sempre, e levaria todo worker novo
-- junto — fila travada por um arquivo so.
create or replace function public.requeue_stale_jobs(
  p_minutos integer default 30,
  p_max     integer default 3
)
returns TABLE (id uuid, status public.job_status, attempts smallint)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_limite timestamptz := now() - make_interval(mins => greatest(1, coalesce(p_minutos, 30)));
begin
  return query
  with parados as (
    select j.id, j.user_id, j.attempts
      from public.jobs as j
     where j.status = 'processing'
       and coalesce(j.started_at, j.queued_at) < v_limite
     order by j.id
       for update skip locked
  ),
  desistidos as (
    update public.jobs as j
       set status      = 'failed',
           error       = 'O processamento foi interrompido vezes demais. '
                         || 'Remova o vídeo e envie de novo.',
           finished_at = now()
      from parados as p
     where j.id = p.id and p.attempts >= coalesce(p_max, 3)
    returning j.id, j.status, j.attempts, j.user_id
  ),
  devolvidos as (
    update public.jobs as j
       set status          = 'queued',
           progress        = 0,
           started_at      = null,
           next_attempt_at = null,
           error           = 'O processamento foi interrompido e o vídeo voltou para a fila.'
      from parados as p
     where j.id = p.id and p.attempts < coalesce(p_max, 3)
    returning j.id, j.status, j.attempts
  ),
  estornos as (
    update public.subscriptions as s
       set videos_used = greatest(s.videos_used - contagem.quantos, 0)
      from (
        select d.user_id, count(*) as quantos from desistidos as d group by d.user_id
      ) as contagem
     where s.user_id = contagem.user_id
    returning s.user_id
  )
  select d.id, d.status, d.attempts from desistidos as d
  union all
  select v.id, v.status, v.attempts from devolvidos as v;
end;
$fn$;

revoke execute on function public.requeue_stale_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.requeue_stale_jobs(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- worker_beat — batimento
-- ---------------------------------------------------------------------------
create or replace function public.worker_beat(
  p_worker    text,
  p_ffmpeg    text default null,
  p_jobs_done integer default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_worker is null or length(btrim(p_worker)) = 0 then
    raise exception 'worker sem identificacao' using errcode = 'PM014';
  end if;

  insert into public.worker_heartbeat as w (worker, beat_at, ffmpeg, jobs_done)
  values (left(btrim(p_worker), 120), now(), left(p_ffmpeg, 200), greatest(0, coalesce(p_jobs_done, 0)))
  on conflict (worker) do update
     set beat_at    = now(),
         ffmpeg     = coalesce(excluded.ffmpeg, w.ffmpeg),
         jobs_done  = excluded.jobs_done;
end;
$fn$;

revoke execute on function public.worker_beat(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.worker_beat(text, text, integer) to service_role;

commit;
