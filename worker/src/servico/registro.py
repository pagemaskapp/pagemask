"""Log em JSON, uma linha por evento.

O PLANO pede `job_id`, etapa, duracao e resultado. O formato e uma linha de
JSON por evento porque e o que um coletor (Sentry, Loki, CloudWatch) consegue
ler sem regex — e porque o worker roda em Docker, onde a saida padrao E o log.

REGRA DE OURO DESTE MODULO: nada que chega aqui pode ser segredo. Nao existe
"log de depuracao" com a chave do R2 nem com a `service_role`. Por isso a
funcao nao aceita `**kwargs` soltos de um objeto de configuracao — quem loga
escolhe campo por campo, e o que nao foi escolhido nao vaza.

Nome de arquivo enviado pelo usuario TAMBEM passa por aqui, e ele e entrada
nao confiavel: `_limpar` tira quebra de linha e caractere de controle antes de
gravar. Sem isso, um nome com `\\n` forja uma segunda linha de log inteira.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

_TRAVA = threading.Lock()

# Faixas de controle C0 e C1, mais os marcadores de direcao bidirecional. Os
# mesmos que a interface remove do nome do arquivo (`app/src/lib/r2/chaves.ts`).
_INVISIVEIS = {*range(0x00, 0x20), 0x7F, *range(0x80, 0xA0), *range(0x202A, 0x202F),
               *range(0x2066, 0x206A)}


def _limpar(valor: Any) -> Any:
    if isinstance(valor, str):
        limpo = "".join(" " if ord(c) in _INVISIVEIS else c for c in valor)
        return limpo[:500]
    if isinstance(valor, dict):
        return {k: _limpar(v) for k, v in list(valor.items())[:40]}
    if isinstance(valor, (list, tuple)):
        return [_limpar(v) for v in list(valor)[:40]]
    if isinstance(valor, (int, float, bool)) or valor is None:
        return valor
    return _limpar(str(valor))


def evento(
    etapa: str,
    *,
    resultado: str = "ok",
    job_id: str | None = None,
    duracao_s: float | None = None,
    worker: str | None = None,
    **extras: Any,
) -> None:
    """Uma linha de log. `etapa` e `resultado` sao os dois campos obrigatorios."""
    linha: dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "etapa": etapa,
        "resultado": resultado,
    }
    if job_id:
        linha["job_id"] = str(job_id)
    if worker:
        linha["worker"] = _limpar(worker)
    if duracao_s is not None:
        linha["duracao_s"] = round(float(duracao_s), 3)
    for chave, valor in extras.items():
        linha[chave] = _limpar(valor)

    texto = json.dumps(linha, ensure_ascii=False, default=str)
    with _TRAVA:
        # `flush` sempre: em Docker a saida e um pipe, e pipe e bufferizado em
        # blocos. Sem o flush, o log de um worker que morre fica preso no
        # buffer e some — justo o log que explica por que ele morreu.
        sys.stdout.write(texto + "\n")
        sys.stdout.flush()


class Cronometro:
    """Mede uma etapa e loga o resultado, inclusive quando ela levanta."""

    def __init__(self, etapa: str, *, job_id: str | None = None, **extras: Any) -> None:
        self.etapa = etapa
        self.job_id = job_id
        self.extras = extras
        self.inicio = 0.0

    def __enter__(self) -> "Cronometro":
        self.inicio = time.monotonic()
        return self

    def __exit__(self, tipo, valor, _tb) -> bool:
        duracao = time.monotonic() - self.inicio
        if tipo is None:
            evento(self.etapa, resultado="ok", job_id=self.job_id,
                   duracao_s=duracao, **self.extras)
        else:
            evento(self.etapa, resultado="erro", job_id=self.job_id, duracao_s=duracao,
                   erro=type(valor).__name__, mensagem=str(valor), **self.extras)
        return False
