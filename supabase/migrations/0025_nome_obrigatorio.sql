-- ===========================================================================
-- 0025 — profiles.name passa a ser obrigatorio
--
-- O campo "Nome" era opcional no cadastro e a coluna aceitava nulo. O
-- resultado aparecia na tela de Conta como um traco no lugar do nome, e em
-- todo lugar que precisasse tratar a pessoa pelo nome sobrava um `?? ""`.
--
-- Ordem obrigatoria, e cada passo depende do anterior:
--
--   1. a funcao do gatilho ganha um nome de reserva — se ela continuasse
--      podendo inserir nulo, o `set not null` do passo 3 viraria uma bomba-
--      relogio: o proximo cadastro sem nome quebraria o `signUp` INTEIRO, com
--      a linha de `auth.users` ja criada e nenhum perfil do lado de ca;
--   2. as linhas antigas sao preenchidas;
--   3. so entao a coluna recusa nulo.
--
-- Idempotente de ponta a ponta: roda duas vezes sem erro.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. O gatilho nunca mais insere nulo
-- ---------------------------------------------------------------------------
--
-- A reserva e a parte local do e-mail, capitalizada. Nao e um bom nome — e uma
-- etiqueta plausivel que a pessoa troca na tela de Conta, e que mantem o
-- cadastro funcionando quando o nome nao chega pelo formulario: usuario criado
-- pelo painel do Supabase, pela admin API, ou por um cliente que chame
-- `signUp` direto sem `data.name`. Nenhum desses caminhos passa pelo zod do
-- app, e a coluna nao pode ficar refem deles.
--
-- `security definer` com `search_path` vazio continua valendo, entao toda FUNCAO
-- aqui e qualificada com o schema — `public.profiles`, `pg_catalog.split_part`.
--
-- `coalesce` e `nullif` ficam SEM qualificacao, e isso nao e esquecimento:
-- os dois nao sao funcao, sao construcao do parser SQL (o `nullif` vira um
-- `CASE`). Nao existe `pg_catalog.nullif`, e escrever assim derruba a funcao
-- inteira — medido no aceite, com `createUser` da admin API devolvendo
-- "Database error creating new user" e nenhuma conta criada. Sem search_path
-- eles continuam valendo, porque nao passam por resolucao de nome.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nome text;
begin
  v_nome := nullif(
    pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'name', '')),
    ''
  );

  -- Reserva: parte local do e-mail com a inicial maiuscula. `left(…, 120)`
  -- porque a coluna tem limite e um e-mail pode ser mais longo que isso.
  if v_nome is null then
    v_nome := pg_catalog.initcap(
      pg_catalog.split_part(coalesce(new.email, ''), '@', 1)
    );
  end if;

  -- O corte em 120 vem ANTES do guarda de tamanho minimo, e a ordem importa:
  -- e o valor JA CORTADO que vai ser medido pela restricao `between 2 and 120`.
  -- Cortando depois, um nome como 'A' + 200 espacos + 'B' passava no guarda
  -- (tem 202 caracteres), virava 'A' + 119 espacos no insert, e o `btrim` da
  -- restricao media 1 — a funcao levantava excecao e derrubava a criacao do
  -- usuario inteira. Exatamente a bomba-relogio que o cabecalho deste arquivo
  -- existe para desarmar, so que pela outra ponta.
  v_nome := pg_catalog.left(v_nome, 120);

  -- Ultimo recurso: cadastro sem e-mail nenhum (provedor externo, admin API)
  -- — e tambem o e-mail de uma letra so (`a@exemplo.com`), que daria um nome de
  -- 1 caractere e reprovaria na restricao. Preferir uma etiqueta generica a
  -- perder a conta.
  if pg_catalog.length(pg_catalog.btrim(coalesce(v_nome, ''))) < 2 then
    v_nome := 'Usuario';
  end if;

  insert into public.profiles (id, name)
  values (new.id, v_nome)
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is
  'Cria a linha de `profiles` no cadastro. `security definer` com search_path '
  'vazio: a funcao roda com privilegio do dono e nao pode ser sequestrada por '
  'um schema no caminho de busca. Desde a 0025 o nome nunca e nulo — sem nome '
  'no metadado, cai na parte local do e-mail.';

-- ---------------------------------------------------------------------------
-- 2. Backfill das linhas que ja existem
-- ---------------------------------------------------------------------------
--
-- Mesma regra do gatilho, para as contas criadas antes desta migration.
-- `btrim(...) = ''` junto do `is null` porque nome so de espacos passa pelo
-- `not null` e continua nao sendo nome.

update public.profiles as p
   -- Mesma ordem do gatilho: corta em 120 primeiro, mede depois.
   set name = case
                when length(btrim(left(initcap(split_part(coalesce(u.email, ''), '@', 1)), 120))) >= 2
                  then left(initcap(split_part(u.email, '@', 1)), 120)
                else 'Usuario'
              end
  from auth.users as u
 where u.id = p.id
   and (p.name is null or length(btrim(p.name)) < 2);

-- Cinto e suspensorio: perfil orfao, sem linha correspondente em `auth.users`,
-- nao seria alcancado pelo `update` acima (o `from` e um join interno) e
-- derrubaria o `set not null` logo abaixo.
update public.profiles
   set name = 'Usuario'
 where name is null or length(btrim(name)) < 2;

-- ---------------------------------------------------------------------------
-- 3. A coluna recusa nulo
-- ---------------------------------------------------------------------------

alter table public.profiles
  alter column name set not null;

-- O `not null` sozinho aceita string vazia e aceita 300 caracteres. A restricao
-- fecha os dois: o mesmo intervalo que o zod do formulario aplica (2 a 120
-- depois do `trim`).
--
-- `not valid` + `validate constraint` em vez de um `add constraint` direto:
-- assim a checagem das linhas existentes acontece sem AccessExclusiveLock
-- prolongado na tabela. Com o backfill acima, nenhuma linha reprova.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'profiles_name_tamanho'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_name_tamanho
      check (length(btrim(name)) between 2 and 120) not valid;

    alter table public.profiles
      validate constraint profiles_name_tamanho;
  end if;
end;
$$;

comment on column public.profiles.name is
  'Nome de exibicao. Obrigatorio desde a 0025: o formulario de cadastro exige, '
  'e o gatilho `handle_new_user` cai na parte local do e-mail quando o nome nao '
  'vem no metadado. O `grant update (name)` da 0001 segue de pe — o dono edita '
  'o proprio nome, e a restricao `profiles_name_tamanho` impede que ele o apague.';
