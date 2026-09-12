-- PageMask · 0022_cobranca
--
-- A Fase 8 traz a cobranca. O que o banco precisa guardar e decidir:
--
--   1. a ponte com a Stripe (`plans.stripe_price_id`, `stripe_product_id`,
--      `profiles.stripe_customer_id` — esta ja existia desde a 0001);
--   2. o estado da assinatura, espelhado do que a Stripe manda pelo webhook;
--   3. QUEM PODE CONSUMIR — o gate que substitui "todo mundo pode" pela
--      pergunta "essa conta esta paga?".
--
-- NAO EXISTE PLANO GRATUITO NESTE PRODUTO
-- =======================================
--
-- `partida`, `ritmo` e `escala` sao os tres, e os tres sao pagos. Entao
-- "cancelar rebaixa no fim do periodo" (docs/PLANO.md, Fase 8) nao pode
-- significar "cai para o plano mais barato": isso daria 700 videos por mes de
-- graca a quem cancelou. Significa SUSPENDER:
--
--   · `profiles.plan_slug` continua marcando o ultimo plano contratado — e
--     registro, nao permissao;
--   · quem decide o acesso e `subscriptions.status`, via
--     `public.assinatura_ativa()`;
--   · conta suspensa nao envia video, nao processa lote e nao agenda
--     publicacao. Continua entrando, baixando o que ja esta pronto, exportando
--     e apagando a conta — o que a pessoa ja pagou continua dela, e a LGPD nao
--     e um recurso do plano.
--
-- `billing_exempt` E PARA OS PILOTOS, E SO A CHAVE SECRETA ESCREVE NELA
-- ====================================================================
--
-- Os 3–5 pilotos da Fase 7 usam o produto sem nunca terem passado por um
-- checkout. Ligar o gate sem uma valvula os expulsaria no mesmo deploy. A
-- valvula e uma coluna booleana em `profiles`, marcada por SQL — e o `grant
-- update (name)` da 0001 continua sendo a lista inteira do que o dono pode
-- escrever no proprio perfil, entao ninguem se isenta sozinho.
--
-- IDEMPOTENCIA: UMA TRANSACAO SO, INSERT ANTES DE PROCESSAR
-- =========================================================
--
-- `apply_stripe_event` faz o insert em `webhook_events` e a mudanca de estado
-- na MESMA transacao. Reentrega do mesmo `event_id` bate no unique, nao acha
-- nada para inserir e volta 'repetido' sem tocar em mais nada. E processamento
-- que estoura no meio desfaz tambem o insert — o evento nao fica marcado como
-- tratado quando nao foi, e a Stripe reentrega. E o mesmo desenho dos
-- callbacks da Meta (0019).
--
-- FORA DE ORDEM E O NORMAL, NAO A EXCECAO
-- =======================================
--
-- A Stripe nao garante ordem de entrega. Um `customer.subscription.updated`
-- de tres minutos atras chegando depois do atual sobrescreveria o estado novo
-- pelo velho — e o caso caro e justo o do cancelamento: o evento antigo diria
-- "ativo" e devolveria acesso a quem cancelou. Dai `last_event_at`: evento
-- mais velho que o ultimo aplicado nao mexe no estado da assinatura.
--
-- O RESET DA COTA E DIRIGIDO POR `invoice.paid` — MAS GUARDADO POR PERIODO
-- ========================================================================
--
-- `quota_period_start` grava de qual periodo foi o ultimo reset. Com isso o
-- reset acontece no maximo uma vez por ciclo, venha a noticia de
-- `invoice.paid` (o caminho normal, o que o PLANO manda) ou de um
-- `customer.subscription.updated` que ja mostra o periodo virado.
--
-- Esse segundo caminho existe por causa do Pix Automatico: o debito acontece
-- no ciclo + 3 dias (docs.stripe.com/payments/pix/pix-automatico), entao o
-- `invoice.paid` do mes novo so chega tres dias depois de o mes novo comecar.
-- Sem o segundo caminho, quem paga por Pix passaria 72 horas de cada mes com a
-- cota do mes anterior — e a Stripe mantem a assinatura `active` esse tempo
-- todo, ou seja, o cliente estaria em dia e barrado ao mesmo tempo.

