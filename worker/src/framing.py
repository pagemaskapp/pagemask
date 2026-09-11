"""Normalizacao do video de entrada para o canvas vertical.

Um unico ponto de verdade: analyze.py e render.py usam a MESMA cadeia de
filtros, entao as coordenadas detectadas valem para o render final.
"""
from __future__ import annotations

from .util import PipelineError, rgb_to_ffmpeg_color


def build_framing_filter(cfg: dict, label_in: str = "0:v", label_out: str = "bg") -> str:
    canvas = cfg["canvas"]
    w, h = canvas["width"], canvas["height"]
    fps = canvas["fps"]
    mode = cfg["framing"]["mode"]
    bg = rgb_to_ffmpeg_color(canvas["background"])

    if mode == "fit":
        chain = (
            f"[{label_in}]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={bg},"
            f"setsar=1,fps={fps}[{label_out}]"
        )
    elif mode == "cover":
        chain = (
            f"[{label_in}]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1,fps={fps}[{label_out}]"
        )
    elif mode == "blur":
        chain = (
            f"[{label_in}]split=2[fgsrc][bgsrc];"
            f"[bgsrc]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
            f"gblur=sigma=40[blurbg];"
            f"[fgsrc]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];"
            f"[blurbg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps}[{label_out}]"
        )
    else:
        raise PipelineError(f"framing.mode desconhecido: {mode!r} (use fit, cover ou blur)")

    return chain

