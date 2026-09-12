-- PageMask · 0020_editor_de_template
--
-- A Fase 6 tira o template da constante em `app/src/lib/template/padrao.ts` e o
-- devolve ao usuario. Tres coisas mudam de dono por causa disso:
--
--   1. `templates.config` passa a ser ESCRITO POR GENTE. Ele ja era `jsonb`
--      livre; agora ele chega ao worker e vira desenho. A defesa nao e nova —
--      `worker/src/servico/molde.py` sempre montou a config do zero, copiando
--      so o que esta na tabela dele — e a validacao com `zod` no servidor e a
--      primeira camada, nao a unica.
--   2. `enqueue_project` ganha `p_job_ids`: "aplicar ao projeto inteiro ou a
--      itens selecionados" e a mesma funcao com um filtro a mais.
--   3. Nasce a fila de PREVIA (`template_previews`), que e o que faz o editor
--      ser um editor e nao um formulario.
--
-- POR QUE A PREVIA NAO E UMA LINHA EM `jobs`
-- =========================================
--
-- O prompt da fase diz "enfileira um job 'preview'", e a leitura literal seria
-- uma coluna `kind` em `jobs`. Ela custaria caro em lugares que ja estao
-- certos: `fail_job` e `requeue_stale_jobs` DEVOLVEM CREDITO ao usuario quando
-- um job morre, `claim_job` limita jobs simultaneos por usuario, e a tela do
-- projeto lista `jobs` do projeto. Uma previa que entrasse ali devolveria
-- credito que nunca foi cobrado, ocuparia uma das duas vagas de render do
-- usuario e apareceria na lista de videos. Seriam quatro correcoes com `where
-- kind = 'render'` espalhadas por codigo que a Fase 3 deixou fechado.
--
-- Tabela propria, com fila propria, e a mesma ideia com os riscos separados:
--
--     jobs                render, cota, credito, 30 dias
--     template_previews   PNG de rascunho, sem cota, 1 hora
--
-- E ela ganha uma thread propria no worker, o que resolve o requisito que a
-- tabela unica nao resolveria de jeito nenhum: **previa em segundos**. Numa
-- fila so, a previa de quem mudou uma palavra esperaria o render de 20 minutos
-- que estava na frente.
--
-- A VALIDADE DE 1 HORA E DE VERDADE, e nao so uma coluna
-- =====================================================
--
-- O lifecycle do bucket e de 30 dias e a menor granularidade que o R2 aceita e
-- 1 dia — nenhum dos dois entrega "1 hora". Quem entrega sao tres coisas
-- juntas: `expires_at` na linha, a URL assinada que nunca passa do `expires_at`
-- (o app confere) e `expire_previews`, que o zelador do worker chama para
-- APAGAR o objeto no R2. O lifecycle continua sendo a rede de seguranca para o
-- caso de o zelador nao rodar.
--
-- Codigos de erro desta migration:
--   PM023  template inexistente ou de outro usuario
--   PM024  limite de templates da conta
--   PM025  nome de template invalido ou repetido
--   PM026  projeto sem video utilizavel para a previa
--   PM027  esta previa nao esta mais com este worker

begin;

-- ---------------------------------------------------------------------------
-- templates — nome unico por dono, versao que anda sozinha
-- ---------------------------------------------------------------------------

alter table public.templates
  drop constraint if exists templates_name_len;
alter table public.templates
  add constraint templates_name_len
  check (length(btrim(name)) between 1 and 60);

-- Dois templates com o mesmo nome na mesma conta nao sao um erro de banco, mas
-- sao um erro de produto: o seletor do projeto mostra so o nome, e escolher
-- entre dois "Padrao" e escolher no escuro.
create unique index if not exists templates_nome_unico_idx
  on public.templates (user_id, lower(btrim(name)));

comment on column public.templates.version is
  'Sobe a cada mudanca de `config` — mudar so o nome nao conta. O historico de '
  'versoes vive em `jobs.template_snapshot`: e a copia congelada que de fato '
  'renderizou alguma coisa, e a unica que alguem pode precisar reproduzir.';

