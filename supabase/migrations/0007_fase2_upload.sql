-- PageMask · 0007_fase2_upload
-- O que a Fase 2 precisa do banco: nome do arquivo, criacao de projeto dentro
-- do limite do plano, registro do upload com quota consumida de forma atomica e
-- remocao que devolve o credito.
--
-- DECISAO CENTRAL DESTE ARQUIVO: o cliente perde INSERT e DELETE em `jobs`.
--
-- A 0001 dava ao papel `authenticated` um insert restrito a quatro colunas, e
-- aquilo bastava enquanto nao havia servidor no caminho. Agora ha, e o insert
-- direto seria um atalho por fora de tudo que a fase construiu: quem o usasse
-- criaria um job sem sondagem de codec (PLANO §4), sem consumir quota e
-- apontando para uma chave do R2 que ninguem conferiu se existe.
--
-- O DELETE tinha o problema espelhado: apagar a linha deixa o objeto no R2 sem
-- dono — so o servidor tem credencial para apagar la — e ainda queima o credito
-- de um video que nunca foi processado.
--
-- Daqui em diante `jobs` e, para o cliente, somente leitura. Escrita so pelas
-- funcoes abaixo, que rodam `security definer` e decidem tudo a partir de
-- `auth.uid()` — nunca de um id que a requisicao mandou.

begin;

-- ---------------------------------------------------------------------------
-- jobs.filename — o nome que o usuario deu ao arquivo
-- ---------------------------------------------------------------------------
-- A chave no R2 e `{user_id}/{project_id}/{uuid}.{ext}`: opaca de proposito,
-- para que nome de arquivo — entrada nao confiavel — nunca vire caminho. Mas a
-- tela precisa mostrar "corte-final-03.mp4" em vez de um uuid, entao o nome
-- original vive aqui, como DADO, longe de qualquer sistema de arquivos.

alter table public.jobs
  add column if not exists filename text
    check (filename is null or (length(filename) between 1 and 255));

comment on column public.jobs.filename is
  'Nome original do arquivo enviado, so para exibicao. Entrada nao confiavel: '
  'higienizado no servidor antes de chegar aqui e nunca usado como caminho.';

comment on column public.jobs.queued_at is
  'Momento em que a linha nasceu. Com o estado `uploaded` (0006) isso e a hora '
  'do UPLOAD, nao a da entrada na fila: o job so vira `queued` quando o usuario '
  'manda processar o lote, e e la (Fase 3) que este campo e reescrito.';

-- ---------------------------------------------------------------------------
-- Quem ainda pode escrever em `jobs`
-- ---------------------------------------------------------------------------

revoke insert, update, delete on public.jobs from anon, authenticated;

drop policy if exists "jobs proprios: enfileirar" on public.jobs;
drop policy if exists "jobs proprios: apagar"     on public.jobs;

-- `grant select on public.jobs to authenticated` (0004) continua valendo, com a
-- politica "jobs proprios: ler" da 0001 filtrando as linhas.

-- ---------------------------------------------------------------------------
-- plano_do_usuario — o limite sai da tabela `plans`, nunca de constante
-- ---------------------------------------------------------------------------

create or replace function public.plano_do_usuario(p_user uuid)
returns public.plans
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.*
    from public.profiles as pf
    join public.plans    as p on p.slug = pf.plan_slug
   where pf.id = p_user;
$fn$;

comment on function public.plano_do_usuario is
  'Linha de `plans` do usuario. `security definer` porque as funcoes abaixo '
  'precisam do limite mesmo quando a RLS do chamador nao alcanca a linha.';

