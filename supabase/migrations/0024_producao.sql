-- PageMask · 0024_producao
--
-- A Fase 10 fecha o checklist de producao. Do ponto de vista do banco, o que
-- falta e a EXCLUSAO DE CONTA PONTA A PONTA e a EXPORTACAO (PLANO §8) — as
-- duas ja tinham endereco na tela (`/app/conta`), e nenhuma tinha motor.
--
-- Funcoes desta migration:
--
--   export_account_data      tudo que guardamos sobre o titular, em JSON
--   ig_account_tokens        os tokens das contas dele, para revogar na Meta
--   open_account_deletion    abre a solicitacao e devolve o codigo
--   purge_account            apaga as linhas e ANONIMIZA a auditoria
--   fail_account_deletion    marca a solicitacao como falha, sem apagar nada
--
-- POR QUE A EXCLUSAO NAO E UM `delete from auth.users` E PRONTO
-- ============================================================
--
-- Quase tudo cascateia de `auth.users` (conferido no banco: `assets`,
-- `batch_zips`, `ig_accounts`, `ig_oauth_states`, `jobs`, `profiles`,
-- `projects`, `subscriptions`, `template_previews`, `templates`). Duas tabelas
-- NAO: `audit_log` e `data_requests` sao `on delete set null`.
--
-- E ai esta a armadilha. `set null` zera a coluna `user_id` e deixa `ip`,
-- `meta` e `target` exatamente como estavam — ou seja, um `audit_log` cheio de
-- endereco IP e de id de recurso de alguem que pediu para ser esquecido, so que
-- agora sem a coluna que permitiria encontrar e apagar essas linhas. A exclusao
-- pareceria completa e teria deixado para tras justamente o dado pessoal que
-- sobrevive a ela.
--
-- Por isso a anonimizacao acontece AQUI, com o `user_id` ainda preenchido, e
-- ANTES de o usuario sair do Auth. O `delete` no Auth vem depois, como ultimo
-- passo e rede de seguranca do que este arquivo nao tiver alcancado.
--
-- O QUE ESTA FUNCAO **NAO** FAZ
-- ============================
--
-- Nao apaga arquivo no R2 e nao revoga token na Meta: as duas coisas moram
-- fora do Postgres. Quem orquestra e `app/src/lib/conta/exclusao.ts`, na ordem
-- em que o dano de uma falha no meio e menor:
--
--   1. apaga no R2      (falhar aqui ABORTA — arquivo orfao sem dono no banco
--                        seria um vazamento que ninguem mais consegue achar.
--                        Vem PRIMEIRO para que esse aborto aconteca antes de
--                        qualquer coisa irreversivel do lado da Meta)
--   2. revoga na Meta   (falhar aqui nao impede: o token morre no passo 3)
--   3. purge_account    (esta funcao)
--   4. delete no Auth
--
-- `data_requests.status` acompanha: `processing` no passo 1, `completed` no 3,
-- `failed` se abortar. A pagina publica `/exclusao-de-dados?code=…` le esse
-- estado — e e por isso que a solicitacao e aberta ANTES de qualquer destruicao.

begin;