-- ---------------------------------------------------------------------------
-- save_template — criar ou atualizar, com a versao decidida pelo banco
-- ---------------------------------------------------------------------------
--
-- `service_role` so, pela regra da 0008: o dono chega por `p_user_id` vindo da
-- sessao no servidor, e nao por `auth.uid()`. Exposta ao PostgREST, ela
-- aceitaria o `p_user_id` que o chamador escrevesse.
--
-- O TETO DE TEMPLATES NAO E LIMITE DE PLANO. Limite de plano sai de `plans`
-- (CLAUDE.md, "Convencoes") e template nao e um item vendido: ninguem contrata
-- "ate N templates". O numero aqui existe para que um laco de POST nao encha a
-- tabela, e se um dia virar caracteristica de plano ele muda de lugar, nao de
-- valor.
create or replace function public.save_template(
  p_user_id uuid,
  p_id      uuid,
  p_name    text,
  p_config  jsonb
)
returns public.templates
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c_teto constant integer := 50;
  v_nome     text := btrim(coalesce(p_name, ''));
  v_template public.templates;
  v_quantos  integer;
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  if length(v_nome) < 1 or length(v_nome) > 60 then
    raise exception 'nome de template invalido' using errcode = 'PM025';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'template invalido' using errcode = 'PM013';
  end if;

  if p_id is null then
    select count(*) into v_quantos
      from public.templates where user_id = p_user_id;

    if v_quantos >= c_teto then
      raise exception 'limite de templates atingido (%)', c_teto
        using errcode = 'PM024';
    end if;

    begin
      insert into public.templates (user_id, name, config, version)
      values (p_user_id, v_nome, p_config, 1)
      returning * into v_template;
    exception when unique_violation then
      raise exception 'nome de template repetido' using errcode = 'PM025';
    end;

    return v_template;
  end if;

  -- `for update` antes do UPDATE: dois saves simultaneos do mesmo template
  -- (duas abas) precisam produzir versao 2 e versao 3, nunca duas versao 2.
  select * into v_template
    from public.templates
   where id = p_id and user_id = p_user_id
     for update;

  if not found then
    raise exception 'template nao e do usuario' using errcode = 'PM023';
  end if;

  begin
    update public.templates
       set name    = v_nome,
           config  = p_config,
           -- Mudanca de nome nao gera versao nova: versao conta MUDANCA DE
           -- DESENHO, e e por isso que ela e util ao lado de um snapshot.
           version = case when config is distinct from p_config
                          then version + 1 else version end
     where id = p_id
    returning * into v_template;
  exception when unique_violation then
    raise exception 'nome de template repetido' using errcode = 'PM025';
  end;

  return v_template;
end;
$fn$;

