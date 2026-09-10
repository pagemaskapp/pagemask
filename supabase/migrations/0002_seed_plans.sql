-- PageMask · 0002_seed_plans
-- Catalogo de planos. Preco em centavos inteiros (CLAUDE.md, "Dinheiro").
--
-- Idempotente: pode rodar de novo em qualquer ambiente sem duplicar nem
-- sobrescrever o `stripe_price_id`, que e diferente em teste e em producao e
-- por isso e preenchido na Fase 8, por ambiente.

insert into public.plans
  (slug, name, price_cents, videos_month, ig_accounts, projects, max_mb, sort_order)
values
  ('partida', 'Partida',  9700,  700,  3,  3, 500, 1),
  ('ritmo',   'Ritmo',   14990, 1500,  6,  6, 500, 2),
  ('escala',  'Escala',  23990, 2500, 10, 10, 500, 3)
on conflict (slug) do update set
  name         = excluded.name,
  price_cents  = excluded.price_cents,
  videos_month = excluded.videos_month,
  ig_accounts  = excluded.ig_accounts,
  projects     = excluded.projects,
  max_mb       = excluded.max_mb,
  sort_order   = excluded.sort_order;
