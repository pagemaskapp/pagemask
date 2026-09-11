-- PageMask · 0013_discard_project_apaga_antes
-- O mesmo impasse da 0012, agora no outro par de tabelas — e, de brinde, uma
-- devolucao de credito que contava duas vezes.
--
-- A 0012 alinhou `register_upload_job` com `discard_project`, e deixou de fora
-- a terceira funcao que mexe nas mesmas linhas:
--
--   discard_job      trava a linha de `jobs`, depois mexe em `subscriptions`
--   discard_project  mexe em `subscriptions`, e so entao apaga o projeto — cujo
--                    cascata trava as MESMAS linhas de `jobs`
--
-- De novo ordem oposta, de novo `40P01`, e de novo entre dois botoes da mesma
-- tela: remover um video e apagar o projeto.
--
-- O SEGUNDO PROBLEMA, no mesmo lugar
--
-- `discard_project` CONTAVA os jobs `uploaded` numa instrucao e devolvia o
-- credito em outra. Sob READ COMMITTED, um `discard_job` que commitasse entre
-- as duas fazia o UPDATE bloqueado reavaliar sobre a linha ja decrementada — e
-- o mesmo video era devolvido duas vezes. Vazamento de cota silencioso e
-- repetivel: da para ganhar credito de graca apagando video e projeto ao mesmo
-- tempo.
--
-- A CORRECAO E UMA SO, e resolve os dois: **apagar os jobs primeiro**, e tirar
-- do proprio DELETE tanto as chaves quanto a contagem do que devolve credito.
--
--   · a ordem passa a ser `projects` → `jobs` → `subscriptions`, que e a mesma
--     ordem relativa da `discard_job` (`jobs` → `subscriptions`), entao nao ha
--     mais ciclo;
--   · a contagem deixa de ser uma leitura separada e passa a ser o que o DELETE
--     de fato removeu — nao da para devolver credito por linha que outra
--     transacao ja levou, porque ela nao aparece no `returning`.

begin;

create or replace function public.discard_project(p_user_id uuid, p_project_id uuid)
returns table (chave text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_por_apagar integer;
  v_chaves     text[];
begin
  if p_user_id is null then
    raise exception 'sem usuario' using errcode = 'PM000';
  end if;

  -- Primeira trava, igual a da `register_upload_job` depois da 0012.
  if not exists (
    select 1 from public.projects
     where id = p_project_id and user_id = p_user_id
       for update
  ) then
    raise exception 'projeto nao e do usuario' using errcode = 'PM005';
  end if;

  -- Job em fila ou rodando nao pode sumir debaixo do worker: ele esta com o
  -- arquivo aberto e escreveria o resultado numa linha que deixou de existir.
  --
  -- Nota para a Fase 3, e ela e um AVISO, nao uma garantia: esta checagem vale
  -- no instante em que roda, e o DELETE abaixo nao repete a condicao de status
  -- — ele apaga o que estiver la. Um job que virar `processing` entre as duas
  -- instrucoes some assim mesmo. Hoje isso nao acontece porque nao existe
  -- worker; quando existir, ou ele passa pela linha do projeto ao reclamar o
  -- job, ou este DELETE precisa de `and status not in ('queued','processing')`
  -- com conferencia da contagem.
  if exists (
    select 1 from public.jobs
     where project_id = p_project_id
       and status in ('queued', 'processing')
  ) then
    raise exception 'projeto com job em processamento' using errcode = 'PM010';
  end if;

  -- Segunda trava: as linhas de `jobs`, pelo proprio DELETE. As chaves e a
  -- contagem saem do `returning` — do que REALMENTE foi removido por esta
  -- transacao, nunca de uma leitura anterior.
  with apagados as (
    delete from public.jobs
     where project_id = p_project_id
    returning r2_input_key, r2_output_key, status
  )
  select
    coalesce(array_agg(a.r2_input_key), array[]::text[])
      || coalesce(
           array_agg(a.r2_output_key) filter (where a.r2_output_key is not null),
           array[]::text[]
         ),
    count(*) filter (where a.status = 'uploaded')
    into v_chaves, v_por_apagar
    from apagados as a;

  -- Terceira trava: `subscriptions`.
  if v_por_apagar > 0 then
    update public.subscriptions
       set videos_used = greatest(videos_used - v_por_apagar, 0)
     where user_id = p_user_id;
  end if;

  delete from public.projects where id = p_project_id;

  return query select unnest(v_chaves);
end;
$fn$;

commit;
