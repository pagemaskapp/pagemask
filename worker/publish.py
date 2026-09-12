"""PageMask — a publicacao no Instagram.

    python publish.py            sozinho (so o laco de publicacao)
    python service.py            junto com o render (o normal em producao)

O cron do app (`/api/cron/publicar`, a cada minuto) vira agendamento vencido em
`publishing`. Este laco reclama um por vez com `claim_publish` (FOR UPDATE SKIP
LOCKED, migration 0019) e faz o resto:

    URL pre-assinada GET do R2 (2 h)  →  POST /media (REELS)
      →  GET status_code com espera crescente (5, 10, 20, 40 s… ate 10 min)
      →  FINISHED: POST /media_publish  →  GET permalink  →  finish_publish

POR QUE O TOKEN E DECIFRADO AQUI, E NAO NO APP
==============================================

A espera pelo container pode levar minutos, e o app roda em funcao com
prazo. O worker ja e o processo de longa duracao do sistema, ja tem a
`service_role` e ja fala com o R2; ganhar a `TOKEN_ENC_KEY` e a consequencia
natural. O token decifrado vive numa variavel local durante a publicacao e em
lugar nenhum depois — nunca em log, nunca na coluna `error`.

O QUE CADA ERRO DA META VIRA (prompt da Fase 5)
===============================================

    token invalido (190/102)        conta `needs_reconnect` + agendamento
                                    `failed` com mensagem de reconectar
    limite de 24 h (9 / 2207042)    `deferred`, reagendado +1 h, sem gastar
                                    tentativa
    container EXPIRED / builder     refaz o container uma vez
    expirado (24 / 2207008)
    video/legenda invalidos         `failed` de vez — o mesmo arquivo daria o
                                    mesmo erro
    rede, 5xx, "tente de novo"      volta para a fila com espera; na terceira
                                    tentativa vira `failed`

A traducao mora em `classificar`, num lugar so. A tabela oficial de codigos
foi conferida em 11/09/2026 (`reference/error-codes`).
"""
from __future__ import annotations

import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.servico import cripto, meta, objetos, registro  # noqa: E402
from src.servico.ambiente import ConfiguracaoInvalida, carregar  # noqa: E402
from src.servico.banco import Banco, ErroDoBanco, JobDeOutroWorker  # noqa: E402

ESPERA_INICIAL_S = 5
ESPERA_MAXIMA_S = 120
ORCAMENTO_DO_CONTAINER_S = 10 * 60
ADIAMENTO_POR_LIMITE = timedelta(hours=1)

# -- mensagens em pt-BR: o que a tela mostra ------------------------------------

MSG = {
    "reconectar": (
        "O Instagram recusou o acesso a esta conta. Reconecte-a em Conectores e "
        "clique em Tentar de novo."
    ),
    "permissao": (
        "A conta foi conectada sem a permissão de publicar. Reconecte-a em "
        "Conectores, aceitando todas as permissões, e clique em Tentar de novo."
    ),
    "limite_24h": (
        "A conta chegou ao limite de publicações pela API nas últimas 24 horas. "
        "A publicação foi adiada em 1 hora e vai sair sozinha quando couber."
    ),
    "limite_app": (
        "O Instagram limitou as chamadas do PageMask por alguns minutos. A "
        "publicação foi adiada em 1 hora e vai sair sozinha."
    ),
    "bloqueio": (
        "O Instagram bloqueou esta publicação como atividade suspeita. Abra o "
        "app do Instagram, confira se há algum aviso na conta e tente de novo "
        "mais tarde."
    ),
    "conta_restrita": (
        "O Instagram restringiu esta conta. Resolva a pendência no app do "
        "Instagram e clique em Tentar de novo."
    ),
    "formato": (
        "O Instagram recusou o arquivo deste vídeo. Reprocesse o vídeo no "
        "projeto e agende de novo."
    ),
    "legenda": "A legenda passou do que o Instagram aceita. Encurte-a e agende de novo.",
    "parametro": (
        "O Instagram recusou os dados desta publicação. Confira a legenda e a "
        "conta, e tente de novo; se continuar, fale com o suporte."
    ),
    "container_expirado": (
        "O Instagram demorou demais para processar o vídeo, duas vezes. Tente "
        "de novo mais tarde."
    ),
    "container_lento": (
        "O Instagram ainda estava processando o vídeo depois de 10 minutos. "
        "Vamos tentar de novo em alguns minutos."
    ),
    "download": (
        "O Instagram não conseguiu baixar o vídeo. Vamos tentar de novo em "
        "alguns minutos."
    ),
    "temporario": "Não conseguimos publicar agora. Vamos tentar de novo automaticamente.",
    "desistiu": (
        "Não conseguimos publicar este vídeo depois de várias tentativas. "
        "Clique em Tentar de novo ou fale com o suporte."
    ),
    "conta_desconectada": (
        "A conta do Instagram deste agendamento foi desconectada. Reconecte-a "
        "em Conectores e agende de novo."
    ),
    "sem_video": "O vídeo deste agendamento não está mais disponível. Agende outro vídeo.",
    "token_indecifravel": (
        "Não conseguimos ler o acesso desta conta. Reconecte-a em Conectores e "
        "clique em Tentar de novo."
    ),
    "interrompido": (
        "A publicação foi interrompida vezes demais. Clique em Tentar de novo "
        "ou fale com o suporte."
    ),
}


