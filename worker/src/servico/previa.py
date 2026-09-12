"""A previa do editor de template: um PNG, em segundos.

    baixar (com cache)  ->  ffprobe  ->  montar o template  ->  detectar
                        ->  compor   ->  render_preview     ->  subir  ->  done

E o MESMO caminho do render ate o penultimo passo, e isso nao e economia de
codigo — e o requisito. A promessa da tela e "o lote sai igual a previa", e ela
so vale enquanto quem desenha os dois for o mesmo `build_overlay` com a mesma
config montada pelo mesmo `molde.montar`. Um desenhista proprio da previa
(HTML, canvas, o que for) seria mais rapido de escrever e estaria errado a
partir do primeiro ajuste de fonte.

O QUE MUDA EM RELACAO AO RENDER, E POR QUE
==========================================

  · **nao ha `-c:v libx264`**: `render_preview` extrai UM quadro do meio e
    compoe o overlay em cima. E por isso que a previa custa segundos e o job
    custa minutos;
  · **nao ha validacao**: `validate()` confere o ARQUIVO ENTREGUE (duracao,
    audio, cobertura, compatibilidade com Reels). Nada disso existe num PNG;
  · **nao ha cota nem credito**: previa nao gasta video do plano, entao nao ha
    o que devolver quando falha. E por isso que ela nao mora em `jobs` — ver o
    cabecalho da migration 0020;
  · **nao ha tentativa numero dois**: falhou, falhou. O usuario "tenta de novo"
    digitando outra letra, e insistir aqui ocuparia a thread que a proxima
    previa dele esta esperando.

O CACHE DE AMOSTRA E O QUE FAZ "EM SEGUNDOS" SER VERDADE
========================================================

Ajustar um template sao dezenas de previas sobre O MESMO video. Baixar 200 MB
a cada tecla transformaria um debounce de 600 ms numa espera de meio minuto —
e a culpa pareceria do render, que nem comecou. O video de amostra fica em
disco entre uma previa e outra, e o expurgo mantem apenas os ultimos
`PREVIEW_CACHE`.

E cache de ENTRADA, nao de resultado: o PNG e sempre desenhado de novo, porque
o que mudou foi justamente o template.

O TETO DO CACHE E EM BYTES, e nao em numero de arquivos, porque `/work` e um
**tmpfs** — memoria RAM, nao disco (worker/docker-compose.yml). Com 500 MB por
video no plano, guardar "quatro arquivos" seriam 2 GB dentro de um tmpfs de
1,5 GB, e quem perderia espaco seriam os renders que rodam ao lado. O expurgo
roda ANTES de baixar (para abrir espaco, em vez de estourar e limpar depois) e
de novo ao fim de cada previa.
"""
from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from typing import Any

from ..analyze import detect_layout
from ..compose import build_overlay
from ..probe import probe as sondar_media
from ..render import LEGENDA_ASS, LEGENDA_FONTES, render_preview
from ..util import PipelineError
from . import legenda, molde, objetos, registro
from .banco import Banco, ErroDoBanco, JobDeOutroWorker

# Margem sobre o `bytes_in` gravado na Fase 2 — a mesma folga do render.
FOLGA_DE_DOWNLOAD = 1024 * 1024
TETO_SEM_TAMANHO = 2 * 1024 * 1024 * 1024

# Mensagens de tela. O motivo tecnico vai para o log; aqui vai o que a pessoa
# pode fazer a respeito.
MSG_ARQUIVO = (
    "Não conseguimos ler este vídeo de amostra. Escolha outro vídeo na lista."
)
MSG_INTERNA = (
    "Não conseguimos gerar a prévia agora. Tente de novo em instantes."
)


def previador(amb, banco: Banco, r2, parar: threading.Event, nome: str) -> None:
    """A thread da previa. Uma por conteiner basta: cada previa leva segundos."""
    cache = Path(amb.trabalho) / "previas"
    cache.mkdir(parents=True, exist_ok=True)

    registro.evento("previador", resultado="ok", worker=nome,
                    poll_s=amb.previa_poll_s, cache=amb.previa_cache)

    while not parar.is_set():
        try:
            item = banco.reclamar_previa(nome, amb.previa_stale_min)
        except ErroDoBanco as erro:
            registro.evento("reclamar_previa", resultado="erro", worker=nome,
                            mensagem=str(erro))
            parar.wait(min(30, amb.previa_poll_s * 5))
            continue

        if item is None:
            parar.wait(amb.previa_poll_s)
            continue

        # O mesmo anteparo dos outros dois lacos (`service.py`, `publish.py`):
        # o tratador de `executar` fala com o banco de dentro de um `except`, e
        # uma indisponibilidade ali nao pode matar a thread em silencio — o
        # conteiner seguiria de pe, batendo o coracao, sem gerar previa nenhuma.
        try:
            executar(item, amb=amb, banco=banco, r2=r2, cache=cache)
        except Exception as erro:  # noqa: BLE001
            registro.evento("previador", resultado="erro", worker=nome,
                            previa_id=str(item.get("id")),
                            erro=type(erro).__name__, mensagem=str(erro))
            parar.wait(min(30, amb.previa_poll_s * 5))


