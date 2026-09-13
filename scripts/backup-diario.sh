#!/usr/bin/env bash
#
# Dump diario do banco do PageMask (PLANO §2: "PITR ligado no Supabase (plano
# Pro) ou dump diario automatizado").
#
# ESTE SCRIPT NAO SUBSTITUI O PITR. Ele e a segunda copia, e as duas cobrem
# coisas diferentes:
#
#   PITR    volta o banco para um INSTANTE qualquer da janela de retencao —
#           inclusive o segundo anterior ao `delete` sem `where`. E do
#           Supabase, e mora na infraestrutura deles.
#   este    e um arquivo que fica FORA do Supabase. Cobre o caso que o PITR
#           nao cobre: perder o acesso ao projeto (conta suspensa, cobranca em
#           atraso, erro de operacao apagando o projeto inteiro).
#
# Quem tem so um dos dois tem metade do problema resolvido — e a metade errada,
# dependendo do dia.
#
# USO
#   scripts/backup-diario.sh [destino]
#
# Le `SUPABASE_DB_URL` de `app/.env.local` (ou do ambiente). Grava
# `pagemask-AAAA-MM-DD-HHMM.dump` no destino (padrao: `./backups`).
#
# O QUE ENTRA NO DUMP, E POR QUE NAO E O BANCO INTEIRO
# ====================================================
#
# `public` (o schema do produto) e `auth` (os usuarios — sem eles o restore
# deixa todo `user_id` apontando para o vazio). Fora ficam `storage`,
# `realtime`, `vault` e o resto da instalacao do Supabase: sao recriados por
# um projeto novo, e tentar restaura-los por cima e como o restore quebra.
#
# Formato `custom` (`-Fc`), nao SQL puro: e comprimido, e `pg_restore` permite
# escolher o que entra na hora do restore — que e exatamente o que se quer
# quando a emergencia e "preciso de UMA tabela de volta".
#
# PRECISA DE `--network host`. Nesta maquina o host direto do Supabase
# (`db.<ref>.supabase.co`) so resolve IPv6, e o Docker sem rede do host nao
# alcanca. Com `--network host` o conteiner usa a pilha de rede da maquina, que
# tem IPv6. Sem essa flag o erro e um timeout silencioso.
#
# O ARQUIVO E SEGREDO. Ele tem token de Instagram cifrado, e-mail de todo
# cliente e a trilha de auditoria inteira. Guarde cifrado, fora do repositorio
# (o `.gitignore` ja ignora `backups/`), e trate o destino com o mesmo cuidado
# do `.env`.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="${1:-$RAIZ/backups}"
ENV_LOCAL="$RAIZ/app/.env.local"

if [ -z "${SUPABASE_DB_URL:-}" ] && [ -f "$ENV_LOCAL" ]; then
  # `sed` e nao `source`: o arquivo tem valores com `$`, `#` e aspas que o
  # shell interpretaria — e um deles e a senha do banco.
  #
  # `\r` sai junto com as aspas: no Windows o `.env.local` costuma estar em
  # CRLF, e um carriage return no fim da linha entra no nome do banco. O
  # `pg_dump` entao reclama de um banco `postgres\r` que "nao existe" — erro
  # que nao menciona quebra de linha em lugar nenhum e leva meia hora para ser
  # entendido.
  SUPABASE_DB_URL="$(sed -n 's/^SUPABASE_DB_URL=//p' "$ENV_LOCAL" | head -1 | tr -d '"\r')"
fi

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "erro: SUPABASE_DB_URL nao definida (nem no ambiente, nem em app/.env.local)" >&2
  exit 2
fi

# A URL É PARTIDA À MÃO, E O `@` É O MOTIVO.
#
# A senha do projeto tem um `@` dentro. `libpq` — e todo parser de URL que
# segue a norma — corta no PRIMEIRO `@`, então `pg_dump "$SUPABASE_DB_URL"`
# tentava resolver o host `123@db.<ref>.supabase.co` e morria com "Name does
# not resolve". **Medido**, e o erro não fala de senha nenhuma: parece problema
# de DNS.
#
# Cortar no ÚLTIMO `@` resolve, porque host não pode conter `@`. E os pedaços
# vão como PG* no ambiente em vez de voltarem a virar URL: assim `@`, `#`, `/`
# e `%` na senha deixam de ter significado sintático.
SEM_ESQUEMA="${SUPABASE_DB_URL#*://}"
CREDENCIAIS="${SEM_ESQUEMA%@*}"
RESTO="${SEM_ESQUEMA##*@}"
PG_USUARIO="${CREDENCIAIS%%:*}"
PG_SENHA="${CREDENCIAIS#*:}"
HOST_PORTA="${RESTO%%/*}"
PG_HOST="${HOST_PORTA%%:*}"
PG_PORTA="${HOST_PORTA##*:}"
[ "$PG_PORTA" = "$PG_HOST" ] && PG_PORTA=5432
CAMINHO="${RESTO#*/}"
PG_BANCO="${CAMINHO%%\?*}"
[ -z "$PG_BANCO" ] && PG_BANCO=postgres

mkdir -p "$DESTINO"
ARQUIVO="pagemask-$(date -u +%Y-%m-%d-%H%M).dump"

echo "dump de public+auth em $PG_HOST:$PG_PORTA/$PG_BANCO -> $DESTINO/$ARQUIVO"

# `MSYS_NO_PATHCONV=1`: no Git Bash do Windows, o `/backup` do `-v` viraria um
# caminho `C:\Program Files\Git\backup` antes de chegar ao Docker.
MSYS_NO_PATHCONV=1 docker run --rm \
  --network host \
  -v "$DESTINO:/backup" \
  -e PGCONNECT_TIMEOUT=30 \
  -e PGHOST="$PG_HOST" \
  -e PGPORT="$PG_PORTA" \
  -e PGUSER="$PG_USUARIO" \
  -e PGPASSWORD="$PG_SENHA" \
  -e PGDATABASE="$PG_BANCO" \
  -e PGSSLMODE=require \
  postgres:17-alpine \
  pg_dump \
    --format=custom \
    --compress=9 \
    --schema=public \
    --schema=auth \
    --no-owner \
    --no-privileges \
    --file="/backup/$ARQUIVO"

TAMANHO="$(du -h "$DESTINO/$ARQUIVO" | cut -f1)"
echo "pronto: $DESTINO/$ARQUIVO ($TAMANHO)"

# Retencao local de 14 dias. O arquivo que importa de verdade e a copia que sai
# desta maquina (Drive, S3, o que for); aqui e so a area de passagem, e sem
# expurgo ela enche o disco em silencio.
find "$DESTINO" -name 'pagemask-*.dump' -type f -mtime +14 -print -delete
