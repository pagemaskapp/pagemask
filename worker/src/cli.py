"""Entrada do pipeline: inspeciona -> detecta -> compoe -> renderiza -> valida."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .analyze import detect_layout
from .compose import build_overlay
from .probe import probe
from .render import render, render_preview
from .util import PipelineError
from .validate import validate

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    for key in ("canvas", "framing", "profile", "caption", "cover", "detect", "output", "validate"):
        if key not in cfg:
            raise PipelineError(f"config sem a secao obrigatoria '{key}': {path}")
    return cfg


def process_one(src_path: Path, cfg: dict, root: Path, out_dir: Path,
                work_dir: Path, keep_overlay: bool, dry_run: bool,
                preview: bool = False) -> dict:
    t0 = time.time()
    print(f"\n=== {src_path.name} ===")

    info = probe(src_path)
    print(f"  entrada : {info.width}x{info.height} @ {info.fps:.3f}fps  "
          f"{info.duration:.2f}s  {info.video_codec}/{info.pix_fmt}  "
          f"audio={'sim' if info.has_audio else 'nao'}")

    layout = detect_layout(info, cfg)
    print(f"  layout  : video y={layout.video_top}..{layout.video_bottom}  "
          f"header antigo y={layout.old_header_top}..{layout.old_header_bottom}  "
          f"({layout.source})")

    overlay_png = work_dir / f"{src_path.stem}.overlay.png"
    ov = build_overlay(cfg, layout, root, overlay_png)
    print(f"  overlay : cobre ate y={ov.cover_until}  header={ov.header_box}  "
          f"frase {ov.caption_size_px}px em {len(ov.caption_lines)} linha(s)")

    preview_png = None
    if preview or dry_run:
        preview_png = root / "reports" / f"{src_path.stem}.preview.png"
        render_preview(info, cfg, overlay_png, preview_png)
        print(f"  preview : {preview_png}")

    out_file = out_dir / f"{src_path.stem}{cfg['output']['suffix']}.mp4"
    if dry_run:
        print("  dry-run : render pulado")
        return {"input": str(src_path), "layout": layout.as_dict(),
                "overlay": ov.as_dict(),
                "preview": str(preview_png) if preview_png else None, "dry_run": True}

    cmd = render(info, cfg, overlay_png, out_file)
    print(f"  render  : {out_file}")

    checks = validate(info, out_file, cfg, layout, overlay_png)
    print("  validacao:")
    for c in checks:
        print(f"    [{'OK ' if c.ok else 'FALHA'}] {c.name}: {c.detail}")

    if not keep_overlay:
        overlay_png.unlink(missing_ok=True)

    failed = [c.name for c in checks if not c.ok]
    print(f"  tempo   : {time.time() - t0:.1f}s"
          + ("" if not failed else f"  >>> FALHAS: {', '.join(failed)}"))

    return {
        "input": str(src_path),
        "output": str(out_file),
        "media": info.as_dict(),
        "layout": layout.as_dict(),
        "overlay": ov.as_dict(),
        "preview": str(preview_png) if preview_png else None,
        "ffmpeg": " ".join(cmd),
        "checks": [c.as_dict() for c in checks],
        "passed": not failed,
        "elapsed_s": round(time.time() - t0, 2),
    }


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="Pipeline de reposicionamento de header (FFmpeg)")
    ap.add_argument("inputs", nargs="*", help="arquivos ou pastas (padrao: ./input)")
    ap.add_argument("-c", "--config", default=str(root / "config" / "template.pretamente.json"))
    ap.add_argument("-o", "--output", default=str(root / "output"))
    ap.add_argument("--work", default=str(root / "work"))
    ap.add_argument("--text", help="sobrescreve caption.text sem editar o JSON")
    ap.add_argument("--header", help="sobrescreve profile.header_image")
    ap.add_argument("--keep-overlay", action="store_true", help="mantem o PNG do overlay")
    ap.add_argument("--dry-run", action="store_true", help="so inspeciona e compoe, nao renderiza")
    ap.add_argument("--preview", action="store_true",
                    help="salva um PNG do frame composto em reports/ (alem de renderizar)")
    ap.add_argument("--report", help="grava relatorio JSON no caminho indicado")
    args = ap.parse_args(argv)

    cfg = load_config(Path(args.config))
    if args.text:
        cfg["caption"]["text"] = args.text
    if args.header:
        cfg["profile"]["header_image"] = args.header

    targets: list[Path] = []
    sources = [Path(p) for p in args.inputs] or [root / "input"]
    for s in sources:
        if s.is_dir():
            targets += sorted(p for p in s.iterdir() if p.suffix.lower() in VIDEO_EXT)
        elif s.exists():
            targets.append(s)
        else:
            print(f"aviso: ignorado (nao existe): {s}", file=sys.stderr)

    if not targets:
        print("nenhum video de entrada encontrado", file=sys.stderr)
        return 2

    out_dir, work_dir = Path(args.output), Path(args.work)
    out_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    results, failures = [], 0
    for t in targets:
        try:
            r = process_one(t, cfg, root, out_dir, work_dir, args.keep_overlay,
                            args.dry_run, args.preview)
            results.append(r)
            if not r.get("passed", True):
                failures += 1
        except PipelineError as e:
            print(f"  ERRO: {e}", file=sys.stderr)
            results.append({"input": str(t), "error": str(e)})
            failures += 1

    if args.report:
        Path(args.report).write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nrelatorio: {args.report}")

    print(f"\n{len(targets) - failures}/{len(targets)} video(s) OK")
    return 1 if (failures and cfg["validate"].get("fail_on_error", True)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