def executar(item: dict[str, Any], *, amb, banco: Banco, r2, cache: Path) -> None:
    """Gera uma previa ja reclamada. Sempre conclui em algum estado."""
    previa_id = str(item["id"])
    tentativa = int(item["attempts"])
    pasta = Path(amb.trabalho) / f"previa-{previa_id}"
    inicio = time.monotonic()

    try:
        chave = _rodar(item, pasta=pasta, cache=cache, amb=amb, r2=r2)

    except molde.MoldeInvalido as erro:
        registro.evento("previa", resultado="recusada", previa_id=previa_id,
                        duracao_s=time.monotonic() - inicio, motivo=erro.motivo)
        _falhar(banco, previa_id, tentativa, erro.motivo)

    except PipelineError as erro:
        # O pipeline nao conseguiu trabalhar com este ARQUIVO. E a unica falha
        # em que a acao util do usuario e trocar o video de amostra.
        registro.evento("previa", resultado="falhou", previa_id=previa_id,
                        duracao_s=time.monotonic() - inicio,
                        erro=type(erro).__name__, mensagem=str(erro))
        _falhar(banco, previa_id, tentativa, MSG_ARQUIVO)

    except JobDeOutroWorker:
        # O claim expirou e outro worker pegou esta previa. Escrever qualquer
        # coisa agora seria atropelar o trabalho dele.
        registro.evento("previa", resultado="abandonada", previa_id=previa_id,
                        duracao_s=time.monotonic() - inicio)

    except Exception as erro:  # noqa: BLE001 — o ultimo anteparo
        registro.evento("previa", resultado="erro", previa_id=previa_id,
                        duracao_s=time.monotonic() - inicio,
                        erro=type(erro).__name__, mensagem=str(erro))
        _falhar(banco, previa_id, tentativa, MSG_INTERNA)

    else:
        # A conclusao esta FORA do `try` acima (e o `else` de um `try`), entao
        # ela precisa do proprio tratamento: um `PM027` daqui — o claim expirou
        # enquanto o PNG subia — sairia de `executar` inteiro e cairia no
        # anteparo do laco, que pausa a thread por 10 s achando que o banco
        # caiu. E a unica thread de previa que existe.
        try:
            banco.concluir_previa(previa_id, tentativa, chave)
        except JobDeOutroWorker:
            # O PNG fica orfao no R2; o expurgo da hora o recolhe junto com a
            # linha que o outro worker gravou.
            registro.evento("previa", resultado="abandonada", previa_id=previa_id,
                            motivo="o claim expirou enquanto o PNG subia")
        else:
            registro.evento("previa", resultado="pronta", previa_id=previa_id,
                            duracao_s=time.monotonic() - inicio)

    finally:
        _limpar(pasta)
        # Tambem depois, e nao so antes de baixar: a previa que acabou pode ter
        # trazido um video de 500 MB que agora nao serve a ninguem, e deixa-lo
        # ali ate a PROXIMA previa seria segurar meio giga de RAM sem uso.
        _expurgar(cache, amb.previa_cache, amb.previa_cache_mb * 1024 * 1024)


