-- PageMask · 0004_grants
-- Privilégios de tabela, concedidos explicitamente.
--
-- POR QUE ESTA MIGRATION EXISTE
--
-- A 0001 criou as tabelas, ligou RLS e escreveu uma política por comando — e
-- nada disso funcionou contra o Supabase de verdade. Toda consulta de usuário
-- autenticado voltava `42501 permission denied for table …`, inclusive em
-- `plans`, que é leitura pública.
--
-- A causa: **RLS não concede nada.** Ela só filtra linhas de quem já tem o
-- privilégio de tabela. E o Supabase mudou o padrão dele: tabela nova criada em
-- `public` pelo papel `postgres` não recebe mais `SELECT/INSERT/UPDATE/DELETE`
-- para `anon`, `authenticated` nem `service_role` — só `TRUNCATE`,
-- `REFERENCES`, `TRIGGER` e `MAINTAIN` (verificado em `pg_default_acl` no
-- projeto: existe uma entrada `Dxtm` para o schema `public` que vence a antiga
-- `arwdDxtm`).
--
-- O `service_role` estava igualmente sem DML nenhum, ou seja, o cliente admin
-- (webhook, cron, worker) também não teria funcionado — a Fase 2 inteira
-- quebraria.
--
-- A lição, que vale para toda tabela nova daqui em diante: **política de RLS
-- sem GRANT correspondente é uma porta trancada num vão sem porta.** Escreva as
-- duas, sempre, no mesmo arquivo.
--
-- Nota sobre as colunas: onde a 0001 concedeu privilégio POR COLUNA
-- (`ig_accounts.SELECT`, `jobs.INSERT`, `assets.INSERT`, `schedules.INSERT` e
-- `UPDATE`, `profiles.UPDATE`, `data_requests.INSERT`), aqui **não** se concede
-- o mesmo privilégio no nível da tabela: isso apagaria a restrição e devolveria
-- ao cliente as colunas de token e os campos que só o worker escreve.

begin;

-- ---------------------------------------------------------------------------
-- service_role — o papel do servidor. Ignora RLS; precisa de DML completo.
-- ---------------------------------------------------------------------------

grant all on all tables in schema public to service_role;

-- Toda tabela criada daqui em diante **por este papel** já nasce acessível ao
-- servidor. O alcance é esse mesmo, e é preciso saber disso: sem `for role`, o
-- `alter default privileges` vale só para o papel que executa o comando — quem
-- roda as migrations. Tabela criada por outro papel (pelo painel do Supabase,
-- por exemplo) nasce sem privilégio nenhum e reproduz o `42501` silencioso que
-- esta migration existe para consertar.
--
-- Não está errado, está combinado: neste projeto schema só muda por arquivo em
-- `supabase/migrations/`, nunca pelo painel (CLAUDE.md, "Convenções"). Se um dia
-- essa regra mudar, esta linha precisa mudar junto.
alter default privileges in schema public
  grant all on tables to service_role;

-- ---------------------------------------------------------------------------
-- anon — só o catálogo de planos, que é público por decisão de produto.
-- ---------------------------------------------------------------------------

grant select on public.plans to anon;

-- ---------------------------------------------------------------------------
-- authenticated — exatamente o que as políticas da 0001 permitem
-- ---------------------------------------------------------------------------

-- Catálogo: leitura.
grant select on public.plans to authenticated;

-- Perfil: lê o próprio. O UPDATE continua restrito à coluna `name` (0001).
grant select on public.profiles to authenticated;

-- Assinatura: lê a própria. Escrita é do webhook da Stripe.
grant select on public.subscriptions to authenticated;

-- Templates e projetos: o dono manda por inteiro.
grant select, insert, update, delete on public.templates to authenticated;
grant select, insert, update, delete on public.projects to authenticated;

-- Assets: lê e apaga os próprios. O INSERT segue restrito às colunas da 0001.
grant select, delete on public.assets to authenticated;

-- Jobs: lê e cancela os próprios. O INSERT segue restrito às colunas da 0001,
-- e não há UPDATE nenhum — quem move o status é o worker.
grant select, delete on public.jobs to authenticated;

-- Contas do Instagram: desconectar. **Sem `grant select` de tabela aqui** — a
-- 0001 concedeu SELECT só nas 10 colunas que não são token, e um grant de
-- tabela desfaria justamente essa proteção.
grant delete on public.ig_accounts to authenticated;

-- Agendamentos: lê e cancela. INSERT e UPDATE seguem restritos às colunas.
grant select, delete on public.schedules to authenticated;

-- Auditoria: lê a própria. Escrita é sempre do servidor.
grant select on public.audit_log to authenticated;

-- Solicitações de LGPD: lê as próprias. INSERT restrito às colunas da 0001.
grant select on public.data_requests to authenticated;

-- `webhook_events` e `auth_rate_limit` continuam sem nada para anon e
-- authenticated. É a intenção: são tabelas de sistema.

commit;
