"""Legenda: transcrever, higienizar, posicionar e queimar.

    audio -> faster-whisper -> SRT (higienizado) -> R2
                                   |
                                   v
                             ASS (gerado aqui) -> filtro `subtitles` do FFmpeg

TRES DECISOES MORAM NESTE ARQUIVO, e cada uma responde a um risco diferente.

1. O SRT E GRAVADO ANTES DO RENDER
==================================

A transcricao e a UNICA etapa nao deterministica do pipeline (CLAUDE.md,
"Regra numero um"): o mesmo audio pode sair com uma palavra diferente na
proxima execucao, e um modelo atualizado sai diferente com certeza. Gravar o
texto no R2 antes de renderizar troca isso por um arquivo: dali em diante o
render tem um insumo fixo, auditavel e editavel — e reprocessar produz o mesmo
video.

2. O SRT NUNCA CHEGA AO FFMPEG COMO SRT
=======================================

O filtro `subtitles` aceitaria o .srt direto, e e ai que mora o problema de
seguranca da fase. O decodificador de SRT do FFmpeg converte marcacao HTML
(`<b>`, `<font color=...>`) em tags de override do ASS, e o texto do usuario —
que aqui passou por um modelo de IA e depois por um editor na tela — vira
entrada de um interpretador de estilo. Um `{\\an8}` ou um `<font>` no lugar
certo reposiciona ou recolore a legenda, que e exatamente o que o cross-check
da fase testa.

A defesa e a mesma do `molde.py`: **nao validar o que veio, montar de novo**.
`higienizar` remove de vez os caracteres que sao sintaxe nos dois formatos
(`{`, `}`, `\\`, `<`, `>`) e `para_ass` escreve o arquivo final com um
cabecalho e um estilo escritos aqui. O que o libass recebe e um ASS nosso com
o TEXTO do usuario dentro, nunca um arquivo do usuario.

3. A LEGENDA E DESENHADA ANTES DO OVERLAY
=========================================

No `render.py` a ordem e `[bg] -> subtitles -> overlay`. Invertida, uma legenda
que subisse demais seria desenhada POR CIMA do cabecalho novo — e a checagem
`cobertura_header` reprovaria o job inteiro. Nesta ordem, a faixa de cobertura
do overlay e sempre a ultima camada: "a legenda nao invade o cabecalho" deixa
de ser uma conta que precisa estar certa e passa a ser uma propriedade da
composicao. A conta de `posicionar` continua existindo para que a legenda fique
BONITA dentro da faixa de video; a garantia nao depende dela.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ..analyze import Layout
from ..util import PipelineError

# --- limites do arquivo ----------------------------------------------------
#
# Sao tetos de sanidade, e valem tanto para o que o modelo produz quanto para o
# que volta editado da tela. Um SRT e texto: sem teto, um arquivo de 80 MB
# entraria no tmpfs e no libass.
MAX_CUES = 2_000
MAX_LINHAS_POR_CUE = 2
# A quebra por caractere e do ARQUIVO, nao do desenho: ela mantem o SRT legivel
# no editor e igual em qualquer maquina. Quem garante que a linha CABE na tela e
# `ajustar_ao_texto`, que mede em pixeis com a fonte de verdade.
MAX_CARACTERES_POR_LINHA = 42
MAX_BYTES_DO_SRT = 512 * 1024

#: Corpo minimo depois do encolhimento automatico. Abaixo disso a legenda
#: deixa de ser legivel num celular e o certo e falhar a conta, nao entregar
#: algo que ninguem le.
CORPO_MINIMO_PX = 18

#: Altura de linha do libass para um corpo dado. E o valor que o ASS usa quando
#: nao ha `ScaleY` nem `Spacing`, e serve de estimativa para caber o bloco.
ALTURA_DE_LINHA = 1.2

#: O que sai do texto de vez: sintaxe de ASS (`{`, `}`, `\\`), sintaxe de HTML
#: (`<`, `>`) e os invisiveis — controles C0/C1 e as marcas de direcao, que
#: invertem a ordem do texto DESENHADO sem mudar o que aparece na tela de
#: edicao. Escrito como escape pela mesma razao do resto do projeto: caractere
#: de controle literal no fonte some em revisao e em diff.
PROIBIDOS = re.compile(
    # sintaxe de ASS (chave e barra invertida) e de HTML (menor e maior)
    "[{}<>\\\\"
    # controles C0 e C1, SEM a tabulacao e SEM o fim de linha: a primeira
    # vira espaco no colapso de `higienizar`, e o segundo e a quebra de
    # linha que o SRT precisa manter
    "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f"
    # invisiveis de largura zero, marcas de direcao e a BOM. Escritos como
    # escape pela mesma razao do resto do projeto: caractere invisivel
    # literal no fonte some em revisao e em diff — e e isso que o torna
    # util para atacar
    "\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]"
)

TEMPO_SRT = re.compile(
    r"(?P<h>\d{1,3}):(?P<m>\d{1,2}):(?P<s>\d{1,2})[,.](?P<ms>\d{1,3})"
)


class LegendaInvalida(PipelineError):
    """O SRT nao serve. A frase e escrita para quem le a tela."""


@dataclass(frozen=True)
class Fala:
    """Uma fala: inicio e fim em segundos, e as linhas ja higienizadas."""

    inicio: float
    fim: float
    linhas: tuple[str, ...]

    @property
    def texto(self) -> str:
        return "\n".join(self.linhas)


# ===========================================================================
# Higiene
# ===========================================================================


def higienizar(texto: str) -> tuple[str, ...]:
    """O texto de uma fala, pronto para ser desenhado. Nunca sintaxe.

    Remover em vez de escapar e deliberado. Escapar exigiria acertar a regra de
    DOIS interpretadores (o do SRT do FFmpeg e o do ASS do libass) e manter o
    acerto a cada versao dos dois; remover encerra a questao — `{`, `}`, `\\`,
    `<` e `>` nao aparecem em legenda de fala em portugues, e quando aparecem o
    preco de perde-los e um caractere, nao um estilo aplicado por outra pessoa.
    """
    limpo = PROIBIDOS.sub("", texto.replace("\r\n", "\n").replace("\r", "\n"))

    linhas: list[str] = []
    for bruta in limpo.split("\n"):
        # `split()` sem argumento ja colapsa qualquer espaco em branco,
        # tabulacao inclusive. Os invisiveis de largura zero — que NAO sao
        # espaco para o Python — sairam em `PROIBIDOS`, acima.
        normal = " ".join(bruta.split())
        if normal:
            linhas.extend(_quebrar(normal, MAX_CARACTERES_POR_LINHA))

    if not linhas:
        return ()

    if len(linhas) > MAX_LINHAS_POR_CUE:
        # O corte e por LINHA, e nao por caractere, porque o teto de linhas e o
        # que mantem a conta de altura de `posicionar` valida. Uma fala de
        # cinco linhas viraria um bloco alto o bastante para sair da faixa de
        # video — e ai a legenda invadiria o lugar de outra coisa.
        linhas = linhas[:MAX_LINHAS_POR_CUE]
        linhas[-1] = _com_reticencias(linhas[-1], MAX_CARACTERES_POR_LINHA)

    return tuple(linhas)


def _quebrar(texto: str, largura: int) -> list[str]:
    """Quebra por palavra; palavra maior que a largura e cortada."""
    linhas: list[str] = []
    atual = ""

    for palavra in texto.split(" "):
        while len(palavra) > largura:
            if atual:
                linhas.append(atual)
                atual = ""
            linhas.append(palavra[:largura])
            palavra = palavra[largura:]

        if not atual:
            atual = palavra
        elif len(atual) + 1 + len(palavra) <= largura:
            atual = f"{atual} {palavra}"
        else:
            linhas.append(atual)
            atual = palavra

    if atual:
        linhas.append(atual)
    return linhas


def _com_reticencias(linha: str, largura: int) -> str:
    if len(linha) + 1 <= largura:
        return f"{linha}…"
    return f"{linha[: max(0, largura - 1)].rstrip()}…"


# ===========================================================================
# SRT: ler e escrever
# ===========================================================================


def ler_srt(bruto: str | bytes, *, duracao_s: float | None = None) -> list[Fala]:
    """O SRT conferido e higienizado, ou `LegendaInvalida`.

    Aceita o arquivo que ESTE modulo escreveu e o que voltou editado da tela —
    os dois passam pela mesma porta, de proposito. O parser e proprio (e nao
    uma biblioteca) porque ele precisa ser tolerante no formato e intransigente
    no conteudo, e nenhuma biblioteca de SRT faz a segunda parte.
    """
    if isinstance(bruto, bytes):
        if len(bruto) > MAX_BYTES_DO_SRT:
            raise LegendaInvalida(
                f"O arquivo de legenda passa de {MAX_BYTES_DO_SRT // 1024} KB."
            )
        texto = bruto.decode("utf-8", "replace")
    else:
        texto = bruto

    # A BOM sai em `PROIBIDOS`, junto com os outros invisiveis.
    texto = texto.replace("\r\n", "\n").replace("\r", "\n")

    falas: list[Fala] = []
    anterior_fim = 0.0

    for bloco in re.split(r"\n{2,}", texto):
        linhas = [l for l in bloco.split("\n") if l.strip() != ""]
        if not linhas:
            continue

        # O numero de sequencia e opcional aqui: ele e redundante (a ordem e a
        # do arquivo) e um SRT editado a mao chega com a numeracao furada o
        # tempo todo. Reescrevemos a numeracao ao gravar.
        if "-->" not in linhas[0] and len(linhas) > 1:
            linhas = linhas[1:]

        if not linhas or "-->" not in linhas[0]:
            continue

        tempos = TEMPO_SRT.findall(linhas[0])
        if len(tempos) < 2:
            continue

        inicio = _segundos(tempos[0])
        fim = _segundos(tempos[1])
        conteudo = higienizar("\n".join(linhas[1:]))
        if not conteudo:
            continue

        if duracao_s is not None and duracao_s > 0:
            inicio = min(inicio, duracao_s)
            fim = min(fim, duracao_s)

        # Ordem e sobreposicao nao sao erro do usuario, sao ruido de edicao. O
        # libass desenharia duas falas ao mesmo tempo, uma por cima da outra.
        inicio = max(inicio, anterior_fim)
        if fim <= inicio:
            fim = inicio + 0.4
        anterior_fim = fim

        falas.append(Fala(inicio=inicio, fim=fim, linhas=conteudo))
        if len(falas) >= MAX_CUES:
            break

    if not falas:
        raise LegendaInvalida(
            "Esta legenda não tem nenhuma fala legível. Confira o texto e salve de novo."
        )

    return falas


def _segundos(grupo: tuple[str, str, str, str]) -> float:
    h, m, s, ms = grupo
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def escrever_srt(falas: Iterable[Fala]) -> str:
    """O SRT canonico: numeracao refeita, virgula no milissegundo, `\\n` puro."""
    partes: list[str] = []
    for indice, fala in enumerate(falas, start=1):
        partes.append(
            f"{indice}\n{_tempo_srt(fala.inicio)} --> {_tempo_srt(fala.fim)}\n"
            f"{fala.texto}\n"
        )
    return "\n".join(partes)


def _tempo_srt(segundos: float) -> str:
    total = max(0.0, segundos)
    h, resto = divmod(int(total), 3600)
    m, s = divmod(resto, 60)
    ms = int(round((total - int(total)) * 1000))
    if ms >= 1000:  # arredondamento para cima no ultimo milissegundo
        ms, s = 0, s + 1
        if s >= 60:
            s, m = 0, m + 1
        if m >= 60:
            m, h = 0, h + 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ===========================================================================
# Posicionamento
# ===========================================================================


@dataclass(frozen=True)
class Estilo:
    """O estilo resolvido, ja no espaco do canvas."""

    familia: str
    negrito: bool
    corpo_px: int
    cor: str
    cor_do_contorno: str
    contorno_px: int
    alinhamento: int  # 2 = base, 8 = topo (numeracao do ASS)
    margem_v: int
    margem_h: int
    #: A caixa que o bloco de texto ocupa no pior caso (todas as linhas
    #: cheias). Vai para o relatorio e para a checagem de validacao.
    caixa: tuple[int, int]

    def as_dict(self) -> dict[str, Any]:
        return {
            "familia": self.familia,
            "corpo_px": self.corpo_px,
            "contorno_px": self.contorno_px,
            "alinhamento": self.alinhamento,
            "margem_v": self.margem_v,
            "caixa_topo": self.caixa[0],
            "caixa_base": self.caixa[1],
        }


def posicionar(cfg: dict, layout: Layout, cover_until: int,
               corpo_maximo: int | None = None) -> Estilo:
    """Resolve corpo e margens para o bloco caber DENTRO da faixa de video.

    `cover_until` e a altura da faixa opaca do overlay — o que estiver acima
    dela sera coberto de qualquer forma (ver o cabecalho deste modulo). A conta
    aqui usa isso como piso do espaco util para que a legenda nao seja desenhada
    num lugar onde ela sumiria; nao e ela que garante que o cabecalho fica
    intacto.

    `corpo_maximo` substitui o corpo escolhido no template. Quem o usa e
    `ajustar_ao_texto`, para tentar de novo com um corpo menor quando o TEXTO
    nao coube na largura — esta funcao so sabe da altura.
    """
    sub = cfg["subtitles"]
    altura = cfg["canvas"]["height"]
    largura = cfg["canvas"]["width"]

    topo_util = max(0, min(altura - 1, max(layout.video_top, cover_until)))
    base_util = max(topo_util + 1, min(altura - 1, layout.video_bottom))
    faixa = base_util - topo_util

    margem = max(0, int(sub["margin_px"]))
    # Margem maior que a faixa nao e erro de configuracao — e uma faixa de
    # video pequena (video quase todo coberto). A margem cede primeiro, porque
    # ela e enfeite e o corpo minimo e legibilidade.
    margem = min(margem, max(0, faixa - CORPO_MINIMO_PX * 2))

    corpo = int(sub["size_px"] if corpo_maximo is None else corpo_maximo)
    corpo = max(CORPO_MINIMO_PX, min(corpo, int(sub["size_px"])))
    while corpo > CORPO_MINIMO_PX and margem + _altura_do_bloco(corpo, sub) > faixa:
        corpo -= 2
    corpo = max(CORPO_MINIMO_PX, corpo)

    alto = _altura_do_bloco(corpo, sub)
    contorno = max(0, int(sub["outline_px"]))

    if sub["position"] == "topo":
        alinhamento = 8
        # No ASS, `MarginV` com alinhamento de topo e a distancia do TOPO DO
        # QUADRO ate o topo do texto. O texto cresce para baixo, entao esta
        # posicao nunca alcanca o cabecalho por construcao.
        margem_v = topo_util + margem
        caixa = (margem_v, min(altura - 1, margem_v + alto))
    else:
        alinhamento = 2
        # Com alinhamento de base, `MarginV` e a distancia da BASE DO QUADRO
        # ate a base do texto. O texto cresce para cima; o teto de duas linhas
        # de `higienizar` e o que mantem `caixa[0]` dentro da faixa.
        margem_v = (altura - 1 - base_util) + margem
        base = altura - 1 - margem_v
        caixa = (max(0, base - alto), base)

    margem_h = max(
        0, int(round(largura * (1.0 - float(sub["max_width_pct"])) / 2.0))
    )

    return Estilo(
        familia=str(sub["font_family"]),
        negrito=bool(sub["font_bold"]),
        corpo_px=corpo,
        cor=str(sub["color"]),
        cor_do_contorno=str(sub["outline_color"]),
        contorno_px=contorno,
        alinhamento=alinhamento,
        margem_v=margem_v,
        margem_h=margem_h,
        caixa=caixa,
    )




def ajustar_ao_texto(
    falas: list[Fala], cfg: dict, layout: Layout, cover_until: int
) -> tuple[Estilo, list[Fala]]:
    """O estilo e as falas prontos para desenhar: o corpo cabe, as linhas cabem.

    POR QUE ESTA FUNCAO EXISTE, e nao basta o que `higienizar` ja faz.

    `higienizar` quebra em 42 CARACTERES. Isso e o certo para o arquivo
    guardado: o SRT precisa ser o mesmo em qualquer maquina e legivel no
    editor, e largura de caractere depende da fonte e do corpo, que o arquivo
    nao conhece. Mas o libass desenha numa largura em PIXELS — e "WWWWWWWW" e
    quase o dobro de "iiiiiiii" no mesmo corpo. Uma linha de 42 caracteres
    largos estoura a largura de desenho, o libass a requebra sozinho, e a fala
    vira quatro linhas onde `_altura_do_bloco` supos duas: o bloco sobe acima
    do que `posicionar` reservou, e `validate_legenda` — que le a conta, nao os
    pixels — continua dizendo que esta tudo dentro da faixa.

    Aqui a medida e feita com a FONTE DE VERDADE, a mesma que o libass vai
    carregar, no corpo que vai ser usado. O laco encolhe o corpo enquanto o
    texto nao couber em duas linhas; no piso, corta com reticencias. Depois
    disso, "no maximo duas linhas, cada uma dentro da largura" deixa de ser uma
    suposicao e passa a ser uma propriedade do arquivo entregue ao libass.

    O SRT guardado NAO muda: quem corta e a camada de desenho. O texto que o
    usuario editou continua inteiro no R2.
    """
    corpo_maximo = int(cfg["subtitles"]["size_px"])

    while True:
        estilo = posicionar(cfg, layout, cover_until, corpo_maximo=corpo_maximo)
        fonte = _fonte_de_desenho(cfg, estilo.corpo_px)
        largura = _largura_de_desenho(cfg, estilo)

        quebradas = [_quebrar_por_pixel(f, fonte, largura) for f in falas]
        if all(len(f.linhas) <= MAX_LINHAS_POR_CUE for f in quebradas):
            return estilo, quebradas

        if estilo.corpo_px <= CORPO_MINIMO_PX:
            # Nem no corpo minimo coube. Cortar e melhor do que desenhar um
            # bloco alto demais: a legenda continua dentro da faixa de video, e
            # o texto inteiro continua no SRT para quem quiser encurta-lo.
            return estilo, [_cortar(f, fonte, largura) for f in quebradas]

        corpo_maximo = estilo.corpo_px - 2


def _fonte_de_desenho(cfg: dict, corpo: int):
    """A MESMA fonte que o libass vai carregar, aberta pelo Pillow.

    Medir com outra fonte seria medir outra coisa. O caminho vem de
    `molde._resolver_fonte_de_legenda`, que ja o abriu uma vez para ler o nome
    da familia — se ele falhar aqui, a imagem mudou debaixo do job.
    """
    from PIL import ImageFont

    caminho = str(cfg["subtitles"].get("font") or "")
    try:
        return ImageFont.truetype(caminho, max(1, int(corpo)))
    except OSError as erro:
        raise PipelineError(
            f"nao consegui abrir a fonte da legenda para medir: {caminho}"
        ) from erro


#: Folga sobre a largura disponivel, para absorver a diferenca entre a medida
#: do Pillow e a do libass. Os dois moldam texto de formas diferentes — o
#: libass usa HarfBuzz, com kerning e ligaduras — e a diferenca e de fracoes de
#: por cento. 2% cobre isso com sobra e custa meio caractere por linha.
FOLGA_DE_LARGURA = 0.98


def _largura_de_desenho(cfg: dict, estilo: Estilo) -> float:
    """A largura util em pixels: o quadro menos as margens e o contorno.

    O contorno entra na conta porque ele cresce para FORA do glifo: com
    `Outline=3`, uma linha que medisse exatamente a largura disponivel sairia
    3 px para cada lado.
    """
    disponivel = (
        cfg["canvas"]["width"] - 2 * estilo.margem_h - 2 * estilo.contorno_px
    )
    return max(1.0, disponivel * FOLGA_DE_LARGURA)


def _quebrar_por_pixel(fala: Fala, fonte, largura: float) -> Fala:
    """Requebra as linhas da fala pela largura medida. Pode passar de duas."""
    palavras = " ".join(fala.linhas).split(" ")
    linhas: list[str] = []
    atual = ""

    for palavra in palavras:
        if not palavra:
            continue
        # Palavra sozinha maior que a largura: corta letra a letra, senao ela
        # sairia do quadro e nenhuma quebra por espaco resolveria.
        while fonte.getlength(palavra) > largura and len(palavra) > 1:
            corte = len(palavra) - 1
            while corte > 1 and fonte.getlength(palavra[:corte]) > largura:
                corte -= 1
            if atual:
                linhas.append(atual)
                atual = ""
            linhas.append(palavra[:corte])
            palavra = palavra[corte:]

        candidata = f"{atual} {palavra}" if atual else palavra
        if atual and fonte.getlength(candidata) > largura:
            linhas.append(atual)
            atual = palavra
        else:
            atual = candidata

    if atual:
        linhas.append(atual)

    return Fala(inicio=fala.inicio, fim=fala.fim, linhas=tuple(linhas) or fala.linhas)


def _cortar(fala: Fala, fonte, largura: float) -> Fala:
    """As duas primeiras linhas, com reticencias que TAMBEM cabem na largura.

    Acrescentar "\u2026" sem medir de novo desfaria a quebra que acabou de ser
    feita: a ultima linha ja estava no limite, e o glifo a mais a empurraria
    para fora \u2014 que e justamente o que `_quebrar_por_pixel` existe para evitar.
    """
    linhas = list(fala.linhas[:MAX_LINHAS_POR_CUE])
    if len(fala.linhas) > MAX_LINHAS_POR_CUE and linhas:
        base = linhas[-1].rstrip()
        while base and fonte.getlength(base + "\u2026") > largura:
            base = base[:-1].rstrip()
        linhas[-1] = base + "\u2026"
    return Fala(inicio=fala.inicio, fim=fala.fim, linhas=tuple(linhas))


def _altura_do_bloco(corpo: int, sub: dict) -> int:
    linhas = MAX_LINHAS_POR_CUE
    return int(round(corpo * ALTURA_DE_LINHA * linhas + 2 * max(0, int(sub["outline_px"]))))


# ===========================================================================
# ASS
# ===========================================================================


def para_ass(falas: Iterable[Fala], cfg: dict, estilo: Estilo) -> str:
    """O arquivo que o libass le. Cabecalho nosso, estilo nosso, texto deles.

    `PlayResX/PlayResY` iguais ao canvas e o detalhe que faz "corpo 48" querer
    dizer 48 pixels. Sem isso o FFmpeg converteria o SRT para um ASS com a
    resolucao de referencia dele (384x288) e o libass escalaria o resultado por
    ~6,7x — o corpo escolhido na tela sairia gigante no video, e a conta de
    `posicionar` estaria inteira errada sem nunca dar erro.
    """
    canvas = cfg["canvas"]

    cabecalho = "\n".join(
        [
            "[Script Info]",
            "; Gerado pelo PageMask. Nao editar: a fonte da verdade e o .srt.",
            "ScriptType: v4.00+",
            f"PlayResX: {int(canvas['width'])}",
            f"PlayResY: {int(canvas['height'])}",
            # 0 = quebra automatica equilibrada. As linhas ja vem quebradas de
            # `higienizar`, entao isto so age em casos de borda.
            "WrapStyle: 0",
            "ScaledBorderAndShadow: yes",
            # Sem isto o libass adivinha a matriz de cor e a cor da legenda sai
            # levemente diferente da que foi escolhida na tela.
            "YCbCr Matrix: None",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,"
            " OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,"
            " ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,"
            " Alignment, MarginL, MarginR, MarginV, Encoding",
            "Style: PageMask,"
            f"{_nome_de_fonte(estilo.familia)},{estilo.corpo_px},"
            f"{_cor_ass(estilo.cor)},{_cor_ass(estilo.cor)},"
            f"{_cor_ass(estilo.cor_do_contorno)},&H00000000,"
            f"{-1 if estilo.negrito else 0},0,0,0,"
            f"100,100,0,0,1,{estilo.contorno_px},0,"
            f"{estilo.alinhamento},{estilo.margem_h},{estilo.margem_h},"
            f"{estilo.margem_v},1",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV,"
            " Effect, Text",
        ]
    )

    eventos = [
        f"Dialogue: 0,{_tempo_ass(f.inicio)},{_tempo_ass(f.fim)},PageMask,,0,0,0,,"
        + _texto_ass(f)
        for f in falas
    ]

    return cabecalho + "\n" + "\n".join(eventos) + "\n"


def _texto_ass(fala: Fala) -> str:
    """As linhas juntas por `\\N`, o unico override que escrevemos.

    O texto ja saiu de `higienizar` sem `{`, `}` nem `\\`; a passada abaixo e
    a segunda tranca, para o caso de uma `Fala` ser montada por outro caminho
    um dia. Sem ela, este seria o ponto exato em que um `{\\an8}` do usuario
    viraria um comando de posicionamento.
    """
    seguras = [PROIBIDOS.sub("", linha) for linha in fala.linhas]
    return "\\N".join(seguras)


def _nome_de_fonte(familia: str) -> str:
    """Nome de familia sem virgula: ela e separador de campo no `Style:`."""
    limpo = PROIBIDOS.sub("", familia).replace(",", " ").strip()
    return limpo[:60] or "Sans"


def _cor_ass(hexadecimal: str) -> str:
    """`#RRGGBB` -> `&H00BBGGRR`. O ASS e ABGR, e o alfa e INVERTIDO (00 = opaco)."""
    valor = hexadecimal.lstrip("#")
    if len(valor) == 3:
        valor = "".join(c * 2 for c in valor)
    if len(valor) != 6 or not re.fullmatch(r"[0-9A-Fa-f]{6}", valor):
        raise LegendaInvalida("Uma cor da legenda não está no formato #RRGGBB.")
    r, g, b = valor[0:2], valor[2:4], valor[4:6]
    return f"&H00{b}{g}{r}".upper()


def _tempo_ass(segundos: float) -> str:
    total = max(0.0, segundos)
    h, resto = divmod(int(total), 3600)
    m, s = divmod(resto, 60)
    centesimos = int((total - int(total)) * 100)
    return f"{h:d}:{m:02d}:{s:02d}.{centesimos:02d}"


# ===========================================================================
# Transcricao
# ===========================================================================


class TranscricaoEsgotada(PipelineError):
    """O prazo da transcricao acabou antes de o modelo terminar."""


def transcrever(
    entrada: Path,
    *,
    modelo: str,
    modelo_dir: str | None,
    idioma: str,
    prazo_s: float,
    threads: int,
    duracao_s: float | None = None,
) -> list[Fala]:
    """O audio de `entrada` em falas. Levanta se o prazo acabar.

    O PRAZO E CONFERIDO ENTRE SEGMENTOS, e essa e a granularidade real desta
    funcao. `transcribe()` do faster-whisper devolve um gerador preguicoso: o
    trabalho acontece quando o laco pede o proximo segmento, e um segmento
    cobre alguns segundos de audio. Entao o estouro e detectado com atraso de
    um segmento — o suficiente para o teto do PLANO, e por isso o orcamento que
    `trabalho.py` passa reserva tempo para o render que vem depois.

    O MODELO E LOCAL E O DOWNLOAD E DESLIGADO. `modelo_dir` aponta para a copia
    que o Dockerfile baixou na build. Sem isso, a primeira transcricao de cada
    conteiner tentaria buscar o modelo na internet — de dentro do processo que
    abre arquivo de desconhecido, com a rede que o PLANO §4 quer restrita, e
    num sistema de arquivos `read_only` onde a escrita falharia no meio.
    """
    # Importado aqui, e nao no topo: `faster_whisper` carrega o ctranslate2
    # junto, que sao dezenas de MB de biblioteca nativa. Um worker cujo
    # template nao usa legenda nunca paga esse custo.
    try:
        from faster_whisper import WhisperModel
    except ImportError as erro:  # pragma: no cover — imagem mal montada
        raise PipelineError(
            "faster-whisper nao esta instalado nesta imagem do worker"
        ) from erro

    limite = time.monotonic() + max(5.0, prazo_s)

    modelo_alvo = modelo_dir or modelo
    try:
        motor = WhisperModel(
            modelo_alvo,
            device="cpu",
            compute_type="int8",
            cpu_threads=max(1, int(threads)),
            local_files_only=bool(modelo_dir),
        )
    except Exception as erro:  # noqa: BLE001 — ctranslate2 levanta varias classes
        raise PipelineError(
            f"nao consegui carregar o modelo de transcricao: {type(erro).__name__}"
        ) from erro

    try:
        segmentos, _info = motor.transcribe(
            str(entrada),
            language=idioma,
            task="transcribe",
            beam_size=1,
            # `vad_filter` corta os silencios antes de o modelo ver o audio. Num
            # Reels com musica e pausas isso e a diferenca entre transcrever o
            # que foi dito e inventar texto para o silencio — a alucinacao
            # classica do Whisper.
            vad_filter=True,
            condition_on_previous_text=False,
        )

        falas: list[Fala] = []
        for segmento in segmentos:
            if time.monotonic() > limite:
                raise TranscricaoEsgotada(
                    f"a transcricao passou de {int(prazo_s)}s e foi interrompida"
                )

            linhas = higienizar(segmento.text or "")
            if not linhas:
                continue

            inicio = float(segmento.start or 0.0)
            fim = float(segmento.end or inicio)
            if duracao_s and duracao_s > 0:
                inicio = min(inicio, duracao_s)
                fim = min(fim, duracao_s)
            if fim <= inicio:
                fim = inicio + 0.4

            falas.append(Fala(inicio=inicio, fim=fim, linhas=linhas))
            if len(falas) >= MAX_CUES:
                break
    finally:
        # O modelo segura centenas de MB. `/work` e tmpfs e o conteiner tem
        # `mem_limit`: deixar isso para o coletor de lixo decidir e o caminho
        # para o OOM killer derrubar o render que roda na thread ao lado.
        del motor

    if not falas:
        raise LegendaInvalida(
            "Não encontramos fala neste vídeo para legendar. "
            "Desligue a legenda no template ou use um vídeo com narração."
        )

    # `ler_srt` e a porta unica: passar por ela aqui garante que o arquivo
    # gravado e o arquivo editado sejam validados pelas MESMAS regras, em vez
    # de a saida do modelo entrar por uma porta mais frouxa.
    return ler_srt(escrever_srt(falas), duracao_s=duracao_s)