begin;

-- ---------------------------------------------------------------------------
-- plans — o outro lado da ponte com a Stripe
-- ---------------------------------------------------------------------------
-- `stripe_price_id` ja existia (0001). O produto faltava: o script de
-- sincronia precisa dele para nao criar um Product novo a cada execucao.

alter table public.plans
  add column if not exists stripe_product_id text;

comment on column public.plans.stripe_price_id is
  'Price recorrente da Stripe que espelha `price_cents`. DIFERENTE em teste e '
  'em producao — preenchido por `npm run stripe:sync`, por ambiente, nunca '
  'commitado. E a unica fonte do `price` no checkout: o cliente escolhe o '
  'SLUG, e o servidor traduz.';

-- ---------------------------------------------------------------------------
-- profiles — a isencao dos pilotos
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists billing_exempt boolean not null default false;

comment on column public.profiles.billing_exempt is
  'Conta que passa pelos gates de cobranca sem assinatura (pilotos, contas '
  'internas). So a chave secreta escreve: o `grant update (name)` da 0001 e a '
  'lista completa do que o dono edita no proprio perfil.';

-- ---------------------------------------------------------------------------
-- subscriptions — o espelho do que a Stripe diz
-- ---------------------------------------------------------------------------

alter table public.subscriptions
  add column if not exists stripe_customer_id  text,
  add column if not exists stripe_price_id     text,
  add column if not exists plan_slug           text
    references public.plans (slug) on update cascade,
  add column if not exists current_period_start timestamptz,
  add column if not exists cancel_at            timestamptz,
  add column if not exists canceled_at          timestamptz,
  add column if not exists quota_period_start   timestamptz,
  add column if not exists last_event_at        timestamptz,
  add column if not exists payment_state        text not null default 'nenhum';

do $$
begin
  alter table public.subscriptions
    add constraint subscriptions_payment_state_check
    check (payment_state in ('nenhum', 'ok', 'processando', 'falhou'));
exception when duplicate_object then
  null;
end;
$$;

comment on column public.subscriptions.plan_slug is
  'O plano que ESTA assinatura paga, traduzido de `stripe_price_id`. '
  '`profiles.plan_slug` segue este valor enquanto a assinatura vale, e para de '
  'seguir quando ela morre — la o campo vira registro do ultimo plano.';
comment on column public.subscriptions.payment_state is
  '`processando` e o Pix Automatico entre a notificacao previa e o debito '
  '(ciclo + 3 dias). Nesse intervalo a Stripe mantem a assinatura `active` e '
  'o acesso continua — rebaixar aqui seria cortar quem esta em dia.';
comment on column public.subscriptions.quota_period_start is
  'Inicio do periodo cujo `videos_used` ja foi zerado. Guarda contra zerar '
  'duas vezes no mesmo ciclo, venha a noticia de `invoice.paid` ou de um '
  '`customer.subscription.updated` que ja mostra o periodo virado.';
comment on column public.subscriptions.last_event_at is
  'O `created` do ultimo evento da Stripe aplicado ao estado. Evento mais '
  'velho que este e descartado: a Stripe nao garante ordem de entrega.';

create index if not exists subscriptions_stripe_customer_idx
  on public.subscriptions (stripe_customer_id);
create index if not exists profiles_stripe_customer_idx
  on public.profiles (stripe_customer_id);

-- `subscriptions` ja esta revogada por inteiro para anon/authenticated na 0001
-- (`revoke insert, update, delete`), e a politica de select e so do dono. As
-- colunas novas nascem sob essa mesma regra — nao ha o que revogar de novo.