-- ---------------------------------------------------------------------------
-- export_account_data — o direito de acesso e portabilidade (LGPD art. 18)
-- ---------------------------------------------------------------------------
-- Um JSON com tudo que o titular tem neste banco. `security definer` porque a
-- consulta atravessa tabelas que o papel `authenticated` le com RLS e outras
-- que ele nao le de jeito nenhum (`audit_log`, `data_requests` sao select-only
-- por politica; `ig_accounts` tem GRANT por coluna) — reunir tudo pelo cliente
-- daria um retrato incompleto e dependente de politica, que e o pior dos dois
-- mundos num documento legal.
--
-- AS COLUNAS DE TOKEN SAO REMOVIDAS, E ISSO NAO E DETALHE. `token_cipher`,
-- `token_iv` e `token_tag` sao uma CREDENCIAL, nao um dado pessoal do titular:
-- exporta-las poria o segredo de acesso ao Instagram dele dentro de um arquivo
-- que vai para a pasta de downloads e para o e-mail de quem pedir. O que o
-- titular tem direito de saber e QUE existe uma conta conectada, qual e o @ e
-- desde quando — e isso fica.
create or replace function public.export_account_data(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'formato',    'pagemask/exportacao-v1',
    'gerado_em',  now(),
    'titular',    p_user_id,

    'perfil', (
      select to_jsonb(p) from public.profiles as p where p.id = p_user_id
    ),

    'assinatura', (
      select to_jsonb(s) - 'id'
        from public.subscriptions as s where s.user_id = p_user_id
    ),

    'templates', coalesce((
      select jsonb_agg(to_jsonb(t) - 'user_id' order by t.created_at)
        from public.templates as t where t.user_id = p_user_id
    ), '[]'::jsonb),

    'projetos', coalesce((
      select jsonb_agg(to_jsonb(x) - 'user_id' order by x.created_at)
        from public.projects as x where x.user_id = p_user_id
    ), '[]'::jsonb),

    'arquivos_de_marca', coalesce((
      select jsonb_agg(to_jsonb(a) - 'user_id' order by a.created_at)
        from public.assets as a where a.user_id = p_user_id
    ), '[]'::jsonb),

    'videos', coalesce((
      select jsonb_agg(to_jsonb(j) - 'user_id' order by j.queued_at)
        from public.jobs as j where j.user_id = p_user_id
    ), '[]'::jsonb),

    'contas_do_instagram', coalesce((
      select jsonb_agg(
               to_jsonb(c) - 'user_id'
                           - 'token_cipher' - 'token_iv' - 'token_tag'
                           - 'key_version'
               order by c.connected_at)
        from public.ig_accounts as c where c.user_id = p_user_id
    ), '[]'::jsonb),

    'agendamentos', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.scheduled_at)
        from public.schedules as s
        join public.jobs as j on j.id = s.job_id
       where j.user_id = p_user_id
    ), '[]'::jsonb),

    'pacotes', coalesce((
      select jsonb_agg(to_jsonb(z) - 'user_id' order by z.created_at)
        from public.batch_zips as z where z.user_id = p_user_id
    ), '[]'::jsonb),

    'registros_de_auditoria', coalesce((
      select jsonb_agg(to_jsonb(l) - 'user_id' order by l.created_at)
        from public.audit_log as l where l.user_id = p_user_id
    ), '[]'::jsonb),

    'solicitacoes_lgpd', coalesce((
      select jsonb_agg(to_jsonb(d) - 'user_id' order by d.requested_at)
        from public.data_requests as d where d.user_id = p_user_id
    ), '[]'::jsonb)
  );
$fn$;

comment on function public.export_account_data(uuid) is
  'Exportacao LGPD do titular, em JSON. Sem as colunas de token: elas sao '
  'credencial, nao dado pessoal.';

-- ---------------------------------------------------------------------------
-- ig_account_tokens — todos os tokens do usuario, para revogar na Meta
-- ---------------------------------------------------------------------------
-- Irma de `ig_account_token` (0019), que devolve UM. A exclusao precisa de
-- todos, e precisa deles ANTES do purge — depois nao existe mais linha de onde
-- tira-los. Mesma doutrina: o token so sai do banco pelo retorno de uma funcao
-- concedida a `service_role`, nunca por SELECT direto.

create or replace function public.ig_account_tokens(p_user_id uuid)
returns table (
  id          uuid,
  ig_user_id  text,
  username    text,
  status      public.ig_account_status,
  cipher_hex  text,
  iv_hex      text,
  tag_hex     text,
  key_version smallint
)
language sql
security definer
set search_path = ''
as $fn$
  select a.id, a.ig_user_id, a.username, a.status,
         encode(a.token_cipher, 'hex'),
         encode(a.token_iv,     'hex'),
         encode(a.token_tag,    'hex'),
         a.key_version
    from public.ig_accounts as a
   where a.user_id = p_user_id
     and a.token_cipher is not null;
$fn$;

-- ---------------------------------------------------------------------------
-- open_account_deletion — abre a solicitacao ANTES de destruir qualquer coisa
-- ---------------------------------------------------------------------------
-- A ordem importa: se o processo morrer no meio (a funcao da Vercel tem
-- segundos de vida, e apagar 700 objetos no R2 leva tempo), o que fica no banco
-- e uma solicitacao `processing` com codigo — visivel na pagina publica e
-- retomavel — em vez de nada.
--
-- Idempotente por usuario: um segundo clique enquanto a primeira ainda roda
-- devolve o MESMO codigo, em vez de abrir duas exclusoes concorrentes da mesma
-- conta. `ja_aberto` diz qual dos dois casos aconteceu.

