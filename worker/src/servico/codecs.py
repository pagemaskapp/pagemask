"""A lista fechada de codecs (PLANO §4), conferida com o `ffprobe` de verdade.

Esta e a checagem que AUTORIZA o render. A Fase 2 ja tinha uma parecida, feita
no app com um leitor de cabecalho escrito a mao — mas aquela roda numa funcao
da Vercel, onde nao existe binario de FFmpeg, e le so os primeiros quilobytes.
As duas nao sao redundantes, sao camadas com papeis diferentes:

    app (Fase 2)  → barra o obvio cedo, antes de ocupar a fila, e com custo de
                    dezenas de KB. Nao confia em si mesma.
    worker (aqui) → e a que vale. Roda o `ffprobe` inteiro, no arquivo inteiro,
                    e nada e decodificado antes dela passar.

O motivo de existir a lista esta no PLANO: `CVE-2026-8461` era no decoder do
MagicYUV. Fechar a lista tira do alcance de um arquivo de desconhecido a maior
parte dos decoders exoticos do FFmpeg — os que ninguem audita porque ninguem
usa.

O QUE A LISTA NAO CONSEGUE SEPARAR, e vale saber: o `ffprobe` reporta um unico
`format_name` para a familia inteira do MP4 (`mov,mp4,m4a,3gp,3g2,mj2`), entao
um `.3gp` com H.264 e AAC passa neste ponto. O demuxer e o mesmo, os decoders
sao os mesmos, e a superficie de ataque e identica — mas quem quiser separa-los
de fato precisa olhar o `major_brand`, que e o que a sondagem do app faz na
Fase 2 (`app/src/lib/video/sonda.ts`). Por isso ele e gravado no probe aqui.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..util import FFPROBE, PipelineError, run

CONTEINERES = {
    # A familia do MP4 vem sempre como esta lista, nunca separada.
    "mov": "mp4", "mp4": "mp4", "m4a": "mp4", "3gp": "mp4", "3g2": "mp4", "mj2": "mp4",
    "matroska": "mkv", "webm": "webm",
}

VIDEO = frozenset({"h264", "hevc", "vp9", "av1"})
AUDIO_EXATOS = frozenset({"aac", "mp3", "opus", "vorbis"})
AUDIO_PREFIXO = "pcm_"

# Trilha que nao e decodificada nao entra na lista fechada: legenda e anexo de
# Matroska sao dados copiados, nunca abertos por um decoder. O render mapeia
# explicitamente `0:v` e `0:a:0` e ignora o resto.
TIPOS_IGNORADOS = frozenset({"subtitle", "data", "attachment"})

FORMATOS_EM_TEXTO = "MP4, MOV, MKV ou WebM"
VIDEO_EM_TEXTO = "H.264, HEVC, VP9 ou AV1"
AUDIO_EM_TEXTO = "AAC, MP3, Opus, Vorbis ou PCM"


class Recusado(Exception):
    """O arquivo e legivel e NAO ESTA NA LISTA. Vira `rejected`.

    `motivo` e a frase em pt-BR que o usuario le na tela.
    """

    def __init__(self, motivo: str) -> None:
        super().__init__(motivo)
        self.motivo = motivo


class NaoLegivel(Exception):
    """Nem deu para ABRIR o arquivo. Vira `failed`.

    A distincao entre esta e `Recusado` e do PLANO, e ela diz coisas
    diferentes ao usuario:

        rejected  "lemos o seu arquivo e ele usa um codec que nao aceitamos"
        failed    "nao conseguimos sequer ler este arquivo"

    Sao diagnosticos diferentes e levam a acoes diferentes — converter o video,
    contra reenviar o arquivo. Nas duas o credito volta e nao ha nova
    tentativa: arquivo ilegivel continua ilegivel na segunda leitura.
    """

    def __init__(self, motivo: str) -> None:
        super().__init__(motivo)
        self.motivo = motivo


def sondar(caminho: Path) -> dict[str, Any]:
    """`ffprobe` completo do arquivo, como dicionario cru.

    Levanta `NaoLegivel` quando o `ffprobe` nao consegue nem abrir o arquivo —
    o "arquivo de 1 KB corrompido" do cross-check da fase. Nao e erro de
    servidor (o servidor esta bem) nem recusa por codec (nao houve codec para
    ler): e a terceira coisa, e o PLANO a chama de `failed`.
    """
    try:
        bruto = run(
            [FFPROBE, "-v", "error", "-of", "json",
             "-show_streams", "-show_format", str(caminho)],
            capture_stdout=True,
        )
    except PipelineError as erro:
        raise NaoLegivel(
            "Não conseguimos ler este arquivo de vídeo — ele parece incompleto "
            "ou corrompido. Envie o arquivo de novo."
        ) from erro

    try:
        dados = json.loads(bruto.decode("utf-8", "replace"))
    except json.JSONDecodeError as erro:
        raise NaoLegivel(
            "Não conseguimos ler este arquivo de vídeo. Envie o arquivo de novo."
        ) from erro

    if not isinstance(dados, dict) or not dados.get("streams"):
        raise NaoLegivel(
            "Este arquivo não tem nenhuma trilha de vídeo ou áudio que possamos ler. "
            f"Envie um vídeo em {FORMATOS_EM_TEXTO}."
        )
    return dados


def avaliar(dados: dict[str, Any]) -> dict[str, Any]:
    """Aplica a lista fechada. Levanta `Recusado` com o motivo, ou devolve o resumo.

    O resumo e o que vai para `jobs.probe`: e a PROVA, guardada, de que este
    arquivo passou — o PLANO pede isso explicitamente para auditoria depois.
    """
    formato = dados.get("format") or {}
    nomes = {n.strip() for n in str(formato.get("format_name", "")).split(",") if n.strip()}

    conteineres = {CONTEINERES[n] for n in nomes if n in CONTEINERES}
    if not conteineres:
        visto = ", ".join(sorted(nomes)) or "desconhecido"
        raise Recusado(
            f"O formato deste arquivo ({visto}) não é aceito. "
            f"Envie o vídeo em {FORMATOS_EM_TEXTO}."
        )

    streams = [s for s in dados.get("streams", []) if isinstance(s, dict)]
    audios = [s for s in streams if s.get("codec_type") == "audio"]

    # CAPA NAO E TRILHA DE VIDEO, e tratar as duas como a mesma coisa recusava
    # arquivo bom. Um MP4 comum com miniatura embutida carrega um segundo
    # stream de video em MJPEG ou PNG marcado `attached_pic`; ele nunca e
    # decodificado — a selecao automatica do FFmpeg ignora imagem anexada por
    # regra propria, e foi medido: num arquivo com capa MJPEG, tanto o
    # `filter_complex [0:v]` do render quanto o `-vf` da deteccao pegaram o
    # H.264. Barrar esse stream fazia o PageMask recusar o video E APAGAR o
    # arquivo do usuario do bucket, com uma mensagem que culpava um codec que
    # nem seria aberto.
    #
    # Stream de video que NAO e capa continua na lista fechada: esse a selecao
    # automatica poderia escolher, e ai o decoder rodaria de verdade.
    capas = [s for s in streams
             if s.get("codec_type") == "video"
             and (s.get("disposition") or {}).get("attached_pic") == 1]
    videos = [s for s in streams
              if s.get("codec_type") == "video" and s not in capas]

    if not videos:
        raise Recusado(
            "Este arquivo não tem trilha de vídeo. Envie um vídeo, não um áudio ou imagem."
        )

    for stream in videos:
        codec = str(stream.get("codec_name", "?"))
        if codec not in VIDEO:
            raise Recusado(
                f"O codec de vídeo deste arquivo ({codec}) não é aceito. "
                f"Converta para {VIDEO_EM_TEXTO} e envie de novo."
            )

    for stream in audios:
        codec = str(stream.get("codec_name", "?"))
        if codec not in AUDIO_EXATOS and not codec.startswith(AUDIO_PREFIXO):
            raise Recusado(
                f"O codec de áudio deste arquivo ({codec}) não é aceito. "
                f"Converta o áudio para {AUDIO_EM_TEXTO} e envie de novo."
            )

    outros = [
        str(s.get("codec_type"))
        for s in streams
        if s.get("codec_type") not in {"video", "audio"} | TIPOS_IGNORADOS
    ]
    if outros:
        raise Recusado(
            "Este arquivo tem trilhas que não sabemos processar. "
            f"Envie um vídeo simples em {FORMATOS_EM_TEXTO}."
        )

    principal = videos[0]
    audio = audios[0] if audios else None
    marcas = (formato.get("tags") or {})

    return {
        "fonte": "ffprobe",
        "container": sorted(conteineres)[0],
        "format_name": formato.get("format_name"),
        "major_brand": marcas.get("major_brand"),
        "duracao_s": _numero(formato.get("duration")),
        "bytes": _inteiro(formato.get("size")),
        "bitrate": _inteiro(formato.get("bit_rate")),
        "video": {
            "codec": principal.get("codec_name"),
            "perfil": principal.get("profile"),
            "largura": _inteiro(principal.get("width")),
            "altura": _inteiro(principal.get("height")),
            "pix_fmt": principal.get("pix_fmt"),
            "fps": principal.get("avg_frame_rate"),
        },
        "audio": None if audio is None else {
            "codec": audio.get("codec_name"),
            "taxa": _inteiro(audio.get("sample_rate")),
            "canais": _inteiro(audio.get("channels")),
        },
        "trilhas": len(streams),
        "capas": len(capas),
    }


def _numero(valor: Any) -> float | None:
    try:
        return round(float(valor), 3)
    except (TypeError, ValueError):
        return None


def _inteiro(valor: Any) -> int | None:
    try:
        return int(float(valor))
    except (TypeError, ValueError):
        return None
