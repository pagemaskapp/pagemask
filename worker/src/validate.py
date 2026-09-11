"""Validacao pos-render: as 7 checagens do pipeline + a compatibilidade com Reels."""
from __future__ import annotations

import re
import struct
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
from PIL import Image

from .analyze import Layout
from .probe import MediaInfo, probe
from .util import FFMPEG, ffprobe_json, run


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    metrics: dict

    def as_dict(self) -> dict:
        return asdict(self)


def _frames_rgb(path: str, w: int, h: int, n: int) -> np.ndarray:
    cmd = [FFMPEG, "-v", "error", "-i", str(path), "-vf", f"fps=1,scale={w}:{h}",
           "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = run(cmd, capture_stdout=True)
    count = len(raw) // (w * h * 3)
    arr = np.frombuffer(raw, dtype=np.uint8)[: count * w * h * 3]
    return arr.reshape(count, h, w, 3).astype(np.int16)


def _volume_stats(path: str) -> dict:
    err = run([FFMPEG, "-v", "info", "-i", str(path), "-map", "0:a:0",
               "-af", "volumedetect", "-f", "null", "-"]).decode("utf-8", "replace")
    stats = {}
    for key in ("mean_volume", "max_volume"):
        m = re.search(rf"{key}:\s*(-?\d+(?:\.\d+)?) dB", err)
        if m:
            stats[key] = float(m.group(1))
    return stats


def validate(src: MediaInfo, out_file: Path, cfg: dict, layout: Layout,
             overlay_png: Path) -> list[Check]:
    v = cfg["validate"]
    canvas = cfg["canvas"]
    checks: list[Check] = []
    out = probe(out_file)

    # 1. Resolucao / fps / pix_fmt -----------------------------------------
    want = (canvas["width"], canvas["height"])
    got = (out.width, out.height)
    fps_ok = abs(out.fps - canvas["fps"]) < 0.05
    pix_ok = out.pix_fmt == cfg["output"]["pix_fmt"]
    checks.append(Check(
        "resolucao", got == want and fps_ok and pix_ok,
        f"{got[0]}x{got[1]} @ {out.fps:.3f}fps {out.pix_fmt} "
        f"(esperado {want[0]}x{want[1]} @ {canvas['fps']}fps {cfg['output']['pix_fmt']})",
        {"width": out.width, "height": out.height, "fps": out.fps, "pix_fmt": out.pix_fmt},
    ))

    # 2. Duracao ------------------------------------------------------------
    delta = abs(out.duration - src.duration)
    checks.append(Check(
        "duracao", delta <= v["duration_tolerance_s"],
        f"saida {out.duration:.3f}s vs entrada {src.duration:.3f}s (delta {delta:.3f}s, "
        f"tolerancia {v['duration_tolerance_s']}s)",
        {"in": round(src.duration, 3), "out": round(out.duration, 3), "delta": round(delta, 3)},
    ))

    # 3. Audio --------------------------------------------------------------
    if v["require_audio"]:
        if not out.has_audio:
            checks.append(Check("audio", False, "saida sem trilha de audio", {}))
        else:
            vol = _volume_stats(str(out_file))
            mean_db = vol.get("mean_volume", -999.0)
            audible = mean_db > v["silence_floor_db"]
            adelta = abs((out.audio_duration or out.duration) - (src.audio_duration or src.duration))
            ok = audible and adelta <= max(v["duration_tolerance_s"], 0.25)
            if not src.has_audio:
                ok = True  # entrada muda: trilha silenciosa e o esperado
                audible_note = " (entrada sem audio: trilha silenciosa gerada)"
            else:
                audible_note = ""
            checks.append(Check(
                "audio", ok,
                f"{out.audio_codec} {out.audio_rate}Hz {out.audio_channels}ch, "
                f"mean {mean_db:.1f}dB, max {vol.get('max_volume', float('nan')):.1f}dB, "
                f"delta duracao {adelta:.3f}s{audible_note}",
                {"mean_volume_db": mean_db, **vol, "duration_delta": round(adelta, 3)},
            ))

    # 4. Cobertura do header antigo ----------------------------------------
    ov = np.asarray(Image.open(overlay_png).convert("RGBA")).astype(np.int16)
    alpha = ov[:, :, 3]
    opaque = alpha >= 250
    if not opaque.any():
        checks.append(Check("cobertura_header", False, "overlay sem regiao opaca", {}))
    else:
        n = min(v["coverage_sample_frames"], max(2, int(out.duration)))
        frames = _frames_rgb(str(out_file), canvas["width"], canvas["height"], n)
        diff = np.abs(frames - ov[None, :, :, :3])[:, opaque]
        mae = float(diff.mean())
        p99 = float(np.percentile(diff, 99))
        worst = float(diff.max())
        ok = p99 <= v["coverage_max_diff"]
        rows = np.where(opaque.any(axis=1))[0]
        checks.append(Check(
            "cobertura_header", ok,
            f"faixa coberta y=0..{rows.max()} conferida em {frames.shape[0]} frames: "
            f"MAE {mae:.2f}, p99 {p99:.1f}, max {worst:.0f} "
            f"(limite p99 {v['coverage_max_diff']})",
            {"mae": round(mae, 3), "p99": round(p99, 2), "max": worst,
             "covered_until": int(rows.max()) + 1, "frames": int(frames.shape[0])},
        ))

        # 4b. o header antigo esta inteiramente dentro da faixa coberta?
        #     combinado com 4a (saida == overlay na faixa opaca), isso prova
        #     que nenhum pixel do header antigo sobrevive no resultado.
        if layout.has_static_header and layout.old_header_top is not None:
            covered_until = int(rows.max()) + 1
            margin = covered_until - (layout.old_header_bottom + 1)
            inside = margin >= 0
            checks.append(Check(
                "header_antigo_dentro_da_cobertura", inside,
                f"header antigo y={layout.old_header_top}..{layout.old_header_bottom}, "
                f"cobertura opaca ate y={covered_until - 1} "
                f"(folga {margin}px)" + ("" if inside else "  <-- SOBRA HEADER ANTIGO VISIVEL"),
                {"old_header_bottom": layout.old_header_bottom,
                 "covered_until": covered_until, "margin_px": margin},
            ))

            # Resto do header antigo que caiu FORA da faixa opaca: esses pixels
            # nao foram cobertos por construcao, entao aqui a checagem tem
            # significado real (dentro da faixa opaca o teste 4a ja e prova).
            band = slice(layout.old_header_top, layout.old_header_bottom + 1)
            src_frames = _frames_rgb(src.path, canvas["width"], canvas["height"], 2)
            old_content = np.abs(src_frames[0, band] - 255).max(axis=2) > 10
            exposed = old_content & ~opaque[band]
            total = int(old_content.sum())
            if total:
                leak = int(exposed.sum())
                ratio = leak / total
                checks.append(Check(
                    "vazamento_do_header_antigo", ratio <= 0.005,
                    f"{leak} de {total} pixels do header antigo ficaram fora da faixa "
                    f"opaca ({ratio*100:.2f}%, limite 0.5%)",
                    {"leaked_px": leak, "old_content_px": total,
                     "leak_ratio": round(ratio, 5)},
                ))

    # 5. A faixa de video continua viva ------------------------------------
    band_h = layout.video_bottom - layout.video_top
    if band_h > 20:
        n = min(6, max(2, int(out.duration)))
        f = _frames_rgb(str(out_file), 120, canvas["height"], n)
        std = float(f[:, layout.video_top:layout.video_bottom].std(axis=0).mean())
        checks.append(Check(
            "faixa_de_video_preservada", std > 1.0,
            f"variacao temporal media na faixa y={layout.video_top}..{layout.video_bottom}: {std:.2f}",
            {"temporal_std": round(std, 3)},
        ))

    return checks


# ===========================================================================
# Validacao de Reels (Fase 3)
# ===========================================================================
#
# As sete checagens acima perguntam "o render fez o que devia?". Estas
# perguntam outra coisa: "o Instagram aceita este arquivo?". Sao independentes
# — um video pode estar visualmente perfeito e ser recusado no upload por ter a
# `moov` no fim, e o usuario so descobriria depois de baixar e tentar postar.
#
# Os limites vem do PLANO (Fase 3) e cada um tem um porque pratico:
#
#   moov no inicio      o player comeca sem baixar o arquivo inteiro
#   sem edit list       o Reels tropeca no atraso de codificacao do AAC
#   H.264 closed GOP    corte em qualquer keyframe sem quadro quebrado
#   AAC <= 48 kHz, 2ch  o que a plataforma aceita sem recodificar
#   23-60 fps           faixa aceita
#   largura <= 1920     idem
#   3 s - 15 min        duracao de Reels
#   <= 300 MB           teto de upload
#   <= 25 Mbps          teto de bitrate
#
# COMO O "CLOSED GOP" E MEDIDO, que e a unica nao obvia:
#
# Nao existe campo "closed_gop" em lugar nenhum do MP4. O que existe e uma
# consequencia verificavel: num GOP fechado todo quadro-chave e um **IDR**, que
# e o NAL tipo 5 e manda o decoder esquecer tudo que veio antes. Num GOP
# aberto, o encoder emite quadros I comuns (NAL tipo 1) com um SEI de
# recovery point, e quadros depois deles ainda referenciam quadros anteriores.
#
# Entao a checagem compara duas contagens que so batem em GOP fechado:
#
#     pacotes marcados como keyframe   ==   NALs do tipo 5 (IDR)
#
# Medido nos dois sentidos: no nosso render, 1 e 1; num arquivo codificado de
# proposito com `open-gop=1`, 4 keyframes contra 1 IDR.
#
# A leitura usa `-show_entries packet=flags`, nao `frame=`. Pacote nao precisa
# ser decodificado — num Reels de 15 minutos a diferenca e entre ler o indice e
# decodificar 27 mil quadros.

REELS_LIMITES = {
    "fps_min": 23.0,
    "fps_max": 60.0,
    "largura_max": 1920,
    "duracao_min_s": 3.0,
    "duracao_max_s": 15 * 60.0,
    "bytes_max": 300 * 1024 * 1024,
    "bitrate_max": 25_000_000,
    "audio_taxa_max": 48_000,
    "audio_canais_max": 2,
}


def _caixas_de_topo(path: Path, limite: int = 64) -> list[str]:
    """Ordem das caixas de primeiro nivel do MP4, sem carregar o arquivo.

    Le so os 16 bytes de cada cabecalho e salta para a proxima. Num arquivo de
    300 MB isso sao algumas dezenas de leituras de 16 bytes.
    """
    ordem: list[str] = []
    tamanho = path.stat().st_size
    with path.open("rb") as f:
        pos = 0
        while pos + 8 <= tamanho and len(ordem) < limite:
            f.seek(pos)
            cabecalho = f.read(16)
            if len(cabecalho) < 8:
                break
            caixa = struct.unpack(">I", cabecalho[0:4])[0]
            tipo = cabecalho[4:8].decode("latin1")
            ordem.append(tipo)
            if caixa == 1:
                if len(cabecalho) < 16:
                    break
                caixa = struct.unpack(">Q", cabecalho[8:16])[0]
            elif caixa == 0:
                break  # "vai ate o fim do arquivo": nao ha proxima
            if caixa < 8:
                break
            pos += caixa
    return ordem


def _tem_edit_list(path: Path) -> bool:
    """Procura a assinatura `elst` dentro da `moov`.

    Varre so a `moov` — e onde a edit list mora, e ela tem alguns KB. Varrer o
    arquivo inteiro daria falso positivo: `elst` sao quatro bytes quaisquer, e
    num `mdat` de 300 MB de video comprimido eles aparecem por acaso.
    """
    tamanho = path.stat().st_size
    with path.open("rb") as f:
        pos = 0
        while pos + 8 <= tamanho:
            f.seek(pos)
            cabecalho = f.read(16)
            if len(cabecalho) < 8:
                return False
            caixa = struct.unpack(">I", cabecalho[0:4])[0]
            tipo = cabecalho[4:8].decode("latin1")
            desvio = 8
            if caixa == 1:
                if len(cabecalho) < 16:
                    return False
                caixa = struct.unpack(">Q", cabecalho[8:16])[0]
                desvio = 16
            if caixa < 8:
                return False
            if tipo == "moov":
                f.seek(pos + desvio)
                return b"elst" in f.read(min(caixa - desvio, 64 * 1024 * 1024))
            pos += caixa
    return False


def _keyframes_e_idr(path: Path) -> tuple[int, int]:
    dados = ffprobe_json(path, "-select_streams", "v:0", "-show_entries", "packet=flags")
    pacotes = dados.get("packets", []) or []
    chaves = sum(1 for p in pacotes if "K" in str(p.get("flags", "")))

    # LIDO EM PEDACOS, e nao de uma vez so. Juntar o fluxo H.264 inteiro na
    # memoria custaria ate 300 MB (o teto do proprio Reels) num processo que ja
    # tem a entrada e a saida ocupando o tmpfs — e tmpfs e memoria, e tambem
    # conta contra o `mem_limit` do conteiner. Com dois jobs em paralelo isso
    # convida o OOM killer, e o OOM leva os DOIS jobs junto.
    #
    # Contar NAL nao precisa do fluxo todo: basta uma janela deslizante. Os 3
    # bytes carregados de um pedaco para o outro existem porque um codigo de
    # inicio (`00 00 01`) pode cair exatamente na emenda.
    processo = subprocess.Popen(
        [FFMPEG, "-v", "error", "-i", str(path), "-map", "0:v:0", "-c", "copy",
         "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    idr = 0
    resto = b""
    try:
        assert processo.stdout is not None
        while True:
            pedaco = processo.stdout.read(1024 * 1024)
            if not pedaco:
                break

            janela = resto + pedaco
            posicao = 0
            while True:
                achou = janela.find(b"\x00\x00\x01", posicao)
                if achou < 0 or achou + 3 >= len(janela):
                    break
                if (janela[achou + 3] & 0x1F) == 5:
                    idr += 1
                posicao = achou + 3

            resto = janela[-3:]
    finally:
        if processo.stdout is not None:
            processo.stdout.close()
        processo.wait(timeout=60)

    return chaves, idr


def validate_reels(out_file: Path) -> list[Check]:
    """As checagens de compatibilidade com o Reels. Falha vira `failed`."""
    out = probe(out_file)
    bytes_saida = out_file.stat().st_size
    lim = REELS_LIMITES
    checks: list[Check] = []

    caixas = _caixas_de_topo(out_file)
    posicao_moov = caixas.index("moov") if "moov" in caixas else -1
    posicao_mdat = caixas.index("mdat") if "mdat" in caixas else -1
    moov_na_frente = posicao_moov >= 0 and (posicao_mdat < 0 or posicao_moov < posicao_mdat)
    checks.append(Check(
        "reels_moov_no_inicio", moov_na_frente,
        f"caixas de topo: {' '.join(caixas[:8])}"
        + ("" if moov_na_frente else "  <-- a moov precisa vir antes do mdat"),
        {"caixas": caixas[:8]},
    ))

    tem_elst = _tem_edit_list(out_file)
    checks.append(Check(
        "reels_sem_edit_list", not tem_elst,
        "nenhuma edit list na moov" if not tem_elst
        else "ha uma edit list (elst) na moov  <-- desalinha o audio no Reels",
        {"elst": tem_elst},
    ))

    if out.video_codec != "h264":
        checks.append(Check(
            "reels_closed_gop", False,
            f"a saida precisa ser H.264 para o Reels (veio {out.video_codec})",
            {"codec": out.video_codec},
        ))
    else:
        chaves, idr = _keyframes_e_idr(out_file)
        fechado = chaves > 0 and chaves == idr
        checks.append(Check(
            "reels_closed_gop", fechado,
            f"{chaves} quadro(s)-chave e {idr} IDR"
            + ("" if fechado else "  <-- keyframe que nao e IDR = GOP aberto"),
            {"keyframes": chaves, "idr": idr},
        ))

    audio_ok = (
        out.has_audio
        and out.audio_codec == "aac"
        and (out.audio_rate or 0) <= lim["audio_taxa_max"]
        and (out.audio_channels or 0) <= lim["audio_canais_max"]
    )
    checks.append(Check(
        "reels_audio", audio_ok,
        f"{out.audio_codec} {out.audio_rate}Hz {out.audio_channels}ch "
        f"(limite: aac, {lim['audio_taxa_max']}Hz, {lim['audio_canais_max']}ch)",
        {"codec": out.audio_codec, "taxa": out.audio_rate, "canais": out.audio_channels},
    ))

    fps_ok = lim["fps_min"] <= out.fps <= lim["fps_max"]
    checks.append(Check(
        "reels_fps", fps_ok,
        f"{out.fps:.3f}fps (aceito {lim['fps_min']:.0f}-{lim['fps_max']:.0f})",
        {"fps": out.fps},
    ))

    largura_ok = out.width <= lim["largura_max"]
    checks.append(Check(
        "reels_largura", largura_ok,
        f"{out.width}px de largura (limite {lim['largura_max']})",
        {"largura": out.width},
    ))

    duracao_ok = lim["duracao_min_s"] <= out.duration <= lim["duracao_max_s"]
    checks.append(Check(
        "reels_duracao", duracao_ok,
        f"{out.duration:.2f}s (aceito {lim['duracao_min_s']:.0f}s a "
        f"{lim['duracao_max_s'] / 60:.0f}min)",
        {"duracao_s": round(out.duration, 3)},
    ))

    tamanho_ok = bytes_saida <= lim["bytes_max"]
    checks.append(Check(
        "reels_tamanho", tamanho_ok,
        f"{bytes_saida / 1024 / 1024:.1f} MB (limite {lim['bytes_max'] // 1024 // 1024} MB)",
        {"bytes": bytes_saida},
    ))

    bitrate = int(bytes_saida * 8 / out.duration) if out.duration > 0 else 0
    bitrate_ok = bitrate <= lim["bitrate_max"]
    checks.append(Check(
        "reels_bitrate", bitrate_ok,
        f"{bitrate / 1_000_000:.2f} Mbps (limite "
        f"{lim['bitrate_max'] / 1_000_000:.0f} Mbps)",
        {"bitrate": bitrate},
    ))

    return checks
