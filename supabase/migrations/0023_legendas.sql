-- PageMask · 0023_legendas
--
-- A Fase 9 acrescenta legendas automaticas. Do ponto de vista do banco sao
-- quatro coisas, e uma delas e uma decisao que vale explicar antes das outras.
--
-- POR QUE NAO EXISTE UMA COLUNA `templates.subtitles`
-- ===================================================
--
-- O prompt da fase pede "coluna `subtitles` jsonb em templates". Ela NAO esta
-- aqui, e a razao e o desenho que a Fase 6 fechou: `templates.config` e o
-- template inteiro, e `jobs.template_snapshot` e uma COPIA CONGELADA dele,
-- feita por `enqueue_project` no momento do enfileiramento. Esse par e o que
-- faz "editar o template no meio do lote nao muda os videos ja na fila".
--
-- Uma segunda coluna partiria o template em dois lugares e cada um dos quatro
-- caminhos que hoje copiam `config` — `enqueue_project`, `requeue_failed_jobs`,
-- `request_preview` e o editor — teria que aprender a copiar os dois. A
-- primeira vez que um deles esquecesse, o lote sairia com a legenda de um
-- template e o desenho de outro, sem erro nenhum. O estilo da legenda mora,
-- portanto, em `config.subtitles` — dentro do mesmo objeto, congelado pelo
-- mesmo snapshot, validado pelo mesmo `zod` no app e remontado pelo mesmo
-- `molde.montar` no worker.
--
-- O QUE ESTA AQUI
-- ===============
--
--   jobs.r2_srt_key            onde mora o SRT deste video
--   jobs.transcribed_seconds   quantos segundos de audio foram transcritos
--   subscriptions.transcription_seconds_used   a cota consumida no periodo
--   plans.transcription_seconds_month          o teto por plano
--
--   reserve_transcription      cobra a cota ANTES de a CPU ser gasta
--   job_srt                    grava a chave do SRT (irmã de `job_probe`)
--   requeue_subtitled_jobs     re-renderiza depois de a legenda ser editada
--
-- O SRT E O QUE TORNA O RENDER REPRODUZIVEL DE NOVO
-- =================================================
--
-- A transcricao e a unica etapa nao deterministica do pipeline (CLAUDE.md,
-- "Regra numero um"). Ela roda UMA vez, grava o texto no R2 e guarda a chave
-- aqui; dali em diante o render le o arquivo. Duas consequencias que valem
-- pelo preco de uma coluna:
--
--   · a tentativa 2 de um job que falhou depois da transcricao NAO transcreve
--     de novo — nao gasta CPU nem cota, e produz o mesmo video;
--   · editar o texto na tela e re-renderizar e uma operacao com resultado
--     previsivel, porque o unico insumo variavel virou um arquivo versionavel.
--
-- Codigos de erro desta migration:
--   PM034  cota de transcricao do plano estourada
--   PM035  video sem legenda gravada (nao ha o que re-renderizar)

begin;

-- ---------------------------------------------------------------------------
-- jobs — onde o SRT mora e quanto ele custou
-- ---------------------------------------------------------------------------

alter table public.jobs
  add column if not exists r2_srt_key          text,
  add column if not exists transcribed_seconds integer;

do $$
begin
  alter table public.jobs
    add constraint jobs_transcribed_seconds_check
    check (transcribed_seconds is null or transcribed_seconds >= 0);
exception when duplicate_object then
  null;
end;
$$;

comment on column public.jobs.r2_srt_key is
  'A legenda deste video no R2, no prefixo proprio de legendas. Preenchida na '
  'PRIMEIRA transcricao e nunca mais: a partir dai o render le o arquivo em vez '
  'de transcrever, entao tentativa repetida, reprocessamento e re-render depois '
  'de edicao produzem o mesmo video. Nula = este job nunca teve legenda.';
comment on column public.jobs.transcribed_seconds is
  'Segundos de audio que a transcricao deste job cobrou da cota. Guardado por '
  'job para que a soma do periodo em `subscriptions` tenha de onde ser '
  'auditada — ela nunca e derivada daqui, pela mesma regra de `videos_used`.';

-- O cliente ja tem `grant select on public.jobs` (0004) e a politica do dono
-- (0001). As colunas novas entram nessa mesma regra, e e o que a tela precisa:
-- e `r2_srt_key` que diz se o botao "Legenda" aparece naquele video. A chave
-- sozinha nao abre nada — todo acesso ao R2 passa por assinatura no servidor.

