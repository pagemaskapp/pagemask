-- PageMask · 0016_realtime_dos_jobs
-- A tela precisa ver a barra andar sem recarregar. O Supabase Realtime entrega
-- isso lendo o WAL, e so enxerga tabela que esteja na publicacao
-- `supabase_realtime`.
--
-- A LISTA DE COLUNAS NAO E ENFEITE
--
-- `jobs` tem tres colunas jsonb grandes — `probe`, `report` e
-- `template_snapshot`. O worker escreve progresso ate uma vez por segundo por
-- job; publicar a tabela inteira mandaria o template congelado e o relatorio
-- inteiro de novo a cada tique, para cada assinante, so para dizer que 37%
-- virou 38%. Com a lista, o que trafega e o que a tela usa.
--
-- `user_id` esta na lista por necessidade, nao por utilidade: a autorizacao do
-- Realtime aplica a politica de RLS de `jobs`, que compara `user_id` com o
-- `auth.uid()` do assinante. Sem a coluna no payload, nao ha o que comparar, e
-- ninguem recebe nada.
--
-- Coluna nova que a tela venha a mostrar precisa ser acrescentada AQUI tambem,
-- senao ela simplesmente nunca chega ao vivo — e o sintoma e um campo que so
-- atualiza quando a pagina recarrega.
--
-- O QUE ISTO **NAO** ENTREGA: o evento de DELETE
--
-- Com `REPLICA IDENTITY DEFAULT` (o padrao), o WAL de um DELETE carrega so a
-- chave primaria. O assinante filtra por `project_id=eq.…`, e essa coluna nao
-- esta no registro antigo — entao o evento e descartado antes de chegar a
-- tela. Remover um video em outra aba NAO some da lista ao vivo; ele some na
-- recarga periodica, alguns segundos depois.
--
-- E deliberado nao trocar por `replica identity full`: isso passaria a
-- escrever a linha INTEIRA no WAL a cada UPDATE — inclusive `probe`, `report`
-- e `template_snapshot` — e o worker faz um UPDATE por segundo, por job, so
-- para mexer no progresso. Pagar isso no WAL para animar uma remocao que a
-- recarga ja resolve seria trocar uma comodidade por um custo permanente.

begin;

do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'jobs'
  ) then
    alter publication supabase_realtime drop table public.jobs;
  end if;

  alter publication supabase_realtime
    add table public.jobs (
      id, project_id, user_id, status, progress, error,
      filename, r2_output_key, queued_at, started_at, finished_at
    );
end
$$;

commit;