# -- desfechos -------------------------------------------------------------------


class Desfecho(Exception):
    def __init__(self, mensagem: str) -> None:
        super().__init__(mensagem)
        self.mensagem = mensagem


class Reconectar(Desfecho):
    """A Meta recusou o token: conta `needs_reconnect`, agendamento `failed`."""


class Adiar(Desfecho):
    def __init__(self, mensagem: str, ate: datetime) -> None:
        super().__init__(mensagem)
        self.ate = ate


class Definitivo(Desfecho):
    """`failed` de vez: repetir daria o mesmo resultado."""


class TentarDepois(Desfecho):
    def __init__(self, mensagem: str, espera_s: int = 60, *, limpar_container: bool = False) -> None:
        super().__init__(mensagem)
        self.espera_s = espera_s
        # Container em ERROR e terminal: a proxima tentativa precisa criar
        # outro. Container so lento (IN_PROGRESS) e mantido.
        self.limpar_container = limpar_container


class RefazerContainer(Exception):
    """Container morto (EXPIRED, builder expirado): cria outro e segue."""


def classificar(erro: meta.ErroDaMeta) -> Desfecho | RefazerContainer:
    """Um erro da Meta vira exatamente um desfecho. A tabela esta no cabecalho."""
    if erro.origem in ("rede", "formato"):
        return TentarDepois(MSG["temporario"], 60)

    c, s = erro.codigo, erro.subcodigo

    if c in (190, 102):
        return Reconectar(MSG["reconectar"])
    if c in (10, 200, 803) or (erro.tipo == "OAuthException" and c == 100 and s == 33):
        return Reconectar(MSG["permissao"])

    if c == 9 or s == 2207042:
        return Adiar(MSG["limite_24h"], _agora() + ADIAMENTO_POR_LIMITE)
    if s == 2207051:
        return Definitivo(MSG["bloqueio"])
    if c in (4, 17, 32, 613):
        return Adiar(MSG["limite_app"], _agora() + ADIAMENTO_POR_LIMITE)

    if s in (2207008, 2207020) or c == 24:
        return RefazerContainer()
    if c == 25 or s == 2207050:
        return Definitivo(MSG["conta_restrita"])
    if c == 352 or s in (2207026, 2207005):
        return Definitivo(MSG["formato"])
    if c == 36004 or s == 2207010:
        return Definitivo(MSG["legenda"])
    if c == 9004 or s in (2207052, 2207003, 2207004):
        return TentarDepois(MSG["download"], 120)
    if c == 9007 or s == 2207027:
        return TentarDepois(MSG["container_lento"], 60)
    if c in (-1, -2, 1, 2) or s in (2207001, 2207032, 2207053):
        return TentarDepois(MSG["temporario"], 120)
    if c == 100:
        return Definitivo(MSG["parametro"])

    return TentarDepois(MSG["temporario"], 120)


def classificar_status(status: str | None) -> Desfecho | RefazerContainer:
    """`status_code == ERROR`: o subcodigo vem dentro do texto de `status`."""
    sub = meta.subcodigo_do_status(status)
    if sub is None:
        return TentarDepois(MSG["temporario"], 120)
    return classificar(meta.ErroDaMeta("meta", status or "erro no container", subcodigo=sub))