-- ---------------------------------------------------------------------------
-- plans — o teto de transcricao, que e teto de CPU
-- ---------------------------------------------------------------------------
--
-- POR QUE ESTE LIMITE EXISTE SEPARADO DE `videos_month`. Um video de 60 s e um
-- de 15 min consomem a MESMA vaga de `videos_month` e transcricoes de custo
-- muito diferente: o `small` do faster-whisper em CPU roda a uma fracao do
-- tempo real, entao 2.500 videos de 15 minutos seriam dias de processador por
-- conta. O teto em segundos e o unico que mede o que de fato e gasto.
--
-- O valor segue uma regra que da para explicar a um cliente: `videos_month`
-- vezes 60 segundos, ou seja, "o plano inteiro em videos de ate um minuto".
-- Quem passa disso esta transcrevendo video longo, que e o caso caro.

alter table public.plans
  add column if not exists transcription_seconds_month integer not null default 0;

do $$
begin
  alter table public.plans
    add constraint plans_transcription_seconds_check
    check (transcription_seconds_month >= 0);
exception when duplicate_object then
  null;
end;
$$;

comment on column public.plans.transcription_seconds_month is
  'Teto de audio transcrito por periodo, em segundos. Zero desliga a legenda '
  'automatica naquele plano. Como todo limite de plano, sai daqui e nunca de '
  'constante no codigo (CLAUDE.md, "Convencoes").';

-- O seed dos planos mora na 0002, mas ele NAO ganha esta coluna: a 0002 roda
-- antes desta migration num banco novo, e uma coluna que ainda nao existe
-- aborta o insert inteiro. O valor de cada plano e escrito aqui, uma vez, e a
-- 0002 continua sendo o catalogo das colunas que ela mesma criou.
update public.plans
   set transcription_seconds_month = videos_month * 60
 where transcription_seconds_month = 0;

-- ---------------------------------------------------------------------------
-- subscriptions — a cota consumida, ao lado de `videos_used`
-- ---------------------------------------------------------------------------

alter table public.subscriptions
  add column if not exists transcription_seconds_used integer not null default 0;

do $$
begin
  alter table public.subscriptions
    add constraint subscriptions_transcription_used_check
    check (transcription_seconds_used >= 0);
exception when duplicate_object then
  null;
end;
$$;

comment on column public.subscriptions.transcription_seconds_used is
  'Segundos de audio transcritos no periodo. Incrementa quando a transcricao e '
  'AUTORIZADA, nao quando ela termina, e nao e devolvida se o render falhar '
  'depois: a CPU ja foi gasta. Zerada junto com `videos_used` no reset de '
  'ciclo. Nunca derivar de soma de `jobs`.';

-- `subscriptions` esta revogada por inteiro para anon/authenticated desde a
-- 0001 e a politica de select e so do dono. A coluna nova nasce sob essa regra.

-- ---------------------------------------------------------------------------
-- reserve_transcription — a cota cobrada ANTES da CPU
-- ---------------------------------------------------------------------------
--
-- Chamada pelo worker, com a senha de porteiro (`p_attempt`) de todas as
-- funcoes de job desde a 0015: um worker atrasado, cujo job ja foi devolvido a
-- fila pelo zelador, nao cobra cota de um trabalho que nao e mais dele.
--
-- COBRA ANTES, E NAO DEPOIS, e essa e a unica ordem que funciona. Cobrar depois
-- significaria descobrir que a conta estourou quando os quinze minutos de
-- processador ja foram gastos — que e exatamente o que este limite existe para
-- impedir. O preco de cobrar antes e conhecido e pequeno: uma transcricao que
-- morra no meio ja debitou os segundos. Ela nao repete na tentativa seguinte
-- (o SRT so e gravado quando termina), entao o risco real e um job que falhe
-- tres vezes na transcricao debitar tres vezes — e a terceira e definitiva.
--
-- `p_seconds` vem do `ffprobe` do proprio worker, sobre o arquivo ja baixado.
-- Nao vem do navegador, e nao vem do `probe` que a Fase 2 gravou no app.

