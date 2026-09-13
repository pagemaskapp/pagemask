#!/usr/bin/env bash
#
# Restaura um dump de `backup-diario.sh` num Postgres DESCARTAVEL e confere que
# o que voltou bate com o que saiu.
#
#   scripts/restaurar-teste.sh backups/pagemask-2026-09-12-2315.dump
#
# POR QUE ISTO EXISTE COMO SCRIPT, E NAO COMO PARAGRAFO NO RUNBOOK
# ================================================================
#
# Um backup que nunca foi restaurado nao e um backup — e um arquivo com nome de
# backup. O checklist §9 pede "backups restaurados uma vez em ambiente de
# teste", e "uma vez" so vale enquanto o schema for o daquele dia: toda
# migration nova pode quebrar o restore (uma extensao que o destino nao tem, um
# tipo que depende de outro schema, uma funcao `security definer` que aponta
# para um papel inexistente). Sendo um script, o teste e repetivel e barato.
#
# O DESTINO NAO E O SUPABASE. E um conteiner `postgres:17-alpine` local, criado
# e destruido nesta execucao. Restaurar por cima do banco de producao para
# "testar o backup" e como testar o extintor ateando fogo na sala.
#
# OS PAPEIS PRECISAM EXISTIR ANTES. O dump de `public` carrega politicas de RLS
# que citam `anon`, `authenticated` e `service_role`. Num Postgres limpo esses
# papeis nao existem e o restore acusa erro em cada politica — erro que parece
# corrupcao do dump e nao e. Por isso eles sao criados antes.

set -euo pipefail

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "uso: scripts/restaurar-teste.sh <arquivo.dump>" >&2
  exit 2
fi

DUMP_ABS="$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")"
NOME="pagemask-restore-teste"
SENHA="restore-de-teste"

limpar() {
  docker rm -f "$NOME" >/dev/null 2>&1 || true
}
trap limpar EXIT

limpar
echo "== subindo Postgres 17 descartavel =="
MSYS_NO_PATHCONV=1 docker run -d --name "$NOME" \
  -e POSTGRES_PASSWORD="$SENHA" \
  -e POSTGRES_DB=pagemask \
  postgres:17-alpine >/dev/null

# Espera com TRES respostas seguidas, e nao com uma.
#
# A imagem oficial sobe um Postgres TEMPORARIO para rodar a inicializacao, o
# derruba e sobe o definitivo. Um `pg_isready` sozinho pega o temporario,
# responde "pronto", e a chamada seguinte cai no intervalo entre os dois — foi
# exatamente o que aconteceu aqui: "pronto em 2s" seguido de "no response".
# `sleep` fixo tem o mesmo defeito, so que mais lento.
#
# Tres respostas seguidas de uma CONSULTA de verdade (e nao do `pg_isready`,
# que so pergunta pelo socket) atravessam essa janela.
SEGUIDAS=0
for _ in $(seq 1 90); do
  if docker exec "$NOME" psql -U postgres -d pagemask -tAc 'select 1' >/dev/null 2>&1; then
    SEGUIDAS=$((SEGUIDAS + 1))
    [ "$SEGUIDAS" -ge 3 ] && break
  else
    SEGUIDAS=0
  fi
  sleep 1
done

if [ "$SEGUIDAS" -lt 3 ]; then
  echo "erro: o Postgres de teste nao subiu" >&2
  docker logs "$NOME" 2>&1 | tail -20 >&2
  exit 1
fi
echo "Postgres de teste no ar."

echo
echo "== preparando o destino (papeis, schemas e extensoes do Supabase) =="
docker exec -i "$NOME" psql -v ON_ERROR_STOP=1 -U postgres -d pagemask <<'SQL'
create role anon            nologin noinherit;
create role authenticated   nologin noinherit;
create role service_role    nologin noinherit bypassrls;
create role supabase_auth_admin login noinherit;
create schema if not exists auth authorization postgres;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
-- `auth.uid()`, `auth.role()` e `auth.email()` sao do Supabase, nao do
-- Postgres, e as politicas de RLS do dump as chamam. O dump TAMBEM as traz —
-- criar antes, mesmo assim, e deliberado: a ordem de restauracao nao garante
-- que a funcao venha antes da politica que a usa, e sem ela toda politica
-- reprova. O preco sao os ~5 erros de "ja existe" que o `pg_restore` resume no
-- fim, e que sao esperados. O corpo aqui e esqueleto: o restore precisa que
-- elas EXISTAM, nao que funcionem.
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select null::text $$;
create or replace function auth.email() returns text language sql stable as $$ select null::text $$;
SQL

echo
echo "== restaurando =="
# `--no-owner`/`--no-privileges` de novo no restore: o dump ja saiu sem eles,
# mas um dump antigo pode nao ter.
#
# O codigo de saida do `pg_restore` NAO e conferido de proposito: ele reclama
# do que ja existe (o schema `auth`, as funcoes criadas acima) e devolve != 0
# por isso. Quem decide se o restore prestou e a CONFERENCIA abaixo, que olha o
# que voltou — e nao o humor do `pg_restore`.
# O dump entra por STDIN, e nao por `docker cp`. No Git Bash do Windows o
# destino do `cp` (`conteiner:/tmp/dump`) tem o caminho reescrito para
# `C:\tmp\dump` antes de chegar ao Docker, e nem `MSYS_NO_PATHCONV=1` segura —
# a reescrita acontece no argumento que carrega `:`. Por stdin nao ha caminho
# para converter, e o `pg_restore` le dump em formato custom da entrada padrao
# sem reclamar.
# Sem `--exit-on-error`: essa opcao NAO aceita argumento (`--exit-on-error=false`
# faz o `pg_restore` recusar a linha inteira), e o padrao ja e o que se quer —
# seguir adiante e resumir os erros no fim.
docker exec -i "$NOME" pg_restore -U postgres -d pagemask \
  --no-owner --no-privileges < "$DUMP_ABS" 2>&1 \
  | grep -v "already exists" | tail -20 || true

echo
echo "== conferencia: o que voltou =="
docker exec -i "$NOME" psql -U postgres -d pagemask <<'SQL'
select 'tabelas em public' as item, count(*)::text as valor
  from pg_tables where schemaname = 'public'
union all
select 'tabelas COM rls', count(*)::text
  from pg_tables where schemaname = 'public' and rowsecurity
union all
select 'politicas de rls', count(*)::text
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
union all
-- SEM as funcoes que vieram de extensao. No Supabase, `pgcrypto` e `uuid-ossp`
-- moram no schema `extensions`; aqui elas foram criadas em `public` e
-- acrescentam ~46 funcoes que nao sao do produto. Contando-as, o numero nunca
-- bate com a origem e a conferencia perde a graca.
select 'funcoes do produto em public', count(*)::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and not exists (
     select 1 from pg_depend d
      where d.objid = p.oid and d.deptype = 'e'
   )
union all
select 'usuarios em auth.users', count(*)::text from auth.users
union all
select 'linhas em plans', count(*)::text from public.plans
union all
select 'linhas em profiles', count(*)::text from public.profiles
union all
select 'linhas em jobs', count(*)::text from public.jobs
union all
select 'linhas em audit_log', count(*)::text from public.audit_log
union all
select 'linhas em data_requests', count(*)::text from public.data_requests
union all
select 'audit_log orfao COM dado pessoal', count(*)::text
  from public.audit_log
 where user_id is null and action <> 'account.deleted'
   and (ip is not null or target is not null or meta <> '{}'::jsonb)
order by 1;
SQL

echo
echo "restore de teste concluido. O conteiner e destruido ao sair."
