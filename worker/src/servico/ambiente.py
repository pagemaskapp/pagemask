"""Configuracao do worker — toda ela por variavel de ambiente.

Nenhum segredo tem valor padrao, e nenhum aparece em log ou em mensagem de
erro (PLANO §3). Quando falta alguma, o erro diz o NOME da variavel e de onde
ela sai; nunca o valor do que estava la.

O worker le e valida tudo **no comeco**, antes de reclamar o primeiro job. Um
worker que sobe com credencial errada e so descobre no meio do primeiro render
deixa o job pendurado em `processing` ate o zelador da fila o resgatar — falha
cara por uma variavel em branco.
"""
from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent.parent


class ConfiguracaoInvalida(RuntimeError):
    pass


def _texto(nome: str, padrao: str | None = None) -> str:
    valor = os.environ.get(nome, "").strip()
    if valor:
        return valor
    if padrao is not None:
        return padrao
    raise ConfiguracaoInvalida(
        f"{nome} nao esta definida. Veja .env.example na raiz do repositorio."
    )


def _inteiro(nome: str, padrao: int, minimo: int, maximo: int) -> int:
    bruto = os.environ.get(nome, "").strip()
    if not bruto:
        return padrao
    try:
        valor = int(bruto)
    except ValueError as erro:
        raise ConfiguracaoInvalida(f"{nome} precisa ser um numero inteiro.") from erro
    if not minimo <= valor <= maximo:
        raise ConfiguracaoInvalida(f"{nome} precisa estar entre {minimo} e {maximo}.")
    return valor


@dataclass(frozen=True)
class Ambiente:
    # --- Supabase ---------------------------------------------------------
    supabase_url: str
    supabase_secret: str = field(repr=False)

    # --- Cloudflare R2 ----------------------------------------------------
    r2_endpoint: str
    r2_bucket: str
    r2_access_key: str = field(repr=False)
    r2_secret_key: str = field(repr=False)

    # --- Operacao ---------------------------------------------------------
    worker: str = "worker-1"
    concorrencia: int = 2
    max_por_usuario: int = 2
    timeout_s: int = 20 * 60
    intervalo_poll_s: int = 2
    batimento_s: int = 30
    minutos_ate_travado: int = 30
    max_tentativas: int = 3
    graca_s: int = 280
    trabalho: Path = RAIZ / "work"
    prefixo_saida: str = "saida"

    # --- Publicacao (Fase 5) ----------------------------------------------
    # A chave que decifra o token do Instagram. Sem ela o worker sobe e
    # renderiza, mas a thread de publicacao nao e criada — e o log diz isso.
    token_enc_key: bytes | None = field(default=None, repr=False)
    graph_versao: str = "v25.0"
    publicar_poll_s: int = 5
    publicar_max_tentativas: int = 3
    publicar_stale_min: int = 15
    publicar_url_validade_s: int = 2 * 60 * 60

    # --- Previa do editor (Fase 6) ----------------------------------------
    # A previa tem thread propria porque ela tem PRAZO HUMANO: alguem esta
    # olhando a tela esperando. Na fila do render ela esperaria o job de 20
    # minutos que estava na frente, e "previa em segundos" viraria "previa
    # depois do almoco".
    previa_poll_s: int = 2
    previa_stale_min: int = 5
    prefixo_previa: str = "previas"
    # O cache de videos de amostra: os mesmos poucos videos sendo usados
    # repetidamente enquanto alguem ajusta um template — baixar de novo a cada
    # tecla e o que tornaria a previa lenta.
    #
    # O TETO EM MEGABYTES E O QUE IMPORTA, e nao o numero de arquivos. `/work`
    # e um **tmpfs**, ou seja, RAM (docker-compose.yml): com 500 MB por video
    # no plano, "quatro arquivos" seriam 2 GB de memoria comendo o espaco dos
    # renders que rodam ao lado, num tmpfs de 1,5 GB. O numero de arquivos
    # continua existindo como segundo limite, para o cache nao virar uma lista
    # infinita de videos minusculos.
    previa_cache: int = 4
    previa_cache_mb: int = 300

    # --- Pacote do lote (Fase 7) ------------------------------------------
    # O ZIP nao toca o disco: ele e lido do R2 e subido para o R2 em partes
    # (`objetos.EnvioEmPartes`), entao nenhum destes numeros sai do tmpfs. Os
    # tetos existem contra o pacote absurdo — banda e tempo de fila.
    zip_poll_s: int = 5
    zip_stale_min: int = 20
    prefixo_zip: str = "pacotes"
    zip_max_itens: int = 500
    zip_max_gb: int = 20
    zip_timeout_s: int = 30 * 60
    zip_parte_mb: int = 8

    def __post_init__(self) -> None:
        # `repr=False` nos campos de segredo nao basta: `dataclasses.asdict` e o
        # `__str__` de uma excecao que carregue o objeto ignoram isso. A regra
        # de verdade e nunca passar este objeto para log — e o modulo de log
        # (`registro.py`) so aceita valores explicitos, nunca o ambiente.
        if self.concorrencia > self.max_por_usuario * 8:
            raise ConfiguracaoInvalida(
                "WORKER_CONCURRENCY desproporcional ao limite por usuario."
            )

        # O multipart do S3 aceita 10.000 partes, e o tamanho da parte aqui e
        # FIXO. Os dois numeros juntos definem o maior pacote que consegue
        # subir: passando disso, o envio morre na parte 10.001 — depois de
        # horas de transferencia, com uma mensagem do S3 sobre numero de parte
        # que nao sugere em nada onde esta o problema. Melhor recusar a
        # configuracao na partida.
        teto_do_multipart_gb = self.zip_parte_mb * 10_000 // 1024
        if self.zip_max_gb > teto_do_multipart_gb:
            raise ConfiguracaoInvalida(
                f"ZIP_MAX_GB ({self.zip_max_gb}) passa do que ZIP_PARTE_MB "
                f"({self.zip_parte_mb}) consegue subir em 10.000 partes "
                f"({teto_do_multipart_gb} GB). Suba ZIP_PARTE_MB ou baixe "
                "ZIP_MAX_GB."
            )


