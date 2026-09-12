# PageMask — imagem do worker.
#
# FFMPEG >= 8.1.2 E REQUISITO, E O BUILD FALHA SE NAO FOR (PLANO §4)
# ==================================================================
#
# O `ffmpeg` do Debian bookworm e 5.1. Nao serve, e a diferenca nao e de
# recurso: e o conjunto de correcoes de seguranca nos decoders — que sao
# exatamente o codigo que este conteiner aponta para arquivo de desconhecido.
# Por isso a imagem traz um build estatico do ramo 8.1, e a camada seguinte
# CONFERE a versao. Build com FFmpeg menor nao gera imagem: ele para aqui.
#
# O BINARIO E FIXADO E CONFERIDO, e o build para se a soma nao bater.
#
# Esta e a peca que abre arquivo de desconhecido — logo, a que MENOS pode vir
# de uma origem mutavel. A primeira versao deste arquivo apontava para a tag
# `latest` do BtbN com a soma opcional: um `docker compose up --build`
# instalava um binario nao verificado, e o aviso saia no meio do log, onde
# ninguem le. Comprometida a conta que publica essas releases, um `ffmpeg`
# trojanizado entraria na imagem na build seguinte — e `read_only`, `cap_drop`
# e nao-root nao ajudariam em nada, porque o codigo malicioso seria o processo
# legitimo, nao uma fuga dele. Ele ja tem, no ambiente, a `service_role` e as
# credenciais do R2.
#
# Agora a URL e de uma release DATADA (imutavel) e a soma e obrigatoria.
# Atualizar o FFmpeg passa a ser um ato deliberado: trocar as duas linhas
# juntas, depois de conferir a nova soma.
#
#   FFMPEG_URL     release datada do BtbN, arquivo do ramo 8.1
#   FFMPEG_SHA256  `sha256sum` do .tar.xz — conferido ANTES de extrair

FROM python:3.12-slim-bookworm AS ffmpeg

ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-11-13-20/ffmpeg-n8.1.2-52-g5a03dfa0f6-linux64-gpl-8.1.tar.xz
ARG FFMPEG_SHA256=6fc8d0a3ac9e3956bef486655fbc0a049fb3dacb74ea2e44cc2fc62eeb80a182

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    if [ -z "$FFMPEG_SHA256" ]; then \
      echo "ERRO: FFMPEG_SHA256 vazio — este binario nao entra sem conferencia." >&2; \
      exit 1; \
    fi; \
    curl -fsSL "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz; \
    echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1; \
    cp /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/; \
    rm -rf /tmp/ffmpeg.tar.xz /opt/ffmpeg

# A TRAVA DE VERSAO. Esta camada e o "o build FALHA se a versao for menor" do
# PLANO §4. O script mora em `scripts/` para poder ser rodado contra um FFmpeg
# antigo e PROVAR que reprova — trava nunca vista falhando e so otimismo.
COPY scripts/conferir-ffmpeg.sh /usr/local/bin/conferir-ffmpeg.sh
RUN chmod +x /usr/local/bin/conferir-ffmpeg.sh && conferir-ffmpeg.sh 8.1.2


FROM python:3.12-slim-bookworm

# `fonts-liberation` tem a Liberation Sans Bold, metricamente compativel com a
# Arial — que e a fonte do post original (worker/README.md §4 das hipoteses).
# Sem fonte na imagem, o Pillow nao desenha a frase e o job falha inteiro.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe

# Usuario sem privilegio, criado antes do codigo para a camada do pip nao
# precisar ser refeita quando o codigo muda.
RUN groupadd --system --gid 10001 pagemask \
 && useradd --system --uid 10001 --gid pagemask --home /app --shell /usr/sbin/nologin pagemask

WORKDIR /app

COPY requirements.txt ./
# `pip freeze` guarda o que de fato foi instalado. Com faixas no
# `requirements.txt`, e este arquivo — dentro da imagem — que responde "qual
# versao esta rodando em producao?" quando sair um aviso de seguranca.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip freeze > /app/requirements.lock.txt

