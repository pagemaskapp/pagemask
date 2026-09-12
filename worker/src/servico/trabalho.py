"""Um job, do comeco ao fim.

    baixar → ffprobe (lista fechada) → montar o template → detectar → compor
           → renderizar (com progresso) → validar (7 + Reels) → subir → done

O pipeline nao e reescrito aqui: `detect_layout`, `build_overlay`,
`build_command` e `validate` sao importados e usados como estao. O que este
modulo acrescenta e o que um serviço precisa e um script de linha de comando
nao precisava — de onde vem o arquivo, para onde vai o resultado, o que fazer
quando da errado e quem paga a conta.

TRES DESTINOS DIFERENTES PARA "DEU ERRADO", e a diferenca importa para quem ve
a tela:

  `rejected`  o arquivo foi LIDO e o codec ou o container nao esta na lista
              fechada. Credito devolvido, objeto de entrada apagado — arquivo
              recusado nao fica guardado, mesma regra da Fase 2.
  `failed`    nao deu para ler o arquivo, o template nao serve, a validacao
              reprovou ou o prazo estourou. Credito devolvido, entrada
              PRESERVADA: aqui o defeito pode ser nosso, e apagar o arquivo do
              usuario por causa disso seria apagar a copia que talvez ele nao
              tenha mais.
  volta pra fila   o problema foi do CAMINHO (rede, R2 fora do ar, FFmpeg que
              morreu). Ate 3 tentativas com espera crescente; na terceira vira
              `failed`.

Confundir os dois primeiros e o erro caro: tratar arquivo ruim como falha
nossa faz o worker tentar tres vezes o que nunca vai funcionar, e tratar falha
nossa como arquivo ruim faz o PageMask culpar o usuario pelo proprio defeito.
"""
from __future__ import annotations

import math
import shutil
import time
from pathlib import Path
from typing import Any

from ..analyze import detect_layout
from ..compose import build_overlay
from ..probe import probe as sondar_media
from ..render import LEGENDA_ASS, LEGENDA_FONTES, build_command
from ..util import FFMPEG, PipelineError, run
from ..validate import validate, validate_legenda, validate_reels
from . import codecs, legenda, molde, objetos, progresso, registro
from .ambiente import Ambiente
from .banco import Banco, ErroDoBanco, JobDeOutroWorker

# Margem sobre o `bytes_in` que a Fase 2 gravou. A assinatura pre-assinada
# trava o `Content-Length`, entao o objeto nao PODE ser maior — a folga existe
# so para nao transformar um byte de diferenca em falha.
FOLGA_DE_DOWNLOAD = 1024 * 1024

# Teto para o caso de `bytes_in` vir nulo. A coluna aceita nulo e a
# `register_upload_job` exige `> 0`, entao isso nao deveria acontecer — mas se
# acontecer, o limite precisa ser um numero util, e nao 1 MB (que reprovaria
# qualquer video de verdade com uma mensagem sobre tamanho que nao faz sentido).
TETO_SEM_TAMANHO = 2 * 1024 * 1024 * 1024


class RecusaDoArquivo(Exception):
    def __init__(self, motivo: str) -> None:
        super().__init__(motivo)
        self.motivo = motivo


class FalhaDefinitiva(Exception):
    def __init__(self, motivo: str) -> None:
        super().__init__(motivo)
        self.motivo = motivo


