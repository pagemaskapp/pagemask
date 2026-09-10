# Insteira — Plano de execução

Cada fase é um bloco fechado: você cola o prompt no Claude Code, ele constrói, e você
roda o **critério de aceite** antes de seguir. Nenhuma fase começa com a anterior
quebrada.

- **Fases 0 a 5** = MVP vendável (edição em lote + download)
- **Fases 6 a 9** = paridade com o MyPageFlow (cobrança, legendas, agendamento, publicação)
- **Fase 10** = decisão sua, com risco documentado
- **Fase 11** = lançamento

Estimativa realista trabalhando com o Claude Code: **7 a 10 semanas** até a Fase 9,
sendo que a espera da Meta corre em paralelo desde o dia 1.

---

## Arquitetura

```
                 ┌──────────────┐
   navegador ──► │  Next.js     │ ──► Supabase (Postgres · Auth · Storage)
                 │  Vercel      │            │
                 └──────────────┘            │  tabela `jobs` = a fila
                        │                    │
                        │ Stripe webhook     ▼
                        │            ┌────────────────┐
                        └──────────► │ Worker Python  │  VPS + Docker
                                     │ FFmpeg+Pillow  │  N processos em paralelo
                                     └────────────────┘
                                             │
                                     Instagram Graph API
```

Sem Redis, sem fila gerenciada: a tabela `jobs` com `FOR UPDATE SKIP LOCKED` dá
concorrência segura e transacional. Menos uma peça de infra para manter e pagar.

---

## Modelo de dados

```
plans              slug, nome, preco_cents, videos_mes, contas_ig, projetos, max_mb, stripe_price_id
profiles           ← auth.users. nome, plan_slug, stripe_customer_id
subscriptions      user_id, status, current_period_end, videos_used
projects           user_id, nome, template_id
templates          user_id, nome, config jsonb    ← o JSON do worker, versionado
assets             user_id, kind (header|logo|fonte), storage_path
jobs               project_id, user_id, status, progress, input_path, output_path,
                   template_snapshot jsonb, attempts, error, timestamps
ig_accounts        user_id, ig_user_id, page_id, username, token_cipher, expires_at
schedules          job_id, ig_account_id, scheduled_at, caption, status, ig_media_id
```

Duas decisões que evitam dor depois:

**`template_snapshot` no job.** O job guarda uma cópia congelada do template no
momento em que foi enfileirado. Se o usuário editar o template no meio do lote, os
vídeos já enfileirados não mudam de cara. Sem isso, um lote de 200 vídeos sai
inconsistente e você não consegue reproduzir o que aconteceu.

**Quota em `subscriptions.videos_used`, não em `count(jobs)`.** Contar jobs fica lento
e conta errado quando há retry. Incremente no momento em que o job é aceito e devolva
o crédito se falhar em definitivo.

---

## Fase 0 — Fundação e o relógio da Meta

Duas coisas ao mesmo tempo: subir o esqueleto e **entrar na fila da Meta hoje**.

### O que fazer sozinho, antes do código

Isto não é tarefa do Claude Code — é burocracia externa e leva semanas. Comece agora:

1. **Meta Business Suite** — crie o Business com o CNPJ da agência.
2. **Verificação de negócio** — envie cartão CNPJ e comprovante de endereço. Leva de
   dias a semanas e é pré-requisito para publicar em contas de terceiros.
3. **App no Meta for Developers** — tipo Business. Adicione os produtos
   *Instagram Graph API* e *Facebook Login*.
4. **Permissões a solicitar no App Review**: `instagram_basic`,
   `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
   `business_management`.
5. **Grave o screencast do fluxo** — a Meta exige vídeo mostrando o uso de cada
   permissão. Você pode gravar com um protótipo tosco; não precisa do produto pronto.

> **Enquanto não aprovar**, o app funciona em modo desenvolvimento: publica só em
> contas onde você é admin. Isso é suficiente para desenvolver e testar tudo até a
> Fase 9. Se a aprovação atrasar, você lança sem publicação automática e liga depois
> — o resto do produto não depende dela.

### Prompt

```
Inicie o projeto Insteira. Leia CLAUDE.md antes.

1. Next.js 15 com App Router, TypeScript, Tailwind e shadcn/ui na pasta app/.
2. Cliente Supabase configurado por variáveis de ambiente (browser e server separados).
3. supabase/migrations/0001_init.sql com as tabelas plans, profiles, subscriptions,
   projects, templates, assets, jobs, ig_accounts e schedules conforme docs/PLANO.md.
   Habilite RLS em todas: cada usuário só enxerga as próprias linhas. A tabela plans
   é leitura pública.
