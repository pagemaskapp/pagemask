"""PageMask — o worker.

    python service.py

Um laco que reclama job da fila, processa e conclui. Tudo que ele precisa vem
de variavel de ambiente (`src/servico/ambiente.py`), e nenhum segredo aparece
em log.

DESENHO
=======

    N threads de trabalho   reclamam e processam, uma job por vez cada
    1 thread de zeladoria   batimento a cada 30 s + resgate de job travado

Threads, e nao processos, porque o trabalho pesado e o FFmpeg — um processo
externo. Enquanto ele roda, a thread esta bloqueada em I/O e a GIL esta solta.
O unico trecho de CPU em Python e a validacao com numpy, que tambem solta a
GIL nas operacoes de array.

POR QUE O LIMITE POR USUARIO NAO E CONTADO AQUI
===============================================

Seria natural o worker contar quantos jobs de cada usuario ele esta rodando.
Seria errado: com dois conteineres, cada um contaria os SEUS dois e o usuario
teria quatro. A conta certa e a do banco (`claim_job`, migration 0015), que ve
todos os workers ao mesmo tempo. O worker so passa o numero.

DESLIGAMENTO
============

`SIGTERM` (o que o `docker stop` manda) para de reclamar job novo e espera os
que estao rodando terminarem, ate `WORKER_GRACA_S`. Job que nao terminar a
tempo fica em `processing` e volta para a fila pelo zelador — que e o mesmo
caminho de um `docker kill`, so que aquele nao avisa ninguem.
"""
from __future__ import annotations

import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import publish  # noqa: E402
from src.servico import objetos, registro, trabalho  # noqa: E402
from src.servico.ambiente import ConfiguracaoInvalida, carregar  # noqa: E402
from src.servico.banco import Banco, ErroDoBanco  # noqa: E402
from src.util import FFMPEG  # noqa: E402

FFMPEG_MINIMO = (8, 1, 2)

parar = threading.Event()
_contador = {"jobs": 0}
_contador_trava = threading.Lock()


