-- PageMask · 0008_funcoes_so_do_servidor
-- Fecha um buraco que a 0007 abriu ao fechar outro.
--
-- O QUE ACONTECEU
--
-- A 0007 tirou INSERT e DELETE de `jobs` do papel `authenticated`, para que a
-- unica porta de entrada fosse `register_upload_job` — a funcao que roda depois
-- da sondagem de codec (PLANO §4) e que consome cota na mesma transacao.
--
-- So que ela deu `grant execute … to authenticated` para essa mesma funcao. E
-- funcao do Postgres com grant para `authenticated` **e uma rota publica**: o
-- PostgREST a expoe em `POST /rest/v1/rpc/register_upload_job`, alcancavel com
-- a chave anon e o JWT do proprio usuario. A porta trancada tinha uma janela
-- ao lado.
--
-- O que dava para fazer por ali: pedir uma URL pre-assinada legitima, gravar
-- QUALQUER conteudo naquela chave (a assinatura prende o `Content-Type` do
-- cabecalho HTTP, nao os bytes do arquivo), e entao chamar a RPC direto com
-- `p_recusa => null` e um `p_probe` inventado. A linha nasceria `uploaded`, com
-- um probe que parece prova de que a lista fechada foi conferida — e na Fase 3
-- esse arquivo e o que o worker entrega ao FFmpeg. Exatamente o decoder exotico
-- que a lista fechada existe para nao acionar, com o banco atestando o
-- contrario.
--
-- A REGRA, daqui em diante
--
-- Uma funcao so continua chamavel por `authenticated` quando chama-la DIRETO e
-- equivalente a chama-la pelo app. Se o app faz algo antes ou depois que o
-- banco nao tem como refazer, a funcao e do servidor:
--
--   create_project       → continua com `authenticated`. Nao ha passo de
--                          servidor: o limite de plano esta todo dentro dela.
--   register_upload_job  → servidor. Antes dela vem o `HEAD` no R2 (tamanho
--                          real) e a sondagem de codec.
--   discard_job          → servidor. Depois dela vem apagar o objeto no R2, que
--                          exige credencial que o navegador nao tem.
--   discard_project      → servidor, pela mesma razao.
--
-- Como as tres passam a rodar com a chave `service_role`, `auth.uid()` la
-- dentro seria nulo — o dono agora chega por parametro. Isso NAO afrouxa nada:
-- so o servidor chama, e ele preenche o parametro com o id que o
-- `supabase.auth.getUser()` validou contra o Supabase, nunca com algo vindo do
-- corpo da requisicao.

begin;

-- ---------------------------------------------------------------------------
-- register_upload_job
-- ---------------------------------------------------------------------------
-- A assinatura muda (ganha `p_user_id` na frente), entao a versao antiga
-- precisa sair: um `create or replace` deixaria as duas no ar, e a antiga
-- continuaria com o grant para `authenticated`.
--
-- O segundo `drop`, o da assinatura NOVA, e o que deixa esta migration
-- reaplicavel. O laco do README roda todos os arquivos em ordem, sempre; sem
-- ele, a segunda passada morre em "function already exists with same argument
-- types" — e morre DEPOIS de ja ter alterado o que vinha antes, deixando o
-- banco no meio do caminho.

drop function if exists public.register_upload_job(uuid, text, bigint, text, jsonb, text);
drop function if exists public.register_upload_job(uuid, uuid, text, bigint, text, jsonb, text);

