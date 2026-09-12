-- PageMask · 0021_entrega
--
-- A Fase 7 fecha o ciclo: o usuario LEVA os videos embora. Tres coisas nascem
-- aqui, e as tres sao estado novo que o banco precisa guardar:
--
--   1. `batch_zips` — a fila do ZIP do lote, gerado pelo worker;
--   2. `requeue_failed_jobs` — o botao "Reprocessar os que falharam", que
--      reaproveita a MESMA linha em vez de criar outra;
--   3. `discard_project` passa a devolver tambem as chaves dos ZIPs, senao
--      apagar o projeto deixaria arquivo nosso no bucket.
--
-- POR QUE O ZIP NAO E UMA LINHA EM `jobs`
-- =======================================
--
-- Pela mesma razao que a previa nao e (cabecalho da 0020), e vale repetir
-- porque o prompt da fase tambem diz "job 'zip'": `fail_job` e
-- `requeue_stale_jobs` DEVOLVEM CREDITO de video quando um job morre,
-- `claim_job` limita renders simultaneos por usuario, e a tela do projeto
-- lista `jobs` do projeto. Um ZIP ali dentro devolveria credito que ninguem
-- cobrou, ocuparia uma das duas vagas de render do dono e apareceria na lista
-- de videos como se fosse um video.
--
-- Tabela propria, fila propria, thread propria no worker:
--
--     jobs         render, cota, credito, 30 dias
--     batch_zips   pacote do que ja esta pronto, sem cota, 7 dias
--
-- O ZIP NAO PASSA PELA VERCEL, e e por isso que ele e um job
-- ==========================================================
--
-- Um lote de 200 videos sao dezenas de gigabytes. Montar isso numa funcao
-- serverless estoura tempo de execucao e memoria antes do decimo arquivo, e
-- o usuario pagaria a banda duas vezes (R2 → Vercel → navegador). O worker
-- monta o pacote lendo do R2 e gravando no R2, e o que chega ao navegador e
-- uma URL pre-assinada — a mesma tecnica do download individual.
--
-- O `digest` E O QUE IMPEDE ZIP DUPLICADO
-- =======================================
--
-- Ele e a impressao digital do CONJUNTO de videos prontos do projeto: os ids
-- e as chaves de saida, em ordem, resumidos em md5. Dois pedidos com o mesmo
-- digest sao o mesmo pacote, entao o segundo recebe o primeiro em vez de
-- ocupar o worker de novo. Terminou um video novo? O digest muda, e ai o
-- pacote novo e outro pacote de verdade.
--
-- Codigos de erro desta migration:
--   PM029  projeto sem video pronto para empacotar
--   PM030  este ZIP nao esta mais com este worker

begin;

-- ---------------------------------------------------------------------------
-- O tipo
-- ---------------------------------------------------------------------------
-- `create type` nao aceita `if not exists`, e o resto do arquivo e
-- reexecutavel. Sem o bloco, rodar a migration duas vezes abortaria a
-- transacao inteira no primeiro comando (mesma nota da 0020).
do $$
begin
  create type public.zip_status as enum ('queued', 'processing', 'done', 'failed');
exception when duplicate_object then
  null;
end;
$$;

-- ---------------------------------------------------------------------------
-- batch_zips
-- ---------------------------------------------------------------------------

create table if not exists public.batch_zips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id)      on delete cascade,
  project_id  uuid        not null references public.projects (id) on delete cascade,
  status      public.zip_status not null default 'queued',
  digest      text        not null,
  r2_key      text,
  bytes       bigint      check (bytes is null or bytes >= 0),
  videos      integer     not null default 0 check (videos >= 0),
  error       text,
  attempts    smallint    not null default 0 check (attempts >= 0),
  claimed_by  text,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  finished_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '7 days')
);

comment on table public.batch_zips is
  'Fila dos ZIPs de lote. Sete dias de vida, contados em `expires_at`, '
  'aplicados pela URL assinada (que nunca passa dele) e por `expire_zips`, '
  'que apaga o objeto no R2. O lifecycle de 30 dias do bucket e a rede de '
  'seguranca para o caso de o zelador do worker nao rodar.';
comment on column public.batch_zips.digest is
  'md5 dos ids + chaves de saida dos videos prontos do projeto, em ordem. '
  'Mesmo digest = mesmo pacote: e o que faz um segundo pedido reaproveitar o '
  'ZIP que ja existe em vez de ocupar o worker de novo.';
