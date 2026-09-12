# Pipeline de reposicionamento de header (substitui a edição manual no CapCut)

> **Desde a Fase 3, esta pasta é também o serviço de fila do PageMask.**
>
> O pipeline descrito abaixo não mudou e continua rodando sozinho
> (`python run.py input/`). O que foi acrescentado ao redor dele:
>
> | Arquivo | O que é |
> | --- | --- |
> | `service.py` | o laço que reclama job da fila, processa e conclui |
> | `src/servico/` | banco (RPC), R2, lista fechada de codecs, template, progresso |
> | `src/validate.py` | ganhou `validate_reels()` — 9 checagens de compatibilidade |
> | `Dockerfile`, `docker-compose.yml` | a imagem endurecida e os limites |
>
> Como rodar, quais variáveis e o que cada estado de falha significa está no
> [README da raiz](../README.md#rodar-o-worker).
>
> **Uma mudança no pipeline**, e só uma: `src/render.py` passou a escrever
> `-movflags +faststart+negative_cts_offsets -use_editlist 0` em vez de
> `-movflags +faststart`. O Reels não aceita edit list, e tirá-la sozinha
> desalinha o áudio em 66 ms — o motivo completo está no comentário da função.

Transforma um vídeo "post" (card de perfil no topo + vídeo no meio) em uma versão
com **outro perfil e outra frase**, sem abrir o CapCut. Render determinístico,
sem IA no caminho principal.

```
input/ → probe → detecção de layout → composição do overlay → render (FFmpeg) → validação → output/
```

## Por que FFmpeg (e não Remotion)

O layout é **estático**: nenhum elemento anima, nada depende do tempo. Remotion
renderiza frame a frame em Chromium — pagaria ~1920 renderizações de página por
vídeo para desenhar sempre a mesma imagem. Aqui o overlay é um único PNG RGBA
gerado uma vez em Pillow e aplicado num passe só de FFmpeg.

|                     | FFmpeg + Pillow (escolhido)          | Remotion                    |
| ------------------- | ------------------------------------ | --------------------------- |
| 34s de vídeo        | **~20s**                             | ~3-8 min                    |
| Dependências        | ffmpeg + Pillow/numpy (já instalados) | Node + Chromium + bundle    |
| Tipografia          | total (Pillow desenha o PNG)         | total                       |
| Animação por frame  | não                                  | sim                         |

**Quando trocar para Remotion:** só se entrarem legendas animadas palavra a
palavra, contadores, transições ou elementos que mudam ao longo do tempo. Nesse
caso o ponto de troca é `src/compose.py` (que passa a gerar uma sequência PNG ou
um MOV com alpha) — o resto do pipeline não muda.

## Requisitos

- `ffmpeg` e `ffprobe` no PATH (build testado: 8.1.2 gyan.dev)
- Python 3.10+ com `Pillow` e `numpy`

## Uso

```bash
python run.py
```

```bash
python run.py input/video.mp4 --text "Sua frase aqui"
```

```bash
python run.py input/video.mp4 --dry-run
```

```bash
python run.py input/ --report reports/lote.json
```

Flags: `--config`, `--output`, `--text`, `--header`, `--preview`, `--dry-run`,
`--keep-overlay`, `--report`.

- `--dry-run` gera só o preview PNG em `reports/` (~2s em vez de ~20s). É o modo
  para ajustar frase, fonte e posição.
- Código de saída `1` se alguma validação falhar — serve para CI / automação.

## Configuração

Tudo em `config/template.pretamente.json`. Para um novo perfil, **copie o JSON** e
troque `profile.header_image` + `caption.text`. Nenhum código muda.

| Campo | O que faz |
| --- | --- |
| `canvas` | 1080×1920, 30fps, cor de fundo |
| `framing.mode` | `fit` (barras) · `cover` (crop central) · `blur` (fundo desfocado) |
| `profile.header_image` | PNG do header novo (RGB ou RGBA) |
| `profile.align` | `auto` alinha o header novo ao topo do header antigo detectado; `fixed` usa `offset_y` puro |
| `profile.offset_y` / `offset_space_height` | ajuste fino; `offset_space_height` é a altura em que o offset foi medido (o CapCut mostrava Y numa base de 1280) |
| `profile.trim_to_content` | recorta o PNG na bbox do conteúdo antes de colar |
| `caption.text` | a frase (aceita `\n` para quebra manual) |
| `caption.size_px` + `autofit` + `min_size_px` | corpo desejado; encolhe sozinho até caber |
| `caption.position` | `between` centraliza entre header e vídeo; `fixed` usa `fixed_y` |
| `cover.color` | cor da faixa que cobre o header antigo; `"auto"` usa o fundo detectado |
| `cover.extra_px` | linhas extras cobertas (positivo invade o vídeo) |
| `detect.*` | amostragem, limiar de movimento e tolerância de fundo |
| `output.*` | codec, CRF, preset, áudio, `faststart`, sufixo do arquivo |
| `validate.*` | tolerâncias das checagens |

## Como o layout é detectado (sem IA)

`src/analyze.py`, dois passos determinísticos sobre 24 frames amostrados a 1fps:

1. **Variância temporal por linha** — só a faixa de vídeo muda entre frames. O
   maior bloco contíguo com desvio-padrão acima do limiar é a faixa de vídeo.
2. **Cor de fundo estimada** — mediana das linhas *estáticas* (fora da faixa de
   vídeo). Não assume branco, então funciona igual em posts de fundo escuro. A
   faixa de vídeo é então expandida para cima e para baixo enquanto as linhas não
   forem fundo liso (pega barras pretas e cenário parado nas pontas).

O que sobra acima da faixa de vídeo e não é fundo = **header antigo**. A faixa de
cobertura vai de `y=0` até o topo do vídeo, então cobre o header antigo inteiro
por construção.

Se o vídeo não tem card estático no topo, cai no fallback
`detect.fallback_header_ratio` (faixa fixa) e o relatório marca `source: fallback`.

## Validações (`src/validate.py`)

| Checagem | Critério |
| --- | --- |
| `resolucao` | 1080×1920, 30fps, `yuv420p` |
| `duracao` | saída vs entrada dentro de `duration_tolerance_s` |
| `audio` | trilha presente, duração compatível e `mean_volume` acima do piso de silêncio |
| `cobertura_header` | a faixa opaca da saída é **idêntica ao overlay** em N frames (MAE + p99) — prova que nada do vídeo original vaza ali |
| `header_antigo_dentro_da_cobertura` | `[old_header_top, old_header_bottom]` está contido em `[0, cover_until)`, com a folga em px |
| `vazamento_do_header_antigo` | pixels de conteúdo antigo que caíram **fora** da faixa opaca (limite 0,5%) |
| `faixa_de_video_preservada` | a faixa de vídeo continua variando no tempo (não foi coberta por engano) |

As duas primeiras checagens de cobertura, juntas, são uma prova completa: "a saída
é igual ao overlay na faixa opaca" + "o header antigo está inteiro dentro da faixa
opaca" ⇒ nenhum pixel do header antigo sobreviveu.

## Medidas extraídas dos originais

Vídeo de referência `sikeiradebochado_...mp4` — 720×1280, 30fps, 33,967s, H.264
`yuv420p`, AAC 44,1kHz estéreo. Convertido para o canvas 1080×1920 (fator 1,5):

| Elemento | 720×1280 | 1080×1920 |
| --- | --- | --- |
| Header antigo (card) | y 154–365 | y **231–545** |
| Frase antiga, linha 1 | y 292–320 | y 438–480 |
| Frase antiga, linha 2 | y 325–354 | y 487–531 |
| Faixa de vídeo | y 400–880 | y **599–1320** |
| Área lisa inferior | y 880–1280 | y 1320–1920 |

`1.png` — 1080×1920, **RGB sem canal alfa** (fundo branco puro). Conteúdo do
header em y 215–370, x 77–902. Como não tem alfa, ele só funciona como camada
opaca; o pipeline recorta a bbox do conteúdo e cola sobre a faixa de cobertura, o
que dá o mesmo resultado visual sem depender de transparência.

## Hipóteses assumidas (a gravação não mostrou)

1. **Exportação.** A tela de export não aparece na gravação. Adotado o padrão
   seguro para Reels/TikTok/Shorts: MP4 1080×1920, 30fps, H.264 High, CRF 20,
   `yuv420p`, AAC 192k 48kHz estéreo, `+faststart`. Tudo ajustável em `output.*`.
2. **Resolução do projeto.** O vídeo fonte é 720×1280 e o `1.png` é 1080×1920.
   Adotado 1080×1920 (upscale de 1,5× do fonte) porque é o alvo das plataformas.
   Para render nativo sem upscale, troque `canvas` para 720×1280.
3. **Offset Y = 33 do CapCut.** A gravação tem 720×388 de resolução, o que dá
   ~5,8px de canvas por pixel de preview — não dá para cravar o valor. A medição
   ficou entre +11 e +51px em 1920. Adotado `align: "auto"` (alinha o header novo
   ao topo do header antigo detectado, offset 0), que é determinístico e
   generaliza para qualquer fonte. Para o valor literal do CapCut, use
   `offset_y: 33` com `offset_space_height: 1280`.
4. **Fonte.** O CapCut mostrava "Sistema" tamanho 8 — isso não é px. Pela altura
   medida no preview (~41px de caixa alta em 1920), o corpo equivalente é ~58px,
   que é o default. A família adotada é **Arial Bold**, que é a do post original;
   `segoeuib.ttf` (a "Sistema" real do Windows) está no fallback.
5. **Frase.** Mantida exatamente como na gravação, incluindo "Voce" sem acento. A
   quebra em duas linhas é automática e pode diferir em uma palavra da do CapCut;
   use `\n` no `caption.text` para forçar a quebra idêntica.
6. **Sem cortes e sem trilha extra.** Confirmado na gravação: o áudio original é
   preservado e o timing bate (delta de duração 0,000s no teste).

## Onde a IA entra (módulos opcionais, fora do caminho principal)

O render básico é 100% determinístico e deve continuar assim. IA só onde a tarefa
é genuinamente variável:

| Módulo | Onde encaixa | Ferramenta |
| --- | --- | --- |
| **Legendas** (feito — Fase 9) | passo antes do render, em `servico/legenda.py` | `faster-whisper` (pip), modelo `small`, idioma `pt`, embutido na imagem |
| **Geração de frases** | preenche `caption.text` antes de `build_overlay` | Claude API, usando a transcrição como contexto |
| **Seleção de trechos** | novo passo antes de `detect_layout`, produz um `-ss/-t` | transcrição + LLM escolhendo o corte |
| **Reenquadramento inteligente** | substitui `framing.mode: cover` | detecção de rosto (OpenCV/MediaPipe) gerando crop com keyframes |
| **Verificação visual** | complementa a validação | comparar o frame renderizado com uma referência aprovada |

Regra: cada módulo grava sua saída **no config** (frase, corte, crop) e o render
continua sendo o mesmo passe determinístico. Assim tudo permanece auditável e
reproduzível.

### A legenda, e como ela cumpre essa regra

A transcrição é a única etapa não determinística do pipeline. Ela grava a saída
num **arquivo**, e não no config, por uma razão de tamanho: uma legenda de 15
minutos são centenas de falas com tempo, e isso não cabe num `jsonb` que o
usuário edita num formulário. O efeito é o mesmo da regra:

```
áudio → faster-whisper → legenda.srt (higienizado) → R2, e a chave em jobs.r2_srt_key
                                                  ↓
                                      legenda.ass (gerado no job) → filtro subtitles
```

A partir do SRT gravado, **tudo é determinístico de novo**: a segunda tentativa,
o reprocessamento e o re-render depois de uma edição na tela leem o mesmo
arquivo e produzem o mesmo vídeo. Quem apaga `r2_srt_key` manda transcrever de
novo; ninguém mais.

Três detalhes que não são opcionais, cada um com o porquê no código:

| O quê | Onde | Por quê |
| --- | --- | --- |
| O SRT **nunca** chega ao FFmpeg como SRT | `legenda.para_ass` | o decodificador de SRT converte HTML em tags de override do ASS; o texto vem de um modelo e de um editor do usuário |
| A legenda é desenhada **antes** do overlay | `render.build_command` | a faixa de cobertura é sempre a última camada, então "não invade o cabeçalho" é propriedade da composição, não de uma conta |
| O áudio é extraído pelo **nosso** FFmpeg | `trabalho._transcrever` | o faster-whisper decodificaria o MP4 com as libs do PyAV — outra build, mais velha que a 8.1.2 que o Dockerfile fixa e confere por soma |

O modelo (`small`) é baixado **na build** e vive em `/opt/modelos/whisper`, com
`HF_HUB_OFFLINE=1` em execução: o contêiner é `read_only` e a rede dele é
restrita, então download em tempo de execução não é lentidão, é falha.

## Estrutura

```
src/util.py      execução de ffmpeg/ffprobe, cores
src/probe.py     inspeção (duração, resolução, fps, áudio, rotação)
src/framing.py   normalização para o canvas — fonte única usada por analyze e render
src/analyze.py   detecção de layout por variância temporal + cor de fundo
src/compose.py   overlay RGBA (cobertura + header + frase com autofit)
src/render.py    comando FFmpeg e preview PNG
src/validate.py  as 7 checagens
src/cli.py       orquestração e relatório
servico/legenda.py  transcrição, higienização do SRT e geração do ASS
```
