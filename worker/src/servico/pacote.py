"""O ZIP do lote: o que ja esta pronto vira um arquivo so.

    reclamar  ->  lista os videos `done` do projeto  ->  para cada um:
                  le do R2 em pedacos e escreve no ZIP  ->  sobe em partes
              ->  finish_zip

O PACOTE NAO PASSA PELO DISCO NEM PELA VERCEL
=============================================

Duas restricoes diferentes levam a mesma solucao. A Vercel esta fora porque um
lote de 200 videos sao dezenas de gigabytes: nenhuma funcao serverless monta
isso dentro do prazo dela, e a banda seria paga duas vezes (R2 → Vercel →
navegador). E o disco esta fora porque `/work` e **tmpfs**, ou seja, RAM: o
pacote inteiro nao caberia ali, e enquanto estivesse sendo montado ocuparia o
espaco dos renders que rodam ao lado.

Entao o ZIP e um duto: cada video e lido do R2 em pedacos de 1 MB, escrito no
`zipfile`, e o que sai do `zipfile` vira parte de um upload multipart assim que
passa de 8 MB (`objetos.EnvioEmPartes`). O pico de memoria e uma parte mais um
pedaco — o mesmo para 10 videos e para 200.

SEM COMPRESSAO, DE PROPOSITO
============================

`ZIP_STORED`. MP4 ja e um formato comprimido: passar `deflate` por cima gasta
CPU do worker — a mesma CPU que renderiza o lote de outra pessoa — para
economizar algo entre 0% e 2%. O ZIP aqui serve para EMPACOTAR, nao para
encolher.

TRES TETOS, E CADA UM EVITA UM ESTRAGO DIFERENTE
================================================

  · `zip_max_itens`   um projeto com milhares de videos nao trava a fila;
  · `zip_max_gb`      um pacote absurdo nao consome a banda do mes;
  · `zip_timeout_s`   um pacote que nao anda devolve o lugar para os outros.

O NOME DENTRO DO ZIP E ENTRADA NAO CONFIAVEL
============================================

Ele vem de `jobs.filename`, que veio do navegador de alguem. No R2 isso nunca
foi problema — a chave do objeto e um UUID gerado pelo servidor (PLANO §4) —,
mas dentro de um ZIP o nome VOLTA a ser caminho: e o extrator, na maquina de
quem baixou, que decide onde gravar. `..\\..\\` num nome de arquivo e o
"zip slip" classico. `_nome_no_pacote` corta isso antes de escrever.
"""
from __future__ import annotations

import re
import threading
import time
import zipfile
from datetime import datetime
from typing import Any

from . import objetos, registro
from .banco import Banco, ErroDoBanco, JobDeOutroWorker

# Mensagens de tela. O motivo tecnico vai para o log; aqui vai o que a pessoa
# pode fazer a respeito.
MSG_INTERNA = "Não conseguimos montar o pacote agora. Peça o download de novo."
MSG_VAZIO = (
    "Nenhum vídeo deste projeto está pronto para baixar. Processe o lote "
    "e peça o pacote de novo."
)

# O `zip_beat` renova o claim; a cada 30 s basta para uma janela de dezenas de
# minutos, e nao enche o banco de chamadas durante um pacote longo.
BATIMENTO_S = 30

_RESERVADOS_WINDOWS = {
    "con", "prn", "aux", "nul",
    *(f"com{n}" for n in range(1, 10)),
    *(f"lpt{n}" for n in range(1, 10)),
}

# Separadores de caminho, dois-pontos (fluxo alternativo no NTFS), curingas, e
# os invisiveis que o resto do sistema ja remove — controles C0/C1, DEL e as
# marcas de direcao de texto.
#
# Escritos como escape unicode de proposito, pela mesma razao de
# `app/src/lib/r2/chaves.ts`: um caractere de controle literal no fonte e
# invisivel em revisao e em diff, que e justamente o que o torna util para
# atacar.
_PROIBIDOS = re.compile(
    r'[/\\:*?"<>|\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]'
)


class PacoteVazio(Exception):
    pass


class PacoteGrandeDemais(Exception):
    def __init__(self, teto_bytes: int) -> None:
        super().__init__(f"o pacote passou de {teto_bytes} bytes")
        self.teto_bytes = teto_bytes


class ItensDemais(Exception):
    def __init__(self, quantos: int, teto: int) -> None:
        super().__init__(f"{quantos} videos, teto de {teto}")
        self.quantos = quantos
        self.teto = teto


class TempoEsgotado(Exception):
    pass


