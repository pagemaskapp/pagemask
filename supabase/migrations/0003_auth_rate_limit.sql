-- PageMask · 0003_auth_rate_limit
-- Rate limit por IP nas rotas de autenticação (docs/PLANO.md, Segurança §1).
--
-- Por que uma tabela e não o Upstash: a fila de jobs já é uma tabela Postgres
-- com `FOR UPDATE SKIP LOCKED`, e o plano decidiu não ter Redis. Uma peça a
-- menos para pagar, monitorar e ver cair.
--
-- Por que uma função e não SELECT + UPDATE na aplicação: contar tentativa é
-- ler-e-escrever, e duas requisições simultâneas do mesmo IP leriam o mesmo
-- valor e gravariam o mesmo `hits + 1`. O upsert abaixo é uma instrução só,
-- então o Postgres serializa por linha e a corrida deixa de existir.

begin;

create table public.auth_rate_limit (
  bucket             text        primary key,
  hits               integer     not null default 0 check (hits >= 0),
  janela_iniciada_em timestamptz not null default now()
);

comment on table public.auth_rate_limit is
  'Contador de tentativas por IP e rota. `bucket` é "<rota>:<ip>". '
  'Escrito só pelo servidor, com a chave service_role.';

-- Para a limpeza periódica (cron da Fase 10) não varrer a tabela inteira.
create index auth_rate_limit_janela_idx
  on public.auth_rate_limit (janela_iniciada_em);

alter table public.auth_rate_limit enable row level security;

-- RLS ligada e zero políticas: negado para anon e authenticated em todos os
-- comandos. Intencional — quem conta tentativa é o servidor, e um visitante
-- que pudesse ler ou apagar esta tabela desmontaria o próprio limite.
revoke all on public.auth_rate_limit from anon, authenticated;

-- ---------------------------------------------------------------------------
-- consume_rate_limit — registra uma tentativa e diz se ela passa
-- ---------------------------------------------------------------------------

create function public.consume_rate_limit(
  p_bucket text,
  p_limite integer,
  p_janela interval
)
returns table (permitido boolean, restantes integer, liberado_em timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agora  timestamptz := now();
  v_hits   integer;
  v_inicio timestamptz;
begin
  if p_limite < 1 then
    raise exception 'p_limite precisa ser >= 1';
  end if;

  insert into public.auth_rate_limit as r (bucket, hits, janela_iniciada_em)
  values (p_bucket, 1, v_agora)
  on conflict (bucket) do update
    set hits = case
                 when r.janela_iniciada_em + p_janela <= v_agora then 1
                 else r.hits + 1
               end,
        janela_iniciada_em = case
                 when r.janela_iniciada_em + p_janela <= v_agora then v_agora
                 else r.janela_iniciada_em
               end
  returning r.hits, r.janela_iniciada_em into v_hits, v_inicio;

  return query select
    v_hits <= p_limite,
    greatest(p_limite - v_hits, 0),
    v_inicio + p_janela;
end;
$$;

comment on function public.consume_rate_limit is
  'Conta uma tentativa no bucket e devolve se ela é permitida, quantas restam '
  'e quando a janela expira. Janela fixa: o contador zera quando a janela '
  'vence, não desliza. Simples de explicar para quem levou o bloqueio.';

revoke execute on function public.consume_rate_limit(text, integer, interval)
  from public, anon, authenticated;

-- O grant explicito importa: sem ele a funcao so e chamavel pelos privilegios
-- ambientes do projeto, que podem mudar. Se a chamada passar a dar
-- "permission denied", o limitador falha aberto — e o login fica sem limite
-- nenhum, funcionando normalmente, sem nada na tela denunciando.
grant execute on function public.consume_rate_limit(text, integer, interval)
  to service_role;

commit;
