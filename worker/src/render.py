"""Render final: normaliza o video, aplica o overlay e codifica o MP4."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from .framing import build_framing_filter
from .probe import MediaInfo
from .util import FFMPEG, run


#: Nome do arquivo de legenda dentro da pasta do job. Fixo e sem caractere
#: especial de proposito — ele vai DENTRO de um filtergraph do FFmpeg, e e por
#: isso que o comando roda com `cwd` na pasta do job (ver `util.run`).
LEGENDA_ASS = "legenda.ass"

#: A pasta que o libass varre atras de fontes, relativa ao `cwd`.
#:
#: ELA PRECISA CONTER SO A FONTE, e isso e seguranca, nao arrumacao. O
#: `fontsdir` do libass nao e uma dica de onde procurar: ele LE CADA ARQUIVO do
#: diretorio inteiro para a memoria e entrega o buffer ao FreeType
#: (`FT_New_Memory_Face`). Apontado para a pasta do job, ele leria
#: `entrada.bin` — o video que um desconhecido enviou — como se fosse uma
#: fonte, e ai bytes de atacante entrariam num parser de fonte que esta FORA da
#: trava de versao do Dockerfile: o FreeType vem estatico dentro do binario do
#: FFmpeg, e o `conferir-ffmpeg.sh` so olha a versao do FFmpeg. O conteiner que
#: roda isso carrega a `service_role`, as credenciais do R2 e a `TOKEN_ENC_KEY`.
#:
#: O libass nao desce em subpastas, entao `fontes/` isola de verdade: o unico
#: arquivo lido e a copia que `trabalho.py` poe la.
LEGENDA_FONTES = "fontes"


def build_command(info: MediaInfo, cfg: dict, overlay_png: Path, out_path: Path,
                  legenda: bool = False) -> list[str]:
    """O comando do render. Com `legenda=True`, queima `LEGENDA_ASS` do cwd.

    A ORDEM DOS FILTROS E UMA GARANTIA, e nao uma preferencia:

        [0:v] enquadramento -> [bg] -> subtitles -> [leg] -> overlay -> [v]

    A legenda entra ANTES do overlay. Assim a faixa de cobertura e o cabecalho
    novo sao sempre a ultima camada, e uma legenda que por qualquer motivo
    subisse demais fica coberta em vez de ser desenhada por cima do cabecalho —
    que e o que a checagem `cobertura_header` reprovaria, derrubando o job
    inteiro por um problema de enquadramento de texto.
    """
    out = cfg["output"]
    canvas = cfg["canvas"]

    fc = build_framing_filter(cfg, "0:v", "bg")

    ultimo = "bg"
    if legenda:
        # `fontsdir` aponta para a SUBPASTA que tem SO a fonte escolhida, nunca
        # para a pasta do job. As duas razoes estao em `LEGENDA_FONTES`, e a
        # segunda e a que decide: o libass le como fonte cada arquivo do
        # diretorio, e na pasta do job mora o video do usuario.
        #
        # Sem um `fontsdir` que funcione, o libass cairia no fontconfig do
        # sistema — que no conteiner existe e responde o que estiver
        # instalado. A legenda sairia com OUTRA tipografia, sem erro nenhum.
        fc += (
            f";[bg]subtitles=filename={LEGENDA_ASS}"
            f":fontsdir={LEGENDA_FONTES}[leg]"
        )
        ultimo = "leg"

    fc += f";[{ultimo}][1:v]overlay=0:0:format=auto,format=" + out["pix_fmt"] + "[v]"

    cmd = [FFMPEG, "-y", "-v", "error", "-stats",
           "-i", str(info.path),
           "-loop", "1", "-i", str(overlay_png)]

    maps = ["-map", "[v]"]
    audio_args: list[str] = []

    if info.has_audio:
        maps += ["-map", "0:a:0"]
        audio_args = ["-c:a", out["audio_codec"], "-b:a", out["audio_bitrate"],
                      "-ar", str(out["audio_rate"]), "-ac", str(out["audio_channels"])]
    elif out.get("ensure_audio_track", True):
        # trilha silenciosa: muitas plataformas rejeitam MP4 sem audio
        cmd += ["-f", "lavfi", "-i",
                f"anullsrc=channel_layout={'stereo' if out['audio_channels'] == 2 else 'mono'}"
                f":sample_rate={out['audio_rate']}"]
        maps += ["-map", "2:a:0"]
        audio_args = ["-c:a", out["audio_codec"], "-b:a", out["audio_bitrate"]]

    cmd += ["-filter_complex", fc, *maps,
            "-c:v", out["video_codec"], "-profile:v", out["profile"],
            "-preset", out["preset"], "-crf", str(out["crf"]),
            "-pix_fmt", out["pix_fmt"], "-r", str(canvas["fps"]),
            *audio_args,
            "-t", f"{info.duration:.3f}",   # o overlay e infinito: corta na duracao da fonte
            "-shortest"]

    if out.get("faststart", True):
        # Duas exigencias do Reels, e elas andam juntas (PLANO, Fase 3):
        #
        #   `+faststart`  poe a `moov` na frente do `mdat`, para o player
        #                 comecar sem baixar o arquivo inteiro.
        #   sem edit list o Reels nao tropeca no atraso de codificacao do AAC.
        #
        # So que `-use_editlist 0` SOZINHO desalinha: a edit list existe
        # justamente para compensar esse atraso, e sem ela o video passa a
        # comecar 66 ms depois do audio (medido: `start_time` 0.066667 contra
        # 0.000000). `+negative_cts_offsets` resolve pelo outro lado — guarda o
        # deslocamento em offsets de composicao negativos, dentro do proprio
        # `ctts`, e ai as duas trilhas voltam a comecar em zero sem edit list
        # nenhuma (medido: video 0.000/4.000, audio 0.000/4.021).
        cmd += ["-movflags", out.get("movflags", "+faststart+negative_cts_offsets")]
        if not out.get("edit_list", False):
            cmd += ["-use_editlist", "0"]

    cmd.append(str(out_path))
    return cmd


def render(info: MediaInfo, cfg: dict, overlay_png: Path, out_path: Path,
           legenda: bool = False) -> list[str]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = build_command(info, cfg, overlay_png, out_path, legenda=legenda)
    run(cmd, cwd=out_path.parent if legenda else None)
    return cmd


def render_preview(info: MediaInfo, cfg: dict, overlay_png: Path, out_png: Path,
                   at_seconds: float | None = None, legenda: bool = False) -> Path:
    """Compoe o overlay sobre um frame real e salva um PNG.

    Serve para ajustar frase, fonte e posicao sem pagar o render completo.

    Com `legenda=True`, queima `LEGENDA_ASS` da pasta de `out_png` — que na
    previa e uma fala de exemplo, nao a transcricao. A previa do editor nao
    transcreve nada (ver `servico/previa.py`): ela existe para mostrar TIPO,
    CORPO, COR e POSICAO da legenda, e para isso um texto qualquer serve.
    """
    canvas = cfg["canvas"]
    t = info.duration / 2 if at_seconds is None else at_seconds
    fc = build_framing_filter(cfg, "0:v", "bg")
    if legenda:
        fc += (
            f";[bg]subtitles=filename={LEGENDA_ASS}"
            f":fontsdir={LEGENDA_FONTES}[leg]"
        )
    raw = run([FFMPEG, "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(info.path),
               "-filter_complex", fc, "-map", "[leg]" if legenda else "[bg]",
               "-frames:v", "1",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_stdout=True,
              cwd=out_png.parent if legenda else None)

    w, h = canvas["width"], canvas["height"]
    frame = Image.frombytes("RGB", (w, h), raw[: w * h * 3]).convert("RGBA")
    frame.alpha_composite(Image.open(overlay_png).convert("RGBA"))
    out_png.parent.mkdir(parents=True, exist_ok=True)
    frame.convert("RGB").save(out_png)
    return out_png