-- ---------------------------------------------------------------------------
-- assinatura_ativa — o gate, num lugar so
-- ---------------------------------------------------------------------------
-- SEM ARGUMENTO DE PROPOSITO. A politica de `schedules` precisa chama-la com o
-- papel `authenticated`, ou seja, ela e executavel pelo cliente. Com um
-- parametro `uuid` isso viraria um oraculo: qualquer usuario logado poderia
-- perguntar se a conta de outra pessoa esta paga. Lendo `auth.uid()` por
-- dentro, a unica resposta possivel e sobre quem perguntou.
--
-- QUAIS STATUS DAO ACESSO, E POR QUE ESTES
--
--   active, trialing            em dia, obvio
--   past_due                    a Stripe AINDA ESTA TENTANDO cobrar (Smart
--                               Retries). Cortar ali e cortar quem
--                               provavelmente paga em algumas horas. O corte
--                               vem quando a Stripe desiste e move para
--                               `canceled` ou `unpaid` — o "failed definitivo"
--                               do PLANO.
--   incomplete + processando    o Pix Automatico. A documentacao da Stripe diz
--   incomplete + ok             as duas coisas sobre forma de pagamento de
--                               confirmacao adiada: que a assinatura "e ativada
--                               imediatamente" e que ela "pode ficar
--                               `incomplete` quando o PaymentIntent esta em
--                               `processing`". Nao da para escolher uma e
--                               esperar que seja a que acontece.
--
--                               `ok` entra junto com `processando`, e sem ele o
--                               desenho tinha um buraco que trancava justo quem
--                               PAGOU: `payment_state` e escrito pela familia de
--                               eventos de FATURA e o `status` pela de
--                               ASSINATURA, entao um `invoice.paid` que chega
--                               antes do `customer.subscription.updated` deixa a
--                               linha em `incomplete` + `ok` por alguns
--                               segundos. Com a regra so em `processando`, esse
--                               intervalo era acesso NEGADO a quem acabou de
--                               pagar — e a mesma combinacao fica permanente se
--                               o evento de assinatura se perder.
--
--                               Nao e acesso de graca: `ok` e `processando` so
--                               sao escritos por `invoice.paid` ou por uma sessao
--                               de checkout concluida. A linha que
--                               `register_upload_job` cria sozinha tambem nasce
--                               `incomplete`, mas com `payment_state = 'nenhum'`,
--                               e continua sem acesso. `falhou` idem.
--
-- `incomplete_expired` NAO da acesso, e e o par certo deste desenho: e o
-- estado em que a Stripe declara que o pagamento inicial nao aconteceu no
-- prazo. Fim do "processando", e o corte e este.

create or replace function public.assinatura_ativa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (
      select pf.billing_exempt
          or coalesce(s.status, '') in ('active', 'trialing', 'past_due')
          or (
            coalesce(s.status, '') = 'incomplete'
            and s.payment_state in ('processando', 'ok')
          )
        from public.profiles as pf
        left join public.subscriptions as s on s.user_id = pf.id
       where pf.id = (select auth.uid())
    ),
    false
  );
$fn$;

comment on function public.assinatura_ativa is
  'O acesso pago de quem chamou. Lida pela RLS de `schedules` e pelas funcoes '
  'de upload e de fila. Sem argumento para nao virar um oraculo sobre a '
  'assinatura dos outros.';

grant execute on function public.assinatura_ativa() to authenticated;

-- A versao com dono explicito, para as funcoes `security definer` que ja
-- recebem `p_user_id` do servidor. Nunca exposta ao cliente.

create or replace function public.assinatura_ativa_de(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (
      select pf.billing_exempt
          or coalesce(s.status, '') in ('active', 'trialing', 'past_due')
          or (
            coalesce(s.status, '') = 'incomplete'
            and s.payment_state in ('processando', 'ok')
          )
        from public.profiles as pf
        left join public.subscriptions as s on s.user_id = pf.id
       where pf.id = p_user_id
    ),
    false
  );
$fn$;

revoke execute on function public.assinatura_ativa_de(uuid)
  from public, anon, authenticated;