def versao_do_ffmpeg() -> tuple[str, tuple[int, int, int] | None]:
    """Texto da versao e a tupla comparavel. `None` quando nao da para ler.

    Build de distribuicao as vezes traz sufixo (`8.1.2-full_build`,
    `8.1.2-1ubuntu1`), por isso a leitura pega so os tres primeiros numeros.
    """
    try:
        saida = subprocess.run(
            [FFMPEG, "-version"], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return "desconhecida", None

    primeira = saida.splitlines()[0] if saida else ""
    achado = re.search(r"ffmpeg version n?(\d+)\.(\d+)(?:\.(\d+))?", primeira)
    if not achado:
        return primeira[:120] or "desconhecida", None

    partes = (int(achado.group(1)), int(achado.group(2)), int(achado.group(3) or 0))
    return primeira[:120], partes


def zeladoria(amb, banco: Banco) -> None:
    """Batimento a cada `WORKER_HEARTBEAT_S` e resgate de job travado."""
    texto, _ = versao_do_ffmpeg()
    proximo_resgate = 0.0

    while not parar.is_set():
        try:
            banco.bater(amb.worker, texto, _contador["jobs"])
        except ErroDoBanco as erro:
            registro.evento("batimento", resultado="erro", worker=amb.worker,
                            mensagem=str(erro))

        # O resgate e barato e idempotente, mas nao precisa da frequencia do
        # batimento: ele procura job parado ha dezenas de minutos.
        agora = time.monotonic()
        if agora >= proximo_resgate:
            proximo_resgate = agora + max(60, amb.batimento_s * 2)
            try:
                mexidos = banco.resgatar_travados(amb.minutos_ate_travado, amb.max_tentativas)
                if mexidos:
                    registro.evento("zelador", resultado="ok", worker=amb.worker,
                                    resgatados=len(mexidos),
                                    ids=[str(m.get("id"))[:8] for m in mexidos[:10]])
            except ErroDoBanco as erro:
                registro.evento("zelador", resultado="erro", worker=amb.worker,
                                mensagem=str(erro))

        parar.wait(amb.batimento_s)


def trabalhador(indice: int, amb, banco: Banco, r2) -> None:
    nome = f"{amb.worker}#{indice}"

    while not parar.is_set():
        try:
            job = banco.reclamar(nome, amb.max_por_usuario)
        except ErroDoBanco as erro:
            registro.evento("reclamar", resultado="erro", worker=nome, mensagem=str(erro))
            parar.wait(min(30, amb.intervalo_poll_s * 5))
            continue

        if job is None:
            parar.wait(amb.intervalo_poll_s)
            continue

        registro.evento("reclamar", resultado="ok", worker=nome, job_id=str(job["id"]),
                        tentativa=job.get("attempts"), bytes=job.get("bytes_in"))

        # ESTE `try` E O QUE MANTEM A THREAD VIVA, e ele nao e zelo.
        #
        # `trabalho.executar` ja captura tudo que acontece DURANTE o job — mas
        # os tratadores dele terminam chamando `banco.falhar` / `banco.recusar`
        # para gravar o desfecho, e essas chamadas falam com a rede. Uma
        # indisponibilidade do Supabase bem nesse instante levanta `ErroDoBanco`
        # de DENTRO de um `except`, e ai a excecao sobe por cima do tratamento e
        # sai de `executar` inteira.
        #
        # Sem este anteparo, essa exceção mata a thread. E o worker continua
        # existindo: o conteiner segue de pé, o batimento continua sendo
        # gravado pela thread de zeladoria, e o painel mostra tudo verde — com
        # uma thread a menos processando. Com `WORKER_CONCURRENCY=2`, uma
        # oscilacao de rede de dez segundos derruba metade da capacidade em
        # silencio, e a outra metade na proxima.
        try:
            trabalho.executar(job, amb=amb, banco=banco, r2=r2)
        except Exception as erro:  # noqa: BLE001 — anteparo do laco, de proposito
            registro.evento("trabalhador", resultado="erro", worker=nome,
                            job_id=str(job["id"]), erro=type(erro).__name__,
                            mensagem=str(erro))
            # O job fica em `processing` e o zelador o devolve para a fila.
            # Uma pausa evita queimar a fila inteira enquanto o banco nao volta.
            parar.wait(min(30, amb.intervalo_poll_s * 5))
            continue

        with _contador_trava:
            _contador["jobs"] += 1


def main() -> int:
    try:
        amb = carregar()
    except ConfiguracaoInvalida as erro:
        # Sem `registro.evento`: o log estruturado ainda nem faz sentido, e
        # esta mensagem e para quem esta olhando o `docker logs` agora.
        print(f"configuracao invalida: {erro}", file=sys.stderr, flush=True)
        return 2

    texto, versao = versao_do_ffmpeg()
    if versao is None or versao < FFMPEG_MINIMO:
        registro.evento("inicio", resultado="erro", worker=amb.worker, ffmpeg=texto,
                        mensagem="FFmpeg abaixo do minimo exigido "
                                 + ".".join(str(n) for n in FFMPEG_MINIMO))
        return 2

    amb.trabalho.mkdir(parents=True, exist_ok=True)

    banco = Banco(amb.supabase_url, amb.supabase_secret)
    r2 = objetos.cliente_r2(amb.r2_endpoint, amb.r2_access_key, amb.r2_secret_key)

    def pedir_parada(numero, _quadro):
        registro.evento("parada", resultado="ok", worker=amb.worker, sinal=int(numero))
        parar.set()

    signal.signal(signal.SIGTERM, pedir_parada)
    signal.signal(signal.SIGINT, pedir_parada)

    registro.evento("inicio", resultado="ok", worker=amb.worker, ffmpeg=texto,
                    concorrencia=amb.concorrencia,
                    max_por_usuario=amb.max_por_usuario,
                    timeout_s=amb.timeout_s, trabalho=str(amb.trabalho))

    threads = [
        threading.Thread(target=zeladoria, args=(amb, banco), name="zeladoria", daemon=True)
    ]
    for indice in range(1, amb.concorrencia + 1):
        threads.append(
            threading.Thread(
                target=trabalhador, args=(indice, amb, banco, r2),
                name=f"trabalho-{indice}", daemon=True,
            )
        )

    # A publicacao (Fase 5) e uma thread so, e e opcional: sem TOKEN_ENC_KEY
    # nao ha como decifrar token, entao ela nao sobe — e o log diz por que,
    # em vez de a agenda ficar em `publishing` para sempre sem explicacao.
    if amb.token_enc_key:
        threads.append(
            threading.Thread(
                target=publish.publicador, args=(amb, banco, r2, parar, f"{amb.worker}#pub"),
                name="publicacao", daemon=True,
            )
        )
    else:
        registro.evento("inicio", resultado="aviso", worker=amb.worker,
                        mensagem="TOKEN_ENC_KEY ausente: a publicacao no Instagram esta desligada")

    for thread in threads:
        thread.start()

    graca = amb.graca_s
    try:
        while not parar.is_set():
            parar.wait(1)
    except KeyboardInterrupt:
        parar.set()

    limite = time.monotonic() + graca
    for thread in threads:
        thread.join(timeout=max(0.1, limite - time.monotonic()))

    vivos = [t.name for t in threads if t.is_alive()]
    registro.evento("fim", resultado="ok" if not vivos else "incompleto",
                    worker=amb.worker, jobs=_contador["jobs"],
                    threads_penduradas=vivos)

    # So fecha o cliente HTTP se ninguem mais estiver usando. Com uma thread
    # ainda viva, fechar aqui arrancaria a conexao debaixo de um render que
    # esta a segundos de gravar `finish_job` — e ai o trabalho estaria feito, o
    # arquivo no bucket, e o job voltaria para a fila pelo zelador para ser
    # refeito do zero. O processo esta terminando de qualquer forma; o sistema
    # operacional fecha o socket.
    if not vivos:
        banco.fechar()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