4. Seed dos planos: Partida R$97 (700 vídeos, 3 contas IG, 3 projetos, 500MB),
   Ritmo R$149,90 (1500, 6, 6, 500MB), Escala R$239,90 (2500, 10, 10, 500MB).
5. Página inicial mínima com o nome e um link de entrar. Sem landing ainda.
6. README com os passos para rodar local.

Não implemente auth, upload nem worker agora.
```

**Aceite** — `npm run dev` sobe sem erro; as migrations aplicam no Supabase local ou
remoto; `select * from plans` devolve as três linhas; RLS ativo em todas as tabelas.

---

## Fase 1 — Conta e sessão

### Prompt

```
Implemente autenticação com Supabase Auth.

- Cadastro e login por email e senha, mais magic link.
- Trigger no Postgres que cria a linha em profiles quando nasce um auth.users.
- Middleware protegendo /app/*; visitante sem sessão vai para /entrar.
- Layout autenticado: barra lateral com Projetos, Templates, Agenda e Conta, e um
  menu de usuário com sair.
- Página /app/conta mostrando email, plano atual e uso do mês.

Interface toda em pt-BR. Mensagens de erro dizem o que houve e o que fazer.
```

**Aceite** — criar conta, sair, entrar de novo; acessar `/app` deslogado redireciona;
a linha em `profiles` nasceu sozinha; um usuário não lê os dados do outro (teste com
duas contas).

---

## Fase 2 — Projetos e upload em lote

### Prompt

```
Implemente projetos e upload em lote.

- CRUD de projetos em /app/projetos, respeitando o limite de projetos do plano.
- Dentro do projeto, upload múltiplo por seleção ou arrastar, direto para o bucket
  privado do Supabase Storage via signed upload URL — o arquivo não passa pelo servidor.
- Antes de aceitar: valide extensão e tamanho contra max_mb do plano. Mostre progresso
  por arquivo e permita cancelar.
- Grave uma linha em jobs com status 'uploaded' para cada arquivo.
- Lista os vídeos do projeto com nome, tamanho, duração e status. Permita remover.

A duração ainda não é conhecida no upload; deixe nula e preencha na Fase 3.
```

**Aceite** — subir 5 vídeos de uma vez; aparecem na lista com o tamanho certo; um
arquivo acima do limite é recusado com mensagem clara; recarregar a página mantém tudo;
o bucket é privado (URL direta sem assinatura dá 403).

---

## Fase 3 — Worker e fila

O coração. Aqui o pipeline que já existe vira serviço.

### Antes do prompt

Copie o pipeline pronto para dentro do repo:

```bash
cp -r "C:/Users/User/Downloads/video-pipeline" "C:/Users/User/Downloads/insteira/worker"
```

### Prompt

```
Transforme worker/ em um serviço de fila. O pipeline de render já funciona: leia
worker/README.md e NÃO reescreva a lógica de detecção, composição ou validação.

1. worker/service.py: laço que reclama um job com
   UPDATE jobs SET status='running', started_at=now(), attempts=attempts+1
   WHERE id = (SELECT id FROM jobs WHERE status='queued'
               ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING *;
2. Para cada job: baixar o input do Storage, rodar ffprobe e gravar a duração,
   renderizar com o template_snapshot do job, subir o resultado, gravar as validações
   em jobs.report jsonb e marcar 'done'.
3. Progresso real: leia -progress do ffmpeg e atualize jobs.progress no máximo uma vez
   por segundo.
4. Falha: status 'error' com a mensagem, até 3 tentativas com espera crescente. Na
   terceira, marque 'failed' e devolva o crédito de quota.
5. Job travado em 'running' há mais de 30 minutos volta para 'queued'.
6. Dockerfile com ffmpeg e docker-compose.yml com WORKER_CONCURRENCY (padrão 2).
7. Na UI, botão Processar lote que muda os jobs para 'queued', e a lista mostrando
   progresso ao vivo por Supabase Realtime.

O worker fala com o Supabase pela service role key, sempre por variável de ambiente.
```

**Aceite** — `docker compose up`, clicar em Processar, ver a barra andar de verdade;
o arquivo de saída baixa e abre correto; matar o worker no meio e reiniciar faz o job
travado voltar para a fila; um arquivo corrompido vira `failed` com mensagem legível,
sem derrubar o worker.

---

## Fase 4 — Editor de template

### Prompt

```
Construa o editor visual de templates. Ele monta o mesmo JSON que o worker consome
(campos em worker/config/template.pretamente.json) — a UI é só uma casca sobre ele.

Controles: imagem de header (upload para assets), frase com contador de caracteres,
fonte, corpo em px com autofit, cor, alinhamento do header (auto ou fixo com offset),
modo de enquadramento (fit, cover, blur) e cor da faixa de cobertura.

Preview: endpoint que roda o worker em modo --dry-run sobre um vídeo já enviado do
projeto e devolve o PNG composto. Custa cerca de 2 segundos, então dá para iterar sem
renderizar o lote. Faça debounce de 600ms e mostre estado de carregando.

Salvar como template nomeado, reutilizável em outros projetos. Aplicar ao projeto
inteiro ou a itens selecionados.
```

**Aceite** — mudar a frase e ver o preview atualizar em segundos; salvar, abrir outro
projeto e reaplicar; o lote renderizado sai igual ao preview; um header PNG novo é
detectado e posicionado sozinho.

---

## Fase 5 — Entrega

### Prompt

```
Implemente a entrega dos resultados.

- Download individual por signed URL com validade curta.
- Download do lote em ZIP: gere sob demanda no worker (não no Next), grave no Storage
  e entregue por signed URL. Um lote de 200 vídeos não pode passar pela função serverless.
- Página do projeto mostrando concluídos, com falha e pendentes, e botão de reprocessar
  os que falharam.
```

**Aceite** — baixar um ZIP com 10 vídeos, abrir e conferir que todos tocam; reprocessar
um item com falha funciona sem duplicar o job.

> **Aqui você já tem um produto vendável.** Considere seriamente colocar 5 pessoas
> usando de graça antes de seguir para a Fase 6. O que elas reclamarem muda a ordem
> do resto.

---

## Fase 6 — Cobrança com Stripe

### Prompt

```
Integre a Stripe para assinatura recorrente.

- Produtos e prices espelhando a tabela plans; grave stripe_price_id no banco.
- Checkout Session para assinar, com cartão e PIX habilitados.
- Webhook em /api/stripe/webhook tratando checkout.session.completed,
  customer.subscription.updated e customer.subscription.deleted. Verifique a assinatura
  do evento e trate o mesmo evento chegando duas vezes sem cobrar ou liberar em dobro.
- Billing Portal da Stripe para o cliente trocar de plano e cancelar.
- Gate de quota: ao enfileirar, bloqueie se videos_used + selecionados > videos_mes,
  com mensagem dizendo quanto falta e oferecendo o upgrade.
- Reset de videos_used na virada do período, dirigido pelo webhook.

Valores em centavos, inteiros. Nunca float.
```

**Aceite** — assinar em modo teste com cartão de teste; a quota do plano aparece na
conta; estourar a quota bloqueia com mensagem correta; cancelar rebaixa o acesso no fim
do período; reenviar o mesmo webhook manualmente não duplica nada.

---

## Fase 7 — Legendas

O `ffmpeg` que você já tem vem com `whisper` compilado. Transcrição local, sem API e
sem custo por minuto.

### Prompt

```
Adicione legendas automáticas ao worker.

- Etapa opcional por template: transcrever o áudio com o filtro whisper do ffmpeg,
  gerando SRT com marcação de tempo.
- Guardar o SRT no Storage e permitir editar o texto na UI antes de queimar.
- Queimar no vídeo com estilo configurável (fonte, corpo, cor, contorno, posição),
  respeitando a faixa de vídeo já detectada para a legenda não cair em cima do header.
- Modelo whisper e idioma configuráveis; padrão português.

A transcrição é a única etapa não determinística. Salve o SRT antes de renderizar,
para que o render continue reproduzível a partir dele.
```

**Aceite** — um vídeo com fala em português gera SRT coerente; editar uma linha e
renderizar reflete a edição; a legenda não invade o header nem sai do quadro.

---

## Fase 8 — Contas de Instagram e agenda

### Prompt

```
Conecte contas de Instagram e monte a agenda.

- Facebook Login pedindo instagram_basic, instagram_content_publish, pages_show_list,
  pages_read_engagement e business_management.
- Listar as Páginas do usuário, descobrir a conta Instagram Business ligada a cada uma
  e gravar em ig_accounts. Token cifrado no banco (nunca exposto ao cliente) e renovado
  antes de expirar.
- Respeitar o limite de contas do plano.
- Calendário mensal e semanal em /app/agenda, com arrastar para reagendar.
- Agendar um vídeo pronto: escolher conta, data, hora e legenda. Grava em schedules
  com status 'scheduled'. Fuso America/Sao_Paulo na tela, UTC no banco.
```

**Aceite** — conectar uma conta real de teste onde você é admin; ela aparece com
@usuário e foto; agendar um vídeo e ver no calendário; reagendar arrastando persiste.

---

## Fase 9 — Publicação automática

Só funciona de verdade depois que a Meta aprovar. Até lá roda em contas suas.

### Prompt

```
Implemente a publicação via Instagram Content Publishing API.

Fluxo por post: criar container com media_type=REELS, video_url (signed URL do
Storage com validade suficiente) e caption; consultar status_code do container até
FINISHED, com espera crescente; então publicar com media_publish e gravar o ig_media_id.

- Um cron a cada minuto pega schedules vencidos e enfileira a publicação.
- Trate o limite de 50 publicações por conta a cada 24h: ao bater, adie e avise o
  usuário, sem perder o agendamento.
- Falha vira status 'failed' com o erro da Meta em português e botão de tentar de novo.
- Página de histórico com o que foi publicado, link para o post e o que falhou.
- Enquanto o app estiver em modo desenvolvimento, mostre um aviso claro de que só
  publica em contas onde o usuário é admin.
```

**Aceite** — publicar um Reel de verdade numa conta de teste; ele aparece no perfil com
a legenda certa; simular erro (token vencido) mostra mensagem tratada e permite repetir.

---

## Fase 10 — Anti-duplicidade

Sua decisão, com o risco já registrado: essa função existe para contornar a detecção
de conteúdo duplicado das plataformas, sobre material de terceiros. O risco recai no
cliente, que pode ter a conta restringida, e em você, por direito autoral. Se entrar,
que entre consciente e não como manchete.

### Prompt

```
Adicione variação controlada ao worker, desligada por padrão.

Derive todos os parâmetros de uma seed por job, para o resultado ser reproduzível:
escala entre 1,00 e 1,03; deslocamento de 0 a 6 px; variação de brilho e saturação
abaixo de 2%; ajuste de velocidade entre 0,98 e 1,02 com correção de pitch; metadados
limpos e recriados.

Registre no relatório do job exatamente quais valores foram usados.
```

**Aceite** — dois renders do mesmo vídeo com seeds diferentes produzem hashes
diferentes e continuam visualmente equivalentes; com a função desligada, o resultado é
idêntico ao de antes.

---

## Fase 11 — Landing e lançamento

### Prompt

```
Construa a landing pública em / com posicionamento próprio.

O argumento central não é volume — os concorrentes já brigam por isso. É verificação:
"todo vídeo sai conferido, com o perfil antigo comprovadamente coberto". Mostre isso
com um antes e depois real e com o relatório de validação.

Seções: proposta, como funciona em três passos, prova visual, planos com os preços do
banco, perguntas frequentes e chamada final. Sem número inventado e sem depoimento
falso.

Inclua ainda: /termos, /privacidade e /exclusao-de-dados — as três são exigidas pela
Meta no App Review.
```

**Aceite** — Lighthouse acima de 90 em performance e acessibilidade; as três páginas
legais no ar e acessíveis pelo rodapé; assinar de ponta a ponta em produção com um
cartão real de valor baixo.

---

## Capacidade e custo

Um vídeo de 34 segundos leva cerca de 20 segundos de CPU. Numa VPS de 4 vCPU com 3
workers em paralelo:

| | |
| --- | --- |
| Capacidade | ~15.500 vídeos/dia · ~460.000/mês |
| Custo da VPS | ~R$ 60 a 120/mês |
| Custo real por vídeo | menos de R$ 0,01 |
| Preço praticado no mercado | ~R$ 0,10 |

O gargalo econômico não é CPU — é **banda e storage**. Um vídeo de 1080p com 34s pesa
uns 7 MB; 700 vídeos por cliente somam ~5 GB de entrada mais 5 GB de saída por mês.
Com 50 clientes são 500 GB circulando. Coloque **expiração automática de 30 dias** nos
arquivos desde a Fase 2, ou o storage vira seu maior custo antes do centésimo cliente.

---

## Ordem de risco

| Risco | Quando aparece | Mitigação |
| --- | --- | --- |
| App Review da Meta negado ou lento | Fase 9 | Já começou no dia 1; produto vende sem ele desde a Fase 5 |
| Storage crescendo sem controle | Fase 2 | Expiração de 30 dias desde o início |
| Vídeo de entrada quebrando o worker | Fase 3 | `ffprobe` antes de processar, 3 tentativas, worker isolado em container |
| Cobrança duplicada por webhook repetido | Fase 6 | Idempotência por `event.id` |
| Direito autoral e termos das plataformas | Fase 10 | Termos de uso explícitos; não usar como manchete |

---

## Primeiro passo, hoje

1. Abra o Meta Business e envie a verificação de negócio. É a fila mais longa.
2. Registre `insteira.com.br`.
3. Crie o projeto no Supabase e um projeto vazio na Vercel.
4. Cole o prompt da Fase 0 no Claude Code.