class Desligando(Exception):
    """O conteiner pediu parada no meio do pacote.

    Separada de `TempoEsgotado` por causa da FRASE QUE O USUARIO LE. Abandonar
    por desligamento e por estouro de prazo tem o mesmo efeito tecnico — o
    pacote volta para a fila —, mas dizer "passou do tempo limite" a quem
    pegou um deploy no meio manda a pessoa procurar um problema que nao existe.
    """


def zipador(amb, banco: Banco, r2, parar: threading.Event, nome: str) -> None:
    """A thread do pacote. Uma por conteiner basta: ela e I/O do inicio ao fim.

    Thread propria pelo mesmo motivo da previa (Fase 6): numa fila so, o
    pacote esperaria o render de 20 minutos que estivesse na frente — e
    empacotar nao usa CPU nenhuma, entao ele nao disputa nada com o render.
    """
    registro.evento("zipador", resultado="ok", worker=nome,
                    poll_s=amb.zip_poll_s, max_itens=amb.zip_max_itens,
                    teto_gb=amb.zip_max_gb)

    while not parar.is_set():
        try:
            item = banco.reclamar_zip(nome, amb.zip_stale_min)
        except ErroDoBanco as erro:
            registro.evento("reclamar_zip", resultado="erro", worker=nome,
                            mensagem=str(erro))
            parar.wait(min(30, amb.zip_poll_s * 5))
            continue

        if item is None:
            parar.wait(amb.zip_poll_s)
            continue

        # O mesmo anteparo das outras threads: o tratador de `executar` fala
        # com o banco de dentro de um `except`, e uma indisponibilidade ali nao
        # pode matar a thread em silencio — o conteiner seguiria de pe, batendo
        # o coracao, sem empacotar nada.
        try:
            executar(item, amb=amb, banco=banco, r2=r2, parar=parar)
        except Exception as erro:  # noqa: BLE001
            registro.evento("zipador", resultado="erro", worker=nome,
                            zip_id=str(item.get("id")),
                            erro=type(erro).__name__, mensagem=str(erro))
            parar.wait(min(30, amb.zip_poll_s * 5))


def executar(item: dict[str, Any], *, amb, banco: Banco, r2,
             parar: threading.Event | None = None) -> None:
    """Monta um pacote ja reclamado. Sempre conclui em algum estado."""
    zip_id = str(item["id"])
    tentativa = int(item["attempts"])
    inicio = time.monotonic()

    try:
        chave, bytes_totais, quantos = _rodar(
            item, amb=amb, banco=banco, r2=r2, parar=parar
        )

    except PacoteVazio:
        # O projeto perdeu os videos entre o pedido e o claim (alguem removeu).
        # Definitivo: tentar de novo daria o mesmo nada.
        registro.evento("zip", resultado="vazio", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio)
        _falhar(banco, zip_id, tentativa, MSG_VAZIO, definitivo=True)

    except ItensDemais as erro:
        registro.evento("zip", resultado="itens_demais", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio,
                        itens=erro.quantos, teto=erro.teto)
        _falhar(
            banco, zip_id, tentativa,
            f"Este projeto tem mais de {erro.teto} vídeos prontos e não cabe "
            "num pacote só. Baixe os vídeos individualmente.",
            definitivo=True,
        )

    except PacoteGrandeDemais as erro:
        registro.evento("zip", resultado="grande", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio,
                        teto_bytes=erro.teto_bytes)
        _falhar(
            banco, zip_id, tentativa,
            "Este lote passa do tamanho máximo de um pacote. Baixe os vídeos "
            "individualmente ou divida o projeto.",
            definitivo=True,
        )

    except Desligando:
        registro.evento("zip", resultado="interrompido", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio)
        _falhar(
            banco, zip_id, tentativa,
            "O pacote parou no meio de uma atualização do sistema e voltou "
            "para a fila. Ele fica pronto em instantes.",
        )

    except TempoEsgotado:
        registro.evento("zip", resultado="timeout", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio,
                        limite_s=amb.zip_timeout_s)
        _falhar(
            banco, zip_id, tentativa,
            "A montagem do pacote passou do tempo limite. Tente de novo em "
            "alguns minutos.",
        )

    except JobDeOutroWorker:
        # O claim expirou e outro worker pegou o pacote. Escrever agora seria
        # atropelar o trabalho dele.
        registro.evento("zip", resultado="abandonado", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio)

    except Exception as erro:  # noqa: BLE001 — o ultimo anteparo
        registro.evento("zip", resultado="erro", zip_id=zip_id,
                        duracao_s=time.monotonic() - inicio,
                        erro=type(erro).__name__, mensagem=str(erro))
        _falhar(banco, zip_id, tentativa, MSG_INTERNA)

    else:
        # Fora do `try` acima (e o `else` de um `try`), entao precisa do
        # proprio tratamento: um `PM030` daqui — o claim expirou enquanto o
        # pacote fechava — sairia de `executar` inteiro e cairia no anteparo do
        # laco, que pausa a unica thread de pacote por 10 s achando que o banco
        # caiu.
        try:
            banco.concluir_zip(zip_id, tentativa, chave, bytes_totais, quantos)
        except JobDeOutroWorker:
            # O .zip fica orfao no R2; o expurgo dos sete dias o recolhe junto
            # com a linha que o outro worker gravou.
            registro.evento("zip", resultado="abandonado", zip_id=zip_id,
                            motivo="o claim expirou enquanto o pacote fechava")
        else:
            registro.evento("zip", resultado="pronto", zip_id=zip_id,
                            duracao_s=time.monotonic() - inicio,
                            videos=quantos, bytes=bytes_totais)