revoke execute on function public.plano_do_usuario(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_project — criar projeto sem estourar o limite do plano
-- ---------------------------------------------------------------------------
-- Contar-e-inserir em duas instrucoes e uma corrida classica: dois cliques
-- simultaneos leem "2 de 3" e inserem os dois, terminando em 4. O `for update`
-- na linha do perfil serializa por usuario e desfaz a corrida — a linha existe
-- desde o cadastro (trigger `handle_new_user`), entao ha sempre o que travar.

create or replace function public.create_project(p_name text)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user    uuid := (select auth.uid());
  v_nome    text := nullif(btrim(p_name), '');
  v_limite  integer;
  v_atuais  integer;
  v_projeto public.projects;
begin
  if v_user is null then
    raise exception 'sem sessao' using errcode = 'PM000';
  end if;

  if v_nome is null or length(v_nome) > 80 then
    raise exception 'nome invalido' using errcode = 'PM003';
  end if;

  perform 1 from public.profiles where id = v_user for update;

  select pl.projects into v_limite from public.plano_do_usuario(v_user) as pl;
  if v_limite is null then
    raise exception 'plano nao encontrado' using errcode = 'PM004';
  end if;

  select count(*) into v_atuais from public.projects where user_id = v_user;
  if v_atuais >= v_limite then
    raise exception 'limite de projetos do plano atingido (%)', v_limite
      using errcode = 'PM001';
  end if;

  insert into public.projects (user_id, name)
  values (v_user, v_nome)
  returning * into v_projeto;

  return v_projeto;
end;
$fn$;

revoke execute on function public.create_project(text) from public, anon;
grant execute on function public.create_project(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- register_upload_job — o unico caminho para uma linha nova em `jobs`
-- ---------------------------------------------------------------------------
-- Chamada pelo servidor DEPOIS de o objeto existir no R2 e de a sondagem de
-- codec ter rodado (PLANO §4). Dois desfechos, um deles sem quota:
--
--   p_recusa nulo       → 'uploaded', quota consumida
--   p_recusa preenchido → 'rejected', quota intacta, `error` com o motivo em
--                         pt-BR que a tela mostra
--
-- A quota e conferida e consumida na MESMA transacao, com a linha da assinatura
-- travada. Conferir antes e gravar depois deixaria passar o lote inteiro: vinte
-- uploads simultaneos leem "699 de 700" e gravam os vinte.

create or replace function public.register_upload_job(
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
  v_user   uuid := (select auth.uid());
  v_limite integer;
  v_usados integer;
  v_job    public.jobs;
begin
  if v_user is null then
    raise exception 'sem sessao' using errcode = 'PM000';
  end if;

  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = v_user
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  -- O prefixo da chave e o que amarra o objeto ao dono (PLANO §4). O servidor
  -- ja monta a chave sozinho; esta checagem existe para o caso de um dia ele
  -- montar errado — e para que a regra esteja escrita tambem no banco.
  if p_r2_key not like v_user::text || '/' || p_project_id::text || '/%' then
    raise exception 'chave fora do prefixo do dono' using errcode = 'PM006';
  end if;

  if p_bytes is null or p_bytes <= 0 then
    raise exception 'tamanho invalido' using errcode = 'PM007';
  end if;

  if p_recusa is null then
    insert into public.subscriptions (user_id) values (v_user)
    on conflict (user_id) do nothing;

    select videos_used into v_usados
      from public.subscriptions
     where user_id = v_user
       for update;

    select pl.videos_month into v_limite
      from public.plano_do_usuario(v_user) as pl;
    if v_limite is null then
      raise exception 'plano nao encontrado' using errcode = 'PM004';
    end if;

    if v_usados >= v_limite then
      raise exception 'quota de videos do plano atingida (%)', v_limite
        using errcode = 'PM002';
    end if;

    update public.subscriptions
       set videos_used = videos_used + 1
     where user_id = v_user;
  end if;

  insert into public.jobs (
    project_id, user_id, status, r2_input_key, bytes_in, filename, probe, error
  )
  values (
    p_project_id,
    v_user,
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
  public.register_upload_job(uuid, text, bigint, text, jsonb, text)
  from public, anon;
grant execute on function
  public.register_upload_job(uuid, text, bigint, text, jsonb, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- discard_job — apaga a linha e diz ao servidor o que apagar no R2
-- ---------------------------------------------------------------------------
-- Devolve as chaves ANTES de a linha sumir, porque quem tem credencial do R2 e
-- o servidor, e ele precisa saber o que apagar. A ordem e deliberada: banco
-- primeiro, bucket depois. Se o bucket falhar, sobra um objeto orfao que o
-- lifecycle de 30 dias recolhe; se fosse ao contrario, sobraria uma linha
-- apontando para um arquivo que nao existe mais — e essa a tela mostra.
--
-- O credito volta so para o que ainda nao foi processado. Video ja renderizado
-- consumiu worker de verdade; apagar o arquivo depois nao desfaz isso.

create or replace function public.discard_job(p_job_id uuid)
-- Os nomes de saida NAO repetem os das colunas (`r2_input_key`,
-- `r2_output_key`) de proposito: parametro OUT e variavel de plpgsql, e uma
-- variavel com o mesmo nome de uma coluna sequestra a referencia dentro de
-- qualquer SQL da funcao — silenciosamente, com o valor errado.
returns table (input_key text, output_key text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_job  public.jobs;
begin
  if v_user is null then
    raise exception 'sem sessao' using errcode = 'PM000';
  end if;

  select * into v_job
    from public.jobs
   where id = p_job_id and user_id = v_user
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
     where user_id = v_user;
  end if;

  delete from public.jobs where id = v_job.id;

  input_key  := v_job.r2_input_key;
  output_key := v_job.r2_output_key;
  return next;
end;
$fn$;

revoke execute on function public.discard_job(uuid) from public, anon;
grant execute on function public.discard_job(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- discard_project — apagar um projeto e tudo que ele guarda
-- ---------------------------------------------------------------------------
-- Existe porque o limite de projetos do plano precisa ter uma saida: sem
-- apagar, quem cria tres projetos no plano Partida fica preso para sempre — e a
-- mensagem de limite atingido mandaria fazer algo que a tela nao permite.
--
-- Devolve as chaves do R2 pelo mesmo motivo da `discard_job`: quem tem
-- credencial do bucket e o servidor. O `delete` em `projects` leva os `jobs`
-- junto por cascata (0001), entao as chaves sao lidas ANTES.

create or replace function public.discard_project(p_project_id uuid)
returns table (chave text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user       uuid := (select auth.uid());
  v_por_apagar integer;
  v_chaves     text[];
begin
  if v_user is null then
    raise exception 'sem sessao' using errcode = 'PM000';
  end if;

  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = v_user
       for update
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  -- Job em fila ou rodando nao pode sumir debaixo do worker: ele esta com o
  -- arquivo aberto e escreveria o resultado numa linha que deixou de existir.
  if exists (
    select 1 from public.jobs
     where project_id = p_project_id
       and status in ('queued', 'processing')
  ) then
    raise exception 'projeto com job em processamento' using errcode = 'PM010';
  end if;

  -- Cota devolvida pelo que ainda nao foi processado, mesma regra da
  -- `discard_job`: video ja renderizado consumiu worker de verdade.
  select count(*) into v_por_apagar
    from public.jobs
   where project_id = p_project_id and status = 'uploaded';

  if v_por_apagar > 0 then
    update public.subscriptions
       set videos_used = greatest(videos_used - v_por_apagar, 0)
     where user_id = v_user;
  end if;

  -- As chaves saem ANTES do delete: `projects` leva `jobs` junto por cascata
  -- (0001), e depois nao haveria mais de onde ler o que apagar no bucket.
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

revoke execute on function public.discard_project(uuid) from public, anon;
grant execute on function public.discard_project(uuid) to authenticated, service_role;

commit;