def executar(job: dict[str, Any], *, amb: Ambiente, banco: Banco, r2) -> None:
    """Processa um job ja reclamado. Sempre conclui o job em algum estado."""
    job_id = str(job["id"])
    tentativa = int(job["attempts"])
    pasta = Path(amb.trabalho) / job_id
    inicio = time.monotonic()

    try:
        relatorio = _rodar(job, pasta=pasta, amb=amb, banco=banco, r2=r2)

    except RecusaDoArquivo as erro:
        registro.evento("job", resultado="rejected", job_id=job_id,
                        duracao_s=time.monotonic() - inicio, motivo=erro.motivo)
        # O `_apagar_entrada` so acontece se a recusa foi REGISTRADA por este
        # worker. Se o job ja e de outro, apagar a entrada destruiria o arquivo
        # que ele esta processando agora.
        if _concluir(lambda: banco.recusar(job_id, tentativa, erro.motivo,
                                           _probe_guardado(job)), job_id):
            _apagar_entrada(job, amb=amb, r2=r2)

    except FalhaDefinitiva as erro:
        registro.evento("job", resultado="failed", job_id=job_id,
                        duracao_s=time.monotonic() - inicio, motivo=erro.motivo)
        _concluir(lambda: banco.falhar(job_id, tentativa, erro.motivo,
                                       definitivo=True,
                                       max_tentativas=amb.max_tentativas), job_id)

    except progresso.TempoEsgotado as erro:
        # Prazo estourado nao ganha segunda chance. O mesmo video, no mesmo
        # template, leva o mesmo tempo — tres tentativas seriam uma hora de
        # fila ocupada para chegar a mesma conclusao.
        motivo = _mensagem_de_falha(erro, tentativa, amb)
        registro.evento("job", resultado="failed", job_id=job_id,
                        duracao_s=time.monotonic() - inicio, motivo="timeout",
                        limite_s=amb.timeout_s)
        _concluir(lambda: banco.falhar(job_id, tentativa, motivo, definitivo=True,
                                       max_tentativas=amb.max_tentativas), job_id)

    except JobDeOutroWorker:
        # O zelador devolveu o job para a fila enquanto ele rodava aqui. Quem
        # manda agora e o outro worker: escrever qualquer coisa seria
        # atropelar o trabalho dele.
        registro.evento("job", resultado="abandonado", job_id=job_id,
                        duracao_s=time.monotonic() - inicio)

    except Exception as erro:  # noqa: BLE001 — o ultimo anteparo do laco
        espera = _espera(tentativa)
        registro.evento("job", resultado="erro", job_id=job_id,
                        duracao_s=time.monotonic() - inicio,
                        erro=type(erro).__name__, mensagem=str(erro),
                        tentativa=tentativa, espera_s=espera)
        _concluir(
            lambda: banco.falhar(job_id, tentativa,
                                 _mensagem_de_falha(erro, tentativa, amb),
                                 max_tentativas=amb.max_tentativas, espera_s=espera),
            job_id,
        )

    else:
        registro.evento("job", resultado="done", job_id=job_id,
                        duracao_s=time.monotonic() - inicio,
                        checagens=len(relatorio.get("checks", [])))

    finally:
        shutil.rmtree(pasta, ignore_errors=True)


