-- PageMask · 0018_conectores_do_instagram
--
-- A Fase 4 conecta contas do Instagram pelo Business Login. O token que volta
-- de la e o segredo mais sensivel que o produto guarda: com ele se publica no
-- perfil do cliente. Tudo neste arquivo existe para que ele nunca saia do
-- servidor.
--
-- TRES PECAS
-- ==========
--
--   1. `ig_oauth_states` — o nonce do `state`, de uso unico. O `state` em si e
--      um HMAC sem estado (10 min, PLANO Fase 4), o que ja barra forjar. Nao
--      barra REPETIR: quem interceptar um callback inteiro pode reenvia-lo. A
--      linha aqui e o que torna a segunda tentativa inofensiva.
--
--   2. `connect_ig_account` — grava a conta com o token cifrado e cobra o
--      limite do plano NA MESMA TRANSACAO. Contar no app e inserir depois abre
--      uma janela para duas abas passarem juntas pela contagem.
--
--   3. `ig_accounts_para_renovar` / `refresh_ig_token` — o par que o cron usa.
--      Existem como funcao, e nao como consulta direta, por um motivo de tipo:
--      `ig_accounts.Row` em `database.types.ts` NAO tem as colunas de token, de
--      proposito. Uma consulta direta obrigaria a mentir nesse tipo. Aqui o
--      token aparece so no retorno de uma funcao concedida apenas a
--      `service_role` — o contrato do cliente segue honesto.
--
-- BYTEA EM TEXTO
-- ==============
--
-- As funcoes recebem e devolvem o token cifrado como HEX (`text`), nao como
-- `bytea`. Pelo PostgREST um `bytea` trafega como string `\x…` e depende do
-- `bytea_output` do servidor e do cast implicito do driver. Hex explicito com
-- `decode(…, 'hex')` / `encode(…, 'hex')` nao depende de nenhum dos dois.
--
-- `search_path = ''` em todas: funcao `security definer` sem isso aceita que o
-- chamador troque o significado de `jobs` ou `plans` por uma tabela dele.
--
-- Codigos de erro desta migration:
--   PM018  limite de contas do plano atingido
--   PM019  conta inexistente ou de outro usuario
--   PM020  perfil sem plano correspondente em `plans`

begin;

-- ---------------------------------------------------------------------------
-- ig_oauth_states — o nonce do `state`, queimado no primeiro uso
-- ---------------------------------------------------------------------------