def _rodar(item: dict[str, Any], *, pasta: Path, cache: Path, amb, r2) -> str:
    previa_id = str(item["id"])
    pasta.mkdir(parents=True, exist_ok=True)

    entrada = _amostra(item, cache=cache, amb=amb, r2=r2)

    with registro.Cronometro("previa_montar", previa_id=previa_id):
        # A MESMA fronteira de confianca do render. O `config` aqui veio do
        # editor, ou seja, direto do usuario — e `montar` nao valida o que
        # chegou, monta do zero e copia so o que conhece. E a razao de a previa
        # poder receber um rascunho nao salvo sem abrir nada.
        cfg = molde.montar(
            item.get("config"),
            user_id=str(item["user_id"]),
            pasta_do_job=pasta,
            baixar_asset=lambda chave, destino: objetos.baixar(
                r2, amb.r2_bucket, chave, destino, limite_bytes=16 * 1024 * 1024
            ),
        )

    with registro.Cronometro("previa_compor", previa_id=previa_id):
        info = sondar_media(entrada)
        layout = detect_layout(info, cfg)
        overlay = pasta / "overlay.png"
        relatorio = build_overlay(cfg, layout, molde.RAIZ, overlay)

        com_legenda = _legenda_de_exemplo(cfg, layout, relatorio.cover_until, pasta)

        saida = pasta / "previa.png"
        render_preview(info, cfg, overlay, saida, legenda=com_legenda)

    chave = objetos.chave_de_previa(amb.prefixo_previa, item)
    with registro.Cronometro("previa_subir", previa_id=previa_id,
                             bytes=saida.stat().st_size):
        objetos.subir(r2, amb.r2_bucket, chave, saida, tipo="image/png")

    return chave


#: A fala que a previa desenha quando a legenda esta ligada. Duas linhas
#: cheias de proposito: e o pior caso de altura que `legenda.posicionar`
#: admite, entao o que aparece na previa e o limite, nunca menos.
FALA_DE_EXEMPLO = (
    "Assim a legenda vai aparecer no vídeo",
    "com o tamanho e a cor que você escolheu",
)


def _legenda_de_exemplo(cfg: dict[str, Any], layout, cover_until: int,
                        pasta: Path) -> bool:
    """Deixa um `legenda.ass` de amostra na pasta. `False` = legenda desligada.

    A PREVIA NAO TRANSCREVE, e essa e a unica diferenca deliberada em relacao
    ao render. Transcrever aqui custaria minutos de CPU a cada tecla digitada no
    editor, gastaria a cota de transcricao do usuario antes de ele ter mandado
    processar coisa alguma, e mostraria um texto que o video final nem usaria —
    porque quem manda no render e o SRT gravado no R2, nao uma transcricao de
    rascunho.

    O que a previa precisa mostrar e outra coisa: TIPO, CORPO, COR, CONTORNO e
    POSICAO. Para isso uma fala de exemplo serve, e serve melhor — ela e sempre
    do tamanho maximo, entao o enquadramento que aparece na tela e o pior caso.
    """
    if not cfg["subtitles"]["enabled"]:
        return False

    # `ajustar_ao_texto`, o mesmo do render: ele mede as linhas com a fonte de
    # verdade e devolve as falas ja quebradas na largura de desenho. Aqui isso
    # importa por um motivo a mais — a previa tem que mostrar o enquadramento
    # que o lote vai ter, e um texto requebrado pelo libass seria outro.
    falas = [legenda.Fala(inicio=0.0, fim=3600.0, linhas=FALA_DE_EXEMPLO)]
    estilo, falas = legenda.ajustar_ao_texto(falas, cfg, layout, cover_until)

    # A mesma subpasta isolada do render — ver `render.LEGENDA_FONTES`.
    # Aqui ela importa igual: a pasta da previa tem o `header.png` que o
    # usuario enviou.
    fontes = pasta / LEGENDA_FONTES
    fontes.mkdir(exist_ok=True)
    origem = Path(str(cfg["subtitles"]["font"]))
    shutil.copyfile(origem, fontes / f"legenda{origem.suffix or '.ttf'}")

    (pasta / LEGENDA_ASS).write_text(
        legenda.para_ass(falas, cfg, estilo), encoding="utf-8",
        newline="\n",
    )
    return True


