"""Entrada e saida no Cloudflare R2.

A saida vai para um PREFIXO DIFERENTE da entrada (PLANO §4). Nao e organizacao:
a entrada e arquivo de desconhecido e a saida e arquivo que o PageMask produziu,
e os dois nunca devem poder ser confundidos por uma regra de bucket, por um
lifecycle ou por um humano lendo a lista. Alem disso, a URL de download que a
Fase 2 assina (`/api/videos/[id]/baixar`) so assina `r2_output_key` — se a saida
pudesse cair no prefixo da entrada, um job manipulado devolveria ao navegador o
arquivo cru que o usuario subiu, sem passar pelo pipeline.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

# Nao e validacao de seguranca — e um limite de sanidade. A chave ja foi
# escolhida pelo servidor na Fase 2 e conferida pelo banco na `reject_job`/
# `finish_job`. Aqui a regra existe para que uma chave estranha vinda do banco
# pare ANTES de virar caminho de arquivo.
CHAVE_VALIDA = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_.\-]{0,511}$")


class ErroDeArmazenamento(RuntimeError):
    pass


class ArquivoGrandeDemais(ErroDeArmazenamento):
    def __init__(self, limite: int) -> None:
        super().__init__(f"O arquivo passa do limite de {limite} bytes.")
        self.limite = limite


def cliente_r2(endpoint: str, access_key: str, secret_key: str):
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="auto",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=15,
            read_timeout=120,
        ),
    )


def conferir_chave(chave: str) -> str:
    if not isinstance(chave, str) or not CHAVE_VALIDA.match(chave) or ".." in chave:
        raise ErroDeArmazenamento("Chave de objeto fora do formato esperado.")
    return chave


def baixar(cliente, bucket: str, chave: str, destino: Path, *, limite_bytes: int) -> int:
    """Baixa `chave` para `destino`, parando no limite. Devolve os bytes gravados.

    O limite e conferido **enquanto grava**, nao pelo `ContentLength` que o
    servidor anuncia. Sao coisas diferentes: o cabecalho e uma promessa, o
    corpo e o que chega. Um objeto que anuncia 10 MB e entrega 4 GB encheria o
    tmpfs do conteiner — e tmpfs cheio e memoria cheia, entao isso derruba o
    worker inteiro, nao so o job.
    """
    conferir_chave(chave)
    destino.parent.mkdir(parents=True, exist_ok=True)

    try:
        objeto = cliente.get_object(Bucket=bucket, Key=chave)
    except Exception as erro:  # noqa: BLE001 — o botocore levanta varias classes
        raise ErroDeArmazenamento(f"nao consegui ler {_curta(chave)}: {type(erro).__name__}") from erro

    escritos = 0
    corpo = objeto["Body"]
    try:
        with destino.open("wb") as saida:
            while True:
                pedaco = corpo.read(1024 * 1024)
                if not pedaco:
                    break
                escritos += len(pedaco)
                if escritos > limite_bytes:
                    raise ArquivoGrandeDemais(limite_bytes)
                saida.write(pedaco)
    finally:
        corpo.close()

    return escritos


def subir(cliente, bucket: str, chave: str, origem: Path, *, tipo: str = "video/mp4") -> None:
    conferir_chave(chave)
    with origem.open("rb") as arquivo:
        try:
            cliente.put_object(Bucket=bucket, Key=chave, Body=arquivo, ContentType=tipo)
        except Exception as erro:  # noqa: BLE001
            raise ErroDeArmazenamento(
                f"nao consegui gravar {_curta(chave)}: {type(erro).__name__}"
            ) from erro


def apagar(cliente, bucket: str, chave: str) -> None:
    conferir_chave(chave)
    try:
        cliente.delete_object(Bucket=bucket, Key=chave)
    except Exception:  # noqa: BLE001
        # Limpeza nao derruba operacao: o lifecycle de 30 dias recolhe o resto.
        pass


def url_de_leitura(cliente, bucket: str, chave: str, *, validade_s: int = 2 * 60 * 60) -> str:
    """URL pre-assinada de GET para a Meta baixar o video (PLANO, Fase 5).

    Duas horas: o container pode levar minutos para processar, e a Meta baixa
    o arquivo DEPOIS de o container ser criado. Curta demais e o download
    falha com `9004`; longa demais e uma URL do video do cliente circulando
    por mais tempo do que precisa. O cross-check da fase confere que ela
    morre de fato.

    So `r2_output_key` chega aqui — a chave da saida do pipeline, nunca a da
    entrada. A regra e a mesma da rota de download do app (PLANO §4).
    """
    conferir_chave(chave)
    return cliente.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": chave, "ResponseContentType": "video/mp4"},
        ExpiresIn=int(validade_s),
    )


def chave_de_saida(prefixo: str, job: dict[str, Any]) -> str:
    """`{prefixo}/{user_id}/{project_id}/{job_id}.mp4`.

    Derivada dos ids do PROPRIO job, nunca de texto vindo junto. Assim ela e
    unica por construcao (o id do job e chave primaria) e nao ha como um job
    escrever por cima da saida de outro.
    """
    return conferir_chave(
        f"{prefixo.strip('/')}/{job['user_id']}/{job['project_id']}/{job['id']}.mp4"
    )


def chave_de_legenda(prefixo: str, job: dict[str, Any]) -> str:
    """`{prefixo}/{user_id}/{project_id}/{job_id}.srt`.

    Prefixo proprio, pela mesma razao dos outros: a legenda tem ciclo de vida
    diferente do video. Ela e o UNICO objeto do bucket que o app REGRAVA — o
    editor da tela grava por cima da mesma chave — e a unica que precisa
    sobreviver a um reprocessamento para o render continuar reproduzivel. Uma
    regra de bucket escrita para entrada ou saida nao deve alcanca-la.

    Derivada dos ids do proprio job, como a chave de saida: unica por
    construcao, e sem como um job escrever na legenda de outro.
    """
    return conferir_chave(
        f"{prefixo.strip('/')}/{job['user_id']}/{job['project_id']}/{job['id']}.srt"
    )


def chave_de_zip(prefixo: str, item: dict[str, Any]) -> str:
    """`{prefixo}/{user_id}/{project_id}/{zip_id}.zip`.

    Prefixo proprio, pela mesma razao dos outros dois: o pacote vive 7 dias
    (`expire_zips`, migration 0021), a saida vive 30, e a entrada e arquivo de
    desconhecido. Regra de bucket escrita para um prefixo nunca deve alcancar
    outro por acidente.
    """
    return conferir_chave(
        f"{prefixo.strip('/')}/{item['user_id']}/{item['project_id']}/{item['id']}.zip"
    )


class EnvioEmPartes:
    """Um arquivo que o `zipfile` escreve e que sobe direto para o R2.

    POR QUE NAO GRAVAR O ZIP EM DISCO ANTES DE SUBIR: `/work` e **tmpfs**, ou
    seja, RAM (worker/docker-compose.yml). Um pacote de 200 videos sao dezenas
    de gigabytes; ele nao caberia ali nem se o disco fosse disco — e enquanto
    estivesse sendo montado, ocuparia o espaco dos renders que rodam ao lado.

    Entao o ZIP nunca existe inteiro em lugar nenhum: cada video e lido do R2
    em pedacos, escrito no `zipfile`, e o que sai dele vira PARTE de um upload
    multipart assim que passa de `parte_bytes`. O pico de memoria e uma parte
    (8 MB) mais o pedaco em transito, independentemente do tamanho do lote.

    O `zipfile` aceita um destino sem `seek` — ele detecta isso na abertura e
    passa a gravar o tamanho e o CRC DEPOIS de cada arquivo, num "data
    descriptor". Por isso esta classe tem `write` e `tell` e **nao** tem
    `seek`: a ausencia e o que liga aquele modo. O formato continua um ZIP
    normal; todo extrator moderno o le.
    """

    # Minimo do protocolo S3 para parte que nao e a ultima. Abaixo disso o
    # `complete_multipart_upload` recusa o envio inteiro.
    PARTE_MINIMA = 5 * 1024 * 1024

    def __init__(
        self,
        cliente,
        bucket: str,
        chave: str,
        *,
        parte_bytes: int = 8 * 1024 * 1024,
        tipo: str = "application/zip",
    ) -> None:
        conferir_chave(chave)
        self._cliente = cliente
        self._bucket = bucket
        self._chave = chave
        self._parte = max(self.PARTE_MINIMA, int(parte_bytes))
        self._buffer = bytearray()
        self._partes: list[dict[str, Any]] = []
        self._posicao = 0
        self._encerrado = False

        try:
            inicio = cliente.create_multipart_upload(
                Bucket=bucket, Key=chave, ContentType=tipo
            )
        except Exception as erro:  # noqa: BLE001 — botocore levanta varias classes
            raise ErroDeArmazenamento(
                f"nao consegui abrir o envio de {_curta(chave)}: {type(erro).__name__}"
            ) from erro

        self._upload_id = inicio["UploadId"]

    # -- o que o zipfile usa ------------------------------------------------

    def write(self, dados) -> int:
        if self._encerrado:
            raise ErroDeArmazenamento("envio ja encerrado")

        vista = bytes(dados)
        self._buffer.extend(vista)
        self._posicao += len(vista)

        while len(self._buffer) >= self._parte:
            self._enviar(bytes(self._buffer[: self._parte]))
            del self._buffer[: self._parte]

        return len(vista)

    def tell(self) -> int:
        return self._posicao

    def flush(self) -> None:
        """No-op de proposito.

        `flush` aqui nao pode despejar o buffer: uma parte que nao seja a
        ultima precisa ter 5 MB no minimo, e o `zipfile` chama `flush` quando
        lhe convem — inclusive depois de escrever um cabecalho de 60 bytes.
        """

    # -- o que o chamador usa ----------------------------------------------

    def concluir(self) -> int:
        """Fecha o envio e devolve o total de bytes gravados."""
        if self._encerrado:
            return self._posicao

        if self._buffer:
            self._enviar(bytes(self._buffer))
            self._buffer.clear()

        if not self._partes:
            # ZIP vazio nunca deveria chegar aqui (`request_zip` recusa projeto
            # sem video pronto), mas um multipart sem partes e um erro do S3 —
            # e um erro confuso. Melhor falhar com uma frase que se entende.
            self.abortar()
            raise ErroDeArmazenamento("pacote vazio: nada foi gravado")

        try:
            self._cliente.complete_multipart_upload(
                Bucket=self._bucket,
                Key=self._chave,
                UploadId=self._upload_id,
                MultipartUpload={"Parts": self._partes},
            )
        except Exception as erro:  # noqa: BLE001
            self.abortar()
            raise ErroDeArmazenamento(
                f"nao consegui fechar {_curta(self._chave)}: {type(erro).__name__}"
            ) from erro

        self._encerrado = True
        return self._posicao

    def abortar(self) -> None:
        """Desiste do envio. As partes ja enviadas somem com ele.

        Sem isto, um pacote interrompido no meio deixaria partes pagas no
        bucket que nenhum lifecycle de objeto recolhe — multipart pendente e
        invisivel na listagem normal.
        """
        if self._encerrado:
            return
        self._encerrado = True
        try:
            self._cliente.abort_multipart_upload(
                Bucket=self._bucket, Key=self._chave, UploadId=self._upload_id
            )
        except Exception:  # noqa: BLE001 — limpeza nao derruba operacao
            pass

    def _enviar(self, dados: bytes) -> None:
        numero = len(self._partes) + 1
        try:
            saida = self._cliente.upload_part(
                Bucket=self._bucket,
                Key=self._chave,
                UploadId=self._upload_id,
                PartNumber=numero,
                Body=dados,
            )
        except Exception as erro:  # noqa: BLE001
            raise ErroDeArmazenamento(
                f"nao consegui enviar a parte {numero} de {_curta(self._chave)}: "
                f"{type(erro).__name__}"
            ) from erro

        self._partes.append({"ETag": saida["ETag"], "PartNumber": numero})


def ler_em_blocos(cliente, bucket: str, chave: str, *, bloco: int = 1024 * 1024):
    """Gera o conteudo do objeto em pedacos, sem passar por disco.

    Usado pelo empacotador: o video vai do R2 para dentro do ZIP sem nunca
    existir como arquivo no worker. `baixar` continua sendo o caminho do
    render, que precisa do arquivo em disco para o FFmpeg abrir.
    """
    conferir_chave(chave)
    try:
        objeto = cliente.get_object(Bucket=bucket, Key=chave)
    except Exception as erro:  # noqa: BLE001
        raise ErroDeArmazenamento(
            f"nao consegui ler {_curta(chave)}: {type(erro).__name__}"
        ) from erro

    corpo = objeto["Body"]
    try:
        while True:
            pedaco = corpo.read(bloco)
            if not pedaco:
                break
            yield pedaco
    finally:
        corpo.close()


def chave_de_previa(prefixo: str, item: dict[str, Any]) -> str:
    """`{prefixo}/{user_id}/{project_id}/{previa_id}.png`.

    Prefixo proprio, separado da entrada e da saida, pela mesma razao do
    `chave_de_saida`: previa e arquivo DESCARTAVEL, com validade de uma hora, e
    e o unico objeto do bucket que some por decisao do banco (`expire_previews`)
    e nao pelo lifecycle. Misturar os prefixos faria uma regra de expurgo
    escrita para previa alcancar video entregue.
    """
    return conferir_chave(
        f"{prefixo.strip('/')}/{item['user_id']}/{item['project_id']}/{item['id']}.png"
    )


def _curta(chave: str) -> str:
    """A chave contem o id do usuario. No log vai so a ponta."""
    return chave[-40:] if len(chave) > 40 else chave