grant execute on function public.assinatura_ativa_de(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- schedules — agendar exige assinatura
-- ---------------------------------------------------------------------------
-- O insert de `schedules` e o unico dos tres gates que o cliente faz DIRETO na
-- tabela, sem passar por funcao nossa (0001). Entao o gate dele tem que morar
-- na politica, senao um POST no PostgREST passa por cima da tela.
--
-- Reagendar (`update`) continua liberado: mexer no horario de algo que ja foi
-- agendado nao produz trabalho novo. Cancelar (`delete`), idem — e cortar a
-- saida de quem quer cancelar seria hostil.
--
-- CUIDADO AO MEXER AQUI, e esta advertencia foi paga: `create policy` nao tem
-- "adicionar uma condicao". Para somar `assinatura_ativa()` e preciso derrubar
-- a politica e escrever OUTRA INTEIRA — e a primeira versao desta migration
-- reescreveu a da 0001 em vez da da 0019, perdendo em silencio quatro
-- predicados que a 0019 tinha acrescentado de proposito:
--
--   j.status = 'done'                       so video PRONTO se agenda
--   j.r2_output_key is not null              e que tenha arquivo de saida
--   a.status = 'active'                      conta com token vivo; `publish.py`
--                                            so barra `revoked` na unha, entao
--                                            `needs_reconnect` seria TENTADO
--   scheduled_at > now() - '5 minutes'       nao se agenda para o passado, o que
--                                            faria `mark_due_schedules` publicar
--                                            na tiquetada seguinte
--
-- Nenhum deles e conferido pela RLS em outro lugar: a `agendarVideo` os checa,
-- mas ela e a TELA, e um POST direto no PostgREST nao passa por ela. Perder
-- isso era regressao de 18 migrations.
--
-- Quem editar esta politica de novo: compare o `with check` novo com
-- `pg_policies` ANTES de aplicar, nao com a versao que estiver mais a mao.

drop policy if exists "agendamentos proprios: criar" on public.schedules;

create policy "agendamentos proprios: criar"
  on public.schedules for insert
  to authenticated
  with check (
    public.assinatura_ativa()
    and exists (
      select 1 from public.jobs j
       where j.id = job_id
         and j.user_id = (select auth.uid())
         and j.status = 'done'
         and j.r2_output_key is not null
    )
    and exists (
      select 1 from public.ig_accounts a
       where a.id = ig_account_id
         and a.user_id = (select auth.uid())
         and a.status = 'active'
    )
    -- Cinco minutos de folga para o relogio do navegador; o servidor ainda
    -- confere o "no passado" com mensagem propria.
    and scheduled_at > now() - interval '5 minutes'
  );

-- ---------------------------------------------------------------------------
-- register_upload_job — o gate no ponto onde a cota e cobrada
-- ---------------------------------------------------------------------------
-- Identica a 0014, com UMA adicao: `PM031` quando nao ha assinatura ativa.
--
-- A checagem vem depois da trava em `projects` (a ordem da 0012 nao muda) e
-- so no caminho de aceite: um arquivo RECUSADO pelo ffprobe (`p_recusa`) e
-- registrado mesmo sem assinatura, porque essa linha existe para o usuario
-- entender por que o envio dele nao valeu — e ela nao consome cota nenhuma.

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

  if p_recusa is null and not public.assinatura_ativa_de(p_user_id) then
    raise exception 'assinatura inativa' using errcode = 'PM031';
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

    if not found then
      raise exception 'o registro deste envio sumiu no meio da confirmacao'
        using errcode = 'PM011';
    end if;
  end;

  return v_job;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- enqueue_project — o gate na fila, e a conta que o PLANO pede
-- ---------------------------------------------------------------------------
-- Identica a 0020, com duas adicoes.
--
-- 1. `PM031` sem assinatura ativa.
--
-- 2. A CONTA DA COTA AGORA DIZ QUANTO FALTA. O PLANO pede
--    "bloqueia se videos_used + selecionados > videos_month, dizendo quanto
--    falta". Aqui a vaga JA FOI COBRADA no upload — `register_upload_job`
--    incrementa `videos_used` ao aceitar o arquivo, e cobrar de novo na fila
--    contaria o mesmo video duas vezes. Entao `videos_used` ja INCLUI os
--    selecionados, e a soma do PLANO, feita de novo aqui, seria o dobro.
--
--    O que muda de verdade e a mensagem: em vez de um `PM002` mudo, a excecao
--    leva `videos_used` e `videos_month` no texto, e a interface transforma
--    isso em "voce usou X de Y; sobram Z" com o botao de mudar de plano. O
--    caso real que dispara isso e quem baixou de plano entre enviar e
--    processar — ai `videos_used` fica de fato acima do limite novo.

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

  if not public.assinatura_ativa_de(p_user_id) then
    raise exception 'assinatura inativa' using errcode = 'PM031';
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
    -- `detail` = usados/limite/pedidos. Os tres numeros num formato so porque os
    -- dois lugares que levantam `PM002` com numero (aqui e
    -- `requeue_failed_jobs`) precisam dizer coisas diferentes, e o TypeScript le
    -- os dois pelo MESMO parser (`mensagemDaQuota`, em `lib/plano/erros.ts`).
    --
    -- Aqui `pedidos` e ZERO, e isso nao e descuido: a vaga foi cobrada no
    -- upload, entao `videos_used` JA inclui os selecionados. Somar os
    -- selecionados de novo contaria cada video duas vezes, e a frase diria o
    -- dobro do que a pessoa deve.
    raise exception 'cota de videos estourada'
      using errcode = 'PM002',
            detail  = coalesce(v_usados, 0)::text || '/' || v_limite::text || '/0';
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

-- ---------------------------------------------------------------------------
-- requeue_failed_jobs — o gate no reprocessamento
-- ---------------------------------------------------------------------------
-- Identica a 0021, com duas adicoes: `PM031` sem assinatura ativa, e os numeros
-- no `detail` do `PM002`.
--
-- Reprocessar PRODUZ TRABALHO NOVO, e aqui a cota e cobrada de verdade (a
-- `fail_job` devolveu o credito quando o video falhou) — entao aqui a soma que
-- o PLANO pede, `videos_used + selecionados > videos_month`, e literalmente a
-- que existe. Diferente do `enqueue_project`, onde a vaga ja foi paga no
-- upload.

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

  if not public.assinatura_ativa_de(p_user_id) then
    raise exception 'assinatura inativa' using errcode = 'PM031';
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
    -- Aqui `pedidos` e `v_quantos` de verdade: reprocessar COBRA cota de novo
    -- (a `fail_job` devolveu o credito quando o video falhou), entao a soma do
    -- PLANO — `videos_used + selecionados > videos_month` — e literalmente esta.
    -- O primeiro numero continua sendo o consumo ATUAL, sem os pedidos: quem le
    -- a frase precisa saber quanto ja gastou e quanto esta pedindo, separados.
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

revoke execute on function public.requeue_failed_jobs(uuid, uuid, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.requeue_failed_jobs(uuid, uuid, jsonb, uuid[])
  to service_role;

-- ---------------------------------------------------------------------------
-- apply_stripe_event — o webhook inteiro numa transacao
-- ---------------------------------------------------------------------------
-- A rota valida a assinatura, decide QUEM e o dono e traduz o evento para
-- estes parametros. Aqui acontece o resto: registrar, ordenar, aplicar.
--
-- Por que a traducao fica no TypeScript e nao aqui: a forma do payload da
-- Stripe muda de versao para versao (na 2026-08-26.dahlia a assinatura nao tem
-- mais `current_period_end` no topo — ele mora em `items.data[]` — e a fatura
-- nao tem mais `subscription`, que virou `parent.subscription_details`).
-- Cavar jsonb em plpgsql atras desses campos seria escrever um parser de API
-- externa dentro de uma migration, sem tipo e sem teste. O SQL recebe valores
-- ja normalizados e cuida do que e dele: unicidade, ordem e atomicidade.
--
-- DUAS FAMILIAS DE EVENTO, DOIS EFEITOS DIFERENTES
-- ================================================
--
--   estado    checkout.session.completed, customer.subscription.*
--             → escrevem status, plano, periodo e avancam `last_event_at`
--   cobranca  invoice.paid, invoice.payment_failed
--             → escrevem `payment_state` e, no caso da paga, zeram a cota
--
-- Sao separadas de proposito. A fatura e a assinatura do MESMO ciclo chegam com
-- `created` a segundos uma da outra e em ordem imprevisivel; se as duas
-- disputassem `last_event_at`, a que chegasse depois faria a outra ser
-- descartada por "fora de ordem" — e o efeito perdido seria justo o reset da
-- cota ou a mudanca de status.

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

  -- O insert vem ANTES de qualquer efeito (PLANO §5). Na mesma transacao, o
  -- que significa duas garantias e nao uma: reentrega bate no unique e nao faz
  -- nada; e processamento que estoura desfaz tambem este insert, entao o
  -- evento nao fica marcado como tratado sem ter sido.
  insert into public.webhook_events (provider, event_id, payload, processed_at)
  values ('stripe', p_event_id, coalesce(p_payload, '{}'::jsonb), now())
  on conflict (event_id) do nothing
  returning id into v_evt;

  if v_evt is null then
    return 'repetido';
  end if;

  -- Um cliente da Stripe pertence a UM usuario. Dois perfis apontando para o
  -- mesmo `cus_…` significaria cobrar uma pessoa e liberar outra; e melhor
  -- estourar aqui, com a transacao inteira desfeita e a Stripe reentregando,
  -- do que gravar isso.
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

  -- Fora de ordem: so o estado se protege. O reset de cota e o `payment_state`
  -- tem guarda propria (`quota_period_start`) e nao dependem de ordem.
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
           -- Sem `coalesce` nestes dois: desmarcar o cancelamento no Billing
           -- Portal manda `cancel_at_period_end=false` com os dois nulos, e um
           -- `coalesce` guardaria para sempre a data de um cancelamento que
           -- foi desfeito.
           cancel_at              = p_cancel_at,
           canceled_at            = p_canceled_at,
           last_event_at          = coalesce(p_created, last_event_at)
     where user_id = p_user_id;

    -- `profiles.plan_slug` so segue a assinatura enquanto ela vale. Morta a
    -- assinatura, o campo congela no ultimo plano: e registro do que a pessoa
    -- teve, e quem decide o acesso passa a ser `assinatura_ativa()`.
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

  -- O reset da cota. `quota_period_start` e a guarda: no maximo uma vez por
  -- ciclo, venha a noticia de `invoice.paid` (o caminho normal) ou de um
  -- evento de assinatura que ja mostra o periodo virado — que e como o Pix
  -- Automatico chega, tres dias antes da fatura.
  --
  -- A folga de uma hora nao e frescura. O `period_start` chega de duas fontes
  -- que deveriam coincidir e nem sempre coincidem ao segundo: `items.data[]`
  -- da assinatura e a linha da fatura. Um segundo de diferenca entre as duas
  -- passaria pela guarda e zeraria a cota DUAS vezes no mesmo ciclo — cota de
  -- graca. Uma hora e grande o bastante para absorver a diferenca e pequena
  -- demais para engolir um ciclo de verdade, que e semanal no mais curto.
  if p_reset_quota
     and p_period_start is not null
     and (
       v_sub.quota_period_start is null
       or p_period_start > v_sub.quota_period_start + interval '1 hour'
     )
  then
    update public.subscriptions
       set videos_used        = 0,
           quota_period_start = p_period_start
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
  '"aplicado".';

revoke execute on function public.apply_stripe_event(
  text, text, timestamptz, jsonb, uuid, text, text, text, text, text,
  timestamptz, timestamptz, boolean, timestamptz, timestamptz, text, boolean
) from public, anon, authenticated;
grant execute on function public.apply_stripe_event(
  text, text, timestamptz, jsonb, uuid, text, text, text, text, text,
  timestamptz, timestamptz, boolean, timestamptz, timestamptz, text, boolean
) to service_role;

commit;