def _rodar(item: dict[str, Any], *, amb, banco: Banco, r2,
           parar: threading.Event | None) -> tuple[str, int, int]:
    zip_id = str(item["id"])
    tentativa = int(item["attempts"])

    itens = banco.itens_do_zip(zip_id)
    if not itens:
        raise PacoteVazio()

    if len(itens) > amb.zip_max_itens:
        raise ItensDemais(len(itens), amb.zip_max_itens)

    teto = amb.zip_max_gb * 1024 * 1024 * 1024
    prazo = time.monotonic() + amb.zip_timeout_s
    chave = objetos.chave_de_zip(amb.prefixo_zip, item)
    destino = objetos.EnvioEmPartes(
        r2, amb.r2_bucket, chave, parte_bytes=amb.zip_parte_mb * 1024 * 1024
    )

    usados: set[str] = set()
    lidos = 0
    quantos = 0
    proximo = [time.monotonic() + BATIMENTO_S]

    def vigiar() -> None:
        """Prazo, desligamento e renovacao de claim — A CADA PEDACO LIDO.

        Entre um video e outro nao basta, e a diferenca e a que o `zip_beat`
        existe para cobrir: UM video de 500 MB numa rede ruim leva mais tempo
        do que a janela de claim inteira, e nesse intervalo nenhuma renovacao
        aconteceria. Um segundo worker reclamaria o mesmo pacote, e os dois
        escreveriam a MESMA chave no R2 (ela vem do id do pacote) — um por
        cima do outro, possivelmente enquanto alguem baixa.

        A conta por pedaco e um `time.monotonic()` a cada 1 MB. Ao lado de uma
        leitura de rede, isso nao existe.
        """
        if parar is not None and parar.is_set():
            # Desligamento pedido (`docker stop`). Abandonar agora devolve o
            # pacote para a fila inteiro, em vez de gastar o prazo de graca com
            # um arquivo que o proximo worker refaria do zero de qualquer jeito.
            raise Desligando()

        agora = time.monotonic()
        if agora > prazo:
            raise TempoEsgotado()

        if agora >= proximo[0]:
            proximo[0] = agora + BATIMENTO_S
            if banco.bater_zip(zip_id, tentativa) is False:
                raise JobDeOutroWorker(
                    "o pacote saiu deste worker durante a montagem", "PM030"
                )

    try:
        with registro.Cronometro("zip_montar", zip_id=zip_id, itens=len(itens)):
            # `allowZip64` e o que permite passar de 4 GB e de 65.535 arquivos.
            # Sem ele, um lote grande sairia corrompido em vez de dar erro.
            with zipfile.ZipFile(destino, "w", zipfile.ZIP_STORED,
                                 allowZip64=True) as pacote:
                for linha in itens:
                    vigiar()

                    nome = _nome_no_pacote(linha, usados)
                    registro_zip = zipfile.ZipInfo(nome, _data(linha))
                    registro_zip.compress_type = zipfile.ZIP_STORED

                    # `force_zip64`: o tamanho do arquivo so e conhecido depois
                    # de ele ter sido escrito, entao o cabecalho precisa nascer
                    # preparado para 4 GB+ em vez de descobrir tarde demais.
                    with pacote.open(registro_zip, "w", force_zip64=True) as entrada:
                        for pedaco in objetos.ler_em_blocos(
                            r2, amb.r2_bucket, str(linha["r2_key"])
                        ):
                            vigiar()
                            lidos += len(pedaco)
                            if lidos > teto:
                                raise PacoteGrandeDemais(teto)
                            entrada.write(pedaco)

                    quantos += 1

        total = destino.concluir()

    except BaseException:
        # Multipart interrompido nao e recolhido por lifecycle de objeto: ele
        # fica pendente, invisivel na listagem e cobrado. O `abortar` e o unico
        # jeito de ele sumir.
        destino.abortar()
        raise

    return chave, total, quantos