create function public.register_upload_job(
  p_user_id    uuid,
  p_project_id uuid,
  p_r2_key     text,
  p_bytes      bigint,
  p_filename   text,
  p_probe      jsonb,
  p_recusa     text default null
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_limite integer;
  v_usados integer;
  v_job    public.jobs;
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  -- A forma INTEIRA da chave, nao so o prefixo. O servidor ja a monta assim
  -- (`lib/r2/chaves.ts`); escrever a regra aqui tambem significa que uma
  -- mudanca em um dos dois lados quebra alto, em vez de gravar em silencio uma
  -- linha apontando para um lugar que o resto do sistema nao espera.
  if p_r2_key !~ ('^' || p_user_id::text || '/' || p_project_id::text ||
                  '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm|mkv)$')
  then
    raise exception 'chave fora do formato esperado' using errcode = 'PM006';
  end if;

  if p_bytes is null or p_bytes <= 0 then
    raise exception 'tamanho invalido' using errcode = 'PM007';
  end if;

  if p_recusa is null then
    insert into public.subscriptions (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

    select videos_used into v_usados
      from public.subscriptions
     where user_id = p_user_id
       for update;

    select pl.videos_month into v_limite
      from public.plano_do_usuario(p_user_id) as pl;
    if v_limite is null then
      raise exception 'plano nao encontrado' using errcode = 'PM004';
    end if;

    if v_usados >= v_limite then
      raise exception 'quota de videos do plano atingida (%)', v_limite
        using errcode = 'PM002';
    end if;

    update public.subscriptions
       set videos_used = videos_used + 1
     where user_id = p_user_id;
  end if;

  insert into public.jobs (
    project_id, user_id, status, r2_input_key, bytes_in, filename, probe, error
  )
  values (
    p_project_id,
    p_user_id,
    case
      when p_recusa is null then 'uploaded'
      else 'rejected'
    end::public.job_status,
    p_r2_key,
    p_bytes,
    p_filename,
    p_probe,
    p_recusa
  )
  returning * into v_job;

  return v_job;
end;
$fn$;

revoke execute on function
  public.register_upload_job(uuid, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function
  public.register_upload_job(uuid, uuid, text, bigint, text, jsonb, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- discard_job
-- ---------------------------------------------------------------------------

drop function if exists public.discard_job(uuid);
drop function if exists public.discard_job(uuid, uuid);

create function public.discard_job(p_user_id uuid, p_job_id uuid)
returns table (input_key text, output_key text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_job public.jobs;
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  select * into v_job
    from public.jobs
   where id = p_job_id and user_id = p_user_id
     for update;

  if not found then
    raise exception 'job nao encontrado' using errcode = 'PM008';
  end if;

  if v_job.status in ('processing', 'queued') then
    raise exception 'job em processamento' using errcode = 'PM009';
  end if;

  if v_job.status = 'uploaded' then
    update public.subscriptions
       set videos_used = greatest(videos_used - 1, 0)
     where user_id = p_user_id;
  end if;

  delete from public.jobs where id = v_job.id;

  input_key  := v_job.r2_input_key;
  output_key := v_job.r2_output_key;
  return next;
end;
$fn$;

revoke execute on function public.discard_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.discard_job(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- discard_project
-- ---------------------------------------------------------------------------

drop function if exists public.discard_project(uuid);
drop function if exists public.discard_project(uuid, uuid);

create function public.discard_project(p_user_id uuid, p_project_id uuid)
returns table (chave text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_por_apagar integer;
  v_chaves     text[];
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
       for update
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  if exists (
    select 1 from public.jobs
     where project_id = p_project_id
       and status in ('queued', 'processing')
  ) then
    raise exception 'projeto com job em processamento' using errcode = 'PM010';
  end if;

  select count(*) into v_por_apagar
    from public.jobs
   where project_id = p_project_id and status = 'uploaded';

  if v_por_apagar > 0 then
    update public.subscriptions
       set videos_used = greatest(videos_used - v_por_apagar, 0)
     where user_id = p_user_id;
  end if;

  select array_agg(k) into v_chaves from (
    select j.r2_input_key as k
      from public.jobs as j
     where j.project_id = p_project_id
    union all
    select j.r2_output_key
      from public.jobs as j
     where j.project_id = p_project_id and j.r2_output_key is not null
  ) as t;

  delete from public.projects where id = p_project_id;

  return query select unnest(coalesce(v_chaves, array[]::text[]));
end;
$fn$;

revoke execute on function public.discard_project(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.discard_project(uuid, uuid) to service_role;

commit;