create or replace function public.open_account_deletion(
  p_user_id uuid,
  p_code    text,
  p_ip      inet default null
) returns table (confirmation_code text, request_id uuid, ja_aberto boolean)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_existente public.data_requests%rowtype;
  v_nova      public.data_requests%rowtype;
begin
  if p_user_id is null then
    raise exception 'user_id ausente' using errcode = 'PM040';
  end if;

  -- `for update` na linha aberta: duas chamadas simultaneas do mesmo usuario
  -- serializam aqui, e a segunda enxerga a primeira.
  select * into v_existente
    from public.data_requests as d
   where d.user_id = p_user_id
     and d.kind = 'deletion'
     and d.status in ('received', 'processing')
   order by d.requested_at desc
   limit 1
     for update;

  if found then
    return query select v_existente.confirmation_code, v_existente.id, true;
    return;
  end if;

  insert into public.data_requests (user_id, kind, confirmation_code, status, meta)
  values (
    p_user_id, 'deletion', p_code, 'processing',
    jsonb_build_object('origem', 'self-service')
  )
  returning * into v_nova;

  insert into public.audit_log (user_id, actor, action, target, meta, ip)
  values (
    p_user_id, 'user', 'account.delete_requested', p_code,
    jsonb_build_object('origem', 'self-service'), p_ip
  );

  return query select v_nova.confirmation_code, v_nova.id, false;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- purge_account — apaga as linhas do titular e anonimiza o que fica
-- ---------------------------------------------------------------------------
-- Devolve a contagem por tabela. Nao e enfeite: e a evidencia que vai para
-- `docs/PRODUCAO.md` e para a `meta` da solicitacao, e e o que permite dizer
-- "a exclusao apagou N videos e M agendamentos" em vez de "deu certo".
--
-- A ORDEM DOS DELETES segue a dependencia, mesmo com os `cascade` no lugar.
-- Confiar no cascade aqui daria certo hoje e quebraria calado no dia em que
-- alguem acrescentasse uma tabela filha sem `on delete cascade`: o delete do
-- pai falharia com violacao de chave estrangeira no MEIO da exclusao, com
-- parte dos dados ja destruida. Explicito, cada tabela nova aparece como uma
-- linha a acrescentar aqui.

