# PageMask — inventário de dados pessoais

Exigido pelo PLANO §8 ("inventário de dados em `docs/DADOS.md`: tabela → campo →
finalidade → retenção") e pelo art. 37 da LGPD, que obriga o controlador a manter
registro das operações de tratamento.

**Controlador:** PageMask.
**Encarregado (DPO):** Arthur Lima — privacidade@pagemask.com.br
(fonte única: `app/src/lib/legal/encarregado.ts`).

Levantado em 12/09/2026 contra o schema real do banco (`information_schema.columns`),
não contra as migrations. As duas coisas deveriam ser iguais; o inventário vale
mais quando olha a que está no ar.

---

## Como ler este documento

| Coluna | O que significa |
| --- | --- |
| **Campo** | a coluna, exatamente como está no Postgres |
| **É dado pessoal?** | se identifica ou torna identificável uma pessoa natural (LGPD art. 5º, I). Um `uuid` de projeto não é; o `user_id` dele é, porque liga a um titular |
| **Finalidade** | para que ele existe. Campo sem finalidade escrita é campo a apagar |
| **Base legal** | art. 7º da LGPD |
| **Retenção** | quanto tempo fica, e o que o apaga |

**Bases legais usadas, e só estas três:**

- **Execução de contrato** (art. 7º, V) — quase tudo. O titular contratou edição e
  publicação de vídeo; sem esses dados não há serviço.
- **Legítimo interesse** (art. 7º, IX) — os registros de segurança: IP e horário de
  ação sensível, contadores de limite de taxa. O interesse é manter o serviço
  seguro e disponível; o teste de balanceamento está em "Notas sobre o legítimo
  interesse", no fim.
- **Obrigação legal** (art. 7º, II) — registros fiscais da cobrança, que ficam com a
  Stripe, não conosco.

**O que o PageMask NÃO faz com dado pessoal:** publicidade, venda, perfilamento,
enriquecimento com base de terceiro, treino de modelo. Nenhum dado sai para outro
destino além dos operadores listados no fim.

---

## `auth.users` (schema `auth`, do Supabase)

Não está em `public`, mas é onde mora o dado mais sensível do cadastro. Não é
tocado por migration nossa.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `id` | sim (identificador) | chave do titular em todo o resto | contrato | enquanto a conta existir |
| `email` | **sim** | login, avisos transacionais, contato | contrato | enquanto a conta existir |
| `encrypted_password` | sim (credencial) | autenticação. Hash bcrypt — a senha em si não é guardada | contrato | enquanto a conta existir |
| `email_confirmed_at` | não | prova de que o e-mail é do titular | contrato | idem |
| `last_sign_in_at` | sim (comportamental) | suporte e detecção de acesso indevido | legítimo interesse | idem |
| `raw_user_meta_data` | pode conter | o `name` do cadastro chega por aqui antes de virar `profiles.name` | contrato | idem |

**Apagado por:** exclusão de conta (`app/src/lib/conta/exclusao.ts`, passo 4).

---

## `public.profiles`

Extensão de `auth.users` com o que é do produto.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `id` | sim | FK para `auth.users` | contrato | conta |
| `name` | **sim** | tratar a pessoa pelo nome na interface. Opcional | contrato | conta |
| `plan_slug` | não | qual plano vale para os limites | contrato | conta |
| `stripe_customer_id` | sim (pseudônimo) | ligar a conta ao cliente na Stripe | contrato | conta |
| `billing_exempt` | não | isenção manual de cobrança (piloto, cortesia) | contrato | conta |
| `created_at` / `updated_at` | não | ordenação e suporte | contrato | conta |

**Apagado por:** `purge_account` (migration 0024), e por cascade de `auth.users`.

---

## `public.subscriptions`

Estado da assinatura e cota consumida no período.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | dono | contrato | conta |
| `stripe_subscription_id`, `stripe_customer_id`, `stripe_price_id` | pseudônimo | ligação com a Stripe | contrato | conta |
| `status`, `payment_state`, `plan_slug` | não | decidir se o serviço está liberado | contrato | conta |
| `current_period_start/end`, `quota_period_start`, `cancel_at`, `canceled_at`, `cancel_at_period_end`, `last_event_at` | não | janela de cobrança e de cota | contrato | conta |
| `videos_used`, `transcription_seconds_used` | não | cota consumida no período | contrato | conta |

**Não há dado de cartão em lugar nenhum do PageMask.** O número, a validade e o CVV
ficam na Stripe, que é PCI-DSS; daqui só sai o cliente para lá.

---

## `public.plans`

Catálogo. **Nenhum dado pessoal** — é a única tabela de leitura pública
(`using (active)`).

| Campo | Finalidade |
| --- | --- |
| `slug`, `name`, `price_cents`, `sort_order`, `active` | o que a página de planos mostra |
| `videos_month`, `ig_accounts`, `projects`, `max_mb`, `transcription_seconds_month` | os limites, que saem daqui e nunca de constante no código |
| `stripe_price_id`, `stripe_product_id` | ligação com o catálogo da Stripe |

---

## `public.projects` e `public.templates`

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | dono | contrato | conta |
| `name` | **pode ser** — o titular escolhe o texto e pode pôr nome de cliente dele ali | organizar os lotes | contrato | conta |
| `template_id` / `config` | não | o padrão visual aplicado ao lote | contrato | conta |
| `version` | não | congelar o template no enfileiramento | contrato | conta |

---

## `public.assets`

Imagens de marca enviadas pelo titular (cabeçalho, logo, fonte).

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | dono | contrato | conta |
| `kind`, `mime`, `bytes`, `sha256` | não | validação e deduplicação | contrato | conta |
| `r2_key` | sim (aponta para o arquivo) | onde o objeto está no R2 | contrato | conta |

**O conteúdo da imagem** pode conter dado pessoal (uma logo com nome, um rosto). É
do titular; não é analisado nem indexado.

---

## `public.jobs`

Um vídeo no pipeline. É a tabela com mais conteúdo do titular.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | dono, e a conta de cota | contrato | conta |
| `project_id` | não | agrupamento | contrato | conta |
| `filename` | **pode ser** — é o nome do arquivo que o titular enviou | o titular reconhecer o vídeo na lista | contrato | conta |
| `r2_input_key`, `r2_output_key`, `r2_srt_key` | sim (apontam para conteúdo) | onde estão os objetos no R2 | contrato | **objeto: 30 dias**; a linha fica |
| `probe` | não | prova de que o arquivo passou na lista fechada de codecs | legítimo interesse (segurança) | conta |
| `template_snapshot` | não | cópia congelada do template | contrato | conta |
| `report` | não | resultado da validação do render | contrato | conta |
| `status`, `progress`, `attempts`, `error`, `bytes_in`, `transcribed_seconds` | não | estado da fila e cobrança de cota | contrato | conta |
| `queued_at`, `started_at`, `finished_at`, `next_attempt_at` | não | operação da fila | contrato | conta |
| `expires_at` | não | combina com o lifecycle de 30 dias do R2 | contrato | conta |

**O VÍDEO EM SI não está no banco.** Ele está no R2 — ver "Cloudflare R2" abaixo.

**A legenda transcrita (`.srt` no R2) pode conter qualquer coisa que foi dita no
vídeo**, inclusive dado pessoal de terceiros que aparecem nele. Ela é gerada
localmente, no worker, por um modelo que roda dentro do contêiner: **nenhum áudio
sai para serviço de transcrição de terceiro.**

---

## `public.schedules`

Publicação agendada de um vídeo numa conta do Instagram.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `job_id`, `ig_account_id` | indireto | o que publicar e onde | contrato | conta |
| `caption` | **pode ser** — texto livre escrito pelo titular | a legenda do post | contrato | conta |
| `scheduled_at`, `published_at`, `status`, `attempts`, `error`, `next_attempt_at` | não | operação da agenda | contrato | conta |
| `ig_container_id`, `ig_media_id`, `ig_permalink` | pseudônimo (do perfil do titular) | rastrear e linkar o post publicado | contrato | conta |
| `claimed_by`, `claimed_at`, `created_at`, `updated_at` | não | controle de concorrência | contrato | conta |

---

## `public.ig_accounts`

A conta profissional do Instagram conectada. **A tabela mais sensível do banco.**

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | dono | contrato | conta |
| `ig_user_id` | **sim** (identificador na Meta) | publicar e responder aos callbacks da Meta | contrato | até desconectar |
| `username` | **sim** (o @ público) | o titular reconhecer qual conta é | contrato | até desconectar |
| `profile_picture_url` | **sim** (imagem) | idem. URL do CDN da Meta, não copiamos a imagem | contrato | até desconectar |
| `scopes` | não | o que a autorização permite | contrato | até desconectar |
| `token_cipher`, `token_iv`, `token_tag` | **credencial** (não é "dado do titular", é chave de acesso) | publicar em nome do titular | contrato | apagado ao desconectar, revogar ou excluir a conta |
| `key_version` | não | permitir rotação da `TOKEN_ENC_KEY` sem downtime | — | idem |
| `token_expires_at`, `last_refreshed_at`, `status`, `connected_at` | não | saber quando renovar e quando pedir reconexão | contrato | até desconectar |

**Três travas sobre o token, e as três valem juntas:**

1. cifrado com AES-256-GCM antes de gravar, com o `ig_user_id` como AAD — copiar o
   token da linha de A para a de B faz a decifragem falhar;
2. o papel `authenticated` **não tem privilégio de SELECT** nessas três colunas
   (GRANT por coluna, migration 0001), então elas não saem pelo PostgREST;
3. o tipo TypeScript exposto ao cliente (`IgAccountPublic`) não as tem — o token
   não chega nem a poder ser serializado para o navegador por engano.

**Na exportação LGPD o token NÃO vai** (migration 0024, `export_account_data`): é
credencial, não dado pessoal do titular.

---

## `public.ig_oauth_states`

Nonce do fluxo OAuth, entre abrir o popup e voltar dele.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `nonce` | não | amarrar o retorno do OAuth à sessão que o iniciou (anti-CSRF) | legítimo interesse | **minutos**; consumido no retorno |
| `user_id` | sim | quem iniciou | contrato | idem |
| `created_at`, `used_at` | não | expiração e uso único | legítimo interesse | idem |

---

## `public.audit_log`

Quem fez o quê. É prova de conformidade e ferramenta de resposta a incidente.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | quem agiu | legítimo interesse | **anonimizado na exclusão da conta** |
| `actor` | não | `user`, `system`, `worker` ou `meta` | legítimo interesse | permanente |
| `action` | não | o que aconteceu | legítimo interesse | permanente |
| `target` | indireto | id do recurso afetado | legítimo interesse | **zerado na exclusão** |
| `meta` | **pode ser** — carrega `username` do Instagram, ids | contexto do evento | legítimo interesse | **zerado na exclusão** |
| `ip` | **sim** | detectar acesso indevido e abuso | legítimo interesse | **zerado na exclusão** |
| `created_at` | não | quando | legítimo interesse | permanente |

**O que "anonimizar" significa aqui, exatamente:** `purge_account` (0024) faz
`user_id = null, ip = null, target = null, meta = '{}'`. Sobram `actor`, `action` e
`created_at` — a forma do que aconteceu, sem nada que leve a uma pessoa. A linha
continua servindo de estatística e de prova de que o sistema funcionava; deixa de
ser dado pessoal.

**Nunca gravar token nem e-mail em `meta`** — regra escrita no `comment` da tabela
e em `app/src/lib/auditoria.ts`.

---

## `public.data_requests`

As solicitações de LGPD: exclusão pedida aqui ou pela Meta.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | de quem é o pedido | obrigação legal / contrato | **nulo quando a conta é apagada** (`on delete set null`) |
| `kind`, `status` | não | tipo e estado do pedido | obrigação legal | permanente |
| `confirmation_code` | não (aleatório, ~60 bits) | o titular consultar o estado em `/exclusao-de-dados` | obrigação legal | permanente |
| `requested_at`, `completed_at` | não | provar o prazo cumprido | obrigação legal | permanente |
| `meta` | indireto (guarda `ig_user_id` quando o pedido veio da Meta; e a contagem do que foi apagado) | auditoria da exclusão | obrigação legal | permanente |

**Esta tabela sobrevive à exclusão de propósito.** Ela é a prova de que a exclusão
aconteceu, e apagá-la junto deixaria o PageMask sem como demonstrar conformidade —
que é o oposto do que a lei pede. O que sobra dela não identifica ninguém.

---

## `public.webhook_events`

Idempotência de Stripe e Meta.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `provider`, `event_id` | não | a chave que impede efeito duplicado | contrato | **permanente, de propósito** |
| `payload` | **pode ser** — o evento da Stripe traz e-mail e nome de cobrança; o da Meta traz `ig_user_id` | reprocessar e auditar um problema de cobrança | contrato | **90 dias**, depois podado |
| `received_at`, `processed_at`, `error` | não | operação | contrato | permanente |

**Esta tabela foi o achado do inventário**, e vale registrar como, porque a lição
se repete: ela é a única do banco que guarda dado pessoal **sem ter `user_id`**. Sem
coluna de dono, `purge_account` não tem como saber quais linhas são de quem — ou
seja, era o único dado que sobrevivia inteiro a um pedido de "me esqueça", e
nenhuma leitura de código teria apontado isso. O inventário apontou porque a
pergunta que ele obriga a responder é, campo a campo, *o que acontece com isto na
exclusão?*

O conserto é `expire_webhook_events(90)` (migration 0024), chamada pelo cron diário
de `/api/cron/ig-tokens`. Ela **poda o `payload` e mantém a linha**: o `event_id` é
o `unique` que faz a idempotência funcionar, e apagar a linha reabriria a porta que
a Fase 8 fechou — uma reentrega antiga da Stripe voltaria a ter efeito por não ter
mais com o que colidir. Sobra `{ podado_em, tipo }`, que responde "que evento era
este?" sem identificar ninguém.

Noventa dias: a Stripe reentrega por até ~3 dias e a Meta não reentrega; o excedente
existe para o `payload` ainda estar lá quando alguém investigar uma cobrança do mês
passado.

---

## `public.template_previews` e `public.batch_zips`

Filas de trabalho efêmero.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `user_id` | sim | dono e limite | contrato | **prévia: 1 hora** · **ZIP: 7 dias** |
| `project_id`, `job_id` | não | de onde saiu | contrato | idem |
| `config` (prévia) | não | o template sendo editado | contrato | idem |
| `r2_key` | sim (aponta para conteúdo) | o PNG / o .zip no R2 | contrato | idem |
| `digest`, `bytes`, `videos` (ZIP) | não | reaproveitar pacote idêntico | contrato | idem |
| `status`, `error`, `attempts`, `claimed_by`, `claimed_at`, `created_at`, `finished_at`, `expires_at` | não | operação da fila | contrato | idem |

O expurgo é do worker (`expire_previews` / `expire_zips`), que apaga a linha **e** o
objeto no R2.

---

## `public.auth_rate_limit`

Contador dos limites de taxa.

| Campo | É dado pessoal? | Finalidade | Base legal | Retenção |
| --- | --- | --- | --- | --- |
| `bucket` | **sim** — contém IP (`entrar:203.0.113.7`) ou id de usuário | contar tentativas por origem | legítimo interesse | **a janela** (15 min a 1 h); expurgado pela migration 0005 |
| `hits`, `janela_iniciada_em` | não | a contagem | legítimo interesse | idem |

---

## `public.worker_heartbeat`

Nenhum dado pessoal. `worker` (nome do contêiner), `beat_at`, `started_at`,
`jobs_done`, `ffmpeg`. Existe para o alerta de "worker sem batimento há 5 min".

---

## Fora do banco

### Cloudflare R2 (operador — armazenamento)

| O que | Dado pessoal? | Retenção |
| --- | --- | --- |
| `{user_id}/{project_id}/{uuid}.{ext}` — vídeo enviado | **sim**: é conteúdo do titular e pode ter imagem de terceiros | **30 dias** (lifecycle do bucket + `jobs.expires_at`) |
| `{user_id}/assets/{uuid}.{png\|jpg}` — cabeçalho e logo | pode ser | 30 dias |
| `saida/{user_id}/…` — vídeo renderizado | **sim** | 30 dias |
| `legendas/{user_id}/…` — o `.srt` | **sim** (transcrição da fala) | 30 dias |
| `previas/{user_id}/…` — PNG da prévia | pode ser | 1 hora |
| `pacotes/{user_id}/…` — o ZIP do lote | **sim** | 7 dias |

Buckets **privados**, sem acesso público. Todo acesso é por URL pré-assinada de
validade curta. Na exclusão de conta, **todos os seis prefixos são varridos e
apagados**, inclusive objetos órfãos que o banco não conhecia
(`app/src/lib/conta/arquivos.ts`).

### Operadores (a quem os dados chegam, e só o necessário)

| Operador | O que recebe | Onde |
| --- | --- | --- |
| **Supabase** | tudo do banco e a autenticação | (região do projeto) |
| **Cloudflare R2** | os arquivos | rede global |
| **Stripe** | e-mail, dados de pagamento, `stripe_customer_id` | EUA/UE |
| **Meta (Instagram)** | o vídeo a publicar (baixado por link temporário), a legenda, e o `ig_user_id` do titular | EUA |
| **Resend** | e-mail do titular e o texto do aviso transacional | EUA/UE |
| **Sentry** | mensagem de erro, `user_id`, rota. **Nunca token, e-mail, IP ou conteúdo de vídeo** — ver `app/src/lib/observabilidade/sentry-comum.ts` e `worker/src/servico/observabilidade.py` | UE/EUA conforme a DSN |
| **Vercel** | logs de requisição das rotas do app | rede global |

**Transferência internacional:** Stripe, Meta, Sentry e Vercel operam fora do Brasil.
A base é a execução do contrato (LGPD art. 33, II, "d"), e está declarada na
política de privacidade.

### O que o PageMask não coleta

Cookie de analytics, pixel de terceiro, fingerprint, geolocalização, dado de
criança ou adolescente (os termos exigem 18 anos), dado sensível do art. 5º, II.
Os únicos cookies são os de sessão do `@supabase/ssr` — `HttpOnly`, `Secure`,
`SameSite=Lax`, estritamente necessários.

---

## Notas sobre o legítimo interesse

O art. 10 exige que o legítimo interesse seja avaliado, não só invocado. As três
hipóteses usadas aqui, e o raciocínio de cada uma:

**IP em `audit_log`.** Finalidade: descobrir acesso indevido a uma conta e
responder a incidente. Necessidade: sem o IP, "alguém entrou na minha conta" não
tem investigação possível. Balanceamento: é o dado mínimo para a finalidade, fica
restrito à `service_role` (nenhuma política de leitura o expõe), e é **zerado na
exclusão da conta**. Expectativa do titular: registrar acesso é prática esperada em
serviço com login.

**IP em `auth_rate_limit`.** Finalidade: barrar ataque de força bruta ao login.
Necessidade: o limite tem que ser por origem; por usuário não impede a varredura de
mil e-mails. Balanceamento: vive **a janela** (15 minutos) e é apagado depois.

**`jobs.probe`.** Finalidade: provar que o arquivo passou na lista fechada de
codecs antes de ser aberto por um decoder. Não identifica pessoa; entra aqui porque
a finalidade é de segurança e não de execução do contrato.

---

## Direitos do titular, e por onde cada um passa

| Direito (art. 18) | Como é atendido | Prazo |
| --- | --- | --- |
| Confirmação e acesso | `/app/conta` › Exportar meus dados (JSON completo) | imediato |
| Portabilidade | o mesmo JSON, em formato legível por máquina | imediato |
| Correção | nome e e-mail na própria conta; o resto pelo Encarregado | 15 dias |
| Eliminação | `/app/conta` › Excluir minha conta, ou removendo o app no Instagram, ou por e-mail ao Encarregado | imediato na prática; **72 h** é o teto da política |
| Informação sobre compartilhamento | a tabela de operadores acima, repetida na política de privacidade | — |
| Revogação de consentimento | desconectar a conta do Instagram; a base principal é contrato, não consentimento | imediato |
| Oposição | ao Encarregado | 15 dias |

---

## Manutenção deste documento

Toda migration que acrescenta **coluna** entra aqui na mesma alteração. A pergunta a
responder, para cada campo novo, é uma só: *se um titular pedir para ser esquecido,
o que acontece com este campo?* Se a resposta não for óbvia, o campo provavelmente
não deveria existir.

Revisar por inteiro a cada seis meses, ou quando entrar operador novo.
