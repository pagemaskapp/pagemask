"""Deteccao automatica do layout do video de entrada.

O video de origem e um "post": faixa estatica no topo (avatar + @ + frase),
faixa central com o video em movimento, faixa estatica embaixo.

A deteccao tem duas etapas, ambas deterministicas (sem IA):

1. Variancia temporal por linha -> so a faixa de video muda entre frames.
2. Cor de fundo estimada a partir das linhas estaticas -> funciona tanto para
   posts de fundo branco quanto de fundo escuro.

Todas as coordenadas retornadas ja estao no espaco do CANVAS final.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

from .framing import build_framing_filter
from .probe import MediaInfo
from .util import FFMPEG, PipelineError, run

ANALYSIS_WIDTH = 180  # media horizontal: reduz ruido, preserva precisao vertical


@dataclass
class Layout:
    canvas_width: int
    canvas_height: int
    video_top: int
    video_bottom: int
    old_header_top: int | None
    old_header_bottom: int | None
    has_static_header: bool
    motion_top: int
    motion_bottom: int
    background_level: int
    source: str  # "detected" | "fallback"

    def as_dict(self) -> dict:
        return asdict(self)


def _sample_gray(path: str, cfg: dict, frames: int) -> np.ndarray:
    """Decodifica `frames` amostras (1 fps) ja normalizadas para o canvas."""
    h = cfg["canvas"]["height"]
    fc = build_framing_filter(cfg, "0:v", "bg")
    fc += f";[bg]fps=1,scale={ANALYSIS_WIDTH}:{h}[out]"
    cmd = [FFMPEG, "-v", "error", "-i", path, "-filter_complex", fc, "-map", "[out]",
           "-frames:v", str(frames), "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = run(cmd, capture_stdout=True)
    n = len(raw) // (ANALYSIS_WIDTH * h)
    if n < 2:
        raise PipelineError("amostras insuficientes para analisar o layout (video muito curto?)")
    arr = np.frombuffer(raw, dtype=np.uint8)[: n * ANALYSIS_WIDTH * h]
    return arr.reshape(n, h, ANALYSIS_WIDTH).astype(np.float32)


def _largest_run(mask: np.ndarray) -> tuple[int, int] | None:
    """Maior intervalo contiguo de True, ou None se nao houver nenhum."""
    runs: list[tuple[int, int]] = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(mask) - 1))
    if not runs:
        return None
    return max(runs, key=lambda r: r[1] - r[0])


def detect_layout(info: MediaInfo, cfg: dict) -> Layout:
    det = cfg["detect"]
    h, w = cfg["canvas"]["height"], cfg["canvas"]["width"]
    tol = det.get("background_tolerance", 10)

    n_frames = min(det["sample_frames"], max(2, int(info.duration)))
    frames = _sample_gray(info.path, cfg, n_frames)

    row_std = frames.std(axis=0).mean(axis=1)
    mean_frame = frames.mean(axis=0)

    moving = row_std > det["motion_threshold"]
    run_ = _largest_run(moving)
    if run_ is None:
        return _fallback(cfg, w, h, bg=int(round(float(np.median(mean_frame)))))
    motion_top, motion_bottom = run_

    # Cor de fundo: mediana das linhas ESTATICAS (fora da faixa de video).
    # Nao assume branco -> funciona com posts de fundo escuro.
    static_rows = np.ones(h, dtype=bool)
    static_rows[motion_top:motion_bottom + 1] = False
    if static_rows.any():
        bg = float(np.median(mean_frame[static_rows]))
    else:
        bg = float(np.median(mean_frame))

    row_is_bg = np.abs(mean_frame - bg).max(axis=1) <= tol

    # A faixa de video pode comecar/terminar com linhas paradas (barra preta,
    # cenario estatico). Expande enquanto a linha nao for fundo liso.
    video_top = motion_top
    while video_top > 0 and not row_is_bg[video_top - 1]:
        video_top -= 1
    video_bottom = motion_bottom
    while video_bottom < h - 1 and not row_is_bg[video_bottom + 1]:
        video_bottom += 1

    # Header antigo = conteudo fora do fundo, acima da faixa de video.
    above = np.where(~row_is_bg[:video_top])[0]
    has_header = len(above) > 0 and (above.max() - above.min()) > h * 0.02

    if not has_header:
        return _fallback(cfg, w, h, bg=int(round(bg)),
                         motion=(int(motion_top), int(motion_bottom)))

    return Layout(w, h, video_top=int(video_top), video_bottom=int(video_bottom),
                  old_header_top=int(above.min()), old_header_bottom=int(above.max()),
                  has_static_header=True,
                  motion_top=int(motion_top), motion_bottom=int(motion_bottom),
                  background_level=int(round(bg)), source="detected")


def _fallback(cfg: dict, w: int, h: int, bg: int,
              motion: tuple[int, int] | None = None) -> Layout:
    """Video sem card estatico no topo: reserva uma faixa fixa configurada."""
    band = int(h * cfg["detect"]["fallback_header_ratio"])
    return Layout(w, h, video_top=band, video_bottom=h - 1,
                  old_header_top=0, old_header_bottom=band - 1,
                  has_static_header=False,
                  motion_top=motion[0] if motion else band,
                  motion_bottom=motion[1] if motion else h - 1,
                  background_level=bg, source="fallback")