# -- o trabalho ------------------------------------------------------------------


def publicar(item: dict[str, Any], *, amb, banco: Banco, r2, graph: meta.Graph,
             parar: threading.Event) -> None:
    """Uma publicacao ja reclamada. Sempre termina em algum estado."""
    sid = str(item["schedule_id"])
    tentativa = int(item["attempts"])
    conta = str(item["ig_account_id"])
    inicio = time.monotonic()

    def gravar(chamada) -> bool:
        try:
            chamada()
            return True
        except JobDeOutroWorker:
            registro.evento("publicar", resultado="abandonado", job_id=sid,
                            motivo="o claim expirou e outro worker assumiu")
            return False

    try:
        media_id, permalink = _rodar(item, amb=amb, banco=banco, r2=r2, graph=graph, parar=parar)

    except Reconectar as d:
        registro.evento("publicar", resultado="reconectar", job_id=sid,
                        duracao_s=time.monotonic() - inicio, conta=conta)
        # Marca a conta ANTES de falhar o agendamento: e o estado da conta que
        # faz a tela pedir a reconexao e a agenda parar de aceitar essa conta.
        try:
            banco.marcar_reconectar(conta)
        except ErroDoBanco as erro:
            registro.evento("reconectar", resultado="erro", job_id=sid, mensagem=str(erro))
        gravar(lambda: banco.falhar_publicacao(sid, tentativa, d.mensagem, definitivo=True,
                                               max_tentativas=amb.publicar_max_tentativas))

    except Adiar as d:
        registro.evento("publicar", resultado="deferred", job_id=sid,
                        duracao_s=time.monotonic() - inicio, ate=d.ate.isoformat())
        gravar(lambda: banco.adiar_publicacao(sid, tentativa, d.ate.isoformat(), d.mensagem))

    except Definitivo as d:
        registro.evento("publicar", resultado="failed", job_id=sid,
                        duracao_s=time.monotonic() - inicio, motivo=d.mensagem)
        gravar(lambda: banco.falhar_publicacao(sid, tentativa, d.mensagem, definitivo=True,
                                               max_tentativas=amb.publicar_max_tentativas))

    except TentarDepois as d:
        ultima = tentativa >= amb.publicar_max_tentativas
        registro.evento("publicar", resultado="failed" if ultima else "retry", job_id=sid,
                        duracao_s=time.monotonic() - inicio, motivo=d.mensagem,
                        tentativa=tentativa, espera_s=d.espera_s)
        gravar(lambda: banco.falhar_publicacao(
            sid, tentativa, MSG["desistiu"] if ultima else d.mensagem,
            definitivo=False, max_tentativas=amb.publicar_max_tentativas,
            espera_s=d.espera_s, limpar_container=d.limpar_container))

    except JobDeOutroWorker:
        registro.evento("publicar", resultado="abandonado", job_id=sid,
                        duracao_s=time.monotonic() - inicio)

    except Exception as erro:  # noqa: BLE001 — o ultimo anteparo
        ultima = tentativa >= amb.publicar_max_tentativas
        registro.evento("publicar", resultado="erro", job_id=sid,
                        duracao_s=time.monotonic() - inicio,
                        erro=type(erro).__name__, mensagem=str(erro), tentativa=tentativa)
        gravar(lambda: banco.falhar_publicacao(
            sid, tentativa, MSG["desistiu"] if ultima else MSG["temporario"],
            definitivo=False, max_tentativas=amb.publicar_max_tentativas, espera_s=120))

    else:
        registro.evento("publicar", resultado="published", job_id=sid,
                        duracao_s=time.monotonic() - inicio,
                        media_id=media_id, permalink=permalink, tentativa=tentativa)