def _rodar(job: dict[str, Any], *, pasta: Path, amb: Ambiente, banco: Banco, r2) -> dict[str, Any]:
    job_id = str(job["id"])
    tentativa = int(job["attempts"])
    inicio = time.monotonic()
    pasta.mkdir(parents=True, exist_ok=True)

    # --- 1. baixar ---------------------------------------------------------
    entrada = pasta / "entrada.bin"
    declarado = int(job.get("bytes_in") or 0)
    limite = declarado + FOLGA_DE_DOWNLOAD if declarado > 0 else TETO_SEM_TAMANHO
    with registro.Cronometro("baixar", job_id=job_id):
        try:
            bytes_lidos = objetos.baixar(
                r2, amb.r2_bucket, str(job["r2_input_key"]), entrada, limite_bytes=limite
            )
        except objetos.ArquivoGrandeDemais as erro:
            # Definitivo: o objeto nao vai encolher na segunda tentativa. E,
            # como o tamanho foi travado na assinatura da Fase 2, chegar aqui
            # significa que o objeto no bucket nao e o que foi autorizado.
            raise FalhaDefinitiva(
                "O arquivo no armazenamento não bate com o que foi enviado. "
                "Remova este vídeo e envie de novo."
            ) from erro

    # --- 2. a lista fechada ------------------------------------------------
    with registro.Cronometro("ffprobe", job_id=job_id):
        try:
            cru = codecs.sondar(entrada)
            resumo = codecs.avaliar(cru)
        except codecs.NaoLegivel as erro:
            # Nao deu para ABRIR o arquivo. Vira `failed`, como o PLANO pede —
            # ver `codecs.NaoLegivel` para a diferenca entre os dois destinos.
            raise FalhaDefinitiva(erro.motivo) from erro
        except codecs.Recusado as erro:
            raise RecusaDoArquivo(erro.motivo) from erro

    resumo["bytes_baixados"] = bytes_lidos
    banco.probe(job_id, tentativa, resumo)

    # --- 3. o template congelado ------------------------------------------
    try:
        cfg = molde.montar(
            job.get("template_snapshot"),
            user_id=str(job["user_id"]),
            pasta_do_job=pasta,
            baixar_asset=lambda chave, destino: objetos.baixar(
                r2, amb.r2_bucket, chave, destino, limite_bytes=16 * 1024 * 1024
            ),
        )
    except molde.MoldeInvalido as erro:
        raise FalhaDefinitiva(erro.motivo) from erro
    except FileNotFoundError as erro:
        # Imagem mal montada (sem fonte instalada), nao template ruim. Nao
        # adianta tentar de novo — a proxima execucao usa a MESMA imagem. O
        # motivo tecnico vai para o log; o usuario recebe uma frase que nao o
        # culpa por um defeito nosso.
        registro.evento("molde", resultado="erro", job_id=job_id,
                        mensagem=str(erro))
        raise FalhaDefinitiva(
            "Não conseguimos preparar o template deste lote. "
            "Fale com o suporte — o problema é nosso, não do seu vídeo."
        ) from erro

    # --- 4. o pipeline, como ele ja era -----------------------------------
    with registro.Cronometro("detectar", job_id=job_id):
        try:
            info = sondar_media(entrada)
        except PipelineError as erro:
            # `probe()` lê o MESMO arquivo que o `ffprobe` acabou de aceitar. Se
            # ele falha aqui, o problema é um campo que o arquivo não tem (uma
            # taxa de quadros ilegível, por exemplo) — e isso não muda na
            # segunda tentativa. Definitivo, não recuperável.
            raise FalhaDefinitiva(
                "Não conseguimos ler as informações básicas deste vídeo "
                "(duração, dimensões ou taxa de quadros). Converta o arquivo "
                "e envie de novo."
            ) from erro

        layout = detect_layout(info, cfg)

    with registro.Cronometro("compor", job_id=job_id):
        overlay = pasta / "overlay.png"
        relatorio_overlay = build_overlay(cfg, layout, molde.RAIZ, overlay)

    # --- 4b. a legenda, quando o template pede ----------------------------
    estilo_da_legenda = _preparar_legenda(
        job, cfg=cfg, layout=layout, cover_until=relatorio_overlay.cover_until,
        entrada=entrada, info=info, pasta=pasta, inicio=inicio,
        amb=amb, banco=banco, r2=r2,
    )

    saida = pasta / "saida.mp4"
    comando = build_command(info, cfg, overlay, saida,
                            legenda=estilo_da_legenda is not None)

    # O PRAZO DO RENDER E O QUE SOBRA DO PRAZO DO JOB, e nao o prazo do job de
    # novo. `WORKER_TIMEOUT_S` mede o job inteiro — e o numero que `_espera`, a
    # mensagem de falha e, sobretudo, `WORKER_STALE_MIN` assumem. Dando o prazo
    # cheio ao render depois de a transcricao ter comido dez minutos, um video
    # longo com legenda chegaria a ~30 min de relogio: o zelador o devolveria
    # para a fila no meio (`requeue_stale_jobs` conta a partir de `started_at`),
    # jogando fora um render quase pronto — e repetiria isso tres vezes antes
    # de desistir.
    #
    # O piso de 30 s existe para o caso patologico: se nao sobrou nada, o
    # render falha por tempo em vez de receber um timeout negativo.
    prazo_do_render = max(30, int(amb.timeout_s - (time.monotonic() - inicio)))

    with registro.Cronometro("render", job_id=job_id,
                             duracao_fonte_s=round(info.duration, 2),
                             prazo_s=prazo_do_render):
        progresso.rodar(
            comando,
            duracao_s=info.duration,
            timeout_s=prazo_do_render,
            ao_progredir=lambda valor: _relatar(banco, job_id, tentativa, valor),
            # O filtro `subtitles` le `legenda.ass` por nome relativo, para nao
            # precisar escapar caminho dentro de um filtergraph (ver `util.run`).
            cwd=str(pasta) if estilo_da_legenda is not None else None,
        )

    # --- 5. validar --------------------------------------------------------
    with registro.Cronometro("validar", job_id=job_id):
        checagens = validate(info, saida, cfg, layout, overlay)
        checagens += validate_reels(saida)
        if estilo_da_legenda is not None:
            checagens += validate_legenda(layout, estilo_da_legenda, cfg)

    reprovadas = [c.name for c in checagens if not c.ok]
    relatorio = {
        "versao": 1,
        "entrada": {"bytes": bytes_lidos, "probe": resumo},
        "layout": layout.as_dict(),
        "overlay": relatorio_overlay.as_dict(),
        "legenda": estilo_da_legenda.as_dict() if estilo_da_legenda else None,
        "checks": [c.as_dict() for c in checagens],
        "passou": not reprovadas,
        "worker": amb.worker,
    }

    if reprovadas:
        # Validacao e deterministica: o mesmo arquivo com o mesmo template da o
        # mesmo resultado. Repetir tres vezes so gastaria a fila.
        raise FalhaDefinitiva(_motivo_da_reprovacao(checagens))

    # --- 6. subir e concluir ----------------------------------------------
    chave = objetos.chave_de_saida(amb.prefixo_saida, job)
    with registro.Cronometro("subir", job_id=job_id, bytes=saida.stat().st_size):
        objetos.subir(r2, amb.r2_bucket, chave, saida)

    try:
        banco.concluir(job_id, tentativa, chave, relatorio, resumo)
    except JobDeOutroWorker:
        # O job saiu das nossas maos DEPOIS de o arquivo ja estar no bucket.
        # O objeto fica orfao: ninguem o referencia, e o lifecycle de 30 dias o
        # recolhe. Apaga-lo aqui seria pior — se o outro worker gravou a mesma
        # chave, estariamos apagando a saida boa dele.
        registro.evento("subir", resultado="orfao", job_id=job_id, chave=chave[-40:])
        raise

    return relatorio


