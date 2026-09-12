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
