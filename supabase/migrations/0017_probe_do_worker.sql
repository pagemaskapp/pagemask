-- PageMask · 0017_probe_do_worker
-- O `ffprobe` do worker precisa chegar em `jobs.probe` ASSIM QUE e conhecido,
-- e nao so no fim.
--
-- A 0015 ja aceita `p_probe` em `finish_job` e em `reject_job`, o que cobre o
-- vídeo entregue e o recusado. Falta o terceiro caso, e ele e justamente o que
-- alguem vai querer investigar: o job que FALHOU no render. Nesse caminho o
-- probe morria junto com a tentativa, e a coluna ficava com a sondagem
-- aproximada da Fase 2 — a que le so o cabecalho, feita no app porque na
-- Vercel nao ha FFmpeg.
--
-- O PLANO pede o probe guardado como prova de que o arquivo passou pela lista
-- fechada de codecs, "e permite auditoria depois". Auditoria do que deu certo
-- e a metade facil.
--
-- Mesma senha de porteiro das outras: `p_attempt` impede que um worker
-- atrasado escreva por cima do probe de quem pegou o job depois dele.

begin;

create or replace function public.job_probe(
  p_job_id  uuid,
  p_attempt integer,
  p_probe   jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- Inteiro, e nao boolean. `GET DIAGNOSTICS ... = ROW_COUNT` devolve um
  -- inteiro, e o plpgsql o converteria para boolean pela via textual —
  -- '1' vira true, '0' vira false, e qualquer outro valor levanta erro de
  -- sintaxe de boolean. Funciona aqui porque o UPDATE e por chave primaria,
  -- mas e uma dependencia invisivel entre o tipo da variavel e a cardinalidade
  -- da clausula WHERE. Explicito custa uma linha.
  v_linhas integer;
begin
  if p_probe is null or jsonb_typeof(p_probe) <> 'object' then
    raise exception 'probe invalido' using errcode = 'PM017';
  end if;

  update public.jobs
     set probe = p_probe
   where id = p_job_id
     and status = 'processing'
     and attempts = p_attempt;

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$fn$;

revoke execute on function public.job_probe(uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.job_probe(uuid, integer, jsonb) to service_role;

commit;