def _preparar_legenda(
    job: dict[str, Any],
    *,
    cfg: dict[str, Any],
    layout: Any,
    cover_until: int,
    entrada: Path,
    info: Any,
    pasta: Path,
    inicio: float,
    amb: Ambiente,
    banco: Banco,
    r2,
) -> legenda.Estilo | None:
    """Deixa `legenda.ass` e a fonte na pasta do job. `None` = sem legenda.

    DUAS ENTRADAS, UMA SAIDA. Se o job ja tem `r2_srt_key`, o texto vem do R2 —
    e e ESSE o caminho da segunda tentativa, do reprocessamento e do re-render
    depois de uma edicao na tela. Transcrever de novo ali seria gastar CPU e
    cota para produzir um texto possivelmente diferente do que o usuario acabou
    de corrigir.

    Sem chave gravada, transcreve uma vez, grava o SRT no R2 e registra a chave
    ANTES de renderizar. A ordem importa: um render que falhe depois disso deixa
    a legenda pronta para a proxima tentativa.
    """
    sub = cfg["subtitles"]
    if not sub["enabled"]:
        return None

    job_id = str(job["id"])
    caminho_srt = pasta / "legenda.srt"
    chave = job.get("r2_srt_key")

    try:
        if isinstance(chave, str) and chave:
            with registro.Cronometro("legenda_baixar", job_id=job_id):
                objetos.baixar(
                    r2, amb.r2_bucket, chave, caminho_srt,
                    limite_bytes=legenda.MAX_BYTES_DO_SRT,
                )
            falas = legenda.ler_srt(
                caminho_srt.read_bytes(), duracao_s=info.duration
            )
            registro.evento("legenda", resultado="reaproveitada", job_id=job_id,
                            falas=len(falas))
        else:
            falas = _transcrever(
                job, cfg=cfg, entrada=entrada, info=info, pasta=pasta,
                inicio=inicio, amb=amb, banco=banco, r2=r2,
            )

        # `ajustar_ao_texto`, e nao so `posicionar`: ele mede as linhas com a
        # fonte de verdade e devolve as falas ja quebradas na largura de
        # desenho, para o libass nunca precisar requebrar nada. O porque
        # esta na docstring dele.
        estilo, falas = legenda.ajustar_ao_texto(
            falas, cfg, layout, cover_until
        )

        # A fonte vai para uma SUBPASTA, e nao para a pasta do job: o
        # `fontsdir` do libass LE CADA ARQUIVO do diretorio como fonte, e na
        # pasta do job mora `entrada.bin` — o video que um desconhecido enviou.
        # O porque completo esta em `render.LEGENDA_FONTES`, e a constante vem
        # de la para a pasta e o `fontsdir` nao poderem divergir.
        fontes = pasta / LEGENDA_FONTES
        fontes.mkdir(exist_ok=True)
        origem = Path(str(sub["font"]))
        shutil.copyfile(origem, fontes / f"legenda{origem.suffix or '.ttf'}")

        # `newline="\n"` em toda gravacao de legenda, e nao e detalhe de
        # estilo: sem ele o Python traduz `\n` para o fim de linha do
        # SISTEMA, e o mesmo job produziria bytes diferentes num worker
        # Windows e num conteiner Linux. O SRT e um artefato GUARDADO, que
        # o usuario edita e que o render le de novo — ele precisa ser o
        # mesmo arquivo em toda maquina, como o video e.
        (pasta / LEGENDA_ASS).write_text(
            legenda.para_ass(falas, cfg, estilo), encoding="utf-8",
            newline="\n",
        )
    except objetos.ArquivoGrandeDemais as erro:
        # O SRT no bucket passa do teto. Definitivo: ele nao encolhe na segunda
        # tentativa, e sem este ramo a excecao subiria como falha de CAMINHO e
        # o job tentaria tres vezes o que nunca vai funcionar.
        #
        # So `ArquivoGrandeDemais` — as outras falhas de `ErroDeArmazenamento`
        # (R2 fora do ar, rede) continuam subindo, porque aquelas melhoram
        # sozinhas e merecem a nova tentativa.
        raise FalhaDefinitiva(
            "A legenda deste vídeo ficou grande demais. Abra a legenda, "
            "encurte o texto e salve de novo."
        ) from erro
    except legenda.LegendaInvalida as erro:
        # A mensagem ja e a frase de tela (pt-BR, com a acao possivel).
        raise FalhaDefinitiva(str(erro)) from erro
    except legenda.TranscricaoEsgotada as erro:
        raise FalhaDefinitiva(
            "A transcrição deste vídeo passou do tempo permitido. "
            "Use um vídeo mais curto ou desligue a legenda no template."
        ) from erro
    except OSError as erro:
        # Fonte que sumiu da imagem, disco cheio no tmpfs. Defeito nosso, e a
        # frase nao culpa o usuario pelo arquivo dele.
        registro.evento("legenda", resultado="erro", job_id=job_id,
                        erro=type(erro).__name__, mensagem=str(erro))
        raise FalhaDefinitiva(
            "Não conseguimos preparar a legenda deste vídeo. "
            "Fale com o suporte — o problema é nosso, não do seu vídeo."
        ) from erro

    return estilo


