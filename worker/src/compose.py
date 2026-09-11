"""Composicao do overlay estatico (faixa de cobertura + header novo + frase).

Gera UM unico PNG RGBA do tamanho do canvas. Tudo o que e desenho fica aqui;
o ffmpeg so faz `overlay=0:0`. Isso da controle tipografico total (acentos,
quebra de linha, autofit) sem depender do drawtext.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .analyze import Layout
from .util import PipelineError, hex_to_rgb


@dataclass
class OverlayReport:
    cover_until: int
    header_box: tuple[int, int, int, int] | None
    caption_box: tuple[int, int, int, int] | None
    caption_lines: list[str]
    caption_size_px: int

    def as_dict(self) -> dict:
        return asdict(self)


def _load_font(cfg: dict, size: int) -> ImageFont.FreeTypeFont:
    candidates = [cfg["caption"]["font"], *cfg["caption"].get("font_fallbacks", [])]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise PipelineError("nenhuma fonte encontrada em: " + ", ".join(candidates))


def _content_bbox(img: Image.Image, white_threshold: int) -> tuple[int, int, int, int]:
    """Bbox do conteudo: usa alfa se houver, senao tudo que nao for quase-branco."""
    if img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 255:
        box = img.getchannel("A").getbbox()
    else:
        gray = img.convert("L")
        mask = gray.point(lambda v: 255 if v < white_threshold else 0)
        box = mask.getbbox()
    if box is None:
        raise PipelineError("imagem de header esta vazia (tudo branco / tudo transparente)")
    return box


def _wrap(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            probe = f"{current} {word}"
            if font.getlength(probe) <= max_width:
                current = probe
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def _fit_caption(cfg: dict, max_width: int, max_height: int):
    """Escolhe o maior corpo de fonte cujo bloco cabe na area disponivel."""
    cap = cfg["caption"]
    size = cap["size_px"]
    floor = cap["min_size_px"] if cap.get("autofit", True) else size
    while size >= floor:
        font = _load_font(cfg, size)
        lines = _wrap(cap["text"], font, max_width)
        line_h = size * cap["line_spacing"]
        block_h = line_h * (len(lines) - 1) + size
        widest = max((font.getlength(l) for l in lines), default=0)
        if block_h <= max_height and widest <= max_width:
            return font, lines, size, int(round(block_h)), int(round(line_h))
        size -= 2
    # nao coube nem no minimo: usa o minimo e deixa a validacao acusar
    font = _load_font(cfg, floor)
    lines = _wrap(cap["text"], font, max_width)
    line_h = floor * cap["line_spacing"]
    block_h = line_h * (len(lines) - 1) + floor
    return font, lines, floor, int(round(block_h)), int(round(line_h))


def build_overlay(cfg: dict, layout: Layout, project_root: Path,
                  out_path: Path) -> OverlayReport:
    canvas = cfg["canvas"]
    w, h = canvas["width"], canvas["height"]
    white = cfg["detect"]["white_threshold"]

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    # 1. Faixa de cobertura do header antigo -------------------------------
    cover_until = 0
    if cfg["cover"]["enabled"]:
        cover_until = max(0, min(h, layout.video_top + cfg["cover"]["extra_px"]))
        spec = cfg["cover"]["color"]
        if str(spec).lower() == "auto":  # acompanha o fundo detectado no video
            lvl = layout.background_level
            color = (lvl, lvl, lvl, 255)
        else:
            color = (*hex_to_rgb(spec), 255)
        ImageDraw.Draw(overlay).rectangle([0, 0, w - 1, cover_until - 1], fill=color)

    # 2. Header novo --------------------------------------------------------
    prof = cfg["profile"]
    header_box = None
    header_bottom = 0
    src_path = (project_root / prof["header_image"]).resolve()
    if not src_path.exists():
        raise PipelineError(f"header_image nao encontrado: {src_path}")

    header = Image.open(src_path).convert("RGBA")
    box = _content_bbox(header, white) if prof.get("trim_to_content", True) else (0, 0, *header.size)
    piece = header.crop(box)

    if prof["scale"] != 1.0:
        piece = piece.resize(
            (max(1, int(piece.width * prof["scale"])), max(1, int(piece.height * prof["scale"]))),
            Image.LANCZOS,
        )

    offset_y = int(round(prof["offset_y"] * h / prof.get("offset_space_height", h)))
    if prof["align"] == "auto" and layout.old_header_top is not None:
        top = layout.old_header_top + offset_y
    elif prof["align"] == "auto":
        top = box[1] + offset_y
    else:
        top = offset_y

    if header.width == w and prof["scale"] == 1.0:
        left = box[0] + prof["offset_x"]          # preserva o X do design original
    else:
        left = (w - piece.width) // 2 + prof["offset_x"]

    overlay.alpha_composite(piece, (int(left), int(top)))
    header_box = (int(left), int(top), int(left + piece.width), int(top + piece.height))
    header_bottom = header_box[3]

    # 3. Frase --------------------------------------------------------------
    cap = cfg["caption"]
    max_width = int(w * cap["max_width_pct"])
    if cap["position"] == "fixed":
        area_top = cap["fixed_y"]
        area_bottom = max(area_top + 1, cover_until - cap["gap_bottom_px"])
    else:
        area_top = header_bottom + cap["gap_top_px"]
        area_bottom = cover_until - cap["gap_bottom_px"]
    area_h = max(1, area_bottom - area_top)

    font, lines, size, block_h, line_h = _fit_caption(cfg, max_width, area_h)

    y = area_top + (area_h - block_h) // 2
    draw = ImageDraw.Draw(overlay)
    color = (*hex_to_rgb(cap["color"]), 255)
    left_edge, right_edge = w, 0
    for i, line in enumerate(lines):
        line_w = font.getlength(line)
        x = (w - line_w) / 2
        draw.text((x, y + i * line_h), line, font=font, fill=color)
        left_edge = min(left_edge, int(x))
        right_edge = max(right_edge, int(x + line_w))

    caption_box = (left_edge, int(y), right_edge, int(y + block_h))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(out_path)

    return OverlayReport(cover_until=cover_until, header_box=header_box,
                         caption_box=caption_box, caption_lines=lines,
                         caption_size_px=size)
