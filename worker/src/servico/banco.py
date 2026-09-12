"""Conversa com o Postgres do Supabase, sempre por RPC.

POR QUE RPC, E NAO SQL DIRETO
=============================

O worker poderia abrir uma conexao Postgres com a senha do banco. Nao abre, por
duas razoes que se somam:

1. **Superficie.** A `service_role` fala com o PostgREST e so alcanca o que tem
   `grant execute`. A senha do banco alcanca o banco inteiro, inclusive
   `auth.users`. O worker roda um decodificador de video em cima de arquivo de
   desconhecido — e o processo que menos deveria segurar a chave mestra.

2. **A regra fica num lugar so.** Limite por usuario, devolucao de credito e
   teto de tentativas moram nas funcoes da migration 0015, e nao aqui. Um
   worker com SQL solto teria a sua propria copia dessas regras, e as duas
   copias divergem na primeira vez que alguem corrigir uma so.

O QUE E IDEMPOTENTE E O QUE NAO E
=================================

Toda funcao de conclusao confere `attempts` (a "senha de porteiro" da 0015).
Isso da uma propriedade util: repetir um `finish_job` que ja funcionou levanta
`PM016`, e nao grava nada duas vezes. Por isso essas chamadas podem ser
repetidas quando a REDE falha, e `PM016` na repeticao significa "ja foi".

`claim_job` e a excecao e **nunca** e repetida. Se a resposta se perder depois
de o servidor ter reclamado o job, repetir reclamaria um SEGUNDO job e o
primeiro ficaria orfao em `processing`. Melhor perder o ciclo: o zelador
(`requeue_stale_jobs`) devolve o orfao para a fila em poucos minutos.
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from . import registro


class ErroDoBanco(RuntimeError):
    """Falha vinda do PostgREST. `codigo` e o SQLSTATE quando existe."""

    def __init__(self, mensagem: str, codigo: str | None = None, http: int = 0) -> None:
        super().__init__(mensagem)
        self.codigo = codigo
        self.http = http


class JobDeOutroWorker(ErroDoBanco):
    """`PM016` — o job saiu das maos deste worker (zelador, ou reinicio)."""


class Banco:
    def __init__(self, url: str, secret: str, *, timeout_s: float = 20.0) -> None:
        self._url = url.rstrip("/")
        self._cliente = httpx.Client(
            base_url=f"{self._url}/rest/v1",
            headers={
                "apikey": secret,
                "Authorization": f"Bearer {secret}",
                "Content-Type": "application/json",
                # `return=representation` nao serve para RPC; o que decide o
                # formato aqui e o proprio retorno da funcao.
                "Accept": "application/json",
            },
            timeout=httpx.Timeout(timeout_s, connect=10.0),
        )

    def fechar(self) -> None:
        self._cliente.close()

    # -- transporte ---------------------------------------------------------

    def _chamar(
        self,
        funcao: str,
        argumentos: dict[str, Any],
        *,
        tentativas: int = 1,
        timeout_s: float | None = None,
    ) -> Any:
        ultimo: Exception | None = None

        for tentativa in range(1, tentativas + 1):
            try:
                resposta = self._cliente.post(
                    f"/rpc/{funcao}",
                    json=argumentos,
                    timeout=timeout_s if timeout_s is not None else httpx.USE_CLIENT_DEFAULT,
                )
            except httpx.HTTPError as erro:
                ultimo = erro
                if tentativa < tentativas:
                    time.sleep(min(2 ** tentativa, 8))
                    continue
                raise ErroDoBanco(f"rede: {type(erro).__name__}") from erro

            if resposta.status_code < 300:
                if not resposta.content:
                    return None
                return resposta.json()

            codigo, mensagem = _detalhe(resposta)

            # `PM027` (previa, 0020) e `PM030` (pacote, 0021) sao o `PM016` das
            # outras duas filas: mesma semantica, codigo diferente para o log
            # distinguir de onde veio.
            if codigo in ("PM016", "PM027", "PM030"):
                raise JobDeOutroWorker(mensagem, codigo, resposta.status_code)

            # 5xx e 408 sao do caminho, nao do pedido: vale repetir. 4xx de
            # regra (quota, job de outro worker) nao melhora com insistencia.
            recuperavel = resposta.status_code >= 500 or resposta.status_code == 408
            if recuperavel and tentativa < tentativas:
                time.sleep(min(2 ** tentativa, 8))
                continue

            raise ErroDoBanco(mensagem, codigo, resposta.status_code)

        raise ErroDoBanco(f"rede: {ultimo}")

    # -- fila ---------------------------------------------------------------

    def reclamar(self, worker: str, max_por_usuario: int) -> dict[str, Any] | None:
        """Um job, ou `None` quando nao ha o que fazer.

        `claim_job` devolve um COMPOSTO, e composto vazio nao e lista vazia:
        vem um objeto com todos os campos nulos. Ler `rows.length` aqui daria
        "tem job" para sempre. O que decide e o `id`.
        """
        dados = self._chamar(
            "claim_job",
            {"p_worker": worker, "p_max_por_usuario": max_por_usuario},
            tentativas=1,
        )
        if isinstance(dados, list):
            dados = dados[0] if dados else None
        if not isinstance(dados, dict) or not dados.get("id"):
            return None
        return dados

    def progresso(self, job_id: str, tentativa: int, valor: int) -> bool | None:
        """`True` gravou · `False` o job nao e mais deste worker · `None` nao deu.

        Os tres casos sao diferentes e quem chama precisa saber qual foi.
        `False` vem do banco e e uma informacao dura (o `attempts` nao bate
        mais); `None` e so falta de rede, e nao diz nada sobre o job.
        Confundir os dois abortaria um render bom por causa de um POST perdido.
        """

        try:
            return bool(
                self._chamar(
                    "job_progress",
                    {"p_job_id": job_id, "p_attempt": tentativa, "p_progress": int(valor)},
                    tentativas=1,
                    # Prazo curto, e uma tentativa so. Esta chamada acontece
                    # DENTRO do laco que le o `-progress` do FFmpeg: uma espera
                    # longa aqui trava a leitura do pipe, e um banco lento
                    # passaria a empurrar o job na direcao do proprio timeout
                    # de 20 minutos. Progresso e cosmetico; render nao e.
                    timeout_s=5.0,
                )
            )
        except ErroDoBanco as erro:
            # Progresso e cosmetico: perder um tique nao pode derrubar o render
            # que ja esta a dez minutos de trabalho.
            registro.evento("progresso", resultado="erro", job_id=job_id,
                            mensagem=str(erro))
            return None

    def probe(self, job_id: str, tentativa: int, probe: dict[str, Any]) -> bool:
        """Grava o `ffprobe` logo depois da lista fechada (migration 0017).

        Antes do render, de proposito: se o render falhar, a prova de que o
        arquivo passou na lista fechada ja esta gravada.
        """
        return bool(
            self._chamar(
                "job_probe",
                {"p_job_id": job_id, "p_attempt": tentativa, "p_probe": probe},
                tentativas=2,
            )
        )

    def concluir(
        self,
        job_id: str,
        tentativa: int,
        chave_saida: str,
        relatorio: dict[str, Any],
        probe: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "finish_job",
                {
                    "p_job_id": job_id,
                    "p_attempt": tentativa,
                    "p_output_key": chave_saida,
                    "p_report": relatorio,
                    "p_probe": probe,
                },
                tentativas=3,
            )
        )

    def falhar(
        self,
        job_id: str,
        tentativa: int,
        mensagem: str,
        *,
        definitivo: bool = False,
        max_tentativas: int = 3,
        espera_s: int = 0,
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "fail_job",
                {
                    "p_job_id": job_id,
                    "p_attempt": tentativa,
                    "p_mensagem": mensagem,
                    "p_definitivo": definitivo,
                    "p_max": max_tentativas,
                    "p_espera_s": espera_s,
                },
                tentativas=3,
            )
        )

    def recusar(
        self,
        job_id: str,
        tentativa: int,
        mensagem: str,
        probe: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "reject_job",
                {
                    "p_job_id": job_id,
                    "p_attempt": tentativa,
                    "p_mensagem": mensagem,
                    "p_probe": probe,
                },
                tentativas=3,
            )
        )

    def resgatar_travados(self, minutos: int, max_tentativas: int) -> list[dict[str, Any]]:
        dados = self._chamar(
            "requeue_stale_jobs",
            {"p_minutos": minutos, "p_max": max_tentativas},
            tentativas=2,
        )
        return dados if isinstance(dados, list) else []

    # -- publicacao (migration 0019) ---------------------------------------

    def reclamar_publicacao(self, worker: str, stale_min: int) -> dict[str, Any] | None:
        """Um agendamento `publishing`, ou `None`. Nunca repetida (ver `reclamar`)."""
        dados = self._chamar(
            "claim_publish",
            {"p_worker": worker, "p_stale_min": int(stale_min)},
            tentativas=1,
        )
        if isinstance(dados, list):
            dados = dados[0] if dados else None
        if not isinstance(dados, dict) or not dados.get("schedule_id"):
            return None
        return dados

    def container_registrado(self, schedule_id: str, tentativa: int, container_id: str) -> bool:
        """Guarda o id do container e renova o claim. `False` = nao e mais nosso."""
        return bool(
            self._chamar(
                "publish_container",
                {"p_id": schedule_id, "p_attempt": tentativa, "p_container_id": container_id},
                tentativas=2,
                timeout_s=10.0,
            )
        )

    def concluir_publicacao(
        self, schedule_id: str, tentativa: int, media_id: str, permalink: str | None
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "finish_publish",
                {
                    "p_id": schedule_id,
                    "p_attempt": tentativa,
                    "p_media_id": media_id,
                    "p_permalink": permalink,
                },
                tentativas=3,
            )
        )

    def falhar_publicacao(
        self,
        schedule_id: str,
        tentativa: int,
        mensagem: str,
        *,
        definitivo: bool = False,
        max_tentativas: int = 3,
        espera_s: int = 0,
        limpar_container: bool = False,
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "fail_publish",
                {
                    "p_id": schedule_id,
                    "p_attempt": tentativa,
                    "p_mensagem": mensagem,
                    "p_definitivo": definitivo,
                    "p_max": max_tentativas,
                    "p_espera_s": espera_s,
                    "p_limpar_container": limpar_container,
                },
                tentativas=3,
            )
        )

    def adiar_publicacao(
        self, schedule_id: str, tentativa: int, ate_iso: str, mensagem: str
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "defer_publish",
                {"p_id": schedule_id, "p_attempt": tentativa, "p_ate": ate_iso, "p_mensagem": mensagem},
                tentativas=3,
            )
        )

    def marcar_reconectar(self, account_id: str) -> bool:
        """`True` so quando ESTA chamada mudou a conta para `needs_reconnect`."""
        return bool(
            self._chamar("mark_ig_needs_reconnect", {"p_account_id": account_id}, tentativas=2)
        )

    # -- previa do editor (migration 0020) ---------------------------------

    def reclamar_previa(self, worker: str, stale_min: int) -> dict[str, Any] | None:
        """Uma previa, ou `None`. Nunca repetida (mesma razao de `reclamar`).

        `claim_preview` devolve um CONJUNTO (`returns table`), nao um composto:
        vazio aqui e lista vazia de verdade, e nao um objeto de campos nulos.
        """
        dados = self._chamar(
            "claim_preview",
            {"p_worker": worker, "p_stale_min": int(stale_min)},
            tentativas=1,
        )
        if isinstance(dados, list):
            dados = dados[0] if dados else None
        if not isinstance(dados, dict) or not dados.get("id"):
            return None
        return dados

    def concluir_previa(self, previa_id: str, tentativa: int, chave: str) -> dict[str, Any]:
        return _um(
            self._chamar(
                "finish_preview",
                {"p_id": previa_id, "p_attempt": tentativa, "p_key": chave},
                tentativas=3,
            )
        )

    def falhar_previa(self, previa_id: str, tentativa: int, mensagem: str) -> dict[str, Any]:
        return _um(
            self._chamar(
                "fail_preview",
                {"p_id": previa_id, "p_attempt": tentativa, "p_mensagem": mensagem},
                tentativas=3,
            )
        )

    def expurgar_previas(self, maximo: int = 200) -> list[str]:
        """Apaga as linhas vencidas e devolve as chaves dos PNGs a remover."""
        dados = self._chamar("expire_previews", {"p_max": int(maximo)}, tentativas=2)
        if not isinstance(dados, list):
            return []
        return [
            linha["r2_key"]
            for linha in dados
            if isinstance(linha, dict) and isinstance(linha.get("r2_key"), str)
        ]

    # -- pacote do lote (migration 0021) -----------------------------------

    def reclamar_zip(self, worker: str, stale_min: int) -> dict[str, Any] | None:
        """Um pacote, ou `None`. Nunca repetida (mesma razao de `reclamar`).

        `claim_zip` devolve um CONJUNTO (`returns table`), nao um composto:
        vazio aqui e lista vazia de verdade.
        """
        dados = self._chamar(
            "claim_zip",
            {"p_worker": worker, "p_stale_min": int(stale_min)},
            tentativas=1,
        )
        if isinstance(dados, list):
            dados = dados[0] if dados else None
        if not isinstance(dados, dict) or not dados.get("id"):
            return None
        return dados

    def itens_do_zip(self, zip_id: str) -> list[dict[str, Any]]:
        """Os videos prontos que entram no pacote.

        Vem do banco, e nao do worker: o pacote so conhece o proprio id, e a
        funcao resolve o projeto e o dono a partir da linha. Nao ha caminho em
        que um pacote empacote a saida de outro usuario.
        """
        dados = self._chamar("zip_items", {"p_zip_id": zip_id}, tentativas=3)
        if not isinstance(dados, list):
            return []
        return [linha for linha in dados if isinstance(linha, dict) and linha.get("r2_key")]

    def bater_zip(self, zip_id: str, tentativa: int) -> bool | None:
        """Renova o claim. `False` = o pacote nao e mais deste worker.

        Os tres retornos sao os de `progresso`, e pela mesma razao: `False` vem
        do banco e e informacao dura; `None` e so falta de rede, e abortar um
        pacote de 20 minutos por causa de um POST perdido seria caro e errado.
        """
        try:
            return bool(
                self._chamar(
                    "zip_beat",
                    {"p_id": zip_id, "p_attempt": tentativa},
                    tentativas=1,
                    timeout_s=10.0,
                )
            )
        except ErroDoBanco as erro:
            registro.evento("zip_batimento", resultado="erro", zip_id=zip_id,
                            mensagem=str(erro))
            return None

    def concluir_zip(
        self, zip_id: str, tentativa: int, chave: str, bytes_totais: int, videos: int
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "finish_zip",
                {
                    "p_id": zip_id,
                    "p_attempt": tentativa,
                    "p_key": chave,
                    "p_bytes": int(bytes_totais),
                    "p_videos": int(videos),
                },
                tentativas=3,
            )
        )

    def falhar_zip(
        self, zip_id: str, tentativa: int, mensagem: str, *, definitivo: bool = False
    ) -> dict[str, Any]:
        return _um(
            self._chamar(
                "fail_zip",
                {
                    "p_id": zip_id,
                    "p_attempt": tentativa,
                    "p_mensagem": mensagem,
                    "p_definitivo": definitivo,
                },
                tentativas=3,
            )
        )

    def expurgar_zips(self, maximo: int = 200) -> list[str]:
        """Apaga as linhas vencidas e devolve as chaves dos .zip a remover."""
        dados = self._chamar("expire_zips", {"p_max": int(maximo)}, tentativas=2)
        if not isinstance(dados, list):
            return []
        return [
            linha["r2_key"]
            for linha in dados
            if isinstance(linha, dict) and isinstance(linha.get("r2_key"), str)
        ]

    def bater(self, worker: str, ffmpeg: str | None, jobs_done: int) -> None:
        self._chamar(
            "worker_beat",
            {"p_worker": worker, "p_ffmpeg": ffmpeg, "p_jobs_done": int(jobs_done)},
            tentativas=2,
        )


def _um(dados: Any) -> dict[str, Any]:
    if isinstance(dados, list):
        dados = dados[0] if dados else {}
    return dados if isinstance(dados, dict) else {}


def _detalhe(resposta: httpx.Response) -> tuple[str | None, str]:
    """Codigo e mensagem do PostgREST — sem nunca devolver o corpo cru.

    O corpo de um erro pode conter trecho de instrucao SQL, e instrucao SQL
    pode conter dado do usuario. O que sai daqui vai para o log e, as vezes,
    para a coluna `error` que a tela mostra.
    """
    try:
        corpo = resposta.json()
    except ValueError:
        return None, f"HTTP {resposta.status_code}"

    if not isinstance(corpo, dict):
        return None, f"HTTP {resposta.status_code}"

    codigo = corpo.get("code")
    mensagem = corpo.get("message") or f"HTTP {resposta.status_code}"
    return (codigo if isinstance(codigo, str) else None), str(mensagem)[:300]