def _amostra(item: dict[str, Any], *, cache: Path, amb, r2) -> Path:
    """O video de amostra em disco, baixado uma vez e reaproveitado."""
    job_id = str(item["job_id"])
    destino = cache / f"{job_id}.bin"

    if destino.is_file() and destino.stat().st_size > 0:
        # `touch` e o que faz o expurgo ser LRU de verdade: sem ele, a ordem
        # seria a de download, e o video que esta sendo usado agora seria o
        # primeiro a sair quando o cache enchesse.
        destino.touch()
        return destino

    declarado = int(item.get("bytes_in") or 0)
    limite = declarado + FOLGA_DE_DOWNLOAD if declarado > 0 else TETO_SEM_TAMANHO

    # ABRIR ESPACO ANTES DE BAIXAR, e nao depois. `/work` e tmpfs, ou seja,
    # RAM: baixar primeiro e limpar depois significa ocupar o pico de memoria
    # justamente enquanto dois renders disputam o mesmo tmpfs. Aqui o cache
    # antigo ja sai reservando o tamanho do arquivo que esta por vir.
    teto = amb.previa_cache_mb * 1024 * 1024
    _expurgar(cache, amb.previa_cache - 1, max(0, teto - min(declarado, teto)))

    parcial = destino.with_suffix(".parcial")
    with registro.Cronometro("previa_baixar", previa_id=str(item["id"])):
        try:
            objetos.baixar(
                r2, amb.r2_bucket, str(item["r2_input_key"]), parcial, limite_bytes=limite
            )
        except BaseException:
            # `objetos.baixar` grava enquanto le e NAO limpa quando falha. Num
            # tmpfs isso e memoria: um download interrompido no meio deixaria
            # centenas de MB de RAM presos ate o conteiner reiniciar — e
            # `_expurgar` nao os alcancaria, porque ele so conhece `.bin`.
            parcial.unlink(missing_ok=True)
            raise
    # Renomear so no fim: um download interrompido no meio deixaria no cache um
    # arquivo com o nome certo e o conteudo truncado, e toda previa seguinte
    # daquele video falharia com "nao conseguimos ler este video" — para sempre,
    # porque o cache nunca mais baixaria de novo.
    parcial.replace(destino)

    return destino


def _expurgar(cache: Path, quantos: int, teto_bytes: int) -> None:
    """Deixa o cache dentro dos DOIS limites: numero de arquivos e bytes.

    Os dois existem porque cada um cobre um caso que o outro nao cobre: sem o
    teto de bytes, quatro videos de 500 MB enchem o tmpfs; sem o teto de
    arquivos, mil videos de 200 KB viram mil entradas para varrer.

    Ordem LRU pelo `mtime`, que o acerto em cache atualiza (`touch`).
    """
    try:
        # Restos de download (`.parcial`) que tenham escapado do `unlink` — um
        # `SIGKILL` no meio do `baixar`, por exemplo — saem sempre, sem entrar
        # na conta de LRU: eles nao servem a ninguem.
        for resto in cache.glob("*.parcial"):
            if resto.is_file() and time.time() - resto.stat().st_mtime > 300:
                resto.unlink(missing_ok=True)

        arquivos = sorted(
            (p for p in cache.glob("*.bin") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return

    acumulado = 0
    for indice, arquivo in enumerate(arquivos):
        try:
            tamanho = arquivo.stat().st_size
        except OSError:
            continue

        acumulado += tamanho
        if indice >= max(0, quantos) or acumulado > max(0, teto_bytes):
            arquivo.unlink(missing_ok=True)


def _falhar(banco: Banco, previa_id: str, tentativa: int, motivo: str) -> None:
    """Grava a falha. `PM027` aqui significa que a previa ja nao e nossa."""
    try:
        banco.falhar_previa(previa_id, tentativa, motivo)
    except JobDeOutroWorker:
        registro.evento("previa", resultado="abandonada", previa_id=previa_id,
                        motivo="o claim expirou enquanto esta previa rodava")


def _limpar(pasta: Path) -> None:
    shutil.rmtree(pasta, ignore_errors=True)


def expurgar_vencidas(banco: Banco, r2, amb, nome: str) -> int:
    """Apaga no R2 os PNGs cuja linha ja venceu. Chamado pelo zelador.

    **A LINHA SAI ANTES DO OBJETO**, e a ordem e deliberada (ver o comentario de
    `expire_previews`, migration 0020): assim uma falha no meio deixa um objeto
    orfao que o lifecycle recolhe, e nunca uma previa `done` apontando para um
    PNG que nao existe mais.
    """
    chaves = banco.expurgar_previas()
    for chave in chaves:
        # `objetos.apagar` engole a falha do R2, mas `conferir_chave` fica FORA
        # do `try` dele: uma chave fora do formato levanta `ErroDeArmazenamento`
        # aqui. Sem este `except`, a excecao subiria ate a thread de zeladoria e
        # a mataria — e o conteiner seguiria de pe, sem batimento e sem resgate
        # de job travado, mostrando tudo verde no painel.
        try:
            objetos.apagar(r2, amb.r2_bucket, chave)
        except objetos.ErroDeArmazenamento as erro:
            registro.evento("previa_expurgo", resultado="erro", worker=nome,
                            mensagem=str(erro))

    if chaves:
        registro.evento("previa_expurgo", resultado="ok", worker=nome,
                        apagadas=len(chaves))
    return len(chaves)
