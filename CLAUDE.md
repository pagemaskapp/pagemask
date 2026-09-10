# PageMask

SaaS de edição de vídeo em lote para páginas temáticas do Instagram. O usuário sobe
uma pasta de vídeos, define um template visual uma vez, e recebe o lote inteiro
editado, verificado e publicado nas contas conectadas.

O plano de execução é `docs/PLANO.md` (Revisão 2). Leia a seção da fase atual antes
de qualquer prompt de fase.

## Regra número um

**O render é determinístico e não usa IA.** O motor é FFmpeg + Pillow, já construído
e validado em `worker/`. Nunca substitua esse caminho por chamada a modelo. IA entra
apenas em tarefas genuinamente variáveis (transcrição de legenda, geração de frase) e
sempre grava o resultado no config antes do render, para o render seguir auditável e
reproduzível.

## Regra número dois

**Todo upload é entrada não confiável e todo token é segredo.** Isso não é uma fase,
é uma condição de todas as fases. Detalhe em `docs/PLANO.md`, seção
"Segurança e LGPD" (§1–§9).

## Stack

| Camada | Escolha |
| --- | --- |
| App web + API | Next.js (App Router), TypeScript, Tailwind, shadcn/ui |
| Banco + auth | Supabase (Postgres + Auth) — chaves JWT legadas `anon` / `service_role` |
| Arquivos | Cloudflare R2, buckets privados, URLs pré-assinadas, lifecycle 30 dias |
| Fila de jobs | Tabela Postgres com `FOR UPDATE SKIP LOCKED` — sem Redis |
| Worker | Python 3.12 + FFmpeg ≥ 8.1.2, Docker não-root com limites |
| Publicação | Instagram API with Instagram Login (`graph.instagram.com`) — sem Página do Facebook |
| Cobrança | Stripe Billing — cartão; Pix quando liberado |
| Deploy app | Vercel · Deploy worker: VPS com Docker Compose |
| Observabilidade | Sentry no app e no worker |

## Estrutura

```
app/            Next.js (rotas, UI, server actions, route handlers)
worker/         pipeline Python de render + serviço de fila (ver worker/README.md)
supabase/       migrations SQL
docs/           PLANO.md (fonte da verdade), RUNBOOK.md, DADOS.md, PRODUCAO.md
```

## Convenções

- **Idioma**: interface, mensagens de erro e copy sempre em **pt-BR**. Código,
  nomes de variáveis, tabelas e commits em inglês.
- **Dinheiro**: centavos em inteiro, nunca float.
- **Tempo**: `timestamptz` no banco, sempre UTC. `America/Sao_Paulo` só na exibição.
- **Migrations**: todo schema muda por arquivo em `supabase/migrations/`. Nunca pelo
  painel. Toda tabela nova nasce com RLS e uma política por comando.
- **Validação**: toda entrada de usuário passa por `zod` no servidor.
- **Segredos**: nunca em `NEXT_PUBLIC_*`, log, erro ou commit. `SUPABASE_SERVICE_ROLE_KEY`,
  Stripe, R2 e `TOKEN_ENC_KEY` só em servidor e worker. Token do Instagram
  cifrado em repouso; o tipo exposto ao cliente não tem os campos de token.
- **Chaves do Supabase**: o projeto usa as **legadas**, em formato JWT. Nelas a
  `anon` e a `service_role` são as duas `eyJ…` e indistinguíveis por prefixo — só o
  claim `role` separa uma da outra, e a `service_role` ignora a RLS por completo.
  Por isso `app/src/lib/supabase/key-role.ts` **decodifica o `role`** em vez de
  olhar o começo da string, e a checagem é simétrica: `anon` recusada no servidor
  tanto quanto `service_role` recusada no cliente. Nunca validar chave do Supabase
  por prefixo enquanto o formato for JWT.
  O Supabase descontinua o formato legado no fim de 2026 e o substitui por
  `sb_publishable_` / `sb_secret_`. A validação já aceita os dois: quando as novas
  aparecerem no painel, migrar é trocar o valor das duas variáveis e atualizar esta
  linha. Nada de código muda.
- **Segredo no bundle**: `npm run scan:bundle` roda depois de todo build, no CI e
  localmente. Ele decodifica todo JWT em `.next/static` e reprova papel que não seja
  `anon` — é o que um grep de prefixo não consegue fazer com chave legada. Ao mexer
  nele, lembrar que os padrões exigem corpo de chave: prefixo solto existe dentro da
  própria `@supabase/supabase-js`, e casar com ele reprova build limpa.
- **Uploads**: o arquivo vai direto do navegador para o R2 por URL pré-assinada.
  Antes de processar, `ffprobe` com lista fechada de codecs (PLANO §4).
- **Webhooks**: assinatura verificada + idempotência por `event_id` em `webhook_events`.
- **APIs externas** (Meta, Stripe, R2): confira a documentação oficial atual antes de
  implementar; o plano foi verificado em 02/09/2026 e endpoints mudam.
- **Limites por plano** saem da tabela `plans`, nunca de constante no código.

## Paleta de cores — Esmeralda Noturna

| Token | Hex | Uso |
| --- | --- | --- |
| `--dark` | `#0f172a` | fundo principal (dark mode) |
| `--surface` | `#1e293b` | cards, sidebar, inputs |
| `--primary` | `#10b981` | botões, links, destaques |
| `--primary-light` | `#34d399` | hover, badges, progresso |
| `--bg-light` | `#f0fdf4` | fundo principal (light mode) |
| `--muted` | `#94a3b8` | texto secundário no dark |

Tailwind: usar `emerald` como cor primária, `slate` como base neutra.

## Protocolo de fase (obrigatório)

1. Ler a fase em `docs/PLANO.md`.
2. Implementar o prompt.
3. Rodar o **Aceite funcional** de verdade e mostrar a saída real.
4. Rodar o **Cross-check de segurança** da fase e mostrar a saída real.
5. Rodar `/security-review` e `/code-review`; corrigir o que for confirmado.
6. Marcar a **Definição de pronto** e commitar como `fase N: <entrega>`.

Se algo falhar, diga **o que falhou com a saída real** em vez de seguir adiante.
Nunca marque aceite como cumprido sem ter rodado. Nunca avance de fase com aceite
ou cross-check quebrado.