# O MODELO DE TRANSCRICAO ENTRA NA IMAGEM, E NAO EM TEMPO DE EXECUCAO.
#
# O faster-whisper baixaria o modelo do Hugging Face na primeira transcricao de
# cada conteiner. Tres motivos para isso nao acontecer aqui, e cada um bastaria:
#
#   · o compose monta o sistema de arquivos como `read_only` — a gravacao do
#     cache falharia no meio do primeiro job com legenda, e a mensagem nao
#     falaria de permissao nenhuma;
#   · o PLANO §4 quer a saida de rede restrita a R2, Supabase e
#     graph.instagram.com. Um download do Hugging Face de dentro do conteiner
#     que abre arquivo de desconhecido e exatamente o que aquela regra existe
#     para impedir;
#   · o primeiro job com legenda de cada deploy pagaria o download (~480 MB)
#     dentro do prazo dele, e falharia por tempo antes de transcrever nada.
#
# Baixado aqui, o modelo e parte da imagem: imutavel, conferivel e igual em
# todos os conteineres. `HF_HUB_OFFLINE=1` abaixo fecha a porta de vez.
# A REVISAO E FIXA, pela mesma razao do `FFMPEG_SHA256` acima: o modelo e um
# binario de terceiro que entra na imagem e processa arquivo de desconhecido.
# `download_model("small")` sem revisao busca o `main` do repositorio no
# Hugging Face — ou seja, o que estiver la no dia do build. Comprometida a
# conta que publica aquele repositorio, um `model.bin` trocado entraria na
# imagem seguinte sem ninguem notar. Com o commit fixado, atualizar o modelo
# passa a ser um ato deliberado: trocar as duas linhas juntas.
#
#   WHISPER_MODELO     o repositorio (`small` -> Systran/faster-whisper-small)
#   WHISPER_REVISAO    o commit daquele repositorio, imutavel
ARG WHISPER_MODELO=small
ARG WHISPER_REVISAO=536b0662742c02347bc0e980a01041f333bce120
ENV WHISPER_MODELO=${WHISPER_MODELO} \
    WHISPER_MODELO_DIR=/opt/modelos/whisper
RUN set -eu; \
    WHISPER_REVISAO="${WHISPER_REVISAO}" python -c "\
import os; from faster_whisper import download_model; \
download_model(os.environ['WHISPER_MODELO'], \
output_dir=os.environ['WHISPER_MODELO_DIR'], \
revision=os.environ['WHISPER_REVISAO'])"; \
    chmod -R a+rX /opt/modelos

COPY --chown=pagemask:pagemask src/ ./src/
COPY --chown=pagemask:pagemask assets/ ./assets/
COPY --chown=pagemask:pagemask service.py run.py publish.py ./

# `/work` e o unico lugar onde o worker escreve, e no compose ele e um tmpfs.
# Criado aqui so para existir quando alguem rodar a imagem sem o compose.
RUN mkdir -p /work && chown pagemask:pagemask /work

# `HF_HUB_OFFLINE` e `HF_HOME`: o modelo ja esta na imagem (camada acima), e
# estas duas fecham a porta do download em tempo de execucao — sem elas, um
# `WHISPER_MODELO` diferente do que foi baixado na build faria o conteiner
# tentar a internet em silencio, de dentro do processo que abre arquivo de
# desconhecido.
#
# `OMP_NUM_THREADS`: o ctranslate2 escolhe sozinho quantas threads usar e conta
# os nucleos da MAQUINA, nao o `cpus:` do conteiner. Numa VPS de 8 nucleos com
# `cpus: 1.5` ele abriria 8 threads para disputar 1,5 — mais troca de contexto
# do que trabalho, e roubada do render que roda ao lado. O valor de verdade vem
# de `LEGENDA_THREADS`; este e o piso para quem perguntar antes.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_WORKDIR=/work \
    MPLCONFIGDIR=/work/.cache \
    HF_HUB_OFFLINE=1 \
    HF_HOME=/work/.cache/huggingface \
    OMP_NUM_THREADS=2

USER pagemask

# Sem shell: `exec` direto no Python faz o processo ser o PID 1 e RECEBER o
# SIGTERM do `docker stop`. Com shell no meio, o sinal morre no shell e o
# desligamento gracioso nunca acontece — os jobs em voo ficariam presos em
# `processing` ate o zelador, toda vez que o conteiner reiniciasse.
ENTRYPOINT ["python", "service.py"]
