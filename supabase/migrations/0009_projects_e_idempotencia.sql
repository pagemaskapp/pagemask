-- PageMask · 0009_projects_e_idempotencia
-- Dois buracos que sobraram da 0007/0008, do mesmo feitio um do outro.
--
-- 1. `projects` ainda era escrita direto pelo cliente
--
-- A 0007 tirou INSERT e DELETE de `jobs` do papel `authenticated` para que a
-- unica porta fosse a funcao — e esqueceu de fazer o mesmo com `projects`. A
-- 0001 tinha dado `grant select, insert, update, delete` mais politicas de RLS
-- para todos os comandos, entao a `create_project` e a `discard_project` eram
-- so o caminho BONITO, nao o unico:
--
--   POST /rest/v1/projects      → cria projeto ignorando o limite do plano
--   DELETE /rest/v1/projects?id=eq.…
--                               → apaga o projeto e, por cascata, os jobs:
--                                 pula a trava de job em processamento,
--                                 pula a devolucao de cota, e deixa TODOS os
--                                 objetos do projeto orfaos no R2, porque
--                                 ninguem colheu as chaves antes de apagar.
--
-- O UPDATE fica: mudar o nome e o `template_id` do proprio projeto nao tem
-- passo de servidor nenhum por perto, e a RLS da 0001 ja amarra o `template_id`
-- a um template do proprio dono.
--
-- 2. Confirmar o mesmo upload duas vezes criava dois jobs
--
-- `register_upload_job` inseria sem olhar se aquela chave ja tinha linha. Duas
-- confirmacoes da mesma chave — um duplo clique, uma retentativa depois de a
-- rede cair entre a resposta e o cliente le-la — gastavam DUAS vagas de cota
-- por um arquivo so. Pior: remover um dos dois apagava o objeto no R2, e o
-- outro ficava na tela apontando para um arquivo que nao existe mais.
--
-- A partir daqui a confirmacao e idempotente: a segunda chamada devolve a linha
-- que ja existe, sem consumir cota de novo. O indice unico e o que sustenta
-- isso sob concorrencia — duas confirmacoes simultaneas nao conseguem passar
-- as duas pelo `select` inicial, e a segunda cai no `unique_violation`, que e
-- tratado como o que ele e: "ja registrado".

begin;

-- ---------------------------------------------------------------------------
-- projects: o cliente le e renomeia; criar e apagar passam pelas funcoes
-- ---------------------------------------------------------------------------

revoke insert, delete on public.projects from anon, authenticated;

drop policy if exists "projetos proprios: criar" on public.projects;
drop policy if exists "projetos proprios: apagar" on public.projects;

-- ---------------------------------------------------------------------------
-- Uma chave do R2, um job
-- ---------------------------------------------------------------------------
-- `concurrently` nao entra aqui de proposito: ele nao roda dentro de
-- transacao, e esta migration precisa ser atomica. A tabela e pequena nesta
-- fase; quando nao for, o indice ja existira.

create unique index if not exists jobs_r2_input_key_key
  on public.jobs (r2_input_key);

-- ---------------------------------------------------------------------------
-- register_upload_job, agora idempotente
-- ---------------------------------------------------------------------------
-- Mesma assinatura da 0008, entao `create or replace` basta e o grant de la
-- (`service_role` apenas) continua valendo.

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

  -- Confirmacao repetida da MESMA chave: devolve o que ja existe. A chave
  -- carrega o dono e o projeto no proprio texto, e o formato foi conferido
  -- acima, entao chegar aqui com a chave de outra pessoa e impossivel.
  select * into v_job from public.jobs where r2_input_key = p_r2_key;
  if found then
    return v_job;
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
    -- Outra confirmacao da mesma chave passou pelo `select` acima antes de esta
    -- chegar ao `insert`. Ela ja fez o trabalho; esta devolve o mesmo job. A
    -- cota que esta transacao somou volta junto, senao a corrida cobraria duas.
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
