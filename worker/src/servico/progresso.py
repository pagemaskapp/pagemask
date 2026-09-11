"""Render com progresso de verdade e com prazo.

PROGRESSO
=========

O `-progress pipe:1` faz o FFmpeg escrever, a cada poucos frames, um bloco de
`chave=valor` terminado por `progress=continue` (ou `progress=end`). Dividindo
`out_time_us` pela duracao conhecida da fonte sai a fracao — progresso medido,
nao estimado por tempo decorrido.

O `-nostats` anda junto: sem ele o FFmpeg ainda escreve a linha de status com
`\\r` no stderr, que e a mesma informacao num formato feito para humano.

A taxa e limitada a uma escrita por segundo (PLANO §4). O motivo nao e o banco:
e o Realtime. Cada UPDATE em `jobs` vira uma mensagem para cada assinante
daquela linha; um render de 30 s com 900 tiques seria 900 mensagens para
mostrar uma barra que o olho humano le em 30 passos.

PRAZO
=====

O timeout do PLANO (20 min) precisa MATAR o processo, nao so desistir de
esperar. `subprocess.run(timeout=...)` ja faz isso, mas nao deixa ler o
progresso enquanto roda. Aqui quem cobra o prazo e um alarme em thread
separada, e o encerramento e em dois tempos: `terminate()` (o FFmpeg fecha o
arquivo e sai) e, se ele nao sair em 10 s, `kill()`.

O alarme tem que ser independente do laco de leitura, e isso foi medido: com a
conferencia so dentro do laco, um FFmpeg que nao escreve nada nunca era
interrompido. Com o alarme, um `ffmpeg -v quiet` de 20 horas levanta
`TempoEsgotado` em 6,0 s com `timeout_s=6`, e nao sobra processo vivo.

Um detalhe que so aparece em producao: o stderr precisa ser drenado por uma
thread. Se ficar so no buffer do pipe, um FFmpeg falante enche os 64 KB do
pipe e BLOQUEIA — e o worker fica esperando um progresso que nunca vem de um
processo que nunca escreve, porque ele esta travado tentando escrever no
stderr.
"""
from __future__ import annotations

import subprocess
import threading
import time
from collections import deque
from typing import Callable, Iterable

from ..util import PipelineError


class TempoEsgotado(PipelineError):
    """Esta mensagem vai para o LOG. A do usuário é montada em `trabalho.py`."""

    def __init__(self, segundos: int) -> None:
        # Em segundos quando não chega a um minuto: com `WORKER_TIMEOUT_S=30`
        # (o valor que o cross-check usa para não esperar 20 minutos), dividir
        # por 60 escrevia "passou de 0 minutos" no log.
        quanto = f"{segundos}s" if segundos < 60 else f"{segundos // 60}min"
        super().__init__(f"o render passou de {quanto} e foi interrompido")
        self.segundos = segundos


def com_progresso(comando: list[str]) -> list[str]:
    """Acrescenta `-progress pipe:1 -nostats` logo depois do executavel."""
    saida = list(comando)
    corte = 1
    # `-y`, `-v error` e `-stats` vem antes das entradas; `-stats` sai porque o
    # `-progress` o substitui com vantagem.
    saida = [a for a in saida if a != "-stats"]
    saida[corte:corte] = ["-progress", "pipe:1", "-nostats"]
    return saida