revoke execute on function public.save_template(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_template(uuid, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- enqueue_project — agora com selecao de itens
-- ---------------------------------------------------------------------------
--
-- `drop` e `create`, e nao `create or replace`: mudar a lista de parametros de
-- uma funcao nao e substituicao, e deixar as duas assinaturas vivas criaria
-- duas implementacoes da mesma regra — a segunda vez que alguem corrigir uma
-- delas, as duas divergem.
--
-- `p_job_ids` nulo = o projeto inteiro, que e o comportamento que a Fase 3
-- tinha. Com a lista, so os ids dela, e **sempre** dentro do mesmo projeto e do
-- mesmo dono: a lista vem do navegador e e entrada nao confiavel como qualquer
-- outra. Id de video de outro usuario na lista nao da erro, simplesmente nao
-- casa com o `where` — e o retorno (quantos entraram) denuncia a diferenca.

drop function if exists public.enqueue_project(uuid, uuid, jsonb);

create or replace function public.enqueue_project(
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

  -- Ordem das travas (0012): projects → jobs → subscriptions.
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
       and (p_job_ids is null or id = any (p_job_ids))
    returning 1
  )
  select count(*) into v_quantos from mudados;

  return v_quantos;
end;
$fn$;

revoke execute on function public.enqueue_project(uuid, uuid, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.enqueue_project(uuid, uuid, jsonb, uuid[]) to service_role;

-- ===========================================================================
-- A fila de previa
-- ===========================================================================

-- `create type` nao aceita `if not exists`, e o resto deste arquivo e
-- reexecutavel (`if not exists`, `create or replace`). Sem este bloco, rodar a
-- migration duas vezes aborta a transacao INTEIRA no primeiro comando — e o
-- que se perde nao e o tipo, sao todas as funcoes abaixo dele.
do $$
begin
  create type public.preview_status as enum ('queued', 'processing', 'done', 'failed');
exception when duplicate_object then
  null;
end;
$$;

create table if not exists public.template_previews (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id)     on delete cascade,
  project_id  uuid        not null references public.projects (id) on delete cascade,
  job_id      uuid        not null references public.jobs (id)     on delete cascade,
  config      jsonb       not null,
  status      public.preview_status not null default 'queued',
  r2_key      text,
  error       text,
  attempts    smallint    not null default 0 check (attempts >= 0),
  claimed_by  text,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  finished_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '1 hour')
);

comment on table public.template_previews is
  'Fila das previas do editor de template. Vida curta de proposito: uma hora, '
  'contada em `expires_at`, aplicada pela URL assinada (que nunca passa dela) e '
  'por `expire_previews`, que apaga o PNG no R2.';
comment on column public.template_previews.config is
  'O template EM EDICAO, ainda nao salvo. Escrito por gente: o worker o remonta '
  'campo a campo em `molde.montar` antes de desenhar qualquer coisa.';
comment on column public.template_previews.job_id is
  'O video do projeto que serve de amostra. O worker le `jobs.r2_input_key` '
  'dele — a previa nunca recebe chave de objeto pelo pedido.';

create index if not exists template_previews_fila_idx
  on public.template_previews (created_at)
  where status in ('queued', 'processing');

create index if not exists template_previews_user_idx
  on public.template_previews (user_id, created_at desc);

create index if not exists template_previews_expiram_idx
  on public.template_previews (expires_at);

alter table public.template_previews enable row level security;

-- O dono LE a propria previa (a tela pergunta "ficou pronta?"). Escrever, nao:
-- criar previa consome CPU de worker e passa por limite de taxa, e as duas
-- coisas moram no servidor. Sem politica de insert/update/delete, portanto —
-- negado por construcao, como em `jobs`.
drop policy if exists "previas proprias: ler" on public.template_previews;
create policy "previas proprias: ler"
  on public.template_previews for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke insert, update, delete on public.template_previews from anon, authenticated;

-- **RLS nao concede nada** — ela so filtra linhas de quem ja tem o privilegio
-- de tabela, e tabela nova no Supabase nasce sem nenhum (a licao inteira esta
-- no cabecalho da migration 0004). Sem esta linha, a politica de leitura acima
-- e uma porta trancada num vao sem porta: a tela do editor levaria
-- `42501 permission denied for table template_previews` ao perguntar se a
-- previa ficou pronta.
grant select on public.template_previews to authenticated;

-- O `service_role` ja recebe `all` em tabela nova pelo `alter default
-- privileges` da 0004 — mas so porque as migrations rodam com o papel
-- `postgres`, que e o dono daquele default. Confirmado nesta tabela.

-- ---------------------------------------------------------------------------
-- request_preview — o editor pede um PNG
-- ---------------------------------------------------------------------------
--
-- O QUE ELA SUBSTITUI: a previa anterior do mesmo projeto que ainda estava em
-- `queued`. Digitar uma frase de 40 caracteres produz, mesmo com o debounce de
-- 600 ms, varias chamadas — e renderizar todas seria gastar worker para mostrar
-- estados que ninguem mais quer ver. `processing` nao e substituida: ali o
-- worker ja esta trabalhando, e apagar a linha debaixo dele so produziria um
-- `PM027` e um PNG orfao.
create or replace function public.request_preview(
  p_user_id    uuid,
  p_project_id uuid,
  p_job_id     uuid,
  p_config     jsonb
)
returns public.template_previews
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_job    uuid;
  v_previa public.template_previews;
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'template invalido' using errcode = 'PM013';
  end if;

  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  -- O video da amostra e escolhido AQUI, a partir do que o banco ve. O pedido
  -- pode sugerir um id; ele so vale se for do mesmo projeto e do mesmo dono.
  --
  -- `rejected` fica de fora porque o objeto de entrada dele foi apagado na
  -- recusa (Fase 2): a previa nao teria o que baixar.
  select j.id into v_job
    from public.jobs as j
   where j.project_id = p_project_id
     and j.user_id    = p_user_id
     and j.status <> 'rejected'
     and j.r2_input_key is not null
     and (p_job_id is null or j.id = p_job_id)
   order by j.queued_at desc
   limit 1;

  if v_job is null then
    raise exception 'projeto sem video para a previa' using errcode = 'PM026';
  end if;

  delete from public.template_previews
   where user_id = p_user_id
     and project_id = p_project_id
     and status = 'queued';

  insert into public.template_previews (user_id, project_id, job_id, config)
  values (p_user_id, p_project_id, v_job, p_config)
  returning * into v_previa;

  return v_previa;
end;
$fn$;

revoke execute on function public.request_preview(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.request_preview(uuid, uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- claim_preview — o worker reclama uma previa
-- ---------------------------------------------------------------------------
--
-- Mesmo desenho de `claim_publish` (0019): `for update skip locked`, claim com
-- carimbo de tempo, e uma linha em `processing` ha mais de `p_stale_min`
-- minutos volta a ser candidata (worker morto no meio).
--
-- O TETO DE TENTATIVAS E 3 E NAO TEM VOLTA POR ESPERA. Previa e barata de
-- repetir do lado do usuario — ele digita uma letra e pede outra —, entao
-- insistir aqui seria gastar worker num arquivo que provavelmente nao vai
-- funcionar. Passando de 3, a linha simplesmente nao e mais reclamada e o
-- expurgo a recolhe.
create or replace function public.claim_preview(
  p_worker    text,
  p_stale_min integer default 5
)
returns table (
  id           uuid,
  user_id      uuid,
  project_id   uuid,
  job_id       uuid,
  config       jsonb,
  attempts     smallint,
  expires_at   timestamptz,
  r2_input_key text,
  bytes_in     bigint
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

  select p.id into v_id
    from public.template_previews as p
   where p.attempts < 3
     and p.expires_at > now()
     and (
       p.status = 'queued'
       or (
         p.status = 'processing'
         and p.claimed_at < now() - make_interval(mins => greatest(1, coalesce(p_stale_min, 5)))
       )
     )
   order by p.created_at
     for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  update public.template_previews as p
     set status     = 'processing',
         claimed_by = left(btrim(p_worker), 120),
         claimed_at = now(),
         attempts   = p.attempts + 1,
         error      = null
   where p.id = v_id;

  return query
  select p.id, p.user_id, p.project_id, p.job_id, p.config, p.attempts,
         p.expires_at, j.r2_input_key, j.bytes_in
    from public.template_previews as p
    join public.jobs as j on j.id = p.job_id
   where p.id = v_id;
end;
$fn$;

revoke execute on function public.claim_preview(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_preview(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- finish_preview / fail_preview — o desfecho
-- ---------------------------------------------------------------------------
--
-- `attempts` e a senha de porteiro, como em toda funcao de desfecho desde a
-- 0015: um worker que ficou preso e voltou depois de a previa ter sido
-- reclamada por outro nao escreve por cima do trabalho dele.

create or replace function public.finish_preview(
  p_id      uuid,
  p_attempt integer,
  p_key     text
)
returns public.template_previews
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_previa public.template_previews;
begin
  if p_key is null or length(btrim(p_key)) = 0 then
    raise exception 'previa sem chave' using errcode = 'PM015';
  end if;

  update public.template_previews
     set status      = 'done',
         r2_key      = p_key,
         error       = null,
         finished_at = now()
   where id = p_id
     and status = 'processing'
     and attempts = p_attempt
  returning * into v_previa;

  if not found then
    raise exception 'esta previa nao esta mais com este worker' using errcode = 'PM027';
  end if;

  return v_previa;
end;
$fn$;

revoke execute on function public.finish_preview(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.finish_preview(uuid, integer, text) to service_role;

create or replace function public.fail_preview(
  p_id       uuid,
  p_attempt  integer,
  p_mensagem text
)
returns public.template_previews
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_previa public.template_previews;
begin
  update public.template_previews
     set status      = 'failed',
         error       = left(coalesce(p_mensagem, 'Não conseguimos gerar a prévia.'), 500),
         finished_at = now()
   where id = p_id
     and status = 'processing'
     and attempts = p_attempt
  returning * into v_previa;

  if not found then
    raise exception 'esta previa nao esta mais com este worker' using errcode = 'PM027';
  end if;

  return v_previa;
end;
$fn$;

revoke execute on function public.fail_preview(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.fail_preview(uuid, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- expire_previews — o expurgo da hora
-- ---------------------------------------------------------------------------
--
-- Apaga a LINHA e devolve a CHAVE, nessa ordem, porque quem apaga objeto no R2
-- e o worker e ele precisa saber o que apagar. A ordem inversa (apagar o objeto
-- e depois a linha) deixaria, numa falha no meio, uma previa `done` apontando
-- para um PNG que nao existe mais — e a tela mostraria imagem quebrada.
--
-- Objeto que sobrar por causa de uma falha de rede fica orfao e o lifecycle de
-- 30 dias do bucket o recolhe. Espaco perdido por algumas horas e o preco
-- certo a pagar por nunca mostrar previa quebrada.
create or replace function public.expire_previews(p_max integer default 200)
returns table (r2_key text)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
  with alvos as (
    select p.id
      from public.template_previews as p
     where p.expires_at < now()
     order by p.expires_at
     limit greatest(1, least(coalesce(p_max, 200), 1000))
       for update skip locked
  ),
  apagadas as (
    delete from public.template_previews as p
     using alvos as a
     where p.id = a.id
    returning p.r2_key
  )
  select a.r2_key from apagadas as a where a.r2_key is not null;
end;
$fn$;

revoke execute on function public.expire_previews(integer)
  from public, anon, authenticated;
grant execute on function public.expire_previews(integer) to service_role;

commit;

-- ===========================================================================
-- A imagem de cabecalho so entra pela porta que LE OS BYTES
-- ===========================================================================
--
-- A Fase 6 pede que o cabecalho seja "validado por assinatura de bytes, nao so
-- extensao". A rota `/api/templates/header/confirmar` faz isso — le os
-- primeiros 64 KB do objeto, confere PNG/JPG e a geometria, e apaga o arquivo
-- quando ele nao e imagem.
--
-- SO QUE ELA NAO ERA O UNICO CAMINHO. A 0001 deu ao cliente
-- `grant insert (user_id, kind, r2_key, mime, bytes, sha256) on public.assets`,
-- com a politica exigindo apenas `r2_key like auth.uid() || '/%'`. Com isso o
-- usuario:
--
--   1. pedia a URL pre-assinada em `/header/assinar`;
--   2. gravava no R2 o que quisesse (a assinatura prende o `Content-Type` e o
--      `Content-Length` DECLARADOS, nunca o conteudo);
--   3. **pulava a confirmacao**, que e quem recusaria e apagaria o objeto;
--   4. inseria a linha de `assets` ele mesmo, pelo PostgREST;
--   5. apontava o template para aquela chave.
--
-- E entao bytes nunca conferidos chegavam ao `Image.open` do Pillow dentro do
-- worker — que decide o formato pelo conteudo e abre TIFF, WebP, JP2 e o que
-- mais estiver compilado. O isolamento por dono continuava de pe (o `molde.py`
-- exige o prefixo do usuario), mas a camada de CONTEUDO caia inteira.
--
-- A correcao e a mesma da 0008 com `register_upload_job`: a escrita passa a ser
-- de uma funcao que so o servidor executa, e o cliente perde o INSERT. Assim
-- **existir uma linha em `assets` vira prova de que os bytes foram lidos** — e
-- e essa prova que o editor e o enfileiramento conferem antes de aceitar um
-- cabecalho do R2.
--
--   PM028  chave, tipo ou tamanho de asset fora do formato

begin;

drop policy if exists "assets proprios: criar" on public.assets;
revoke insert on public.assets from anon, authenticated;

comment on table public.assets is
  'Arquivos do usuario (hoje: imagem de cabecalho). O INSERT e exclusivo de '
  '`register_header_asset`, chamada pelo servidor DEPOIS de ler os bytes do '
  'objeto. Linha aqui significa "este arquivo e mesmo uma imagem".';

create or replace function public.register_header_asset(
  p_user_id uuid,
  p_r2_key  text,
  p_mime    text,
  p_bytes   bigint,
  p_sha256  text default null
)
returns public.assets
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- A mesma forma que `montarChaveDeAsset` gera (app/src/lib/r2/chaves.ts):
  -- `{user_id}/assets/{uuid}.{png|jpg}`, sem segmento a mais.
  c_uuid  constant text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  c_teto  constant bigint := 5 * 1024 * 1024;
  v_asset public.assets;
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  if p_r2_key is null
     or p_r2_key !~ ('^' || c_uuid || '/assets/' || c_uuid || '\.(png|jpg)$')
     or p_r2_key not like p_user_id::text || '/assets/%'
  then
    raise exception 'chave de asset fora do formato' using errcode = 'PM028';
  end if;

  if p_mime not in ('image/png', 'image/jpeg') then
    raise exception 'tipo de asset nao aceito' using errcode = 'PM028';
  end if;

  if p_bytes is null or p_bytes <= 0 or p_bytes > c_teto then
    raise exception 'tamanho de asset fora da faixa' using errcode = 'PM028';
  end if;

  -- Idempotente: confirmar duas vezes a mesma chave (o cliente repetiu o
  -- pedido, a resposta se perdeu) devolve a linha que ja existe em vez de
  -- estourar no `unique`. A chave carrega o id do dono e ja foi conferida
  -- contra `p_user_id`, entao o `on conflict` nao alcanca linha alheia.
  insert into public.assets (user_id, kind, r2_key, mime, bytes, sha256)
  values (p_user_id, 'header', p_r2_key, p_mime, p_bytes, p_sha256)
  on conflict (r2_key) do update
     set mime   = excluded.mime,
         bytes  = excluded.bytes,
         sha256 = coalesce(excluded.sha256, public.assets.sha256)
  returning * into v_asset;

  return v_asset;
end;
$fn$;

revoke execute on function public.register_header_asset(uuid, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.register_header_asset(uuid, text, text, bigint, text)
  to service_role;

commit;