def _transcrever(
    job: dict[str, Any],
    *,
    cfg: dict[str, Any],
    entrada: Path,
    info: Any,
    pasta: Path,
    inicio: float,
    amb: Ambiente,
    banco: Banco,
    r2,
) -> list[legenda.Fala]:
    """Transcreve uma vez, grava o SRT no R2 e registra a chave."""
    job_id = str(job["id"])
    tentativa = int(job["attempts"])
    segundos = max(1, int(math.ceil(info.duration)))

    # --- o orcamento de tempo, ANTES da cota ------------------------------
    #
    # O MENOR entre o teto proprio da transcricao e o que sobra do prazo do job
    # depois de reservar tempo para o render. Sem a reserva, um video longo
    # gastaria o prazo inteiro transcrevendo e o job morreria no `TempoEsgotado`
    # do FFmpeg — com a cota ja debitada e sem nada para mostrar.
    #
    # E ESTA CONTA VEM PRIMEIRO, antes de falar com o banco. A cota nao tem
    # devolucao: `reserve_transcription` debita ao AUTORIZAR, porque o ponto
    # dela e cobrar antes de a CPU ser gasta. Debitar e so entao descobrir que
    # nao havia tempo cobraria segundos que ninguem chegou a usar — e a coluna
    # nunca os devolveria.
    restante = amb.timeout_s - (time.monotonic() - inicio) - amb.legenda_reserva_s
    orcamento = min(float(amb.legenda_timeout_s), restante)
    if orcamento < 15:
        raise FalhaDefinitiva(
            "Não sobrou tempo para transcrever este vídeo dentro do prazo de "
            "processamento. Use um vídeo mais curto ou desligue a legenda."
        )

    # --- a cota, ANTES da CPU ---------------------------------------------
    try:
        restam = banco.reservar_transcricao(job_id, tentativa, segundos)
    except JobDeOutroWorker:
        raise
    except ErroDoBanco as erro:
        if erro.codigo == "PM034":
            raise FalhaDefinitiva(
                "Sua conta chegou ao limite de legenda automática deste período. "
                "Desligue a legenda no template ou mude de plano em Planos."
            ) from erro
        raise

    # --- o audio, extraido pelo NOSSO FFmpeg ------------------------------
    #
    # O faster-whisper abriria o MP4 sozinho, e e justamente o que nao se quer:
    # ele decodifica com as bibliotecas que o PyAV empacota, que sao outra
    # build de FFmpeg — mais velha que a 8.1.2 que o Dockerfile fixa e confere
    # por soma. Passar arquivo de desconhecido por ela seria furar a trava de
    # versao do PLANO §4 por uma porta lateral. Aqui o unico decoder que toca o
    # arquivo do usuario continua sendo o nosso; o que chega ao PyAV e um WAV
    # PCM de 16 kHz que nos mesmos escrevemos.
    audio = pasta / "audio.wav"
    with registro.Cronometro("legenda_audio", job_id=job_id):
        run([FFMPEG, "-y", "-v", "error", "-i", str(entrada),
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
             str(audio)])

    with registro.Cronometro("legenda_transcrever", job_id=job_id,
                             segundos=segundos, orcamento_s=int(orcamento)):
        falas = legenda.transcrever(
            audio,
            modelo=amb.legenda_modelo,
            modelo_dir=amb.legenda_modelo_dir or None,
            idioma=amb.legenda_idioma,
            prazo_s=orcamento,
            threads=amb.legenda_threads,
            duracao_s=info.duration,
        )

    audio.unlink(missing_ok=True)

    # --- gravar ANTES de renderizar ---------------------------------------
    caminho_srt = pasta / "legenda.srt"
    caminho_srt.write_text(
        legenda.escrever_srt(falas), encoding="utf-8", newline="\n"
    )

    chave = objetos.chave_de_legenda(amb.prefixo_legenda, job)
    with registro.Cronometro("legenda_subir", job_id=job_id):
        objetos.subir(r2, amb.r2_bucket, chave, caminho_srt,
                      tipo="text/plain; charset=utf-8")

    banco.legenda(job_id, tentativa, chave, segundos)
    registro.evento("legenda", resultado="transcrita", job_id=job_id,
                    falas=len(falas), segundos=segundos, restam_s=restam)

    return falas


