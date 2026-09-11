-- PageMask · 0011_idempotencia_depois_da_trava
-- A ordem de duas instrucoes dentro da `register_upload_job`.
--
-- A 0009 pos a checagem de idempotencia — "ja existe job para esta chave?" —
-- ANTES de travar a linha da assinatura. Numa corrida de duas confirmacoes da
-- mesma chave com a cota no ultimo credito, isso da um final ruim:
--
--   T1  select em jobs → nada          T2  select em jobs → nada (T1 ainda
--                                          nao commitou)
--   T1  trava subscriptions            T2  espera na trava
--   T1  699 → 700, insere o job,
--       commita
--                                      T2  acorda, le 700, levanta PM002
--                                      rota: "cota estourada, apaga o objeto"
--
-- O arquivo apagado e o do job que T1 acabou de gravar. Sobra uma linha
-- dizendo "Enviado", com cota consumida, apontando para um objeto que nao
-- existe mais.
--
-- A CORRECAO E SO INVERTER AS DUAS. Trocada a ordem, T2 so volta a rodar
-- depois do commit de T1 — e o `select` seguinte, sob READ COMMITTED, pega um
-- snapshot novo, que JA ENXERGA a linha de T1. T2 devolve o job existente e
-- nunca chega no ramo da cota. A trava, que existia para serializar o consumo
-- de cota, passa a serializar tambem a decisao de "isto ja foi registrado".
--
-- O caminho de recusa (`p_recusa` preenchido) nao trava nada, porque nao mexe
-- em cota; la quem resolve a corrida continua sendo o indice unico e o
-- `exception when unique_violation` mais abaixo.

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

  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
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

  -- A trava vem PRIMEIRO. Ver o cabecalho deste arquivo.
  if p_recusa is null then
    insert into public.subscriptions (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

    select videos_used into v_usados
      from public.subscriptions
     where user_id = p_user_id
       for update;
  end if;

  -- Confirmacao repetida da MESMA chave: devolve o que ja existe, sem consumir
  -- cota de novo. A chave carrega o dono e o projeto no proprio texto, e o
  -- formato foi conferido acima, entao chegar aqui com a chave de outra pessoa
  -- e impossivel.
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
    -- So alcancavel pelo caminho de recusa, que nao trava a assinatura: duas
    -- recusas simultaneas da mesma chave. A de aceite ja foi serializada pela
    -- trava la em cima. A devolucao de cota fica por seguranca, para o caso de
    -- um caminho futuro chegar aqui com credito somado.
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