create or replace function public.purge_account(
  p_user_id uuid,
  p_code    text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v jsonb := '{}'::jsonb;
  n integer;
begin
  if p_user_id is null then
    raise exception 'user_id ausente' using errcode = 'PM040';
  end if;

  -- `schedules` chega por dois caminhos (job e conta do Instagram); um delete
  -- que olhe so um deles deixaria o outro para o cascade.
  delete from public.schedules as s
   using public.jobs as j
   where s.job_id = j.id and j.user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('schedules', n);

  delete from public.schedules as s
   using public.ig_accounts as a
   where s.ig_account_id = a.id and a.user_id = p_user_id;
  get diagnostics n = row_count;
  v := jsonb_set(v, '{schedules}', to_jsonb((v ->> 'schedules')::int + n));

  delete from public.template_previews where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('template_previews', n);

  delete from public.batch_zips where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('batch_zips', n);

  delete from public.jobs where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('jobs', n);

  delete from public.projects where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('projects', n);

  delete from public.templates where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('templates', n);

  delete from public.assets where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('assets', n);

  delete from public.ig_accounts where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('ig_accounts', n);

  delete from public.ig_oauth_states where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('ig_oauth_states', n);

  delete from public.subscriptions where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('subscriptions', n);

  delete from public.profiles where id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('profiles', n);

  -- A ANONIMIZACAO, que e o motivo de esta funcao existir.
  --
  -- Fica: `actor`, `action`, `created_at` — a forma do que aconteceu, que e o
  -- que da valor a uma trilha de auditoria e nao identifica ninguem.
  -- Some: `user_id`, `ip`, `target` e `meta` — o IP e dado pessoal, e `meta`
  -- carrega @ do Instagram e id de recurso.
  update public.audit_log
     set user_id = null, ip = null, target = null, meta = '{}'::jsonb
   where user_id = p_user_id;
  get diagnostics n = row_count;  v := v || jsonb_build_object('audit_log_anonimizados', n);

  -- Toda solicitacao aberta deste titular fecha junto, e nao so a que motivou
  -- esta chamada: se a Meta tambem tinha pedido exclusao, o pedido dela foi
  -- atendido por este mesmo purge.
  update public.data_requests
     set status       = 'completed',
         completed_at = now(),
         meta         = meta || jsonb_build_object('apagado', v)
   where (confirmation_code = p_code or user_id = p_user_id)
     and status in ('received', 'processing');
  get diagnostics n = row_count;  v := v || jsonb_build_object('data_requests', n);

  -- `user_id` fica nulo de saida: a conta acabou de deixar de existir, e este
  -- registro nao pode ser o que a traz de volta.
  insert into public.audit_log (user_id, actor, action, target, meta)
  values (null, 'system', 'account.deleted', p_code, v);

  return v;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- fail_account_deletion — a exclusao parou no meio, e isso precisa aparecer
-- ---------------------------------------------------------------------------
-- Sem isto, uma falha no R2 deixaria a solicitacao em `processing` para sempre
-- e a pagina publica diria "em andamento" indefinidamente. `failed` e o que faz
-- alguem olhar — e o que da ao titular um estado honesto para reclamar.

create or replace function public.fail_account_deletion(
  p_code   text,
  p_motivo text
) returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.data_requests
     set status = 'failed',
         meta   = meta || jsonb_build_object('falha', left(coalesce(p_motivo, ''), 300))
   where confirmation_code = p_code
     and status in ('received', 'processing');
$fn$;

-- ---------------------------------------------------------------------------
-- expire_webhook_events — retencao do payload de webhook (PLANO §8)
-- ---------------------------------------------------------------------------
-- Encontrado montando o inventario de `docs/DADOS.md`, e nao por leitura de
-- codigo: `webhook_events.payload` guarda o evento cru da Stripe, que traz
-- e-mail e nome de cobranca, e da Meta, que traz `ig_user_id`. A tabela **nao
-- tem `user_id`** — e por isso a exclusao de conta nao a alcanca: nao ha como
-- saber quais linhas sao de quem.
--
-- Nao e vazamento (a tabela nao tem politica de leitura nenhuma; so a
-- `service_role` a le), mas e retencao sem prazo de dado pessoal, que a LGPD
-- nao admite. E o dado que a exclusao de conta menos consegue alcancar,
-- justamente por nao ter dono.
--
-- O CONSERTO PODA, NAO APAGA. A LINHA FICA PARA SEMPRE, e isso e deliberado:
-- `event_id` e o `unique` que faz a idempotencia funcionar. Apagar a linha
-- devolveria a porta que a Fase 8 fechou — uma reentrega da Stripe de um
-- evento antigo voltaria a ter efeito, porque o `unique` nao teria mais com o
-- que colidir. O que sai e o `payload`; o que fica e a chave.
--
-- 90 dias: a Stripe reentrega por ate ~3 dias, e a Meta nao reentrega. O
-- excedente e para o `payload` ainda estar la quando alguem for investigar um
-- problema de cobranca do mes passado.

create or replace function public.expire_webhook_events(
  p_dias integer default 90
) returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_quantos integer;
begin
  update public.webhook_events
     set payload = jsonb_build_object(
           'podado_em', now(),
           -- O tipo do evento fica: sem ele a linha nao responde mais nem
           -- "que evento era este?", e a poda passaria de retencao para
           -- amnesia.
           'tipo', payload ->> 'type'
         )
   where received_at < now() - make_interval(days => greatest(1, coalesce(p_dias, 90)))
     and payload <> '{}'::jsonb
     and not (payload ? 'podado_em');

  get diagnostics v_quantos = row_count;
  return v_quantos;
end;
$fn$;

comment on function public.expire_webhook_events(integer) is
  'Poda o payload de webhooks antigos. A LINHA e o event_id ficam: sao a '
  'idempotencia. Chamada pelo cron diario.';

-- ---------------------------------------------------------------------------
-- Faxina unica: as linhas que JA estavam orfas quando esta migration chegou
-- ---------------------------------------------------------------------------
-- O `purge_account` acima resolve daqui para a frente. O que ele nao alcanca e
-- o passado: toda conta apagada antes desta migration — pelo painel do
-- Supabase, pela admin API, por um teste de fase — deixou em `audit_log`
-- exatamente o resto que o cabecalho deste arquivo descreve. O `on delete set
-- null` zerou o `user_id` e manteve `ip`, `target` e `meta`.
--
-- NAO E TEORIA: no projeto de desenvolvimento, ao escrever esta migration,
-- havia 12 linhas com endereco IP e `user_id` nulo, sobras de usuarios de
-- teste das fases anteriores. Em producao seriam IPs de clientes reais que
-- pediram exclusao.
--
-- A UNICA EXCECAO e `account.deleted`. Nela o `user_id` nulo nao e cicatriz de
-- exclusao: e como a linha NASCE, de proposito. O `target` dela e o codigo de
-- confirmacao (o que a pessoa consulta em `/exclusao-de-dados`) e a `meta` e a
-- contagem do que foi apagado — a evidencia de que a exclusao aconteceu, sem
-- nada que identifique ninguem. Apagar isso seria destruir a prova de que os
-- dados foram destruidos.
--
-- Idempotente: rodar de novo nao muda mais nada.

update public.audit_log
   set ip = null, target = null, meta = '{}'::jsonb
 where user_id is null
   and action <> 'account.deleted'
   and (ip is not null or target is not null or meta <> '{}'::jsonb);

-- ===========================================================================
-- Privilegios: tudo aqui e do servidor
-- ===========================================================================
-- Nenhuma destas funcoes pode ser chamada pelo navegador, nem mesmo a
-- exportacao: `security definer` atravessa a RLS, e o `p_user_id` vem por
-- parametro. Concedida a `authenticated`, bastaria trocar o UUID na chamada
-- para exportar — ou apagar — a conta de outra pessoa. Quem preenche esse
-- parametro e o servidor, com o id da sessao ja validada.

revoke all on function public.export_account_data(uuid)            from public, anon, authenticated;
revoke all on function public.ig_account_tokens(uuid)              from public, anon, authenticated;
revoke all on function public.open_account_deletion(uuid, text, inet) from public, anon, authenticated;
revoke all on function public.purge_account(uuid, text)            from public, anon, authenticated;
revoke all on function public.fail_account_deletion(text, text)    from public, anon, authenticated;
revoke all on function public.expire_webhook_events(integer)       from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sobras de privilegio que o lint da Fase 10 encontrou
-- ---------------------------------------------------------------------------
-- No Postgres, uma funcao criada sem `revoke` nasce com EXECUTE para PUBLIC.
-- Todas as funcoes das fases anteriores tiveram esse `revoke` escrito a mao —
-- menos tres, e por motivos diferentes:
--
--   handle_new_user / rls_auto_enable  sao gatilhos. Ninguem revogou porque
--     "gatilho nao se chama a mao" — e e verdade, o Postgres recusa uma chamada
--     direta a funcao que devolve `trigger` ou `event_trigger`. Ou seja, nao ha
--     exploracao aqui; ha uma linha a menos de defesa e um item no lint, e as
--     duas custam um `revoke` para sumir.
--
--   assinatura_ativa  foi concedida a `authenticated` de proposito (a politica
--     de insert de `schedules` a chama), mas o EXECUTE para PUBLIC que veio de
--     brinde nunca foi tirado. O grant explicito a `authenticated` continua de
--     pe; o que sai e o acesso de `anon`, que nao tem o que fazer com ela.
--
-- Nenhum dos tres e vulnerabilidade. Os tres sao o tipo de folga que vira uma
-- quando a funcao ao lado muda e alguem copia o padrao errado.

revoke execute on function public.handle_new_user()  from public;
revoke execute on function public.rls_auto_enable()  from public;
revoke execute on function public.assinatura_ativa() from public;
grant  execute on function public.assinatura_ativa() to authenticated, service_role;

grant execute on function public.export_account_data(uuid)            to service_role;
grant execute on function public.ig_account_tokens(uuid)              to service_role;
grant execute on function public.open_account_deletion(uuid, text, inet) to service_role;
grant execute on function public.purge_account(uuid, text)            to service_role;
grant execute on function public.fail_account_deletion(text, text)    to service_role;
grant execute on function public.expire_webhook_events(integer)       to service_role;

commit;