def _relatar(banco: Banco, job_id: str, tentativa: int, valor: int) -> None:
    """Grava o progresso e ABORTA o render se o job nao for mais nosso.

    O `job_progress` ja devolvia essa informacao e ela era jogada fora. O
    preco de ignora-la: um job resgatado pelo zelador continuava sendo
    renderizado aqui por ate 20 minutos, e o worker so descobria no
    `finish_job` — depois de ter subido o arquivo, deixando um objeto orfao no
    bucket e gastando uma vaga de CPU para nada.

    `None` (falha de rede) nao aborta: ele nao diz nada sobre o dono do job.
    """
    if banco.progresso(job_id, tentativa, valor) is False:
        raise JobDeOutroWorker("o job saiu deste worker durante o render", "PM016")


def _concluir(gravar, job_id: str) -> bool:
    """Grava o desfecho. `False` quando o job ja nao e deste worker.

    Todas as conclusoes passam por aqui porque todas tem o mesmo risco: elas
    rodam DENTRO de um `except`, e o zelador pode ter devolvido o job para a
    fila enquanto ele era processado. Sem este anteparo, o `PM016` sobe por
    cima do tratamento e sai de `executar` inteira — levando junto os passos
    que vinham depois (apagar a entrada recusada, por exemplo).
    """
    try:
        gravar()
        return True
    except JobDeOutroWorker:
        registro.evento("job", resultado="abandonado", job_id=job_id,
                        motivo="o zelador devolveu este job enquanto ele rodava")
        return False


