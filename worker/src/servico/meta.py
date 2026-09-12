"""O Content Publishing da Instagram API with Instagram Login.

Os quatro endpoints, conferidos na documentacao oficial em 11/09/2026, todos
em `graph.instagram.com` com a versao presa:

    POST /{ig_user_id}/media                     media_type=REELS, video_url,
                                                 caption, share_to_feed
    GET  /{container_id}?fields=status_code,status
    POST /{ig_user_id}/media_publish             creation_id
    GET  /{media_id}?fields=permalink

O que a conferencia devolveu e que muda o codigo:

  · `status_code` e um de EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED. O
    container vale 24 h; `status`, quando `ERROR`, traz o subcodigo do erro
    (`Error: ... 2207026`), e e por ele que a falha e traduzida.
  · A Meta BAIXA o video pela `video_url`: a URL precisa estar acessivel
    publicamente na hora — dai a URL pre-assinada de 2 h do R2.
  · A conta pode publicar 100 posts pela API por janela movel de 24 h. Passou
    disso, `code 9` / subcodigo 2207042.
  · O token vai no cabecalho `Authorization: Bearer`, nunca na query: query
    string entra em log de proxy e em historico de intermediario.

A resposta de erro tem o formato `{"error": {"message", "type", "code",
"error_subcode", "fbtrace_id"}}`. Tudo vira `ErroDaMeta`, com o token redigido
da mensagem caso a Meta o ecoe.
"""
from __future__ import annotations

import re
from typing import Any

import httpx

HOST = "https://graph.instagram.com"


class ErroDaMeta(Exception):
    """`origem`: `rede` (nao chegou la) · `meta` (ela recusou) · `formato`."""

    def __init__(
        self,
        origem: str,
        mensagem: str,
        *,
        codigo: int | None = None,
        subcodigo: int | None = None,
        tipo: str | None = None,
        http: int = 0,
    ) -> None:
        super().__init__(mensagem)
        self.origem = origem
        self.mensagem = mensagem
        self.codigo = codigo
        self.subcodigo = subcodigo
        self.tipo = tipo
        self.http = http

    def __str__(self) -> str:
        partes = [self.origem]
        if self.codigo is not None:
            partes.append(f"code={self.codigo}")
        if self.subcodigo is not None:
            partes.append(f"subcode={self.subcodigo}")
        if self.tipo:
            partes.append(self.tipo)
        return f"[{' '.join(partes)}] {self.mensagem}"


class Graph:
    def __init__(self, versao: str, *, timeout_s: float = 30.0) -> None:
        self._cliente = httpx.Client(
            base_url=f"{HOST}/{versao}",
            timeout=httpx.Timeout(timeout_s, connect=10.0),
            headers={"Accept": "application/json"},
        )

    def fechar(self) -> None:
        self._cliente.close()

    # -- os quatro endpoints ---------------------------------------------

    def criar_container_reels(
        self,
        ig_user_id: str,
        token: str,
        *,
        video_url: str,
        caption: str | None,
        share_to_feed: bool = True,
    ) -> str:
        dados: dict[str, str] = {
            "media_type": "REELS",
            "video_url": video_url,
            "share_to_feed": "true" if share_to_feed else "false",
        }
        if caption:
            dados["caption"] = caption

        corpo = self._pedir("POST", f"/{ig_user_id}/media", token, data=dados)
        return _id_de(corpo, "container")

    def status_do_container(self, container_id: str, token: str) -> tuple[str, str | None]:
        corpo = self._pedir(
            "GET", f"/{container_id}", token,
            params={"fields": "status_code,status"},
        )
        codigo = corpo.get("status_code")
        if not isinstance(codigo, str):
            raise ErroDaMeta("formato", "resposta sem `status_code`")
        status = corpo.get("status")
        return codigo.upper(), status if isinstance(status, str) else None

    def publicar(self, ig_user_id: str, token: str, creation_id: str) -> str:
        corpo = self._pedir(
            "POST", f"/{ig_user_id}/media_publish", token,
            data={"creation_id": creation_id},
        )
        return _id_de(corpo, "media")

    def permalink(self, media_id: str, token: str) -> str | None:
        corpo = self._pedir("GET", f"/{media_id}", token, params={"fields": "permalink"})
        valor = corpo.get("permalink")
        return valor if isinstance(valor, str) and valor.startswith("https://") else None

    # -- transporte -------------------------------------------------------

    def _pedir(
        self,
        metodo: str,
        caminho: str,
        token: str,
        *,
        data: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            resposta = self._cliente.request(
                metodo, caminho, data=data, params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as erro:
            raise ErroDaMeta("rede", _redigir(f"{type(erro).__name__}: {erro}", token)) from erro

        try:
            corpo = resposta.json()
        except ValueError as erro:
            raise ErroDaMeta(
                "formato", f"resposta {resposta.status_code} nao era JSON",
                http=resposta.status_code,
            ) from erro

        if not isinstance(corpo, dict):
            raise ErroDaMeta("formato", "resposta nao era um objeto", http=resposta.status_code)

        erro = corpo.get("error")
        if isinstance(erro, dict) or resposta.status_code >= 400:
            erro = erro if isinstance(erro, dict) else {}
            mensagem = erro.get("message") or f"HTTP {resposta.status_code}"
            raise ErroDaMeta(
                "meta",
                _redigir(str(mensagem)[:500], token),
                codigo=_inteiro(erro.get("code")),
                subcodigo=_inteiro(erro.get("error_subcode")),
                tipo=str(erro["type"]) if isinstance(erro.get("type"), str) else None,
                http=resposta.status_code,
            )

        return corpo


_SUBCODIGO_NO_STATUS = re.compile(r"\b(22\d{5}|9\d{3})\b")


def subcodigo_do_status(status: str | None) -> int | None:
    """O numero dentro de `status` quando `status_code` e ERROR.

    O texto vem como `Error: Media upload has failed with error code 2207026`.
    Sem numero, `None` — e a classificacao trata como erro desconhecido.
    """
    if not status:
        return None
    achado = _SUBCODIGO_NO_STATUS.search(status)
    return int(achado.group(1)) if achado else None


def _id_de(corpo: dict[str, Any], o_que: str) -> str:
    valor = corpo.get("id")
    if isinstance(valor, int):
        valor = str(valor)
    if not isinstance(valor, str) or not valor:
        raise ErroDaMeta("formato", f"resposta sem o id do {o_que}")
    return valor


def _inteiro(valor: Any) -> int | None:
    if isinstance(valor, bool):
        return None
    if isinstance(valor, int):
        return valor
    if isinstance(valor, str) and valor.lstrip("-").isdigit():
        return int(valor)
    return None


def _redigir(texto: str, token: str) -> str:
    if len(token) < 8:
        return texto
    return texto.replace(token, "[token]")
