-- PageMask · 0014_confirmacao_nunca_devolve_nulo
-- Um `if not found` que faltava, e o estrago que a falta dele fazia.
--
-- O tratador de `unique_violation` da `register_upload_job` relia a linha pela
-- chave e devolvia o que achasse. Só que `select … into` do plpgsql **nao
-- levanta erro quando nao acha nada**: ele preenche a variavel com um composto
-- todo nulo e segue em frente. Numa corrida em que a linha e apagada entre o
-- `insert` que falhou no unico e o `select` de recuperacao — um `discard_job`
-- da mesma chave —, a funcao retornava `jobs` com todos os campos nulos.
--
-- A rota entao respondia **200** com `{"id": null, "status": null}`, o cliente
-- lia `status !== "rejected"` e marcava "Enviado" na tela, gastando uma vaga da
-- cota local por um job que nao existe. Falha silenciosa das piores: sucesso
-- aparente, nada gravado.
--
-- Agora esse caminho levanta `PM011`, que a interface traduz para uma frase que
-- diz o que aconteceu e o que fazer.

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

  -- Primeira trava: `projects` (0012).
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

  -- Segunda trava: `subscriptions`, antes da checagem de idempotencia (0011).
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

    -- A linha existia (por isso o unico disparou) e sumiu antes desta leitura.
    -- Sem este `if`, `v_job` seria um composto de campos nulos e a rota
    -- responderia 200 dizendo que deu tudo certo.
    if not found then
      raise exception 'o registro deste envio sumiu no meio da confirmacao'
        using errcode = 'PM011';
    end if;
  end;

  return v_job;
end;
$fn$;

commit;