def _apagar_entrada(job: dict[str, Any], *, amb: Ambiente, r2) -> None:
    """Arquivo recusado nao fica guardado — mesma regra da Fase 2.

    Na falha (`failed`) o objeto e PRESERVADO de proposito: ali o defeito foi
    nosso, e apagar o arquivo do usuario por causa de um erro do PageMask
    apagaria a unica copia que ele talvez nao tenha mais.
    """
    chave = job.get("r2_input_key")
    if isinstance(chave, str) and chave:
        objetos.apagar(r2, amb.r2_bucket, chave)


def _probe_guardado(job: dict[str, Any]) -> dict[str, Any] | None:
    atual = job.get("probe")
    return atual if isinstance(atual, dict) else None


def _espera(tentativa: int) -> int:
    """30 s, 60 s, 120 s. Cresce, e para de crescer bem antes de virar abandono."""
    return min(30 * (2 ** max(0, tentativa - 1)), 300)


def _motivo_da_reprovacao(checagens: list[Any]) -> str:
    reprovadas = [c for c in checagens if not c.ok]
    primeira = reprovadas[0]
    resto = len(reprovadas) - 1

    # O `detail` e escrito para quem entende do assunto. Na tela vai a frase
    # curta; o detalhe inteiro fica no `report`, que a Fase 7 mostra.
    frases = {
        "resolucao": "o vídeo saiu fora do formato 1080×1920",
        "duracao": "a duração do resultado não bateu com a do original",
        "audio": "o áudio do resultado saiu mudo ou fora de sincronia",
        "cobertura_header": "a faixa que cobre o cabeçalho antigo não ficou íntegra",
        "header_antigo_dentro_da_cobertura": "parte do cabeçalho antigo ficou visível",
        "vazamento_do_header_antigo": "parte do cabeçalho antigo ficou visível",
        "faixa_de_video_preservada": "a faixa de vídeo foi coberta por engano",
        "reels_moov_no_inicio": "o arquivo final não abriria direto no Instagram",
        "reels_sem_edit_list": "o arquivo final sairia com o áudio deslocado no Instagram",
        "reels_closed_gop": "o arquivo final saiu com GOP aberto, que o Instagram recusa",
        "reels_audio": "o áudio final saiu fora do que o Instagram aceita",
        "reels_fps": "a taxa de quadros final saiu fora do que o Instagram aceita",
        "reels_largura": "o vídeo final saiu largo demais para o Instagram",
        "reels_duracao": "a duração final saiu fora do que o Instagram aceita",
        "reels_tamanho": "o arquivo final ficou grande demais para o Instagram",
        "reels_bitrate": "o arquivo final saiu com bitrate alto demais para o Instagram",
        "legenda_no_quadro": "a legenda sairia cortada na borda do vídeo",
        "legenda_na_faixa_de_video": "a legenda não coube na faixa de vídeo deste arquivo",
    }
    explicacao = frases.get(primeira.name, "a verificação final não passou")
    extra = f" (e mais {resto})" if resto > 0 else ""

    return (
        f"Não entregamos este vídeo porque {explicacao}{extra}. "
        "Tente com outro vídeo ou fale com o suporte."
    )


def _em_tempo(segundos: int) -> str:
    """"20 minutos", "90 segundos", "1 minuto".

    Dividir por 60 e imprimir direto dava "passou de 0 minutos" para qualquer
    prazo abaixo de um minuto — o que apareceu no cross-check, que roda com 30 s
    para nao esperar 20 minutos por uma medicao.
    """
    if segundos < 60:
        return f"{segundos} segundos"
    minutos = segundos // 60
    return "1 minuto" if minutos == 1 else f"{minutos} minutos"


def _mensagem_de_falha(erro: Exception, tentativa: int, amb: Ambiente) -> str:
    """A frase que o usuario le. Nunca o texto da excecao.

    O `str(erro)` vai para o log, onde e util. Na tela ele seria pior do que
    inutil: nomes de classe, caminho de arquivo e, no caso do FFmpeg, quinze
    linhas de stderr. O que o usuario precisa saber e se vale esperar.
    """
    if isinstance(erro, progresso.TempoEsgotado):
        return (
            f"O processamento passou de {_em_tempo(amb.timeout_s)} e foi interrompido. "
            "Envie um vídeo mais curto ou fale com o suporte."
        )

    if tentativa < amb.max_tentativas:
        return "Não conseguimos processar este vídeo agora. Vamos tentar de novo automaticamente."
    return "Não conseguimos processar este vídeo. Tente enviar o arquivo de novo."