comment on column public.batch_zips.videos is
  'Quantos videos entraram no pacote DE FATO, contados pelo worker ao gravar.';

create index if not exists batch_zips_fila_idx
  on public.batch_zips (created_at)
  where status in ('queued', 'processing');

create index if not exists batch_zips_projeto_idx
  on public.batch_zips (project_id, created_at desc);

create index if not exists batch_zips_expiram_idx
  on public.batch_zips (expires_at);

alter table public.batch_zips enable row level security;

-- O dono LE o proprio ZIP (a tela pergunta "ficou pronto?"). Escrever, nao:
-- pedir um ZIP ocupa worker e passa por limite de taxa, e as duas coisas moram
-- no servidor. Sem politica de insert/update/delete — negado por construcao,
-- como em `jobs` e em `template_previews`.
drop policy if exists "zips proprios: ler" on public.batch_zips;
create policy "zips proprios: ler"
  on public.batch_zips for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke insert, update, delete on public.batch_zips from anon, authenticated;

-- **RLS nao concede nada** — ela filtra linhas de quem ja tem privilegio de
-- tabela, e tabela nova no Supabase nasce sem nenhum (0004). Sem este grant, a
-- politica acima seria uma porta trancada num vao sem porta, e a tela levaria
-- `42501 permission denied for table batch_zips`.
grant select on public.batch_zips to authenticated;

-- ---------------------------------------------------------------------------
-- request_zip — "Baixar tudo"
-- ---------------------------------------------------------------------------
--
-- `service_role` so, pela regra da 0008: o dono chega por `p_user_id` decidido
-- no servidor a partir da sessao, nunca por um id que a requisicao mandou.
--
-- TRES DESFECHOS, e nenhum deles enfileira duas vezes:
--
--   · ja existe pacote em `queued`/`processing` com o mesmo digest → devolve
--     aquele. E o clique repetido, e ele nao pode virar dois ZIPs;
--   · ja existe pacote `done` com o mesmo digest e prazo de sobra → devolve
--     aquele. Baixar duas vezes o mesmo lote nao remonta nada;
--   · qualquer outro caso → linha nova.
--
-- A folga de 15 minutos na reutilizacao e o tempo de vida da URL assinada:
-- devolver um pacote que vence em 40 segundos seria entregar um link que morre
-- no meio do download.
create or replace function public.request_zip(
  p_user_id    uuid,
  p_project_id uuid
)
returns public.batch_zips
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_digest text;
  v_zip    public.batch_zips;
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

  -- SEM ESTA TRAVA, "o clique repetido nao vira dois ZIPs" era so uma
  -- intencao. Dois pedidos simultaneos (o clique duplo, as duas abas) leem a
  -- tabela ao mesmo tempo, nenhum dos dois enxerga a linha que o outro ainda
  -- nao commitou, e os dois inserem — dois pacotes do mesmo lote, duas vezes o
  -- trabalho e duas vezes a banda.
  --
  -- Consultiva por projeto, e nao `for update` na linha de `projects`, pela
  -- razao do cabecalho de `claim_job` (0015): `projects` e a PRIMEIRA tabela da
  -- ordem combinada, e trava-la aqui poria esta funcao dentro do grafo de
  -- travas de `discard_project` e `enqueue_project`. Trava consultiva nao
  -- participa desse grafo, e morre com a transacao.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  -- O CONJUNTO E LIDO DO BANCO, nunca recebido no pedido. O cliente diz qual
  -- projeto; quais arquivos entram e o que `jobs` mostra agora, com o dono
  -- conferido na propria consulta.
  select md5(string_agg(j.id::text || ':' || j.r2_output_key, ',' order by j.id))
    into v_digest
    from public.jobs as j
   where j.project_id = p_project_id
     and j.user_id    = p_user_id
     and j.status     = 'done'
     and j.r2_output_key is not null;

  if v_digest is null then
    raise exception 'projeto sem video pronto' using errcode = 'PM029';
  end if;

  -- PACOTE MORTO NAO CONTA COMO "ja esta sendo feito". Um worker que morre de
  -- vez com o pacote na mao deixa a linha em `processing` para sempre:
  -- `claim_zip` nao a reclama de novo (ela exige `attempts < 3`), e se ela
  -- fosse reaproveitada aqui o projeto ficaria sete dias sem conseguir um
  -- pacote — a tela mostrando "montando" para um worker que nao existe mais.
  --
  -- Por isso a condicao de "em andamento" e a MESMA que torna a linha
  -- reclamavel: tentativas de sobra e claim recente. O que nao passa nela cai
  -- fora e um pacote novo nasce ao lado; o morto expira sozinho.
  select * into v_zip
    from public.batch_zips as z
   where z.project_id = p_project_id
     and z.user_id    = p_user_id
     and z.digest     = v_digest
     and (
       (
         z.status in ('queued', 'processing')
         and z.expires_at > now()
         and z.attempts < 3
         and (z.status = 'queued' or z.claimed_at > now() - interval '30 minutes')
       )
       or (
         z.status = 'done'
         and z.r2_key is not null
         and z.expires_at > now() + interval '15 minutes'
       )
     )
   order by z.created_at desc
   limit 1;

  if found then
    return v_zip;
  end if;

  -- O pacote que ainda nem comecou e de um conjunto ANTIGO nao serve mais a
  -- ninguem: ele foi pedido antes de o ultimo video ficar pronto. O que
  -- esgotou as tentativas sai junto, pelo mesmo motivo — ninguem mais o vai
  -- reclamar. `processing` nao e apagado: o worker pode estar com ele agora, e
  -- tirar a linha debaixo dele so produziria um `PM030` e um objeto orfao.
  delete from public.batch_zips
   where user_id    = p_user_id
     and project_id = p_project_id
     and status     = 'queued'
     and (digest <> v_digest or attempts >= 3);

  insert into public.batch_zips (user_id, project_id, digest)
  values (p_user_id, p_project_id, v_digest)
  returning * into v_zip;

  return v_zip;