def rodar(
    comando: list[str],
    *,
    duracao_s: float,
    timeout_s: int,
    ao_progredir: Callable[[int], None] | None = None,
    intervalo_s: float = 1.0,
) -> None:
    """Executa o FFmpeg relatando progresso. Levanta em falha ou estouro de prazo."""
    processo = subprocess.Popen(
        com_progresso(comando),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    fim_do_stderr: deque[str] = deque(maxlen=20)
    drenagem = threading.Thread(
        target=_drenar, args=(processo.stderr, fim_do_stderr), daemon=True
    )
    drenagem.start()

    limite = time.monotonic() + timeout_s
    ultimo_envio = 0.0
    ultimo_valor = -1
    estourou = False

    # O PRAZO PRECISA DE UM RELOGIO PROPRIO.
    #
    # A versao anterior conferia o prazo dentro do laco que le o `-progress`.
    # Isso so funciona enquanto o FFmpeg FALA: `for linha in processo.stdout`
    # bloqueia, e um processo que para de escrever nunca devolve o controle
    # para a linha que olha o relogio. E o FFmpeg tem dois momentos longos e
    # mudos — a abertura da entrada (um arquivo que faz o demuxer procurar
    # indefinidamente) e a reescrita da `moov` do `+faststart` no fim.
    #
    # Ou seja: o job que MAIS precisava do teto de 20 minutos era justamente o
    # que escapava dele, e ficava pendurado ate o zelador da fila, 30 minutos
    # depois, segurando uma das duas vagas do usuario o tempo todo.
    #
    # Com o alarme numa thread, o prazo vale mesmo em silencio absoluto: ele
    # encerra o processo, o `stdout` fecha, o laco abaixo termina por EOF.
    # O alarme AVISA que disparou, e nao so mata o processo. Sem essa marca, a
    # unica forma de saber, depois do laco, seria olhar o relogio — e ai um
    # render que terminou BEM aos 19min58 viraria `failed` se a ultima
    # gravacao de progresso demorasse os dois minutos restantes. Descartar um
    # render pronto por causa de um POST lento e o pior desfecho possivel.
    alarme = {"disparou": False}

    def _tocar() -> None:
        alarme["disparou"] = True
        _encerrar(processo)

    despertador = threading.Timer(timeout_s, _tocar)
    despertador.daemon = True
    despertador.start()

    # `ao_progredir` pode LEVANTAR — é assim que `trabalho.py` interrompe um
    # render cujo job deixou de ser deste worker. Sem esta marca, o `finally`
    # cairia no `processo.wait(...)` e ficaria esperando educadamente pelo
    # FFmpeg que ninguém mais quer, até o fim do render inteiro.
    interrompido = False

    try:
        assert processo.stdout is not None
        for linha in processo.stdout:
            if time.monotonic() > limite:
                estourou = True
                break

            valor = _fracao(linha, duracao_s)
            if valor is None or ao_progredir is None:
                continue

            agora = time.monotonic()
            if valor != ultimo_valor and agora - ultimo_envio >= intervalo_s:
                ultimo_envio = agora
                ultimo_valor = valor
                try:
                    ao_progredir(valor)
                except BaseException:
                    interrompido = True
                    raise
    finally:
        despertador.cancel()

        if estourou or interrompido:
            _encerrar(processo)
        else:
            try:
                processo.wait(timeout=max(1, int(limite - time.monotonic())))
            except subprocess.TimeoutExpired:
                estourou = True
                _encerrar(processo)

        if processo.stdout is not None:
            processo.stdout.close()
        drenagem.join(timeout=5)

    # O alarme pode ter matado o processo sem que `estourou` tenha sido marcado
    # (o laco terminou por EOF, e nao pela conferencia dentro dele).
    if estourou or alarme["disparou"]:
        raise TempoEsgotado(timeout_s)

    if processo.returncode != 0:
        raise PipelineError(
            "o FFmpeg falhou (%d):\n%s" % (processo.returncode, "\n".join(fim_do_stderr))
        )


def _drenar(fluxo: Iterable[str] | None, guarda: deque[str]) -> None:
    if fluxo is None:
        return
    try:
        for linha in fluxo:
            texto = linha.rstrip()
            if texto:
                guarda.append(texto)
    except (ValueError, OSError):
        # O pipe fechou porque o processo acabou. Nao ha o que relatar.
        pass


def _fracao(linha: str, duracao_s: float) -> int | None:
    """0..99 a partir de `out_time_us=` (ou do `out_time_ms=`, que e o mesmo).

    O `out_time_ms` do FFmpeg sempre foi MICROSSEGUNDOS, apesar do nome — um
    bug antigo que virou compatibilidade. Tratar os dois como microssegundos e
    o que faz a barra bater; dividir um deles por mil daria 0,1% no fim.
    """
    if duracao_s <= 0:
        return None

    chave, _, valor = linha.strip().partition("=")
    if chave not in ("out_time_us", "out_time_ms"):
        return None

    try:
        microssegundos = int(valor)
    except ValueError:
        return None
    if microssegundos < 0:
        return None

    # Teto em 99: o 100 e do `finish_job`, depois da validacao e do upload.
    # Mostrar 100% enquanto ainda falta trabalho e a forma mais barata de
    # fazer o usuario achar que a tela travou.
    return max(0, min(99, int(microssegundos / 10_000 / duracao_s)))


def _encerrar(processo: subprocess.Popen) -> None:
    processo.terminate()
    try:
        processo.wait(timeout=10)
    except subprocess.TimeoutExpired:
        processo.kill()
        processo.wait(timeout=10)
