"""Inspecao do video de entrada: duracao, resolucao, fps, audio."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from fractions import Fraction
from pathlib import Path

from .util import ffprobe_json, PipelineError


@dataclass
class MediaInfo:
    path: str
    width: int
    height: int
    fps: float
    duration: float
    pix_fmt: str
    video_codec: str
    has_audio: bool
    audio_codec: str | None
    audio_rate: int | None
    audio_channels: int | None
    audio_duration: float | None
    rotation: int

    @property
    def aspect(self) -> float:
        return self.width / self.height

    def as_dict(self) -> dict:
        d = asdict(self)
        d["aspect"] = round(self.aspect, 4)
        return d


def _rotation(stream: dict) -> int:
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            return int(round(float(sd["rotation"]))) % 360
    tags = stream.get("tags", {}) or {}
    if "rotate" in tags:
        return int(float(tags["rotate"])) % 360
    return 0


def _taxa_de_quadros(stream: dict) -> float:
    """fps a partir de `avg_frame_rate`, caindo para `r_frame_rate`.

    A versao anterior era `Fraction(avg or "0/1") or Fraction(r)`, contando com
    o `or` para cair no segundo campo quando o primeiro fosse zero. So que o
    `ffprobe` escreve **`0/0`** para trilha sem taxa media conhecida (acontece
    em Matroska e em alguns MP4), e `Fraction("0/0")` levanta
    `ZeroDivisionError` ANTES de o `or` chegar a ser avaliado — entao o caminho
    reserva nunca rodava, e o job quebrava com um erro que nao dizia nada sobre
    fps. Pior: por ser falha "de servidor", ele gastava as tres tentativas
    repetindo exatamente o mesmo estouro.
    """
    for campo in ("avg_frame_rate", "r_frame_rate"):
        bruto = stream.get(campo)
        if not bruto:
            continue
        try:
            fracao = Fraction(str(bruto))
        except (ValueError, ZeroDivisionError):
            continue
        if fracao > 0:
            return float(fracao)

    raise PipelineError("nao consegui ler a taxa de quadros do video")


def probe(path: str | Path) -> MediaInfo:
    path = Path(path)
    if not path.exists():
        raise PipelineError(f"arquivo nao encontrado: {path}")

    data = ffprobe_json(path, "-show_streams", "-show_format")
    streams = data.get("streams", [])
    # A capa embutida (`attached_pic`) e um stream de video que NAO e o video:
    # e a miniatura. Pegar o primeiro `codec_type == "video"` sem filtrar
    # devolveria a geometria e a duracao da MINIATURA num arquivo que a traga
    # antes — e esses numeros mandam no `-t` do render, na deteccao de layout e
    # na validacao de duracao. O resultado seria um `failed` sem explicacao.
    # `src/servico/codecs.py` aplica o mesmo filtro na lista fechada.
    video = next(
        (s for s in streams
         if s.get("codec_type") == "video"
         and (s.get("disposition") or {}).get("attached_pic") != 1),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise PipelineError(f"nenhuma trilha de video em {path.name}")

    rot = _rotation(video)
    w, h = int(video["width"]), int(video["height"])
    if rot in (90, 270):  # dimensoes efetivas apos rotacao do container
        w, h = h, w

    fps = _taxa_de_quadros(video)
    duration = float(video.get("duration") or data["format"]["duration"])

    return MediaInfo(
        path=str(path),
        width=w,
        height=h,
        fps=round(fps, 6),
        duration=duration,
        pix_fmt=video.get("pix_fmt", "?"),
        video_codec=video.get("codec_name", "?"),
        has_audio=audio is not None,
        audio_codec=audio.get("codec_name") if audio else None,
        audio_rate=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        audio_channels=int(audio["channels"]) if audio and audio.get("channels") else None,
        audio_duration=float(audio["duration"]) if audio and audio.get("duration") else None,
        rotation=rot,
    )