end;
$fn$;

revoke execute on function public.request_zip(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_zip(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- claim_zip — o worker reclama um pacote
-- ---------------------------------------------------------------------------
--
-- Mesmo desenho de `claim_preview` (0020) e `claim_publish` (0019): `for
-- update skip locked`, claim com carimbo de tempo, e uma linha em `processing`
-- ha mais de `p_stale_min` minutos volta a ser candidata (worker morto no
-- meio do pacote).
--
-- `p_stale_min` PRECISA SER MENOR que os 30 minutos que a `request_zip` usa
-- para considerar um pacote "em andamento". Nessa folga cabe o caso normal de
-- um pacote que trocou de worker: enquanto o segundo trabalha, o pedido do
-- usuario continua apontando para a mesma linha em vez de criar outra.
create or replace function public.claim_zip(
  p_worker    text,
  p_stale_min integer default 20
)
returns table (
  id         uuid,
  user_id    uuid,
  project_id uuid,
  attempts   smallint,
  expires_at timestamptz,
  projeto    text
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

  select z.id into v_id
    from public.batch_zips as z
   where z.attempts < 3
     and z.expires_at > now()
     and (
       z.status = 'queued'
       or (
         z.status = 'processing'
         and z.claimed_at < now() - make_interval(mins => greatest(1, coalesce(p_stale_min, 20)))
       )
     )
   order by z.created_at
     for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  update public.batch_zips as z
     set status     = 'processing',
         claimed_by = left(btrim(p_worker), 120),
         claimed_at = now(),
         attempts   = z.attempts + 1,
         error      = null
   where z.id = v_id;

  return query
  select z.id, z.user_id, z.project_id, z.attempts, z.expires_at, p.name
    from public.batch_zips as z
    join public.projects as p on p.id = z.project_id
   where z.id = v_id;
end;
$fn$;

revoke execute on function public.claim_zip(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_zip(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- zip_items — o que entra no pacote
-- ---------------------------------------------------------------------------
--
-- Lista separada do claim de proposito: sao centenas de linhas, e carrega-las
-- dentro do `claim_zip` faria toda reclamacao — inclusive a que nao pega nada
-- — trafegar o inventario do projeto.
--
-- A LISTA E LIDA AQUI, E NAO ENVIADA PELO WORKER. O worker so tem o id do
-- pacote; o dono e o projeto saem da propria linha. Assim nao existe caminho
-- em que um pacote empacote a saida de outro usuario.
create or replace function public.zip_items(p_zip_id uuid)
returns table (
  job_id   uuid,
  filename text,
  r2_key   text,
  bytes    bigint,
  pronto_em timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select j.id, j.filename, j.r2_output_key, j.bytes_in, j.finished_at
    from public.batch_zips as z
    join public.jobs as j
      on j.project_id = z.project_id
     and j.user_id    = z.user_id
   where z.id = p_zip_id
     and j.status = 'done'
     and j.r2_output_key is not null
   order by j.id;
$fn$;

revoke execute on function public.zip_items(uuid)
  from public, anon, authenticated;
grant execute on function public.zip_items(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- zip_beat — o worker renova o claim enquanto empacota
-- ---------------------------------------------------------------------------
--
-- Um pacote de 200 videos pode passar do `p_stale_min`, e sem renovacao um
-- segundo worker o reclamaria no meio: os dois escreveriam a MESMA chave (ela
-- e derivada do id do pacote) e o perdedor descobriria isso so no
-- `finish_zip`. Trabalho dobrado e um objeto sobrescrito enquanto alguem podia
-- estar baixando.
--
-- Mesma ideia do `publish_container` (0019), que tambem renova claim durante
-- uma espera longa. `false` significa "o pacote nao e mais seu" — o worker
-- para de empacotar na hora, em vez de gastar banda ate o fim.
create or replace function public.zip_beat(
  p_id      uuid,
  p_attempt integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_linhas integer;
begin
  update public.batch_zips
     set claimed_at = now()
   where id = p_id
     and status = 'processing'
     and attempts = p_attempt;

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$fn$;

revoke execute on function public.zip_beat(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.zip_beat(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- finish_zip / fail_zip — o desfecho
-- ---------------------------------------------------------------------------
--
-- `attempts` e a senha de porteiro, como em toda funcao de desfecho desde a
-- 0015: um worker que ficou preso e voltou depois de o pacote ter sido
-- reclamado por outro nao escreve por cima do trabalho dele.

create or replace function public.finish_zip(
  p_id      uuid,
  p_attempt integer,
  p_key     text,
  p_bytes   bigint,
  p_videos  integer
)
returns public.batch_zips
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_zip public.batch_zips;
begin
  if p_key is null or length(btrim(p_key)) = 0 then
    raise exception 'zip sem chave' using errcode = 'PM015';
  end if;

  update public.batch_zips
     set status      = 'done',
         r2_key      = p_key,
         bytes       = greatest(coalesce(p_bytes, 0), 0),
         videos      = greatest(coalesce(p_videos, 0), 0),
         error       = null,
         finished_at = now()
   where id = p_id
     and status = 'processing'
     and attempts = p_attempt
  returning * into v_zip;

  if not found then
    raise exception 'este zip nao esta mais com este worker' using errcode = 'PM030';
  end if;

  return v_zip;
end;
$fn$;

revoke execute on function public.finish_zip(uuid, integer, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.finish_zip(uuid, integer, text, bigint, integer)
  to service_role;

-- Falha recuperavel devolve o pacote para `queued` e outra tentativa o pega;
-- so a ultima vira `failed`. Nao ha credito para devolver — ZIP nao gasta cota
-- —, entao esta funcao e bem mais simples que a `fail_job`.
create or replace function public.fail_zip(
  p_id         uuid,
  p_attempt    integer,
  p_mensagem   text,
  p_definitivo boolean default false,
  p_max        integer default 3
)
returns public.batch_zips
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_zip    public.batch_zips;
  v_ultima boolean;
begin
  select * into v_zip
    from public.batch_zips
   where id = p_id
     and status = 'processing'
     and attempts = p_attempt
     for update;

  if not found then
    raise exception 'este zip nao esta mais com este worker' using errcode = 'PM030';
  end if;

  v_ultima := coalesce(p_definitivo, false) or v_zip.attempts >= coalesce(p_max, 3);

  update public.batch_zips
     set status      = case when v_ultima then 'failed' else 'queued' end::public.zip_status,
         error       = left(coalesce(p_mensagem, 'Não conseguimos montar o pacote.'), 500),
         finished_at = case when v_ultima then now() else null end,
         claimed_by  = null,
         claimed_at  = null
   where id = p_id
  returning * into v_zip;

  return v_zip;
end;
$fn$;

revoke execute on function public.fail_zip(uuid, integer, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.fail_zip(uuid, integer, text, boolean, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- expire_zips — o expurgo dos sete dias
-- ---------------------------------------------------------------------------
--
-- A LINHA SAI ANTES DO OBJETO, mesma ordem (e mesmo motivo) de
-- `expire_previews`: uma falha no meio deixa objeto orfao, que o lifecycle
-- recolhe, e nunca um ZIP `done` apontando para um arquivo que nao existe
-- mais — esse a tela mostraria como link quebrado.
create or replace function public.expire_zips(p_max integer default 200)
returns table (r2_key text)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
  with alvos as (
    select z.id
      from public.batch_zips as z
     where z.expires_at < now()
     order by z.expires_at
     limit greatest(1, least(coalesce(p_max, 200), 1000))
       for update skip locked
  ),
  apagados as (
    delete from public.batch_zips as z
     using alvos as a
     where z.id = a.id
    returning z.r2_key
  )
  select a.r2_key from apagados as a where a.r2_key is not null;
end;
$fn$;

revoke execute on function public.expire_zips(integer)
  from public, anon, authenticated;
grant execute on function public.expire_zips(integer) to service_role;

-- ---------------------------------------------------------------------------
-- requeue_failed_jobs — "Reprocessar os que falharam"
-- ---------------------------------------------------------------------------
--
-- A MESMA LINHA VOLTA PARA A FILA. Nao ha insert aqui, e e isso que responde
-- ao "sem duplicar job" do prompt: reprocessar e um UPDATE em `jobs` filtrado
-- por `status = 'failed'`, entao o segundo clique — ou dois cliques
-- simultaneos em duas abas — nao encontra mais nada para mudar e devolve 0. O
-- arquivo de entrada continua no R2 (falha PRESERVA a entrada, ver o cabecalho
-- de `worker/src/servico/trabalho.py`), por isso ha o que reprocessar.
--
-- A COTA E COBRADA DE NOVO, e isso nao e cobranca em dobro: `fail_job` (0015)
-- DEVOLVEU o credito quando o job virou `failed`. Reprocessar consome uma vaga
-- como qualquer video novo — e quem esta no teto do plano precisa ouvir isso
-- antes, nao depois de a fila encher.
--
-- ORDEM DAS TRAVAS (0012/0013): projects → jobs → subscriptions.
--
-- A CONTAGEM SAI DO PROPRIO UPDATE, e nao de um `select count(*)` anterior —
-- a licao da 0013. Sob READ COMMITTED, contar numa instrucao e cobrar noutra
-- deixa a cota errada quando alguem remove um video entre as duas. Aqui o
-- numero cobrado e exatamente o numero de linhas que ESTA transacao moveu, e
-- se a cota nao couber a excecao desfaz o UPDATE junto.
create or replace function public.requeue_failed_jobs(
  p_user_id    uuid,
  p_project_id uuid,
  p_snapshot   jsonb,
  p_job_ids    uuid[] default null
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

  -- Segunda trava: `jobs`, pelo proprio UPDATE.
  --
  -- `template_snapshot` e reescrito com o template ATUAL do projeto. Um job
  -- que falhou por causa de um template quebrado precisa rodar com o template
  -- consertado; congelar de novo o que ja nao funcionou seria reprocessar para
  -- chegar ao mesmo erro.
  with mudados as (
    update public.jobs
       set status            = 'queued',
           template_snapshot = p_snapshot,
           queued_at         = now(),
           next_attempt_at   = null,
           progress          = 0,
           attempts          = 0,
           error             = null,
           started_at        = null,
           finished_at       = null
     where project_id = p_project_id
       and user_id    = p_user_id
       and status     = 'failed'
       and (p_job_ids is null or id = any (p_job_ids))
    returning 1
  )
  select count(*) into v_quantos from mudados;

  if v_quantos = 0 then
    return 0;
  end if;

  select pl.videos_month into v_limite
    from public.plano_do_usuario(p_user_id) as pl;
  if v_limite is null then
    raise exception 'plano nao encontrado' using errcode = 'PM004';
  end if;

  -- Terceira trava: `subscriptions`.
  insert into public.subscriptions (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select videos_used into v_usados
    from public.subscriptions
   where user_id = p_user_id
     for update;

  if coalesce(v_usados, 0) + v_quantos > v_limite then
    raise exception 'quota de videos do plano atingida (%)', v_limite
      using errcode = 'PM002';
  end if;

  update public.subscriptions
     set videos_used = videos_used + v_quantos
   where user_id = p_user_id;

  return v_quantos;
end;
$fn$;

revoke execute on function public.requeue_failed_jobs(uuid, uuid, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.requeue_failed_jobs(uuid, uuid, jsonb, uuid[])
  to service_role;

-- ---------------------------------------------------------------------------
-- discard_job — remover um video INVALIDA os pacotes daquele projeto
-- ---------------------------------------------------------------------------
--
-- Sem isto, a remocao de um video ficava pela metade. O pacote e uma COPIA do
-- que estava pronto: apagar o `.mp4` do bucket e deixar o `.zip` que o contem
-- significa que o arquivo removido continua baixavel, pelo dono, pelos sete
-- dias do pacote — enquanto a tela diz "sera apagado do armazenamento e da sua
-- lista. Nao da para desfazer".
--
-- A regra e a mais simples que fecha isso: mexeu na lista de videos prontos, os
-- pacotes daquele projeto morrem. Montar outro custa segundos de worker; nao
-- ter certeza do que foi apagado custa uma conversa com um cliente.
--
-- A ASSINATURA MUDA de `(input_key, output_key)` para `chave`, a mesma da
-- `discard_project`. Os dois nomes existiam para descrever o job; agora a
-- funcao devolve tambem chave que nao e de job nenhum, e manter as duas
-- colunas exigiria inventar qual delas recebe um `.zip`. Quem chama ja
-- juntava as duas numa lista so.
--
-- Ordem das travas (0012/0013): jobs → batch_zips → subscriptions.

drop function if exists public.discard_job(uuid, uuid);

create function public.discard_job(p_user_id uuid, p_job_id uuid)
returns table (chave text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_job    public.jobs;
  v_chaves text[];
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

  v_chaves := array_remove(
    array[v_job.r2_input_key, v_job.r2_output_key], null
  );

  -- Os pacotes do projeto, qualquer que seja o estado deles. O que estiver em
  -- `processing` recebe `PM030` na conclusao e o worker descarta o que fez —
  -- o mesmo caminho de um claim expirado.
  with zipados as (
    delete from public.batch_zips
     where project_id = v_job.project_id
    returning r2_key
  )
  select v_chaves || coalesce(
           array_agg(z.r2_key) filter (where z.r2_key is not null),
           array[]::text[]
         )
    into v_chaves
    from zipados as z;

  if v_job.status = 'uploaded' then
    update public.subscriptions
       set videos_used = greatest(videos_used - 1, 0)
     where user_id = p_user_id;
  end if;

  delete from public.jobs where id = v_job.id;

  return query select unnest(v_chaves);
end;
$fn$;

revoke execute on function public.discard_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.discard_job(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- discard_project — agora leva os ZIPs junto
-- ---------------------------------------------------------------------------
--
-- Sem isto, apagar o projeto apagaria a linha do pacote por cascata e deixaria
-- o .zip no bucket ate o lifecycle de 30 dias o recolher — com uma diferenca
-- que importa: ninguem mais saberia que ele existe, porque a chave morava na
-- linha. Objeto sem dono e sem registro e exatamente o que a fase de LGPD nao
-- pode encontrar.
--
-- A ordem das travas continua a da 0013 — projects → jobs → subscriptions —,
-- com `batch_zips` entre `jobs` e `subscriptions`. `request_zip` so toca
-- `batch_zips` (a leitura de `projects` e de `jobs` la e sem `for update`),
-- entao nao ha ciclo possivel entre as duas.
create or replace function public.discard_project(p_user_id uuid, p_project_id uuid)
returns table (chave text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_por_apagar integer;
  v_chaves     text[];
  v_zips       text[];
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

  with apagados as (
    delete from public.jobs
     where project_id = p_project_id
    returning r2_input_key, r2_output_key, status
  )
  select
    coalesce(array_agg(a.r2_input_key), array[]::text[])
      || coalesce(
           array_agg(a.r2_output_key) filter (where a.r2_output_key is not null),
           array[]::text[]
         ),
    count(*) filter (where a.status = 'uploaded')
    into v_chaves, v_por_apagar
    from apagados as a;

  -- O ZIP em `processing` some junto, e isso e deliberado: o projeto inteiro
  -- esta sendo apagado, entao o pacote nao teria mais o que empacotar. O
  -- worker que estiver montando ele recebe `PM030` na conclusao e descarta o
  -- que fez — o mesmo caminho de um claim expirado.
  with zipados as (
    delete from public.batch_zips
     where project_id = p_project_id
    returning r2_key
  )
  select coalesce(array_agg(z.r2_key) filter (where z.r2_key is not null), array[]::text[])
    into v_zips
    from zipados as z;

  if v_por_apagar > 0 then
    update public.subscriptions
       set videos_used = greatest(videos_used - v_por_apagar, 0)
     where user_id = p_user_id;
  end if;

  delete from public.projects where id = p_project_id;

  return query select unnest(v_chaves || v_zips);
end;
$fn$;

commit;