def _rodar(item: dict[str, Any], *, amb, banco: Banco, r2, graph: meta.Graph,
           parar: threading.Event) -> tuple[str, str | None]:
    sid = str(item["schedule_id"])
    tentativa = int(item["attempts"])
    ig_user_id = str(item["ig_user_id"])

    # --- 0. tem como publicar? -----------------------------------------------
    if item.get("account_status") == "revoked" or not item.get("cipher_hex"):
        raise Definitivo(MSG["conta_desconectada"])
    if tentativa > amb.publicar_max_tentativas:
        # Claim expirado e refeito vezes demais: o worker morre no meio toda
        # vez. Insistir mais so ocuparia a fila.
        raise Definitivo(MSG["interrompido"])
    chave = item.get("r2_output_key")
    if not isinstance(chave, str) or not chave:
        raise Definitivo(MSG["sem_video"])

    try:
        token = cripto.decifrar(
            amb.token_enc_key, str(item["cipher_hex"]), str(item["iv_hex"]),
            str(item["tag_hex"]), ig_user_id,
        )
    except cripto.TokenIndecifravel as erro:
        # Problema nosso (chave rotacionada?) ou linha adulterada. O motivo
        # tecnico vai para o log; para a pessoa, o caminho que resolve.
        registro.evento("decifrar", resultado="erro", job_id=sid, mensagem=str(erro))
        raise Definitivo(MSG["token_indecifravel"]) from erro

    # --- 1. a URL que a Meta vai baixar ---------------------------------------
    video_url = objetos.url_de_leitura(r2, amb.r2_bucket, chave,
                                       validade_s=amb.publicar_url_validade_s)

    # --- 2. container → FINISHED (refazendo uma vez se ele morrer) ------------
    container = item.get("ig_container_id") if isinstance(item.get("ig_container_id"), str) else None
    refeitos = 0

    while True:
        try:
            if not container:
                with registro.Cronometro("container", job_id=sid):
                    container = _na_meta(sid, lambda: graph.criar_container_reels(
                        ig_user_id, token, video_url=video_url,
                        caption=item.get("caption") or None, share_to_feed=True,
                    ))
                if not banco.container_registrado(sid, tentativa, container):
                    raise JobDeOutroWorker("o claim expirou durante a criacao do container", "PM016")

            codigo = _esperar_container(graph, banco, container, token, sid, tentativa, parar)

            if codigo == "PUBLISHED":
                # Ja publicado numa tentativa anterior que morreu depois do
                # media_publish. Nao ha como pedir o media id a Meta por aqui;
                # registra com o id do container e sem permalink.
                registro.evento("container", resultado="ja-publicado", job_id=sid,
                                container=container)
                banco.concluir_publicacao(sid, tentativa, container, None)
                return container, None

            # FINISHED
            with registro.Cronometro("media_publish", job_id=sid):
                media_id = _na_meta(sid, lambda: graph.publicar(ig_user_id, token, container))
            break

        except RefazerContainer:
            # Container morto — EXPIRED no status, ou "builder expirado" na
            # publicacao. Uma segunda chance, e so uma: o mesmo video que
            # expirou duas vezes nao vai processar na terceira.
            refeitos += 1
            if refeitos > 1:
                raise Definitivo(MSG["container_expirado"])
            registro.evento("container", resultado="refazer", job_id=sid, container=container)
            container = None
            continue

    # --- 3. o permalink e a conclusao -----------------------------------------
    permalink: str | None = None
    try:
        permalink = graph.permalink(media_id, token)
    except meta.ErroDaMeta as erro:
        # Publicou. O link e cortesia; sem ele o historico mostra o id.
        registro.evento("permalink", resultado="erro", job_id=sid, mensagem=str(erro))

    banco.concluir_publicacao(sid, tentativa, media_id, permalink)
    return media_id, permalink


def _na_meta(sid: str, chamada):
    """Uma chamada a Meta, com o erro ja traduzido em desfecho.

    A traducao acontece AQUI, na fronteira, e nao em cada `except` do laco: o
    laco so precisa conhecer `RefazerContainer`, e todo outro desfecho sobe
    inteiro ate `publicar`.
    """
    try:
        return chamada()
    except meta.ErroDaMeta as erro:
        registro.evento("meta", resultado="erro", job_id=sid, mensagem=str(erro))
        raise classificar(erro) from erro


# Renova o claim no maximo a cada minuto: basta para um claim de 15 min nunca
# parecer abandonado, sem um UPDATE no banco a cada consulta de status.
BATIMENTO_DO_CLAIM_S = 60


