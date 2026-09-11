-- PageMask · 0005_auth_rate_limit_expurgo
-- A tabela de limite passa a se limpar sozinha.
--
-- O que estava errado em 0003: `consume_rate_limit` só zerava o contador quando
-- a janela vencia — nunca apagava a linha. Na prática a tabela guardava **um
-- endereço IP por rota, para sempre**, de todo mundo que alguma vez tentou
-- entrar. Duas coisas ruins de uma vez:
--
--   1. IP é dado pessoal (docs/PLANO.md, "Segurança e LGPD"). Guardar sem prazo
--      um dado que serve para contar quinze minutos não tem defesa possível —
--      nem para quem tentou entrar e desistiu, nem para quem nunca teve conta.
--   2. A tabela só cresce, e cresce com lixo: 99% das linhas são de janelas que
--      venceram há muito e nunca mais serão lidas.
--
-- 0003 deixava isso para "o cron da Fase 10". Não dá: o cron não existe, e a
-- retenção começa no primeiro usuário, não na Fase 10. A limpeza passa a
-- acontecer dentro da própria função, que é o único código que toca nesta
-- tabela — sem peça nova, sem agendador, sem nada para esquecer de ligar.
--
-- O custo é baixo de propósito: o `delete` usa o índice
-- `auth_rate_limit_janela_idx`, que já existe desde 0003 exatamente para isto,
-- só encosta em linhas velhas, pula as que estiverem ocupadas e apaga no máximo
-- cem por chamada. A janela de guarda é bem mais larga que a do
-- limite (15 minutos) para nunca apagar uma janela ainda em uso — mesmo que
-- alguém chame a função com uma janela maior.

begin;

create or replace function public.consume_rate_limit(
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

  -- Expurgo oportunista, com `skip locked` e teto de linhas.
  --
  -- O `skip locked` não é enfeite: este delete roda na MESMA transação do
  -- upsert acima, que já segurou a linha deste balde. Duas chamadas simultâneas
  -- em baldes diferentes travariam uma na outra — cada uma segurando a linha
  -- que a outra quer apagar — e o impasse aborta a RPC. Abortar aqui é pior do
  -- que não limpar: `consumirLimiteAuth` falha aberto, e a tentativa não é
  -- contada justamente durante uma rajada, que é quando o limite serve para
  -- alguma coisa. Com `skip locked`, linha ocupada é simplesmente pulada — a
  -- próxima chamada limpa.
  --
  -- O `limit` mantém o custo constante: um login nunca paga a conta de uma
  -- faxina inteira. É o mesmo desenho da fila de jobs do PLANO (`for update
  -- skip locked`), pela mesma razão.
  delete from public.auth_rate_limit
   where bucket in (
     select r.bucket
       from public.auth_rate_limit as r
      where r.janela_iniciada_em < v_agora - interval '1 day'
      order by r.janela_iniciada_em
      limit 100
        for update skip locked
   );

  return query select
    v_hits <= p_limite,
    greatest(p_limite - v_hits, 0),
    v_inicio + p_janela;
end;
$$;

comment on function public.consume_rate_limit is
  'Conta uma tentativa no bucket e devolve se ela é permitida, quantas restam '
  'e quando a janela expira. Janela fixa: o contador zera quando a janela '
  'vence, não desliza. Apaga de passagem os baldes parados há mais de um dia — '
  'o IP não fica guardado além do que serve para contar.';

commit;
