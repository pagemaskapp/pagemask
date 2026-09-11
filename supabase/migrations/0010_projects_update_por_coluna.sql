-- PageMask · 0010_projects_update_por_coluna
-- O terceiro lado da mesma porta.
--
-- A 0009 tirou INSERT e DELETE de `projects` do cliente e deixou o UPDATE de
-- tabela inteira que a 0004 tinha concedido. Renomear o proprio projeto e
-- escolher o template dele sao operacoes do dono, sem passo de servidor por
-- perto — o UPDATE em si esta certo. O que estava errado era o ALCANCE dele:
--
--   PATCH /rest/v1/projects?id=eq.…  {"name": "<80 mil caracteres>"}
--       → a validacao de nome vive so na `create_project` (PM003), entao pelo
--         PATCH ela nao existe;
--   PATCH … {"created_at": "2019-01-01"}
--       → reescreve quando o projeto nasceu;
--   PATCH … {"id": "<outro uuid>"}
--       → **este e o ruim**. A chave do R2 e `{user_id}/{project_id}/{uuid}`,
--         com o id do projeto DENTRO dela. Trocar o id da linha deixa todos os
--         objetos daquele projeto apontando para um projeto que nao existe
--         mais: nenhum deles volta a casar com o formato que a
--         `register_upload_job` exige, e a remocao pela tela nunca mais colhe
--         aquelas chaves. Arquivo pago, invisivel e impossivel de apagar.
--
-- A resposta e a mesma que a 0001 ja tinha dado para `profiles`: GRANT por
-- COLUNA. RLS decide quais linhas; GRANT decide quais colunas — e sem as duas
-- coisas a politica autoriza a linha inteira, inclusive os campos que ninguem
-- deveria reescrever.
--
-- O `check` no nome entra junto porque regra que mora so na funcao e regra que
-- vale so por um caminho. No banco, ela vale por todos.

begin;

alter table public.projects
  drop constraint if exists projects_name_tamanho;

alter table public.projects
  add constraint projects_name_tamanho
  check (length(btrim(name)) between 1 and 80);

revoke update on public.projects from anon, authenticated;
grant update (name, template_id) on public.projects to authenticated;

comment on column public.projects.name is
  'Nome dado pelo usuario. 1 a 80 caracteres — a mesma regra que a '
  '`create_project` aplica, escrita tambem aqui para valer no PATCH direto.';

commit;
