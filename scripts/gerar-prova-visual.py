#!/usr/bin/env python3
"""Gera a prova visual da landing: antes, depois e relatorio — pelo pipeline real.

POR QUE UM VIDEO SINTETICO, E NAO UM CLIENTE DE VERDADE
=======================================================

A landing precisa mostrar um antes e depois que seja *nosso*. O material que
existe em `worker/input/` e repost de pagina de terceiro: publicar aquele frame
numa pagina comercial e problema de direito de imagem e de autor, e nao ha
autorizacao nenhuma no processo. Entao a origem e fabricada aqui — um "post"
que imita o formato (header antigo em cima, video no meio, fundo liso embaixo).

O QUE E REAL
============

Tudo depois da origem. O video sintetico passa pelo `worker/run.py` de verdade:
mesma deteccao de layout, mesmo overlay, mesmo FFmpeg, mesma `validate.py`. Os
numeros que a landing mostra (`app/src/lib/landing/prova.json`) sao a saida
literal dessas checagens, copiada sem edicao. Se o pipeline regredir, roda-se
este script de novo e a landing passa a mostrar a regressao.

USO
===

    python scripts/gerar-prova-visual.py

Escreve em `app/public/prova/` (WebP do antes e do depois) e em
`app/src/lib/landing/prova.json` (o relatorio). Precisa de FFmpeg no PATH.
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RAIZ = Path(__file__).resolve().parent.parent
WORKER = RAIZ / "worker"
DESTINO_IMG = RAIZ / "app" / "public" / "prova"
DESTINO_JSON = RAIZ / "app" / "src" / "lib" / "landing" / "prova.json"

# A origem imita um repost de 720x1280 — a resolucao que sai do Instagram.
LARGURA, ALTURA, FPS, SEGUNDOS = 720, 1280, 30, 10

# Faixas do "post" de origem, em pixels da origem (720x1280).
HEADER_TOPO, HEADER_BASE = 120, 300     # avatar + @ da pagina antiga
FRASE_TOPO, FRASE_BASE = 320, 420       # a frase do post antigo
VIDEO_TOPO, VIDEO_BASE = 470, 1010      # a faixa que precisa sobreviver intacta

# As fontes, por sistema. Windows primeiro porque e onde o script roda hoje.
#
# NADA DE `load_default()` COMO ULTIMO RECURSO. O padrao do Pillow e um bitmap
# minusculo: com ele o script terminaria com codigo 0, sobrescrevendo o antes e
# o depois da landing por duas imagens ilegiveis, e ninguem descobriria ate
# alguem abrir a pagina. Fonte que nao carrega e erro, nao degradacao — a mesma
# regra do `render.js` da marca pessoal no CLAUDE.md da raiz.
NEGRITO = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]
REGULAR = [
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def fonte(candidatas: list[str], tamanho: int) -> ImageFont.FreeTypeFont:
    for caminho in candidatas:
        try:
            return ImageFont.truetype(caminho, tamanho)
        except OSError:
            continue
    raise SystemExit(
        "nenhuma fonte encontrada em:\n  "
        + "\n  ".join(candidatas)
        + "\n\nA prova NAO foi atualizada. Instale uma delas (no Debian/Ubuntu:\n"
        "`apt-get install fonts-dejavu-core`) e rode de novo."
    )


# ---------------------------------------------------------------------------
# 1. A moldura do post antigo: PNG 720x1280 com buraco transparente no video
# ---------------------------------------------------------------------------


def moldura_do_post(destino: Path) -> None:
    img = Image.new("RGBA", (LARGURA, ALTURA), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)

    # Avatar da pagina antiga.
    d.ellipse([48, HEADER_TOPO, 48 + 104, HEADER_TOPO + 104], fill=(203, 213, 225, 255))
    d.ellipse([76, HEADER_TOPO + 24, 76 + 48, HEADER_TOPO + 24 + 48], fill=(148, 163, 184, 255))
    d.rounded_rectangle(
        [62, HEADER_TOPO + 78, 62 + 76, HEADER_TOPO + 78 + 34],
        radius=18, fill=(148, 163, 184, 255),
    )

    # `@perfil.antigo`, e nao um @ que soe plausivel: um nome bonitinho de
    # pagina pode existir de verdade, e ai a landing estaria exibindo a marca de
    # alguem como "o perfil que voce vai cobrir". O placeholder tem que se
    # anunciar como placeholder — do mesmo jeito que `@suapagina` do outro lado.
    d.text((176, HEADER_TOPO + 14), "@perfil.antigo", font=fonte(NEGRITO, 40), fill=(15, 23, 42, 255))
    d.text((176, HEADER_TOPO + 64), "Original · há 2 h", font=fonte(REGULAR, 30), fill=(100, 116, 139, 255))

    # A frase do post antigo, em duas linhas.
    f = fonte(REGULAR, 34)
    for i, linha in enumerate(["Você achou a página que posta", "os melhores cortes todo dia"]):
        d.text((48, FRASE_TOPO + i * 46), linha, font=f, fill=(30, 41, 59, 255))

    # Abaixo do video o post antigo fica vazio de proposito. Numero de curtida
    # inventado ali viraria numero inventado na landing — e emoji do Instagram
    # nao existe nas fontes do Windows: sai como caixa vazia no PNG.

    # O buraco por onde o video aparece.
    d.rectangle([0, VIDEO_TOPO, LARGURA - 1, VIDEO_BASE - 1], fill=(0, 0, 0, 0))

    img.save(destino)


# ---------------------------------------------------------------------------
# 2. O conteudo em movimento da faixa central
# ---------------------------------------------------------------------------


def frames_do_video(pasta: Path) -> None:
    """Cena abstrata animada. Precisa MEXER: a checagem 7 mede variancia temporal."""
    largura, altura = LARGURA, VIDEO_BASE - VIDEO_TOPO
    total = FPS * SEGUNDOS

    # Fundo em degrade, desenhado uma vez.
    base = Image.new("RGB", (largura, altura))
    d = ImageDraw.Draw(base)
    for y in range(altura):
        t = y / max(1, altura - 1)
        d.line(
            [(0, y), (largura, y)],
            fill=(int(15 + 24 * t), int(23 + 40 * t), int(42 + 44 * t)),
        )

    bolhas = [
        (0.22, 0.30, 190, (16, 185, 129), 1.00, 0.0),
        (0.72, 0.62, 150, (52, 211, 153), 0.72, 2.1),
        (0.48, 0.84, 220, (14, 116, 144), 0.55, 4.2),
    ]

    for n in range(total):
        fase = 2 * math.pi * n / total
        quadro = base.copy()
        camada = Image.new("RGBA", (largura, altura), (0, 0, 0, 0))
        pincel = ImageDraw.Draw(camada)
        for cx, cy, raio, cor, veloc, offset in bolhas:
            x = cx * largura + math.cos(fase * veloc + offset) * largura * 0.16
            y = cy * altura + math.sin(fase * veloc * 1.3 + offset) * altura * 0.13
            pincel.ellipse([x - raio, y - raio, x + raio, y + raio], fill=(*cor, 90))
        quadro = Image.alpha_composite(quadro.convert("RGBA"), camada).convert("RGB")
        quadro.save(pasta / f"{n:04d}.png")


# ---------------------------------------------------------------------------
# 3. O header novo — o que o PageMask carimba por cima
# ---------------------------------------------------------------------------


def header_novo(destino: Path) -> None:
    """PNG do canvas final (1080 de largura). Fundo transparente: o overlay compoe."""
    largura, altura = 1080, 190
    img = Image.new("RGBA", (largura, altura), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.ellipse([72, 24, 72 + 142, 24 + 142], fill=(16, 185, 129, 255))
    d.text((116, 60), "PM", font=fonte(NEGRITO, 62), fill=(2, 44, 34, 255))

    d.text((248, 46), "@suapagina", font=fonte(NEGRITO, 54), fill=(15, 23, 42, 255))
    d.text((248, 110), "Segue lá · conteúdo novo todo dia", font=fonte(REGULAR, 38),
           fill=(71, 85, 105, 255))

    img.save(destino)


# ---------------------------------------------------------------------------
# 4. Montagem da origem com FFmpeg
# ---------------------------------------------------------------------------


def ffmpeg(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def montar_origem(frames: Path, moldura: Path, destino: Path) -> None:
    ffmpeg([
        "-framerate", str(FPS), "-i", str(frames / "%04d.png"),
        "-i", str(moldura),
        # Trilha de audio de verdade: a checagem 3 reprova saida muda, e um
        # silencio na origem levaria a checagem a passar pelo ramo de excecao,
        # que e justamente o caso que a prova NAO deve exercitar.
        "-f", "lavfi", "-i", f"sine=frequency=196:duration={SEGUNDOS},volume=0.35",
        "-filter_complex",
        f"color=c=white:s={LARGURA}x{ALTURA}:d={SEGUNDOS}:r={FPS}[bg];"
        f"[bg][0:v]overlay=0:{VIDEO_TOPO}:shortest=1[v0];"
        "[v0][1:v]overlay=0:0[v]",
        "-map", "[v]", "-map", "2:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
        str(destino),
    ])


# Fracao da altura que entra no recorte do antes e depois.
#
# Abaixo disso o post nao tem nada — nem na origem nem na saida — e 21% de
# branco morto em cada imagem so faz a parte que interessa (a troca do @ no
# topo) sair menor na tela. O recorte e o MESMO nos dois, medido em fracao e
# nao em pixel, porque origem e saida tem alturas diferentes (1280 e 1920): o
# que a landing compara continua sendo o mesmo pedaco do mesmo quadro.
RECORTE = 0.79


def quadro_webp(video: Path, segundo: float, destino: Path, largura: int) -> None:
    """Um frame do video, recortado, redimensionado e em WebP."""
    ffmpeg([
        "-ss", str(segundo), "-i", str(video), "-frames:v", "1",
        # `2*floor(.../2)`: libwebp recusa altura impar.
        "-vf", f"crop=iw:2*floor(ih*{RECORTE}/2):0:0,"
               f"scale={largura}:-2:flags=lanczos",
        "-c:v", "libwebp", "-quality", "82", "-compression_level", "6",
        str(destino),
    ])


# ---------------------------------------------------------------------------


def main() -> int:
    if shutil.which("ffmpeg") is None:
        print("ffmpeg nao encontrado no PATH", file=sys.stderr)
        return 2

    DESTINO_IMG.mkdir(parents=True, exist_ok=True)
    DESTINO_JSON.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="prova-") as tmp:
        t = Path(tmp)
        (t / "frames").mkdir()
        (t / "saida").mkdir()
        (t / "trabalho").mkdir()

        print("· moldura do post antigo")
        moldura_do_post(t / "moldura.png")

        print("· frames da faixa de video")
        frames_do_video(t / "frames")

        print("· header novo")
        header_novo(t / "header.png")

        print("· montando a origem")
        origem = t / "antes.mp4"
        montar_origem(t / "frames", t / "moldura.png", origem)

        print("· rodando o pipeline de verdade")
        config = json.loads(
            (WORKER / "config" / "template.pretamente.json").read_text(encoding="utf-8")
        )
        config["name"] = "prova-da-landing"
        config["profile"]["header_image"] = str(t / "header.png")
        config["caption"]["text"] = "Todo dia um corte novo. Segue @suapagina"
        config["output"]["suffix"] = "_depois"
        caminho_config = t / "config.json"
        caminho_config.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

        relatorio = t / "relatorio.json"
        execucao = subprocess.run(
            [
                sys.executable, str(WORKER / "run.py"), str(origem),
                "-c", str(caminho_config),
                "-o", str(t / "saida"),
                "--work", str(t / "trabalho"),
                "--report", str(relatorio),
            ],
            cwd=WORKER,
        )
        if execucao.returncode != 0:
            print("o pipeline reprovou — a prova NAO foi atualizada", file=sys.stderr)
            return 1

        resultado = json.loads(relatorio.read_text(encoding="utf-8"))[0]
        saida = Path(resultado["output"])

        # `media.path` e `output` sao caminhos absolutos de uma pasta temporaria
        # — com o nome de usuario do Windows dentro. Isso vai para o git e para
        # o bundle do cliente. Fora.
        resultado["media"].pop("path", None)

        print("· extraindo os quadros")
        # 4,2 s: um instante em que as bolhas estao bem distribuidas nos dois
        # videos. O mesmo segundo nos dois, senao o antes e depois compara
        # cenas diferentes e deixa de provar coisa nenhuma.
        quadro_webp(origem, 4.2, DESTINO_IMG / "antes.webp", 540)
        quadro_webp(saida, 4.2, DESTINO_IMG / "depois.webp", 540)

        DESTINO_JSON.write_text(
            json.dumps(
                {
                    "gerado_por": "scripts/gerar-prova-visual.py",
                    "origem": "video sintetico — ver o cabecalho do script",
                    "media": resultado["media"],
                    "layout": resultado["layout"],
                    "checks": resultado["checks"],
                    "passed": resultado["passed"],
                    "elapsed_s": resultado["elapsed_s"],
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

    print(f"\nantes    : {DESTINO_IMG / 'antes.webp'}")
    print(f"depois   : {DESTINO_IMG / 'depois.webp'}")
    print(f"relatorio: {DESTINO_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
