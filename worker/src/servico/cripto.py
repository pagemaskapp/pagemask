"""Decifra o token do Instagram em repouso — o espelho de `app/src/lib/ig/cripto.ts`.

AES-256-GCM, chave de 32 bytes em base64 (`TOKEN_ENC_KEY`), IV de 12 bytes por
linha e o `ig_user_id` como dado associado (AAD). Os dois lados precisam
concordar em cada detalhe, e por isso este arquivo e curto e sem opcao: nao ha
parametro para escolher algoritmo, tamanho de IV nem AAD.

O AAD e o que amarra o token a conta dona dele. Um texto cifrado copiado para a
linha de outra conta nao decifra — a tag nao confere — e `TokenIndecifravel` e
tudo que sai daqui. A mensagem nunca carrega byte nenhum do conteudo.

O worker so DECIFRA. Cifrar e do app (callback do OAuth e renovacao); o worker
nunca grava token nenhum.
"""
from __future__ import annotations

import base64
import binascii

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TAMANHO_DA_CHAVE = 32
TAMANHO_DO_IV = 12


class ChaveInvalida(ValueError):
    pass


class TokenIndecifravel(RuntimeError):
    """A tag nao conferiu, a chave e outra, ou o `ig_user_id` nao e o da linha."""


def carregar_chave(base64_texto: str) -> bytes:
    try:
        chave = base64.b64decode(base64_texto, validate=True)
    except (binascii.Error, ValueError) as erro:
        raise ChaveInvalida("TOKEN_ENC_KEY nao e base64 valido.") from erro
    if len(chave) != TAMANHO_DA_CHAVE:
        raise ChaveInvalida(
            f"TOKEN_ENC_KEY precisa ter {TAMANHO_DA_CHAVE} bytes (openssl rand -base64 32)."
        )
    return chave


def decifrar(chave: bytes, cipher_hex: str, iv_hex: str, tag_hex: str, aad: str) -> str:
    try:
        iv = bytes.fromhex(iv_hex)
        cifrado = bytes.fromhex(cipher_hex)
        tag = bytes.fromhex(tag_hex)
    except (ValueError, TypeError) as erro:
        raise TokenIndecifravel("token cifrado fora do formato esperado") from erro

    if len(iv) != TAMANHO_DO_IV:
        raise TokenIndecifravel("IV fora do tamanho esperado")

    try:
        # A `cryptography` espera cifra+tag concatenados; o Node os separa.
        aberto = AESGCM(chave).decrypt(iv, cifrado + tag, aad.encode("utf-8"))
    except InvalidTag as erro:
        raise TokenIndecifravel("a tag de autenticacao nao confere") from erro

    try:
        return aberto.decode("utf-8")
    except UnicodeDecodeError as erro:
        raise TokenIndecifravel("token decifrado nao e texto") from erro