create table public.ig_oauth_states (
  nonce      text        primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

comment on table public.ig_oauth_states is
  'Nonce de uso unico do `state` do OAuth. RLS ligada e zero politicas: so a '
  'chave secreta escreve e le. O cliente nunca toca nesta tabela.';

create index ig_oauth_states_expurgo_idx on public.ig_oauth_states (created_at);

alter table public.ig_oauth_states enable row level security;

-- O Supabase concede TRUNCATE, REFERENCES e TRIGGER a `anon` e `authenticated`
-- em toda tabela nova de `public`, por ACL padrao. RLS nao cobre TRUNCATE: ele
-- e privilegio de tabela, e uma tabela truncada nao dispara politica nenhuma.
-- Hoje isso nao e alcancavel — o PostgREST nao emite TRUNCATE — mas nao ha
-- razao para deixar de pe numa tabela que so a chave secreta usa.
revoke all on public.ig_oauth_states from anon, authenticated;

-- ---------------------------------------------------------------------------
-- start_ig_connect — abre um nonce e ja limpa os vencidos
-- ---------------------------------------------------------------------------

create or replace function public.start_ig_connect(
  p_user_id uuid,
  p_nonce   text
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- O expurgo mora aqui porque este e o unico ponto que insere: sem ele a
  -- tabela cresceria para sempre com nonce que ninguem vai usar. Uma hora e
  -- folgado para uma validade de 10 minutos.
  delete from public.ig_oauth_states
   where created_at < now() - interval '1 hour';

  insert into public.ig_oauth_states (nonce, user_id)
  values (p_nonce, p_user_id);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- consume_ig_state — queima o nonce. Devolve falso se ja foi usado ou venceu.
-- ---------------------------------------------------------------------------

create or replace function public.consume_ig_state(
  p_nonce   text,
  p_user_id uuid,
  p_minutos integer default 10
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_linhas integer;
begin
  -- `used_at is null` no WHERE e o que torna isto atomico: dois callbacks
  -- simultaneos com o mesmo nonce disputam a mesma linha e so um atualiza.
  -- Conferir antes e gravar depois teria uma janela entre as duas coisas.
  update public.ig_oauth_states
     set used_at = now()
   where nonce = p_nonce
     and user_id = p_user_id
     and used_at is null
     and created_at > now() - make_interval(mins => p_minutos);

  get diagnostics v_linhas = row_count;
  return v_linhas = 1;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- connect_ig_account — grava a conta e cobra o limite do plano na mesma transacao
-- ---------------------------------------------------------------------------

create or replace function public.connect_ig_account(
  p_user_id     uuid,
  p_ig_user_id  text,
  p_username    text,
  p_picture     text,
  p_scopes      text[],
  p_cipher_hex  text,
  p_iv_hex      text,
  p_tag_hex     text,
  p_expires_at  timestamptz,
  p_key_version smallint default 1
) returns public.ig_accounts
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_limite integer;
  v_usadas integer;
  v_conta  public.ig_accounts;
begin
  -- Serializa as conexoes DESTE usuario. Sem a trava, duas abas clicando em
  -- Conectar ao mesmo tempo contam "2 de 3" as duas e gravam a quarta conta.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select p.ig_accounts into v_limite
    from public.profiles as f
    join public.plans    as p on p.slug = f.plan_slug
   where f.id = p_user_id;

  if v_limite is null then
    raise exception 'perfil sem plano correspondente' using errcode = 'PM020';
  end if;

  -- Reconectar uma conta que ja existe nao consome vaga nova: por isso a
  -- propria conta fica de fora da contagem. `revoked` tambem nao conta — ela e
  -- historico, nao ocupa lugar.
  select count(*) into v_usadas
    from public.ig_accounts as a
   where a.user_id = p_user_id
     and a.status <> 'revoked'
     and a.ig_user_id <> p_ig_user_id;

  if v_usadas >= v_limite then
    raise exception 'limite de contas do plano atingido' using errcode = 'PM018';
  end if;

  insert into public.ig_accounts as a (
    user_id, ig_user_id, username, profile_picture_url, scopes,
    token_cipher, token_iv, token_tag, key_version,
    token_expires_at, last_refreshed_at, status, connected_at
  )
  values (
    p_user_id, p_ig_user_id, p_username, p_picture, coalesce(p_scopes, '{}'),
    decode(p_cipher_hex, 'hex'), decode(p_iv_hex, 'hex'), decode(p_tag_hex, 'hex'),
    p_key_version, p_expires_at, now(), 'active', now()
  )
  on conflict (user_id, ig_user_id) do update set
    username            = excluded.username,
    profile_picture_url = excluded.profile_picture_url,
    scopes              = excluded.scopes,
    token_cipher        = excluded.token_cipher,
    token_iv            = excluded.token_iv,
    token_tag           = excluded.token_tag,
    key_version         = excluded.key_version,
    token_expires_at    = excluded.token_expires_at,
    last_refreshed_at   = now(),
    status              = 'active',
    -- Reconectar e uma autorizacao NOVA, com token novo e 60 dias novos.
    -- "Conectada ha N dias" na tela conta a partir dela, e nao da primeira vez
    -- que aquele @ apareceu aqui.
    connected_at        = now()
  returning a.* into v_conta;

  return v_conta;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- disconnect_ig_account — apaga o token e marca 'revoked'
-- ---------------------------------------------------------------------------
-- O cliente tem `delete` nesta tabela (0004_grants), mas apagar a linha perde o
-- registro de que aquela conta existiu — e a `audit_log` aponta para um id que
-- nao existe mais. Marcar e apagar o token faz as duas coisas: o segredo some e
-- o historico fica.

create or replace function public.disconnect_ig_account(
  p_user_id    uuid,
  p_account_id uuid
) returns public.ig_accounts
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_conta public.ig_accounts;
begin
  update public.ig_accounts as a
     set status            = 'revoked',
         token_cipher      = null,
         token_iv          = null,
         token_tag         = null,
         token_expires_at  = null,
         last_refreshed_at = now()
   where a.id = p_account_id
     and a.user_id = p_user_id
  returning a.* into v_conta;

  if not found then
    raise exception 'conta inexistente ou de outro usuario' using errcode = 'PM019';
  end if;

  return v_conta;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- ig_accounts_para_renovar — a lista do cron, com o token cifrado
-- ---------------------------------------------------------------------------

create or replace function public.ig_accounts_para_renovar(
  p_dias integer default 10,
  p_max  integer default 200
) returns table (
  id          uuid,
  user_id     uuid,
  ig_user_id  text,
  username    text,
  cipher_hex  text,
  iv_hex      text,
  tag_hex     text,
  key_version smallint,
  expires_at  timestamptz
)
language sql
security definer
set search_path = ''
as $fn$
  select a.id,
         a.user_id,
         a.ig_user_id,
         a.username,
         encode(a.token_cipher, 'hex'),
         encode(a.token_iv,     'hex'),
         encode(a.token_tag,    'hex'),
         a.key_version,
         a.token_expires_at
    from public.ig_accounts as a
   -- `needs_reconnect` CONTINUA na lista, e isso e o ponto.
   --
   -- Filtrar so por `active` parecia obvio e criava um beco sem saida: uma
   -- oscilacao de rede marcava a conta, e a marca a tirava da lista para
   -- sempre. Um token com 10 dias de validade restante e uma falha de 30
   -- segundos bastavam para a renovacao automatica nunca mais acontecer
   -- naquela conta — ela so voltaria se o cliente reconectasse na mao.
   --
   -- Com `needs_reconnect` aqui, o cron tenta de novo todo dia enquanto o
   -- token existir. Quem de fato precisa de reconexao continua marcado (a
   -- tentativa falha de novo e nao muda nada); quem foi marcado por engano se
   -- cura sozinho na proxima execucao.
   where a.status in ('active', 'needs_reconnect')
     and a.token_cipher is not null
     and a.token_expires_at is not null
     and a.token_expires_at < now() + make_interval(days => p_dias)
   order by a.token_expires_at
   limit p_max;
$fn$;

-- ---------------------------------------------------------------------------
-- refresh_ig_token — grava o token renovado
-- ---------------------------------------------------------------------------

create or replace function public.refresh_ig_token(
  p_account_id  uuid,
  p_cipher_hex  text,
  p_iv_hex      text,
  p_tag_hex     text,
  p_expires_at  timestamptz,
  p_key_version smallint default 1
) returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.ig_accounts
     set token_cipher      = decode(p_cipher_hex, 'hex'),
         token_iv          = decode(p_iv_hex, 'hex'),
         token_tag         = decode(p_tag_hex, 'hex'),
         key_version       = p_key_version,
         token_expires_at  = p_expires_at,
         last_refreshed_at = now(),
         status            = 'active'
   where id = p_account_id;
$fn$;

-- ---------------------------------------------------------------------------
-- mark_ig_needs_reconnect — a renovacao falhou; o usuario precisa reautorizar
-- ---------------------------------------------------------------------------
-- O token NAO e apagado aqui. Ele pode continuar valido por alguns dias, e
-- apagar tiraria a chance de uma renovacao no dia seguinte dar certo. Quem
-- apaga e `disconnect_ig_account`.
--
-- DEVOLVE SE FOI ESTA CHAMADA QUE MARCOU
-- ======================================
-- O `and status = 'active'` faz o update valer so na TRANSICAO. Devolver isso
-- a quem chamou e o que separa "avise o cliente" de "ja avisamos ontem": sem
-- essa resposta, o cron mandaria o mesmo e-mail de "reconecte sua conta" todo
-- dia, para sempre, ate alguem reconectar. Um aviso repetido todo dia e um
-- aviso que o cliente aprende a ignorar.

create or replace function public.mark_ig_needs_reconnect(
  p_account_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_linhas integer;
begin
  update public.ig_accounts
     set status = 'needs_reconnect'
   where id = p_account_id
     and status = 'active';

  get diagnostics v_linhas = row_count;
  return v_linhas = 1;
end;
$fn$;

-- ===========================================================================
-- Privilegios
-- ===========================================================================
-- Toda funcao concedida a `authenticated` vira endpoint publico do PostgREST.
-- Nenhuma destas pode ser: `connect_ig_account` grava token cifrado e
-- `ig_accounts_para_renovar` DEVOLVE token cifrado. Elas sao do servidor.

revoke all on function public.start_ig_connect(uuid, text)
  from public, anon, authenticated;
revoke all on function public.consume_ig_state(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.connect_ig_account(
  uuid, text, text, text, text[], text, text, text, timestamptz, smallint)
  from public, anon, authenticated;
revoke all on function public.disconnect_ig_account(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.ig_accounts_para_renovar(integer, integer)
  from public, anon, authenticated;
revoke all on function public.refresh_ig_token(
  uuid, text, text, text, timestamptz, smallint)
  from public, anon, authenticated;
revoke all on function public.mark_ig_needs_reconnect(uuid)
  from public, anon, authenticated;

grant execute on function public.start_ig_connect(uuid, text) to service_role;
grant execute on function public.consume_ig_state(text, uuid, integer) to service_role;
grant execute on function public.connect_ig_account(
  uuid, text, text, text, text[], text, text, text, timestamptz, smallint)
  to service_role;
grant execute on function public.disconnect_ig_account(uuid, uuid) to service_role;
grant execute on function public.ig_accounts_para_renovar(integer, integer)
  to service_role;
grant execute on function public.refresh_ig_token(
  uuid, text, text, text, timestamptz, smallint) to service_role;
grant execute on function public.mark_ig_needs_reconnect(uuid) to service_role;

commit;
