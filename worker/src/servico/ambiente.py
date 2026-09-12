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

    def __post_init__(self) -> None:
        # `repr=False` nos campos de segredo nao basta: `dataclasses.asdict` e o
        # `__str__` de uma excecao que carregue o objeto ignoram isso. A regra
        # de verdade e nunca passar este objeto para log — e o modulo de log
        # (`registro.py`) so aceita valores explicitos, nunca o ambiente.
        if self.concorrencia > self.max_por_usuario * 8:
            raise ConfiguracaoInvalida(
                "WORKER_CONCURRENCY desproporcional ao limite por usuario."
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
    )