def _esperar_container(graph: meta.Graph, banco: Banco, container: str, token: str,
                       sid: str, tentativa: int, parar: threading.Event) -> str:
    """Espera crescente ate FINISHED/PUBLISHED. ERROR e EXPIRED levantam."""
    inicio = time.monotonic()
    ultimo_batimento = inicio
    espera = ESPERA_INICIAL_S

    while True:
        codigo, status = _na_meta(sid, lambda: graph.status_do_container(container, token))
        registro.evento("status", resultado=codigo.lower(), job_id=sid,
                        container=container, espera_s=espera)

        if codigo in ("FINISHED", "PUBLISHED"):
            return codigo
        if codigo == "EXPIRED":
            raise RefazerContainer()
        if codigo == "ERROR":
            desfecho = classificar_status(status)
            if isinstance(desfecho, TentarDepois):
                desfecho.limpar_container = True
            raise desfecho

        if time.monotonic() - inicio > ORCAMENTO_DO_CONTAINER_S:
            raise TentarDepois(MSG["container_lento"], 300)

        if parar.wait(espera):
            # Desligamento: o claim expira sozinho e outro worker retoma.
            raise JobDeOutroWorker("worker desligando durante a espera", "PM016")
        espera = min(espera * 2, ESPERA_MAXIMA_S)

        # Batimento do claim: sem isto, 10 min de espera fariam o claim
        # parecer abandonado e outro worker criaria um segundo container.
        if time.monotonic() - ultimo_batimento >= BATIMENTO_DO_CLAIM_S:
            ultimo_batimento = time.monotonic()
            if not banco.container_registrado(sid, tentativa, container):
                raise JobDeOutroWorker("o claim expirou durante a espera", "PM016")


def _agora() -> datetime:
    return datetime.now(timezone.utc)


# -- o laco ---------------------------------------------------------------------


def publicador(amb, banco: Banco, r2, parar: threading.Event, nome: str) -> None:
    """A thread de publicacao. Uma por conteiner basta: a espera e I/O."""
    graph = meta.Graph(amb.graph_versao)
    registro.evento("publicador", resultado="ok", worker=nome,
                    poll_s=amb.publicar_poll_s, graph=amb.graph_versao)

    while not parar.is_set():
        try:
            item = banco.reclamar_publicacao(nome, amb.publicar_stale_min)
        except ErroDoBanco as erro:
            registro.evento("reclamar_publicacao", resultado="erro", worker=nome,
                            mensagem=str(erro))
            parar.wait(min(30, amb.publicar_poll_s * 5))
            continue

        if item is None:
            parar.wait(amb.publicar_poll_s)
            continue

        registro.evento("reclamar_publicacao", resultado="ok", worker=nome,
                        job_id=str(item["schedule_id"]), tentativa=item.get("attempts"),
                        username=item.get("username"))

        # O mesmo anteparo do laco de render (`service.py`): o tratador de
        # `publicar` fala com o banco de dentro de um `except`, e uma
        # indisponibilidade ali nao pode matar a thread em silencio.
        try:
            publicar(item, amb=amb, banco=banco, r2=r2, graph=graph, parar=parar)
        except Exception as erro:  # noqa: BLE001
            registro.evento("publicador", resultado="erro", worker=nome,
                            job_id=str(item["schedule_id"]),
                            erro=type(erro).__name__, mensagem=str(erro))
            parar.wait(min(30, amb.publicar_poll_s * 5))

    graph.fechar()


def main() -> int:
    try:
        amb = carregar()
    except ConfiguracaoInvalida as erro:
        print(f"configuracao invalida: {erro}", file=sys.stderr, flush=True)
        return 2

    if not amb.token_enc_key:
        print("TOKEN_ENC_KEY nao esta definida: sem ela nao ha como publicar.",
              file=sys.stderr, flush=True)
        return 2

    parar = threading.Event()

    def pedir_parada(numero, _quadro):
        registro.evento("parada", resultado="ok", worker=amb.worker, sinal=int(numero))
        parar.set()

    signal.signal(signal.SIGTERM, pedir_parada)
    signal.signal(signal.SIGINT, pedir_parada)

    banco = Banco(amb.supabase_url, amb.supabase_secret)
    r2 = objetos.cliente_r2(amb.r2_endpoint, amb.r2_access_key, amb.r2_secret_key)

    thread = threading.Thread(
        target=publicador, args=(amb, banco, r2, parar, f"{amb.worker}#pub"),
        name="publicacao", daemon=True,
    )
    thread.start()

    try:
        while not parar.is_set():
            parar.wait(1)
    except KeyboardInterrupt:
        parar.set()

    thread.join(timeout=amb.graca_s)
    if not thread.is_alive():
        banco.fechar()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