create or replace function public.reserve_transcription(
  p_job_id  uuid,
  p_attempt integer,
  p_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user   uuid;
  v_limite integer;
  v_usados integer;
  v_pedido integer := greatest(0, coalesce(p_seconds, 0));
begin
  select j.user_id into v_user
    from public.jobs as j
   where j.id = p_job_id
     and j.status = 'processing'
     and j.attempts = p_attempt;

  if not found then
    raise exception 'este job nao esta mais com este worker' using errcode = 'PM016';
  end if;

  select pl.transcription_seconds_month into v_limite
    from public.plano_do_usuario(v_user) as pl;
  if v_limite is null then
    raise exception 'plano nao encontrado' using errcode = 'PM004';
  end if;

  -- A linha existe desde o primeiro upload (`register_upload_job`), mas a
  -- criacao aqui e barata e tira um caminho de nulo do meio da conta.
  insert into public.subscriptions (user_id) values (v_user)
  on conflict (user_id) do nothing;

  select transcription_seconds_used into v_usados
    from public.subscriptions
   where user_id = v_user
     for update;

  if coalesce(v_usados, 0) + v_pedido > v_limite then
    -- `detail` no mesmo formato dos outros limites com numero
    -- (`usados/limite/pedidos`), para a interface ler os tres com um parser so.
    raise exception 'cota de transcricao estourada'
      using errcode = 'PM034',
            detail  = coalesce(v_usados, 0)::text || '/' || v_limite::text
                      || '/' || v_pedido::text;
  end if;

  update public.subscriptions
     set transcription_seconds_used = transcription_seconds_used + v_pedido
   where user_id = v_user;

  return v_limite - (coalesce(v_usados, 0) + v_pedido);
end;
$fn$;

comment on function public.reserve_transcription is
  'Autoriza e cobra `p_seconds` de transcricao do dono do job. Devolve quantos '
  'segundos sobram no periodo. `PM034` quando nao cabe, `PM016` quando o job '
  'nao e mais deste worker.';

revoke execute on function public.reserve_transcription(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_transcription(uuid, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- job_srt — a chave do SRT, gravada assim que ele sobe
-- ---------------------------------------------------------------------------
--
-- Irmã de `job_probe` (0017), e pela mesma razao: o dado precisa chegar ao
-- banco ASSIM QUE existe, e nao no fim. O SRT sobe ANTES do render; se o render
-- falhar, a legenda ja esta gravada e a tentativa seguinte a reaproveita em vez
-- de transcrever de novo.

create or replace function public.job_srt(
  p_job_id  uuid,
  p_attempt integer,
  p_key     text,
  p_seconds integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_linhas integer;
begin
  if p_key is null or length(btrim(p_key)) = 0 then
    raise exception 'legenda sem chave' using errcode = 'PM015';
  end if;

  update public.jobs
     set r2_srt_key          = p_key,
         transcribed_seconds = coalesce(p_seconds, transcribed_seconds)
   where id = p_job_id
     and status = 'processing'
     and attempts = p_attempt;

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$fn$;

revoke execute on function public.job_srt(uuid, integer, text, integer)
  from public, anon, authenticated;
grant execute on function public.job_srt(uuid, integer, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- requeue_subtitled_jobs — re-renderizar depois de editar a legenda
-- ---------------------------------------------------------------------------
--
-- O caminho que a fase pede em uma frase: "editar uma linha na UI e
-- re-renderizar reflete a mudanca". Editar o SRT grava por cima do objeto no
-- R2 e nao mexe em `jobs`; quem transforma o texto novo em video novo e esta
-- funcao.
--
-- IRMA DE `requeue_failed_jobs`, COM DUAS DIFERENCAS:
--
--   1. o alvo e `done`, e nao `failed` — o video ja saiu, e o usuario quer
--      outro com a legenda corrigida;
--   2. so entra job COM `r2_srt_key`. Sem legenda gravada nao ha o que
--      re-renderizar: seria um botao que refaz trabalho identico cobrando cota
--      de novo.
--
-- A COTA E COBRADA, e isso nao e detalhe: re-renderizar produz um render
-- inteiro, do mesmo tamanho do primeiro. A vaga do upload ja foi consumida
-- naquele video e nao volta; esta e uma vaga nova. O `detail` do `PM002` sai no
-- mesmo formato das outras duas, entao a tela diz "voce pediu N e ainda cabem
-- M" sem nenhum parser novo.
--
-- `r2_srt_key` E `r2_output_key` FICAM COMO ESTAO. A primeira e todo o ponto da
-- operacao (o worker le o SRT em vez de transcrever, sem gastar cota de
-- transcricao). A segunda e a saida antiga, que continua no bucket ate o
-- `finish_job` gravar por cima da MESMA chave — derivada do id do job. Limpar
-- a coluna aqui so criaria uma janela em que o video sumiu da conta de alguem
-- que ainda nem clicou em nada.

create or replace function public.requeue_subtitled_jobs(
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

  if not public.assinatura_ativa_de(p_user_id) then
    raise exception 'assinatura inativa' using errcode = 'PM031';
  end if;

  -- A MESMA ordem de travas das outras (0012): projects → jobs → subscriptions.
  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
       for update
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

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
       and status     = 'done'
       and r2_srt_key is not null
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

  insert into public.subscriptions (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select videos_used into v_usados
    from public.subscriptions
   where user_id = p_user_id
     for update;

  if coalesce(v_usados, 0) + v_quantos > v_limite then
    raise exception 'cota de videos estourada'
      using errcode = 'PM002',
            detail  = coalesce(v_usados, 0)::text || '/' || v_limite::text
                      || '/' || v_quantos::text;
  end if;

  update public.subscriptions
     set videos_used = videos_used + v_quantos
   where user_id = p_user_id;

  return v_quantos;
end;
$fn$;

comment on function public.requeue_subtitled_jobs is
  'Devolve a `queued` os videos `done` que ja tem legenda gravada, para o '
  'render refletir o SRT editado. Cobra cota de video; nao cobra cota de '
  'transcricao, porque nao transcreve nada.';

revoke execute on function public.requeue_subtitled_jobs(uuid, uuid, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.requeue_subtitled_jobs(uuid, uuid, jsonb, uuid[])
  to service_role;

commit;

-- ===========================================================================
-- O reset de ciclo zera as DUAS cotas
-- ===========================================================================
--
-- `apply_stripe_event` (0022) zera `videos_used` quando o periodo vira. Sem
-- esta passada, `transcription_seconds_used` so subiria: o cliente pagaria o
-- segundo mes e continuaria bloqueado pelo consumo do primeiro — e o sintoma
-- ("as legendas pararam de funcionar depois que eu paguei") nao aponta em nada
-- para a cota de transcricao.
--
-- O corpo abaixo e o da 0022 com UMA linha a mais, dentro do bloco do reset.
-- Ele e repetido por inteiro de proposito: `create or replace function` nao
-- aceita remendo, e manter as duas versoes lado a lado no historico e o que
-- deixa o diff desta migration mostrar exatamente o que mudou.

begin;

create or replace function public.apply_stripe_event(
  p_event_id             text,
  p_type                 text,
  p_created              timestamptz,
  p_payload              jsonb,
  p_user_id              uuid,
  p_customer_id          text        default null,
  p_subscription_id      text        default null,
  p_status               text        default null,
  p_price_id             text        default null,
  p_plan_slug            text        default null,
  p_period_start         timestamptz default null,
  p_period_end           timestamptz default null,
  p_cancel_at_period_end boolean     default null,
  p_cancel_at            timestamptz default null,
  p_canceled_at          timestamptz default null,
  p_payment_state        text        default null,
  p_reset_quota          boolean     default false
)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_evt        uuid;
  v_sub        public.subscriptions;
  v_estado     boolean;
  v_vale       boolean;
  v_plano_novo text;
  v_plano_velho text;
  v_dono       uuid;
begin
  if p_user_id is null then
    raise exception 'evento sem dono resolvido' using errcode = 'PM000';
  end if;
  if p_event_id is null or length(btrim(p_event_id)) = 0 then
    raise exception 'evento sem id' using errcode = 'PM032';
  end if;

  insert into public.webhook_events (provider, event_id, payload, processed_at)
  values ('stripe', p_event_id, coalesce(p_payload, '{}'::jsonb), now())
  on conflict (event_id) do nothing
  returning id into v_evt;

  if v_evt is null then
    return 'repetido';
  end if;

  if p_customer_id is not null then
    select id into v_dono
      from public.profiles
     where stripe_customer_id = p_customer_id
       and id <> p_user_id;
    if found then
      raise exception 'cliente % ja pertence a outro usuario', p_customer_id
        using errcode = 'PM033';
    end if;

    update public.profiles
       set stripe_customer_id = p_customer_id
     where id = p_user_id
       and stripe_customer_id is distinct from p_customer_id;
  end if;

  insert into public.subscriptions (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_sub
    from public.subscriptions
   where user_id = p_user_id
     for update;

  v_estado := p_type in (
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted'
  );

  v_vale := (not v_estado)
            or p_created is null
            or v_sub.last_event_at is null
            or p_created >= v_sub.last_event_at;

  if v_estado and not v_vale then
    update public.webhook_events
       set error = 'fora de ordem: evento anterior ao ultimo aplicado'
     where id = v_evt;
    return 'fora-de-ordem';
  end if;

  if v_estado then
    v_plano_velho := (select plan_slug from public.profiles where id = p_user_id);
    v_plano_novo  := coalesce(p_plan_slug, v_sub.plan_slug);

    update public.subscriptions
       set stripe_customer_id     = coalesce(p_customer_id, stripe_customer_id),
           stripe_subscription_id = coalesce(p_subscription_id, stripe_subscription_id),
           stripe_price_id        = coalesce(p_price_id, stripe_price_id),
           plan_slug              = v_plano_novo,
           status                 = coalesce(p_status, status),
           current_period_start   = coalesce(p_period_start, current_period_start),
           current_period_end     = coalesce(p_period_end, current_period_end),
           cancel_at_period_end   = coalesce(p_cancel_at_period_end, cancel_at_period_end),
           cancel_at              = p_cancel_at,
           canceled_at            = p_canceled_at,
           last_event_at          = coalesce(p_created, last_event_at)
     where user_id = p_user_id;

    if v_plano_novo is not null
       and coalesce(p_status, '') in ('active', 'trialing', 'past_due')
       and v_plano_novo is distinct from v_plano_velho
    then
      update public.profiles set plan_slug = v_plano_novo where id = p_user_id;

      insert into public.audit_log (user_id, actor, action, target, meta)
      values (
        p_user_id, 'system', 'billing.plan_changed', v_plano_novo,
        jsonb_build_object('de', v_plano_velho, 'para', v_plano_novo, 'evento', p_type)
      );
    end if;

    if p_type = 'customer.subscription.deleted' then
      insert into public.audit_log (user_id, actor, action, target, meta)
      values (
        p_user_id, 'system', 'billing.canceled', p_subscription_id,
        jsonb_build_object('plano', v_plano_novo)
      );
    end if;
  end if;

  if p_payment_state is not null then
    update public.subscriptions
       set payment_state = p_payment_state
     where user_id = p_user_id;
  end if;

  if p_reset_quota
     and p_period_start is not null
     and (
       v_sub.quota_period_start is null
       or p_period_start > v_sub.quota_period_start + interval '1 hour'
     )
  then
    update public.subscriptions
       set videos_used                = 0,
           -- A linha da Fase 9. As duas cotas viram no mesmo instante porque
           -- sao do mesmo ciclo: separa-las criaria um mes em que o video
           -- zerou e a transcricao nao.
           transcription_seconds_used = 0,
           quota_period_start         = p_period_start
     where user_id = p_user_id;

    insert into public.audit_log (user_id, actor, action, target, meta)
    values (
      p_user_id, 'system', 'billing.quota_reset', p_subscription_id,
      jsonb_build_object('periodo_inicio', p_period_start, 'evento', p_type)
    );
  end if;

  return 'aplicado';
end;
$fn$;

comment on function public.apply_stripe_event is
  'Registra e aplica um evento da Stripe numa transacao so. Devolve '
  '"repetido" (ja tratado), "fora-de-ordem" (anterior ao ultimo aplicado) ou '
  '"aplicado". O reset de ciclo zera `videos_used` e '
  '`transcription_seconds_used` juntos.';

revoke execute on function public.apply_stripe_event(
  text, text, timestamptz, jsonb, uuid, text, text, text, text, text,
  timestamptz, timestamptz, boolean, timestamptz, timestamptz, text, boolean
) from public, anon, authenticated;
grant execute on function public.apply_stripe_event(
  text, text, timestamptz, jsonb, uuid, text, text, text, text, text,
  timestamptz, timestamptz, boolean, timestamptz, timestamptz, text, boolean
) to service_role;

commit;