def _data(linha: dict[str, Any]) -> tuple[int, int, int, int, int, int]:
    """A data do arquivo dentro do ZIP: quando o video ficou pronto.

    O formato ZIP guarda data local sem fuso e nao aceita ano antes de 1980 —
    um `finished_at` ausente ou estranho viraria excecao no meio do pacote. O
    reserva e o instante atual, que e sempre valido.
    """
    bruto = linha.get("pronto_em")
    if isinstance(bruto, str) and len(bruto) >= 19:
        try:
            quando = datetime.fromisoformat(bruto.replace("Z", "+00:00"))
            if quando.year >= 1980:
                return (quando.year, quando.month, quando.day,
                        quando.hour, quando.minute, quando.second)
        except ValueError:
            pass

    agora = time.localtime()
    return (agora.tm_year, agora.tm_mon, agora.tm_mday,
            agora.tm_hour, agora.tm_min, agora.tm_sec)


def _nome_no_pacote(linha: dict[str, Any], usados: set[str]) -> str:
    """O nome do arquivo dentro do ZIP, seguro e sem repetir.

    Tres coisas acontecem aqui, nesta ordem, e nenhuma e enfeite:

      1. **o nome deixa de ser caminho.** Barra, contrabarra, dois-pontos e
         `..` saem. E o extrator, na maquina de quem baixou, que transforma
         nome em caminho — e um `..\\..\\autoexec` gravaria fora da pasta;
      2. **a extensao vira `.mp4`.** A saida do pipeline e sempre MP4; um
         `.mov` que sai como MP4 com nome `.mov` abre errado em metade dos
         programas (mesma regra da rota de download individual);
      3. **nomes repetidos ganham sufixo.** Dois arquivos com o mesmo nome num
         ZIP sao validos pelo formato e um desastre na extracao: o segundo
         sobrescreve o primeiro sem avisar.
    """
    bruto = linha.get("filename")
    base = bruto if isinstance(bruto, str) else ""

    base = _PROIBIDOS.sub("_", base)
    base = re.sub(r"\.[^.]{1,10}$", "", base).strip().strip(".")
    base = re.sub(r"\s+", " ", base)

    # `..` some inteiro, e nao so o par isolado: `....//` sobrevive a uma
    # substituicao ingenua de `..` por vazio.
    while ".." in base:
        base = base.replace("..", ".")
    base = base.strip(". ")

    if base.lower().split(".")[0] in _RESERVADOS_WINDOWS:
        base = f"_{base}"

    if not base:
        base = f"video-{str(linha.get('job_id', ''))[:8] or 'sem-nome'}"

    base = base[:80]

    nome = f"{base}.mp4"
    if nome.lower() in usados:
        for n in range(2, 10_000):
            nome = f"{base} ({n}).mp4"
            if nome.lower() not in usados:
                break

    usados.add(nome.lower())
    return nome


def _falhar(banco: Banco, zip_id: str, tentativa: int, motivo: str,
            *, definitivo: bool = False) -> None:
    """Grava a falha. `PM030` aqui significa que o pacote ja nao e nosso."""
    try:
        banco.falhar_zip(zip_id, tentativa, motivo, definitivo=definitivo)
    except JobDeOutroWorker:
        registro.evento("zip", resultado="abandonado", zip_id=zip_id,
                        motivo="o claim expirou enquanto este pacote rodava")


def expurgar_vencidos(banco: Banco, r2, amb, nome: str) -> int:
    """Apaga no R2 os pacotes cuja linha ja venceu. Chamado pelo zelador.

    **A LINHA SAI ANTES DO OBJETO**, mesma ordem (e mesmo motivo) do expurgo da
    previa: uma falha no meio deixa objeto orfao, que o lifecycle de 30 dias
    recolhe, e nunca um ZIP `done` apontando para um arquivo que ja nao existe.
    """
    chaves = banco.expurgar_zips()
    for chave in chaves:
        # `conferir_chave` fica FORA do `try` interno de `objetos.apagar`: uma
        # chave fora do formato levanta `ErroDeArmazenamento` aqui. Sem este
        # `except`, a excecao subiria ate a thread de zeladoria e a mataria — e
        # o conteiner seguiria de pe, sem batimento e sem resgate de job
        # travado, mostrando tudo verde no painel.
        try:
            objetos.apagar(r2, amb.r2_bucket, chave)
        except objetos.ErroDeArmazenamento as erro:
            registro.evento("zip_expurgo", resultado="erro", worker=nome,
                            mensagem=str(erro))

    if chaves:
        registro.evento("zip_expurgo", resultado="ok", worker=nome,
                        apagados=len(chaves))
    return len(chaves)