def carregar() -> Ambiente:
    """Le e valida o ambiente. Levanta `ConfiguracaoInvalida` com o que falta."""
    url = _texto("SUPABASE_URL")
    if not url.startswith("https://"):
        raise ConfiguracaoInvalida("SUPABASE_URL precisa comecar com https://.")

    endpoint = _texto("R2_ENDPOINT")
    if not endpoint.startswith("https://"):
        raise ConfiguracaoInvalida("R2_ENDPOINT precisa comecar com https://.")

    # O nome do worker entra numa chave primaria e em todo log. Sem um padrao
    # estavel, dois conteineres compartilhariam a mesma linha de batimento e o
    # painel mostraria um worker onde ha dois.
    nome = os.environ.get("WORKER_NAME", "").strip() or f"worker-{socket.gethostname()}"

    trabalho = Path(_texto("WORKER_WORKDIR", str(RAIZ / "work")))

    chave_bruta = os.environ.get("TOKEN_ENC_KEY", "").strip()
    token_enc_key: bytes | None = None
    if chave_bruta:
        from .cripto import ChaveInvalida, carregar_chave

        try:
            token_enc_key = carregar_chave(chave_bruta)
        except ChaveInvalida as erro:
            raise ConfiguracaoInvalida(str(erro)) from erro

    graph_versao = _texto("IG_GRAPH_VERSION", "v25.0")
    if not graph_versao.startswith("v") or not graph_versao[1:].replace(".", "").isdigit():
        raise ConfiguracaoInvalida("IG_GRAPH_VERSION precisa ter a forma vNN.N (ex.: v25.0).")

    return Ambiente(
        supabase_url=url.rstrip("/"),
        supabase_secret=_texto("SUPABASE_SERVICE_ROLE_KEY"),
        r2_endpoint=endpoint.rstrip("/"),
        r2_bucket=_texto("R2_BUCKET"),
        r2_access_key=_texto("R2_ACCESS_KEY_ID"),
        r2_secret_key=_texto("R2_SECRET_ACCESS_KEY"),
        worker=nome[:120],
        concorrencia=_inteiro("WORKER_CONCURRENCY", 2, 1, 16),
        max_por_usuario=_inteiro("WORKER_MAX_POR_USUARIO", 2, 1, 16),
        timeout_s=_inteiro("WORKER_TIMEOUT_S", 20 * 60, 30, 4 * 60 * 60),
        intervalo_poll_s=_inteiro("WORKER_POLL_S", 2, 1, 60),
        batimento_s=_inteiro("WORKER_HEARTBEAT_S", 30, 5, 300),
        minutos_ate_travado=_inteiro("WORKER_STALE_MIN", 30, 2, 24 * 60),
        max_tentativas=_inteiro("WORKER_MAX_TENTATIVAS", 3, 1, 10),
        # Combina com o `stop_grace_period` do compose (300 s). Ele passava por
        # um `int()` solto la no `main()`, depois de as threads ja terem
        # subido: um valor nao numerico virava traceback cru dentro de um laco
        # de reinicio, em vez do "configuracao invalida" que todas as outras
        # variaveis produzem ANTES de qualquer job ser reclamado.
        graca_s=_inteiro("WORKER_GRACA_S", 280, 5, 4 * 60 * 60),
        trabalho=trabalho,
        prefixo_saida=_texto("R2_PREFIXO_SAIDA", "saida"),
        token_enc_key=token_enc_key,
        graph_versao=graph_versao,
        publicar_poll_s=_inteiro("PUBLISH_POLL_S", 5, 1, 60),
        publicar_max_tentativas=_inteiro("PUBLISH_MAX_TENTATIVAS", 3, 1, 10),
        # Minimo 11: a espera pelo container vai ate 10 min e renova o claim
        # a cada consulta; um teto menor que isso deixaria dois workers no
        # mesmo agendamento.
        publicar_stale_min=_inteiro("PUBLISH_STALE_MIN", 15, 11, 24 * 60),
        publicar_url_validade_s=_inteiro("PUBLISH_URL_VALIDADE_S", 2 * 60 * 60, 15 * 60, 24 * 60 * 60),
        previa_poll_s=_inteiro("PREVIEW_POLL_S", 2, 1, 60),
        previa_stale_min=_inteiro("PREVIEW_STALE_MIN", 5, 2, 60),
        prefixo_previa=_texto("R2_PREFIXO_PREVIA", "previas"),
        previa_cache=_inteiro("PREVIEW_CACHE", 4, 0, 50),
        previa_cache_mb=_inteiro("PREVIEW_CACHE_MB", 300, 0, 20_000),
        zip_poll_s=_inteiro("ZIP_POLL_S", 5, 1, 60),
        # Minimo 5: a montagem renova o claim a cada 30 s, entao uma janela
        # curta demais so existiria para deixar dois workers no mesmo pacote.
        zip_stale_min=_inteiro("ZIP_STALE_MIN", 20, 5, 24 * 60),
        prefixo_zip=_texto("R2_PREFIXO_ZIP", "pacotes"),
        zip_max_itens=_inteiro("ZIP_MAX_ITENS", 500, 1, 5_000),
        zip_max_gb=_inteiro("ZIP_MAX_GB", 20, 1, 500),
        zip_timeout_s=_inteiro("ZIP_TIMEOUT_S", 30 * 60, 60, 6 * 60 * 60),
        # 5 MB e o minimo do protocolo S3 para parte que nao seja a ultima;
        # abaixo disso o `complete_multipart_upload` recusa o envio inteiro.
        zip_parte_mb=_inteiro("ZIP_PARTE_MB", 8, 5, 128),
    )
