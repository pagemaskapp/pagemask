-- PageMask · 0012_ordem_das_travas
-- Duas funcoes pegando as mesmas duas travas em ordem oposta.
--
-- `discard_project`  trava `projects` e depois `subscriptions`.
-- `register_upload_job` travava `subscriptions` e, ao inserir em `jobs`, o
--                       Postgres pega sozinho um `FOR KEY SHARE` na linha de
--                       `projects` referenciada pela chave estrangeira.
--
-- Ou seja: uma sobe a escada e a outra desce. Com uma confirmacao de upload em
-- voo e o usuario clicando "Apagar projeto" — que estao na MESMA TELA, um
-- embaixo do outro —, as duas transacoes se esperam e o Postgres mata uma com
-- `40P01 deadlock detected`. Nao ha codigo `PM0xx` para isso, entao ele chegava
-- ao usuario como 500 sem explicacao nenhuma.
--
-- Impasse nao se resolve com retentativa, se resolve com ORDEM. As duas passam
-- a pegar `projects` primeiro. Na `register_upload_job` isso custa transformar
-- a checagem de dono, que ja lia a linha, num `select … for update` — e o
-- efeito colateral e bem-vindo: confirmacoes do mesmo projeto passam a
-- serializar entre si, o que ja era o caso de fato por causa da trava da
-- assinatura.

begin;

create or replace function public.register_upload_job(
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

  -- Primeira trava: `projects`. A mesma que a `discard_project` pega primeiro.
  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
       for update
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  if p_r2_key !~ ('^' || p_user_id::text || '/' || p_project_id::text ||
                  '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm|mkv)$')
  then
    raise exception 'chave fora do formato esperado' using errcode = 'PM006';
  end if;

  if p_bytes is null or p_bytes <= 0 then
    raise exception 'tamanho invalido' using errcode = 'PM007';
  end if;

  -- Segunda trava: `subscriptions`. Vem antes da checagem de idempotencia
  -- porque e ela que serializa as duas confirmacoes da mesma chave (0011).
  if p_recusa is null then
    insert into public.subscriptions (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

    select videos_used into v_usados
      from public.subscriptions
     where user_id = p_user_id
       for update;
  end if;

  select * into v_job from public.jobs where r2_input_key = p_r2_key;
  if found then
    return v_job;
  end if;

  if p_recusa is null then
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

  begin
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
  exception when unique_violation then
    if p_recusa is null then
      update public.subscriptions
         set videos_used = greatest(videos_used - 1, 0)
       where user_id = p_user_id;
    end if;
    select * into v_job from public.jobs where r2_input_key = p_r2_key;
  end;

  return v_job;
end;
$fn$;

commit;
