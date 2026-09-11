"""O `template_snapshot` do job, transformado em config do pipeline.

ESTE ARQUIVO E UMA FRONTEIRA DE CONFIANCA, e vale explicar por que.

O snapshot e um `jsonb` que vem do banco. Hoje quem o escreve e o servidor, no
`enqueue_project`. Na Fase 6 quem o escreve passa a ser o editor visual, ou
seja, **o usuario**. Escrever este modulo agora como se o snapshot ja fosse
entrada hostil custa o mesmo e evita ter que lembrar disso depois — e "depois"
e exatamente quando nao se lembra.

O que um snapshot malicioso conseguiria sem esta barreira:

  · `profile.header_image` vira caminho de arquivo dentro de `build_overlay`, e
    la ele e colado com `project_root / valor`. Em Python, juntar um caminho
    ABSOLUTO a um diretorio devolve o absoluto — `Path("/app") / "/etc/shadow"`
    e `/etc/shadow`. Bastaria apontar para qualquer arquivo do conteiner para
    que o Pillow tentasse abri-lo, e o que ele conseguisse decodificar sairia
    DESENHADO no video que o usuario baixa depois.
  · `caption.font` tem o mesmo problema, por outro decoder (FreeType).
  · numeros fora de faixa (`size_px: 100000`, `scale: 1e9`) viram alocacao de
    imagem gigante — o worker morre de memoria e leva os outros jobs junto.

A DEFESA NAO E VALIDAR O QUE VEIO. E MONTAR DE NOVO.

`montar()` comeca de `PADRAO`, uma config completa escrita aqui, e copia do
snapshot **apenas** as chaves de `PERMITIDAS`, cada uma passando pelo seu
proprio conversor com faixa fechada. Chave desconhecida nao e erro: e ignorada.
Assim, o que chega ao pipeline nunca e o dicionario do usuario — e um
dicionario nosso, com alguns valores dele.

Arquivo (header e fonte) nunca vem como caminho. Vem como referencia:
`{"fonte":"embutido","nome":...}` resolve dentro de `worker/assets/`, e
`{"fonte":"r2","chave":...}` exige que a chave comece com o id do dono do job.
As duas terminam com `_dentro_de()`, que compara caminhos REAIS (com links
simbolicos ja resolvidos) antes de devolver.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

RAIZ = Path(__file__).resolve().parent.parent.parent
ASSETS = (RAIZ / "assets").resolve()

NOME_DE_ASSET = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
COR = re.compile(r"^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$")
CONTROLE = re.compile(r"[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]")

# Fontes DA IMAGEM, por apelido. O usuario escolhe um apelido, nunca um
# caminho. A Liberation Sans Bold e metricamente compativel com a Arial, que e
# a do post original (worker/README.md, "Hipoteses assumidas" §4).
FONTES: dict[str, tuple[str, ...]] = {
    "sans-bold": (
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/segoeuib.ttf",
    ),
    "sans": (
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ),
    "serif-bold": (
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "C:/Windows/Fonts/timesbd.ttf",
    ),
}

PRESETS = ("ultrafast", "superfast", "veryfast", "faster", "fast",
           "medium", "slow", "slower")


class MoldeInvalido(Exception):
    """O snapshot nao serve. `motivo` e a frase em pt-BR que o usuario le."""

    def __init__(self, motivo: str) -> None:
        super().__init__(motivo)
        self.motivo = motivo


# --- a config completa, escrita aqui ---------------------------------------
#
# E a `config/template.pretamente.json` sem os caminhos de Windows e sem os
# campos que comecam com `_` (que sao comentario do JSON, nao configuracao).
def _padrao() -> dict[str, Any]:
    return {
        "name": "padrao",
        "canvas": {"width": 1080, "height": 1920, "fps": 30, "background": "#FFFFFF"},
        "framing": {"mode": "fit"},
        "profile": {
            "header_image": "assets/header_pretamente.png",
            "align": "auto",
            "offset_x": 0,
            "offset_y": 0,
            "offset_space_height": 1920,
            "scale": 1.0,
            "trim_to_content": True,
        },
        "caption": {
            "text": "Parabéns! Você achou a página certa",
            "font": "",
            "font_fallbacks": [],
            "size_px": 58,
            "autofit": True,
            "min_size_px": 34,
            "color": "#000000",
            "max_width_pct": 0.9,
            "line_spacing": 1.16,
            "position": "between",
            "fixed_y": 480,
            "gap_top_px": 24,
            "gap_bottom_px": 24,
        },
        "cover": {"enabled": True, "color": "#FFFFFF", "extra_px": 0},
        "detect": {
            "sample_frames": 24,
            "motion_threshold": 2.0,
            "white_threshold": 245,
            "fallback_header_ratio": 0.32,
            "background_tolerance": 10,
        },
        "output": {
            "video_codec": "libx264",
            "crf": 20,
            "preset": "medium",
            "profile": "high",
            "pix_fmt": "yuv420p",
            "audio_codec": "aac",
            "audio_bitrate": "192k",
            "audio_rate": 48000,
            "audio_channels": 2,
            "ensure_audio_track": True,
            "faststart": True,
            "suffix": "_pagemask",
        },
        "validate": {
            "duration_tolerance_s": 0.15,
            "require_audio": True,
            "silence_floor_db": -60.0,
            "coverage_max_diff": 12,
            "coverage_sample_frames": 8,
            "fail_on_error": True,
        },
    }


def _texto(maximo: int) -> Callable[[Any], str]:
    def converter(valor: Any) -> str:
        if not isinstance(valor, str):
            raise MoldeInvalido("Um campo de texto do template veio com tipo errado.")
        # `\n` e a quebra manual que o pipeline entende e precisa sobreviver;
        # todo o resto da faixa de controle sai. Sem isso, um caractere
        # bidirecional inverte a frase desenhada no video.
        normalizado = valor.replace("\r\n", "\n").replace("\r", "\n")
        limpo = "".join(c for c in normalizado if c == "\n" or not CONTROLE.match(c))
        if len(limpo) > maximo:
            raise MoldeInvalido(f"Um texto do template passa de {maximo} caracteres.")
        return limpo

    return converter


def _inteiro(minimo: int, maximo: int) -> Callable[[Any], int]:
    def converter(valor: Any) -> int:
        if isinstance(valor, bool) or not isinstance(valor, (int, float)):
            raise MoldeInvalido("Um número do template veio com tipo errado.")
        inteiro = int(valor)
        if not minimo <= inteiro <= maximo:
            raise MoldeInvalido(f"Um número do template está fora da faixa ({minimo}–{maximo}).")
        return inteiro

    return converter


def _decimal(minimo: float, maximo: float) -> Callable[[Any], float]:
    def converter(valor: Any) -> float:
        if isinstance(valor, bool) or not isinstance(valor, (int, float)):
            raise MoldeInvalido("Um número do template veio com tipo errado.")
        numero = float(valor)
        # `nan` e `inf` passam por qualquer comparacao de faixa sem reprovar —
        # `nan <= x` e sempre falso, entao a checagem abaixo ja os pega, mas
        # so porque ela e escrita como "esta dentro", nunca como "nao esta fora".
        if not (minimo <= numero <= maximo):
            raise MoldeInvalido(f"Um número do template está fora da faixa ({minimo}–{maximo}).")
        return numero

    return converter


def _booleano(valor: Any) -> bool:
    if not isinstance(valor, bool):
        raise MoldeInvalido("Um campo de sim/não do template veio com tipo errado.")
    return valor


def _cor(valor: Any) -> str:
    if not isinstance(valor, str) or not COR.match(valor):
        raise MoldeInvalido("Uma cor do template não está no formato #RRGGBB.")
    return valor


def _cor_ou_auto(valor: Any) -> str:
    if valor == "auto":
        return "auto"
    return _cor(valor)


def _entre(*opcoes: str) -> Callable[[Any], str]:
    def converter(valor: Any) -> str:
        if valor not in opcoes:
            raise MoldeInvalido(
                "Uma opção do template não é válida (esperado: " + ", ".join(opcoes) + ")."
            )
        return str(valor)

    return converter


# Caminho no dicionario -> conversor. Nada fora desta tabela e copiado.
PERMITIDAS: dict[tuple[str, ...], Callable[[Any], Any]] = {
    ("canvas", "background"): _cor,
    ("framing", "mode"): _entre("fit", "cover", "blur"),
    ("profile", "align"): _entre("auto", "fixed"),
    ("profile", "offset_x"): _inteiro(-500, 500),
    ("profile", "offset_y"): _inteiro(-500, 500),
    ("profile", "offset_space_height"): _inteiro(320, 4320),
    ("profile", "scale"): _decimal(0.2, 3.0),
    ("profile", "trim_to_content"): _booleano,
    ("caption", "text"): _texto(400),
    ("caption", "size_px"): _inteiro(20, 140),
    ("caption", "min_size_px"): _inteiro(14, 140),
    ("caption", "autofit"): _booleano,
    ("caption", "color"): _cor,
    ("caption", "max_width_pct"): _decimal(0.3, 1.0),
    ("caption", "line_spacing"): _decimal(0.8, 2.0),
    ("caption", "position"): _entre("between", "fixed"),
    ("caption", "fixed_y"): _inteiro(0, 1920),
    ("caption", "gap_top_px"): _inteiro(0, 400),
    ("caption", "gap_bottom_px"): _inteiro(0, 400),
    ("cover", "enabled"): _booleano,
    ("cover", "color"): _cor_ou_auto,
    ("cover", "extra_px"): _inteiro(-200, 400),
    ("output", "crf"): _inteiro(14, 32),
    ("output", "preset"): _entre(*PRESETS),
}


def montar(
    snapshot: Any,
    *,
    user_id: str,
    pasta_do_job: Path,
    baixar_asset: Callable[[str, Path], None] | None = None,
) -> dict[str, Any]:
    """Config pronta para o pipeline, montada do zero.

    `baixar_asset(chave, destino)` so e chamado para header vindo do R2, e a
    chave ja foi conferida contra o prefixo do dono.
    """
    if not isinstance(snapshot, dict):
        raise MoldeInvalido(
            "O template deste lote não foi gravado corretamente. "
            "Abra o projeto e clique em Processar de novo."
        )

    cfg = _padrao()

    for caminho, converter in PERMITIDAS.items():
        valor = _pegar(snapshot, caminho)
        if valor is None:
            continue
        cfg[caminho[0]][caminho[1]] = converter(valor)

    if cfg["caption"]["min_size_px"] > cfg["caption"]["size_px"]:
        cfg["caption"]["min_size_px"] = cfg["caption"]["size_px"]

    cfg["profile"]["header_image"] = str(
        _resolver_header(
            _pegar(snapshot, ("profile", "header")),
            user_id=user_id,
            pasta_do_job=pasta_do_job,
            baixar_asset=baixar_asset,
        )
    )

    principal, reservas = _resolver_fonte(_pegar(snapshot, ("caption", "fonte")))
    cfg["caption"]["font"] = principal
    cfg["caption"]["font_fallbacks"] = list(reservas)

    return cfg


def _pegar(fonte: dict[str, Any], caminho: tuple[str, ...]) -> Any:
    atual: Any = fonte
    for parte in caminho:
        if not isinstance(atual, dict) or parte not in atual:
            return None
        atual = atual[parte]
    return atual


def _dentro_de(caminho: Path, pasta: Path) -> Path:
    """Confere containment com os caminhos JA resolvidos (links inclusive).

    Comparar texto (`str(p).startswith(str(pasta))`) nao serve: `/app/assets2`
    comeca com `/app/assets`, e um link simbolico dentro da pasta aponta para
    onde quiser sem mudar o texto do caminho.
    """
    real = caminho.resolve()
    try:
        real.relative_to(pasta.resolve())
    except ValueError as erro:
        raise MoldeInvalido("Uma imagem do template está fora das pastas permitidas.") from erro
    return real


def _resolver_header(
    referencia: Any,
    *,
    user_id: str,
    pasta_do_job: Path,
    baixar_asset: Callable[[str, Path], None] | None,
) -> Path:
    if referencia is None:
        referencia = {"fonte": "embutido", "nome": "header_pretamente.png"}

    if not isinstance(referencia, dict):
        raise MoldeInvalido("A imagem de cabeçalho do template não foi indicada corretamente.")

    fonte = referencia.get("fonte")

    if fonte == "embutido":
        nome = referencia.get("nome")
        if not isinstance(nome, str) or not NOME_DE_ASSET.match(nome):
            raise MoldeInvalido("A imagem de cabeçalho do template tem um nome inválido.")
        caminho = _dentro_de(ASSETS / nome, ASSETS)
        if not caminho.is_file():
            raise MoldeInvalido("A imagem de cabeçalho deste template não existe mais.")
        return caminho

    if fonte == "r2":
        chave = referencia.get("chave")
        if not isinstance(chave, str) or not chave.startswith(f"{user_id}/") or ".." in chave:
            raise MoldeInvalido("A imagem de cabeçalho do template não pertence a esta conta.")
        if baixar_asset is None:
            raise MoldeInvalido("Não foi possível buscar a imagem de cabeçalho do template.")
        destino = _dentro_de(pasta_do_job / "header.png", pasta_do_job)
        baixar_asset(chave, destino)
        if not destino.is_file():
            raise MoldeInvalido("Não foi possível buscar a imagem de cabeçalho do template.")
        return destino

    raise MoldeInvalido("A imagem de cabeçalho do template não foi indicada corretamente.")


def _resolver_fonte(apelido: Any) -> tuple[str, tuple[str, ...]]:
    if apelido is None:
        apelido = "sans-bold"
    if apelido not in FONTES:
        raise MoldeInvalido(
            "A fonte escolhida no template não está disponível "
            "(use: " + ", ".join(sorted(FONTES)) + ")."
        )

    candidatos = FONTES[apelido]
    existentes = [c for c in candidatos if Path(c).is_file()]
    if not existentes:
        # Erro de imagem mal montada, nao de template: quem ve isso e o log, e
        # o job falha (nao e recusado), porque nao e culpa do arquivo.
        raise FileNotFoundError(
            f"nenhuma fonte do apelido {apelido!r} existe nesta imagem: {', '.join(candidatos)}"
        )
    return existentes[0], tuple(existentes[1:])
