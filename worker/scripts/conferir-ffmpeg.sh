#!/bin/sh
# Reprova FFmpeg abaixo do minimo (PLANO §4). Sai com 1 — no Dockerfile, isso
# derruba o build; e esse o ponto.
#
# Esta em arquivo, e nao embutido no `RUN`, para poder ser rodado contra uma
# versao ANTIGA e provar que ele de fato reprova. Trava de seguranca que nunca
# foi vista falhando e so uma linha otimista.
#
# `sort -V` compara versao de verdade: 8.1.10 > 8.1.9, que a comparacao de
# texto erraria.
set -eu

minima="${1:-8.1.2}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERRO: ffmpeg nao esta no PATH." >&2
  exit 1
fi

atual="$(ffmpeg -version | head -1 | sed -E 's/^ffmpeg version n?([0-9]+(\.[0-9]+)*).*/\1/')"

case "$atual" in
  ''|*[!0-9.]*)
    echo "ERRO: nao consegui ler a versao do ffmpeg (li: '$atual')." >&2
    exit 1
    ;;
esac

menor="$(printf '%s\n%s\n' "$atual" "$minima" | sort -V | head -1)"
if [ "$menor" != "$minima" ]; then
  echo "ERRO: FFmpeg $atual e menor que o minimo exigido $minima. Veja PLANO §4." >&2
  exit 1
fi

echo "FFmpeg $atual (minimo exigido: $minima) — ok"
ffprobe -version | head -1
