-- PageMask · 0006_job_status_uploaded
-- Novo estado do job: 'uploaded'.
--
-- O video sobe para o R2 e fica PARADO ate o usuario mandar processar o lote
-- (Fase 3, botao "Processar lote"). Sem um estado para isso, o arquivo recem
-- enviado nasceria em 'queued' e o worker o pegaria antes de existir template
-- escolhido — o lote inteiro sairia com o padrao, sem ninguem ter pedido.
--
-- POR QUE ESTE ARQUIVO ESTA SOZINHO
--
-- `alter type … add value` nao pode conviver, na mesma transacao, com o uso do
-- valor novo. O Postgres so enxerga o rotulo depois do commit; usa-lo antes da
-- erro "unsafe use of new value of enum type". A 0007 usa 'uploaded' dentro de
-- funcao, entao as duas precisam ser transacoes separadas — e por isso aqui
-- nao ha `begin`/`commit`: o psql roda em autocommit e o commit acontece ao
-- fim desta instrucao.

alter type public.job_status add value if not exists 'uploaded' before 'queued';
