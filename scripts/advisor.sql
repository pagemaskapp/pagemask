-- Os lints do Security Advisor do Supabase, rodados direto no banco.
--
-- O painel expõe isso numa tela; a Management API que a serve pede um personal
-- access token que não está nesta máquina. As consultas abaixo são as mesmas
-- verificações, escritas à mão — e têm a vantagem de caber no repositório e de
-- poderem ser repetidas a cada fase sem abrir navegador.

select '1. tabelas de public SEM rls' as lint,
       coalesce(string_agg(tablename, ', '), '(nenhuma)') as achado
  from pg_tables
 where schemaname = 'public' and rowsecurity = false

union all
select '2. tabelas COM politica e SEM rls',
       coalesce(string_agg(distinct c.relname, ', '), '(nenhuma)')
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relrowsecurity = false

union all
select '3. views SECURITY DEFINER em public',
       coalesce(string_agg(c.relname, ', '), '(nenhuma)')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v', 'm')
   and exists (
     select 1 from pg_rewrite r
      where r.ev_class = c.oid
        and pg_get_viewdef(c.oid) ilike '%security_definer%'
   )

union all
select '4. funcoes SECURITY DEFINER com search_path MUTAVEL',
       coalesce(string_agg(p.proname, ', '), '(nenhuma)')
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and not exists (
     select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
      where cfg like 'search_path=%'
   )

union all
select '5. tabelas/views de public que expoem auth.users',
       coalesce(string_agg(c.relname, ', '), '(nenhuma)')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v', 'm')
   and pg_get_viewdef(c.oid) ilike '%auth.users%'

union all
select '6. extensoes instaladas no schema public',
       coalesce(string_agg(e.extname, ', '), '(nenhuma)')
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
 where n.nspname = 'public'

union all
select '7. politicas que dao acesso a anon (fora de plans)',
       coalesce(string_agg(c.relname || '.' || p.polname, ', '), '(nenhuma)')
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname <> 'plans'
   and exists (
     select 1 from unnest(p.polroles) as r
      where r::regrole::text in ('anon', 'public')
   )

union all
select '8. funcoes de public executaveis por anon/authenticated',
       coalesce(string_agg(distinct p.proname, ', '), '(nenhuma)')
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and (has_function_privilege('anon', p.oid, 'execute')
     or has_function_privilege('authenticated', p.oid, 'execute'))

union all
select '9. colunas de token legiveis por authenticated',
       coalesce(string_agg(a.attname, ', '), '(nenhuma)')
  from pg_attribute a
 where a.attrelid = 'public.ig_accounts'::regclass
   and a.attname in ('token_cipher', 'token_iv', 'token_tag')
   and has_column_privilege('authenticated', a.attrelid, a.attname, 'select')

order by 1;
