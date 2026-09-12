"""Utilitarios comuns: execucao de ffmpeg/ffprobe e helpers de cor."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


class PipelineError(RuntimeError):
    pass


def run(cmd: list[str], capture_stdout: bool = False,
        cwd: str | Path | None = None) -> bytes:
    """Executa um processo e levanta PipelineError com o stderr em caso de falha.

    `cwd` existe por causa do filtro `subtitles` (Fase 9). O nome do arquivo de
    legenda vai DENTRO de um filtergraph, onde `:`, `\\`, `[`, `]`, `,` e `;`
    sao sintaxe — um caminho absoluto de Windows (`C:\\work\\...`) precisaria de
    dois niveis de escape do FFmpeg, cada um com a sua propria regra. Rodando
    com o diretorio do job como cwd, o nome vira `legenda.ass`: sem caractere
    especial nenhum, e o problema deixa de existir em vez de ser contornado.
    """
    proc = subprocess.run(cmd, capture_output=True, cwd=str(cwd) if cwd else None)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-15:]
        raise PipelineError(
            "comando falhou (%d): %s\n%s" % (proc.returncode, " ".join(cmd[:4]), "\n".join(tail))
        )
    return proc.stdout if capture_stdout else proc.stderr


def ffmpeg_raw_gray(src: str | Path, width: int, height: int, extra_in: list[str] | None = None,
                    vf: str = "", frames: int | None = None) -> bytes:
    """Decodifica frames em GRAY8 cru, no tamanho pedido."""
    chain = [f"scale={width}:{height}"]
    if vf:
        chain.insert(0, vf)
    cmd = [FFMPEG, "-v", "error", *(extra_in or []), "-i", str(src),
           "-vf", ",".join(chain), "-f", "rawvideo", "-pix_fmt", "gray"]
    if frames:
        cmd += ["-frames:v", str(frames)]
    cmd.append("-")
    return run(cmd, capture_stdout=True)


def ffprobe_json(src: str | Path, *args: str) -> dict:
    out = run([FFPROBE, "-v", "error", "-of", "json", *args, str(src)], capture_stdout=True)
    return json.loads(out.decode("utf-8", "replace"))


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        raise PipelineError(f"cor invalida: {value}")
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def rgb_to_ffmpeg_color(value: str) -> str:
    r, g, b = hex_to_rgb(value)
    return "0x%02X%02X%02X" % (r, g, b)
