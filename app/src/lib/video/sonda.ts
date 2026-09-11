/**
 * Sondagem de contêiner e codec, lendo só o cabeçalho do arquivo.
 *
 * POR QUE NÃO É O `ffprobe`
 *
 * `docs/PLANO.md` §4 exige a lista fechada "antes de qualquer render", e a
 * Fase 3 é quem roda o `ffprobe` de verdade, dentro do contêiner do worker,
 * com FFmpeg ≥ 8.1.2. Esta sondagem é a checagem da PORTA DE ENTRADA, e ela
 * precisa acontecer onde o upload acontece: numa função da Vercel, que não tem
 * binário de FFmpeg, não tem disco para um arquivo de 500 MB e tem alguns
 * segundos de vida. Chamar `ffprobe` ali não é uma opção técnica — é uma que
 * funcionaria na máquina de quem escreveu e falharia em produção.
 *
 * Então o que roda aqui é um leitor de cabeçalho escrito à mão, que baixa
 * algumas dezenas de KB por `Range` e responde a única pergunta que importa
 * nesta fase: **este arquivo declara um codec que a gente aceita?** Um vídeo de
 * 500 MB é decidido lendo ~200 KB dele.
 *
 * As duas checagens não são redundância desperdiçada, são camadas com papéis
 * diferentes:
 *
 *   · aqui  — recusa cedo, antes de gastar quota e antes de o arquivo entrar na
 *             fila; a resposta chega ao usuário em segundos, com o motivo.
 *   · lá    — o `ffprobe` decide de fato, dentro do contêiner isolado, e é ele
 *             que autoriza o render. Um arquivo que mentiu no cabeçalho passa
 *             por aqui e morre lá, sem nunca ter tocado um decoder no servidor
 *             web (aqui nada é decodificado: só se leem campos de metadado).
 *
 * O `probe` gravado por esta função leva `fonte: "cabecalho"` justamente para
 * que a Fase 3 possa sobrescrevê-lo pelo `ffprobe` sem ambiguidade sobre quem
 * escreveu o quê.
 *
 * Referências dos formatos: ISO/IEC 14496-12 (caixas do MP4/MOV) e a
 * especificação do Matroska (elementos EBML).
 */

import type { Container } from "@/lib/video/codecs";
import { LeitorEmBlocos } from "@/lib/video/leitor";

export type TipoDeTrilha = "video" | "audio" | "outro";

export type Trilha = {
  tipo: TipoDeTrilha;
  /** Nome na nomenclatura do FFmpeg, ou `null` quando não reconhecido. */
  codec: string | null;
  /** O que o arquivo declarou: fourcc do MP4 ou `CodecID` do Matroska. */
  declarado: string;
};

export type Sonda = {
  /** Quem produziu este probe. A Fase 3 grava `"ffprobe"` por cima. */
  fonte: "cabecalho";
  container: Container;
  duracao_s: number | null;
  largura: number | null;
  altura: number | null;
  trilhas: Trilha[];
  bytes_lidos: number;
  analisado_em: string;
};

/**
 * O arquivo não pôde ser lido como vídeo — cabeçalho ausente, truncado ou de
 * um formato que não é nenhum dos quatro.
 *
 * A `mensagem` é escrita para o usuário final, em pt-BR: ela vai parar na
 * coluna `jobs.error` e na tela, sem tradução no meio do caminho.
 */
export class SondaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "SondaError";
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Entrada
// ───────────────────────────────────────────────────────────────────────────

export async function sondar(leitor: LeitorEmBlocos): Promise<Sonda> {
  try {
    return await sondarInterno(leitor);
  } catch (erro) {
    // `RangeError` aqui significa que um campo de tamanho do arquivo apontou
    // para fora do buffer — ou seja, o arquivo esta malformado. Cada leitura
    // tem a sua guarda, mas um parser de formato binario tem dezenas delas, e
    // uma que falte vira 500 numa rota de API: o usuario ve "erro no servidor"
    // por causa de um arquivo ruim, e o objeto fica no bucket. Aqui isso volta
    // a ser o que e — recusa, com motivo.
    if (erro instanceof RangeError) {
      throw new SondaError(
        "Não conseguimos ler a estrutura deste arquivo: ela está malformada. " +
          "Reexporte o vídeo e envie de novo.",
      );
    }
    throw erro;
  }
}

async function sondarInterno(leitor: LeitorEmBlocos): Promise<Sonda> {
  if (leitor.tamanho < 16) {
    throw new SondaError("O arquivo está vazio ou é pequeno demais para ser um vídeo.");
  }

  const inicio = await leitor.ler(0, 16);

  // Matroska e WebM começam com o mesmo número mágico; o que separa os dois é
  // o `DocType`, lá dentro.
  if (inicio.length >= 4 && inicio.readUInt32BE(0) === 0x1a45dfa3) {
    return sondarMatroska(leitor);
  }

  if (inicio.length >= 8) {
    const tipo = inicio.subarray(4, 8).toString("latin1");
    if (tipo === "ftyp" || CAIXAS_DE_TOPO_QT.has(tipo)) {
      return sondarIsoBmff(leitor);
    }
  }

  throw new SondaError(
    "Não reconhecemos este arquivo como vídeo. Envie MP4, MOV, WebM ou MKV.",
  );
}

/** Caixas que podem abrir um QuickTime antigo, sem `ftyp`. */
const CAIXAS_DE_TOPO_QT = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

// ───────────────────────────────────────────────────────────────────────────
// MP4 / MOV — ISO base media file format
// ───────────────────────────────────────────────────────────────────────────

/** Teto para a `moov`. Acima disso não é metadado, é outra coisa. */
const MOOV_MAXIMA = 24 * 1024 * 1024;

/**
 * Quantas caixas do topo ainda conferir depois de achar a `moov` — o bastante
 * para fechar a cadeia num arquivo preparado para web, e pouco o bastante para
 * não percorrer um fragmentado inteiro. Ver o comentário no passeio.
 */
const DEPOIS_DA_MOOV = 8;

type Caixa = { tipo: string; inicio: number; fim: number; dados: number };

/** Cabeçalho de uma caixa lida do arquivo remoto (offsets absolutos). */
async function caixaRemota(
  leitor: LeitorEmBlocos,
  posicao: number,
): Promise<Caixa | null> {
  const cabecalho = await leitor.ler(posicao, 16);
  if (cabecalho.length < 8) return null;

  const tipo = cabecalho.subarray(4, 8).toString("latin1");
  let tamanho = cabecalho.readUInt32BE(0);
  let dados = posicao + 8;

  if (tamanho === 1) {
    if (cabecalho.length < 16) return null;
    // `largesize` é 64 bits. `readBigUInt64BE` e não duas leituras de 32:
    // arquivo acima de 4 GiB existe, e ler só a metade baixa daria um tamanho
    // pequeno e plausível — o parser sairia do trilho sem erro nenhum.
    const grande = cabecalho.readBigUInt64BE(8);
    if (grande > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    tamanho = Number(grande);
    dados = posicao + 16;
  } else if (tamanho === 0) {
    // "vai até o fim do arquivo"
    tamanho = leitor.tamanho - posicao;
  }

  if (tamanho < dados - posicao) return null; // tamanho menor que o cabeçalho
  return { tipo, inicio: posicao, fim: posicao + tamanho, dados };
}

async function sondarIsoBmff(leitor: LeitorEmBlocos): Promise<Sonda> {
  let container: Container = "mp4";
  let moov: Caixa | null = null;

  let posicao = 0;
  let truncado = false;

  // O passeio continua DEPOIS de achar a `moov`, e isso e de proposito. Num
  // arquivo cortado no meio do upload, a ultima caixa promete um tamanho que
  // passa do fim do arquivo. Como a `moov` costuma vir ANTES da `mdat` em
  // arquivo preparado para web, parar nela aceitaria alegremente um video que
  // e so cabecalho — os metadados dizem "h264, 2 segundos" e o conteudo nao
  // esta la. Conferir custa uma leitura de 8 bytes a mais.
  //
  // Mas continua POUCO: `DEPOIS_DA_MOOV` caixas, nao ate o fim. Num MP4
  // preparado para web sobra uma `mdat` so, entao isso basta para fechar a
  // cadeia no ultimo byte. Num MP4 FRAGMENTADO — o que sai de gravador de tela
  // e de exportacao para streaming — ha um par `moof`+`mdat` por fragmento, e
  // um video de meia hora passa de mil caixas no topo. Ir ate o fim ali
  // significaria uma leitura por fragmento, espalhadas pelo arquivo inteiro:
  // num arquivo grande isso estoura o teto de bytes do leitor, e o arquivo bom
  // seria recusado por "metadados grandes demais". Medido num fragmentado de 30
  // segundos: 903 caixas no topo.
  //
  // O teto geral de voltas existe para o arquivo que NAO e integro: sem ele, um
  // campo de tamanho pequeno e repetido vira laco longo, e laco longo numa rota
  // de API e negacao de servico barata.
  let depoisDaMoov = 0;

  for (let n = 0; n < 512 && posicao < leitor.tamanho; n += 1) {
    if (moov && depoisDaMoov >= DEPOIS_DA_MOOV) break;
    if (moov) depoisDaMoov += 1;

    const caixa = await caixaRemota(leitor, posicao);
    if (!caixa) break;

    if (caixa.tipo === "ftyp" && n === 0) {
      const marca = await leitor.ler(caixa.dados, 4);
      if (marca.toString("latin1") === "qt  ") container = "mov";
    }

    if (caixa.tipo === "moov" && !moov) moov = caixa;

    if (caixa.fim <= posicao) break; // não avançou: arquivo corrompido
    if (caixa.fim > leitor.tamanho) {
      truncado = true; // promete mais conteúdo do que foi enviado
      break;
    }
    posicao = caixa.fim;
    if (posicao === leitor.tamanho) break; // cadeia fechou no último byte
  }

  // Reprova só com PROVA de truncamento. Não chegar ao fim do arquivo dentro
  // do teto de caixas não é evidência de nada: MP4 fragmentado (o que sai de
  // gravador de tela e de exportação para streaming) tem um par `moof`+`mdat`
  // por fragmento, e um vídeo longo passa fácil de 512 caixas no topo. Tratar
  // "não terminei de conferir" como "está quebrado" recusaria arquivo bom e
  // ainda apagaria o objeto do usuário. Quem confere o conteúdo de fato é o
  // `ffprobe` da Fase 3.
  if (truncado) {
    throw new SondaError(
      "Este arquivo parece incompleto: a estrutura interna dele promete mais " +
        "conteúdo do que foi enviado. Se o envio foi interrompido, mande o " +
        "arquivo de novo.",
    );
  }

  if (!moov) {
    throw new SondaError(
      "Não encontramos os metadados do vídeo (caixa `moov`). O arquivo pode " +
        "estar incompleto — se o upload foi interrompido, envie de novo.",
    );
  }

  const tamanhoMoov = moov.fim - moov.dados;
  if (tamanhoMoov > MOOV_MAXIMA) {
    throw new SondaError("Os metadados deste arquivo são grandes demais para analisar.");
  }

  const dados = await leitor.ler(moov.dados, tamanhoMoov);
  if (dados.length < tamanhoMoov) {
    throw new SondaError(
      "O arquivo terminou antes do esperado. Se o upload foi interrompido, envie de novo.",
    );
  }

  let duracao: number | null = null;
  let largura: number | null = null;
  let altura: number | null = null;
  const trilhas: Trilha[] = [];

  for (const filho of caixasEm(dados)) {
    if (filho.tipo === "mvhd") {
      duracao = duracaoDeCabecalho(filho.dados);
    } else if (filho.tipo === "trak") {
      const trilha = trilhaDeTrak(filho.dados);
      if (!trilha) continue;
      trilhas.push(trilha.trilha);
      if (trilha.trilha.tipo === "video" && largura === null && trilha.largura) {
        largura = trilha.largura;
        altura = trilha.altura;
      }
    }
  }

  return {
    fonte: "cabecalho",
    container,
    duracao_s: duracao,
    largura,
    altura,
    trilhas,
    bytes_lidos: leitor.bytesLidos,
    analisado_em: new Date().toISOString(),
  };
}

/** Percorre as caixas filhas dentro de um buffer já em memória. */
function* caixasEm(buf: Buffer): Generator<{ tipo: string; dados: Buffer }> {
  let posicao = 0;
  while (posicao + 8 <= buf.length) {
    let tamanho = buf.readUInt32BE(posicao);
    const tipo = buf.subarray(posicao + 4, posicao + 8).toString("latin1");
    let inicioDados = posicao + 8;

    if (tamanho === 1) {
      if (posicao + 16 > buf.length) return;
      const grande = buf.readBigUInt64BE(posicao + 8);
      if (grande > BigInt(Number.MAX_SAFE_INTEGER)) return;
      tamanho = Number(grande);
      inicioDados = posicao + 16;
    } else if (tamanho === 0) {
      tamanho = buf.length - posicao;
    }

    const fim = posicao + tamanho;
    if (tamanho < inicioDados - posicao || fim > buf.length) return;

    yield { tipo, dados: buf.subarray(inicioDados, fim) };

    if (fim <= posicao) return;
    posicao = fim;
  }
}

/** `mvhd` / `mdhd`: timescale e duração, nas versões 0 e 1. */
function duracaoDeCabecalho(dados: Buffer): number | null {
  if (dados.length < 20) return null;
  const versao = dados.readUInt8(0);

  let escala: number;
  let bruta: number;

  if (versao === 1) {
    if (dados.length < 32) return null;
    escala = dados.readUInt32BE(20);
    const d = dados.readBigUInt64BE(24);
    // Cobre de uma vez o sentinela de "duracao desconhecida" (todos os bits em
    // 1) e qualquer valor grande demais para virar `number` sem perder
    // precisao — que daria uma duracao plausivel e errada.
    if (d > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    bruta = Number(d);
  } else {
    escala = dados.readUInt32BE(12);
    bruta = dados.readUInt32BE(16);
    if (bruta === 0xffffffff) return null; // duração desconhecida
  }

  if (!escala || !bruta) return null;
  return Number((bruta / escala).toFixed(3));
}

type TrilhaDeTrak = { trilha: Trilha; largura: number | null; altura: number | null };

function trilhaDeTrak(trak: Buffer): TrilhaDeTrak | null {
  let largura: number | null = null;
  let altura: number | null = null;
  let manipulador = "";
  let amostra: { tipo: string; dados: Buffer } | null = null;

  for (const filho of caixasEm(trak)) {
    if (filho.tipo === "tkhd") {
      const dimensao = dimensaoDeTkhd(filho.dados);
      if (dimensao) {
        largura = dimensao.largura;
        altura = dimensao.altura;
      }
    } else if (filho.tipo === "mdia") {
      for (const neto of caixasEm(filho.dados)) {
        if (neto.tipo === "hdlr" && neto.dados.length >= 12) {
          manipulador = neto.dados.subarray(8, 12).toString("latin1");
        } else if (neto.tipo === "minf") {
          for (const bisneto of caixasEm(neto.dados)) {
            if (bisneto.tipo !== "stbl") continue;
            for (const stbl of caixasEm(bisneto.dados)) {
              if (stbl.tipo !== "stsd") continue;
              amostra = primeiraAmostra(stbl.dados);
            }
          }
        }
      }
    }
  }

  const tipo: TipoDeTrilha =
    manipulador === "vide" ? "video" : manipulador === "soun" ? "audio" : "outro";

  // Trilha sem descrição de amostra não descreve codec nenhum. Se for de vídeo
  // ou de áudio isso é defeito — e defeito, aqui, é recusa.
  if (!amostra) {
    if (tipo === "outro") return null;
    return { trilha: { tipo, codec: null, declarado: "(sem stsd)" }, largura, altura };
  }

  if (tipo === "outro") {
    return {
      trilha: { tipo, codec: null, declarado: amostra.tipo },
      largura: null,
      altura: null,
    };
  }

  const codec =
    tipo === "video"
      ? (VIDEO_POR_FOURCC[amostra.tipo] ?? null)
      : audioDeAmostra(amostra.tipo, amostra.dados);

  // `stsd` também guarda a dimensão real da amostra de vídeo. Ela é a que vale
  // quando a `tkhd` traz 0 — o que acontece em arquivo gerado por câmera.
  // `VisualSampleEntry`, contado do fim do cabecalho comum: 2 pre_definidos,
  // 2 reservados, 12 pre_definidos, e so entao largura (2) e altura (2).
  if (tipo === "video" && (!largura || !altura) && amostra.dados.length >= 20) {
    const l = amostra.dados.readUInt16BE(16);
    const a = amostra.dados.readUInt16BE(18);
    if (l && a) {
      largura = l;
      altura = a;
    }
  }

  return { trilha: { tipo, codec, declarado: amostra.tipo }, largura, altura };
}

function dimensaoDeTkhd(dados: Buffer): { largura: number; altura: number } | null {
  if (dados.length < 1) return null;
  const versao = dados.readUInt8(0);
  const base = versao === 1 ? 88 : 76;
  if (dados.length < base + 8) return null;

  // 16.16 de ponto fixo: os 16 bits altos são os pixels inteiros.
  const largura = dados.readUInt32BE(base) >>> 16;
  const altura = dados.readUInt32BE(base + 4) >>> 16;
  return largura && altura ? { largura, altura } : null;
}

/**
 * Primeira entrada da `stsd`, sem o cabeçalho comum de 16 bytes.
 *
 * Só a primeira: uma trilha com duas descrições de amostra é rara o bastante
 * para não valer o risco de tratar mal. Se existir, a segunda é ignorada — e o
 * `ffprobe` da Fase 3 vê o arquivo inteiro de qualquer jeito.
 */
function primeiraAmostra(stsd: Buffer): { tipo: string; dados: Buffer } | null {
  if (stsd.length < 16) return null;
  const quantas = stsd.readUInt32BE(4);
  if (quantas === 0) return null;

  const tamanho = stsd.readUInt32BE(8);
  const tipo = stsd.subarray(12, 16).toString("latin1");
  const fim = Math.min(8 + tamanho, stsd.length);
  if (fim <= 24) return { tipo, dados: Buffer.alloc(0) };

  // Devolve o corpo a partir do fim do cabeçalho comum (8 de caixa + 8 de
  // SampleEntry), que é onde começam os campos específicos de vídeo ou áudio.
  return { tipo, dados: stsd.subarray(24, fim) };
}

const VIDEO_POR_FOURCC: Record<string, string> = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  vp09: "vp9",
  av01: "av1",
};

const AUDIO_POR_FOURCC: Record<string, string> = {
  ".mp3": "mp3",
  Opus: "opus",
  sowt: "pcm_s16le",
  twos: "pcm_s16be",
  "raw ": "pcm_u8",
  lpcm: "pcm_s16le",
  ipcm: "pcm_s16be",
  in24: "pcm_s24be",
  in32: "pcm_s32be",
  fl32: "pcm_f32be",
  fl64: "pcm_f64be",
};

/**
 * Áudio: o fourcc `mp4a` não diz qual codec é — ele só diz "áudio MPEG-4". O
 * que separa AAC de MP3 (e dos que não aceitamos) é o
 * `objectTypeIndication`, um byte enterrado no descritor `esds`.
 *
 * `dados` já vem sem o cabeçalho comum de 16 bytes da `stsd`.
 */
function audioDeAmostra(fourcc: string, dados: Buffer): string | null {
  const direto = AUDIO_POR_FOURCC[fourcc];
  if (direto) return direto;
  if (fourcc !== "mp4a") return null;

  // `AudioSampleEntry`: 8 reservados, 2 canais, 2 bits, 2 pré-definidos,
  // 2 reservados, 4 taxa = 20 bytes antes dos filhos. As versões 1 e 2 do
  // QuickTime acrescentam campos; a versão está nos dois primeiros bytes.
  const versaoQt = dados.length >= 2 ? dados.readUInt16BE(0) : 0;
  const extra = versaoQt === 1 ? 16 : versaoQt === 2 ? 36 : 0;
  const inicioFilhos = 20 + extra;
  if (dados.length <= inicioFilhos) return "aac";

  const esds = procurarEsds(dados.subarray(inicioFilhos), 0);
  if (!esds) {
    // `mp4a` sem `esds` é, na prática, AAC: o descritor é o único lugar onde
    // outra coisa poderia ter sido declarada, e ele não está lá. Aceitar é
    // seguro porque quem decide de fato é o `ffprobe` da Fase 3.
    return "aac";
  }

  return AUDIO_POR_OBJETO[esds] ?? null;
}

/** Procura a caixa `esds`, inclusive dentro de um `wave` do QuickTime. */
function procurarEsds(buf: Buffer, profundidade: number): number | null {
  if (profundidade > 2) return null;

  for (const filho of caixasEm(buf)) {
    if (filho.tipo === "esds") return objetoDoEsds(filho.dados);
    if (filho.tipo === "wave") {
      const achado = procurarEsds(filho.dados, profundidade + 1);
      if (achado !== null) return achado;
    }
  }
  return null;
}

/**
 * `objectTypeIndication` do `DecoderConfigDescriptor`, dentro do `esds`.
 *
 * Os descritores do MPEG-4 têm tamanho "expansível": cada byte de tamanho usa o
 * bit alto para dizer "tem mais um byte". Ler um byte só funciona na maioria
 * dos arquivos e falha nos que o codificador escreveu com preenchimento — que é
 * um jeito conhecido de esconder um campo de um parser preguiçoso.
 */
function objetoDoEsds(dados: Buffer): number | null {
  let posicao = 4; // version + flags

  const tamanhoExpansivel = (): number | null => {
    let valor = 0;
    for (let n = 0; n < 4; n += 1) {
      if (posicao >= dados.length) return null;
      const byte = dados.readUInt8(posicao);
      posicao += 1;
      valor = (valor << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return valor;
    }
    return valor;
  };

  if (posicao >= dados.length) return null;
  if (dados.readUInt8(posicao) !== 0x03) return null; // ES_Descriptor
  posicao += 1;
  if (tamanhoExpansivel() === null) return null;

  posicao += 2; // ES_ID
  if (posicao >= dados.length) return null;
  const bandeiras = dados.readUInt8(posicao);
  posicao += 1;
  if (bandeiras & 0x80) posicao += 2; // dependsOn_ES_ID
  if (bandeiras & 0x40) {
    if (posicao >= dados.length) return null;
    posicao += 1 + dados.readUInt8(posicao); // URL
  }
  if (bandeiras & 0x20) posicao += 2; // OCR_ES_Id

  if (posicao >= dados.length) return null;
  if (dados.readUInt8(posicao) !== 0x04) return null; // DecoderConfigDescriptor
  posicao += 1;
  if (tamanhoExpansivel() === null) return null;

  return posicao < dados.length ? dados.readUInt8(posicao) : null;
}

const AUDIO_POR_OBJETO: Record<number, string> = {
  0x40: "aac", // MPEG-4 Audio
  0x66: "aac", // MPEG-2 AAC Main
  0x67: "aac", // MPEG-2 AAC LC
  0x68: "aac", // MPEG-2 AAC SSR
  0x69: "mp3", // MPEG-2 Audio Part 3
  0x6b: "mp3", // MPEG-1 Audio Part 3
};

// ───────────────────────────────────────────────────────────────────────────
// Matroska / WebM — EBML
// ───────────────────────────────────────────────────────────────────────────

const EBML_CABECALHO = 0x1a45dfa3;
const EBML_SEGMENT = 0x18538067;
const EBML_SEEK_HEAD = 0x114d9b74;
const EBML_INFO = 0x1549a966;
const EBML_TRACKS = 0x1654ae6b;
const EBML_CLUSTER = 0x1f43b675;

const EBML_DOCTYPE = 0x4282;
const EBML_TIMECODE_SCALE = 0x2ad7b1;
const EBML_DURATION = 0x4489;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_CODEC_ID = 0x86;
const EBML_VIDEO = 0xe0;
const EBML_PIXEL_WIDTH = 0xb0;
const EBML_PIXEL_HEIGHT = 0xba;
const EBML_SEEK = 0x4dbb;
const EBML_SEEK_ID = 0x53ab;
const EBML_SEEK_POSITION = 0x53ac;

/** Teto por elemento de metadado (`Tracks`, `Info`, `SeekHead`). */
const ELEMENTO_MAXIMO = 4 * 1024 * 1024;

type Vint = { valor: number; bytes: number; desconhecido: boolean };

/**
 * Inteiro de tamanho variável do EBML.
 *
 * O primeiro byte diz, pela posição do primeiro bit 1, quantos bytes o número
 * ocupa. `manterMarcador` distingue os dois usos: num ID o bit marcador FAZ
 * PARTE do identificador (é assim que as tabelas da especificação escrevem os
 * IDs); num tamanho ele é só andaime e sai fora.
 */
function lerVint(buf: Buffer, posicao: number, manterMarcador: boolean): Vint | null {
  if (posicao >= buf.length) return null;

  const primeiro = buf.readUInt8(posicao);
  if (primeiro === 0) return null; // mais de 8 bytes: não é usado em metadado

  let bytes = 1;
  let mascara = 0x80;
  while (!(primeiro & mascara)) {
    mascara >>= 1;
    bytes += 1;
  }
  if (posicao + bytes > buf.length) return null;

  let valor = manterMarcador ? primeiro : primeiro & (mascara - 1);
  let todosUns = (primeiro & (mascara - 1)) === mascara - 1;

  for (let n = 1; n < bytes; n += 1) {
    const byte = buf.readUInt8(posicao + n);
    if (byte !== 0xff) todosUns = false;
    // `* 256` e não `<< 8`: o deslocamento de bits do JavaScript trabalha em
    // 32 bits com sinal, e um tamanho de 5 bytes viraria número negativo.
    valor = valor * 256 + byte;
  }

  if (valor > Number.MAX_SAFE_INTEGER) return null;
  return { valor, bytes, desconhecido: !manterMarcador && todosUns };
}

type Elemento = { id: number; dados: number; fim: number; desconhecido: boolean };

async function elementoRemoto(
  leitor: LeitorEmBlocos,
  posicao: number,
): Promise<Elemento | null> {
  const cabecalho = await leitor.ler(posicao, 16);
  if (cabecalho.length < 2) return null;

  const id = lerVint(cabecalho, 0, true);
  if (!id) return null;

  const tamanho = lerVint(cabecalho, id.bytes, false);
  if (!tamanho) return null;

  const dados = posicao + id.bytes + tamanho.bytes;
  const fim = tamanho.desconhecido ? leitor.tamanho : dados + tamanho.valor;
  return { id: id.valor, dados, fim, desconhecido: tamanho.desconhecido };
}

function* elementosEm(buf: Buffer): Generator<{ id: number; dados: Buffer }> {
  let posicao = 0;
  while (posicao < buf.length) {
    const id = lerVint(buf, posicao, true);
    if (!id) return;

    const tamanho = lerVint(buf, posicao + id.bytes, false);
    if (!tamanho) return;

    const inicio = posicao + id.bytes + tamanho.bytes;
    const fim = tamanho.desconhecido ? buf.length : inicio + tamanho.valor;
    if (fim > buf.length || fim <= posicao) return;

    yield { id: id.valor, dados: buf.subarray(inicio, fim) };
    posicao = fim;
  }
}

function inteiroEbml(dados: Buffer): number {
  let valor = 0;
  for (const byte of dados) valor = valor * 256 + byte;
  return valor;
}

function flutuanteEbml(dados: Buffer): number | null {
  if (dados.length === 4) return dados.readFloatBE(0);
  if (dados.length === 8) return dados.readDoubleBE(0);
  return null;
}

async function sondarMatroska(leitor: LeitorEmBlocos): Promise<Sonda> {
  const cabecalho = await elementoRemoto(leitor, 0);
  if (!cabecalho || cabecalho.id !== EBML_CABECALHO) {
    throw new SondaError("O cabeçalho deste arquivo não é um Matroska válido.");
  }

  let container: Container = "mkv";
  const dadosCabecalho = await leitor.ler(
    cabecalho.dados,
    Math.min(cabecalho.fim - cabecalho.dados, 1024),
  );
  for (const campo of elementosEm(dadosCabecalho)) {
    if (campo.id === EBML_DOCTYPE) {
      const doctype = campo.dados.toString("latin1").replace(/\0+$/, "");
      if (doctype === "webm") container = "webm";
      else if (doctype !== "matroska") {
        throw new SondaError(
          "Este arquivo é EBML, mas não é vídeo Matroska nem WebM.",
        );
      }
    }
  }

  // O `Segment` costuma vir logo depois do cabeçalho, mas não é obrigado: o
  // Matroska permite `Void` (enchimento que um mux reserva para reescrever
  // depois) e `CRC-32` no topo. Exigir que o próximo elemento JÁ seja o
  // segmento recusaria um MKV perfeitamente válido — e recusar aqui apaga o
  // arquivo do usuário com um motivo que não é verdade. O caminho do MP4 já
  // atravessa caixa desconhecida no topo; este passa a fazer o mesmo.
  let segmento: Elemento | null = null;
  let ponto = cabecalho.fim;

  for (let n = 0; n < 8 && ponto < leitor.tamanho; n += 1) {
    const elemento = await elementoRemoto(leitor, ponto);
    if (!elemento || elemento.fim <= ponto) break;

    if (elemento.id === EBML_SEGMENT) {
      segmento = elemento;
      break;
    }
    ponto = elemento.fim;
  }

  if (!segmento) {
    throw new SondaError("Não encontramos o segmento de vídeo neste arquivo.");
  }

  let info: Buffer | null = null;
  let tracks: Buffer | null = null;
  const porSeekHead = new Map<number, number>();

  let posicao = segmento.dados;
  for (let n = 0; n < 64 && posicao < segmento.fim; n += 1) {
    const filho = await elementoRemoto(leitor, posicao);
    if (!filho || filho.fim <= posicao) break;

    const tamanho = filho.fim - filho.dados;

    if (filho.id === EBML_INFO && !info && tamanho <= ELEMENTO_MAXIMO) {
      info = await leitor.ler(filho.dados, tamanho);
    } else if (filho.id === EBML_TRACKS && !tracks && tamanho <= ELEMENTO_MAXIMO) {
      tracks = await leitor.ler(filho.dados, tamanho);
    } else if (filho.id === EBML_SEEK_HEAD && tamanho <= ELEMENTO_MAXIMO) {
      lerSeekHead(await leitor.ler(filho.dados, tamanho), porSeekHead);
    } else if (filho.id === EBML_CLUSTER) {
      // Daqui para a frente é quadro de vídeo. Metadado que não apareceu antes
      // do primeiro cluster está adiante, e quem sabe onde é o `SeekHead`.
      break;
    }

    if (info && tracks) break;
    posicao = filho.fim;
  }

  // `Tracks` depois dos clusters é legítimo (arquivo gravado em fluxo, fechado
  // no fim). O `SeekHead` existe para esse caso: ele guarda a posição de cada
  // metadado, relativa ao início dos dados do segmento.
  if (!tracks && porSeekHead.has(EBML_TRACKS)) {
    tracks = await elementoApontado(leitor, segmento.dados, porSeekHead.get(EBML_TRACKS)!, EBML_TRACKS);
  }
  if (!info && porSeekHead.has(EBML_INFO)) {
    info = await elementoApontado(leitor, segmento.dados, porSeekHead.get(EBML_INFO)!, EBML_INFO);
  }

  if (!tracks) {
    throw new SondaError(
      "Não encontramos a lista de trilhas deste arquivo. Ele pode estar incompleto.",
    );
  }

  let duracao: number | null = null;
  if (info) {
    let escala = 1_000_000; // nanossegundos por tique, padrão do Matroska
    let tiques: number | null = null;
    for (const campo of elementosEm(info)) {
      if (campo.id === EBML_TIMECODE_SCALE) escala = inteiroEbml(campo.dados);
      else if (campo.id === EBML_DURATION) tiques = flutuanteEbml(campo.dados);
    }
    if (tiques !== null && escala > 0) {
      duracao = Number(((tiques * escala) / 1_000_000_000).toFixed(3));
    }
  }

  const trilhas: Trilha[] = [];
  let largura: number | null = null;
  let altura: number | null = null;

  for (const entrada of elementosEm(tracks)) {
    if (entrada.id !== EBML_TRACK_ENTRY) continue;

    let tipoBruto = 0;
    let codecId = "";
    let l: number | null = null;
    let a: number | null = null;

    for (const campo of elementosEm(entrada.dados)) {
      if (campo.id === EBML_TRACK_TYPE) tipoBruto = inteiroEbml(campo.dados);
      else if (campo.id === EBML_CODEC_ID) {
        codecId = campo.dados.toString("latin1").replace(/\0+$/, "");
      } else if (campo.id === EBML_VIDEO) {
        for (const dimensao of elementosEm(campo.dados)) {
          if (dimensao.id === EBML_PIXEL_WIDTH) l = inteiroEbml(dimensao.dados);
          else if (dimensao.id === EBML_PIXEL_HEIGHT) a = inteiroEbml(dimensao.dados);
        }
      }
    }

    const tipo: TipoDeTrilha =
      tipoBruto === 1 ? "video" : tipoBruto === 2 ? "audio" : "outro";

    trilhas.push({
      tipo,
      codec: tipo === "outro" ? null : (codecMatroska(codecId) ?? null),
      declarado: codecId || "(sem CodecID)",
    });

    if (tipo === "video" && largura === null && l && a) {
      largura = l;
      altura = a;
    }
  }

  return {
    fonte: "cabecalho",
    container,
    duracao_s: duracao,
    largura,
    altura,
    trilhas,
    bytes_lidos: leitor.bytesLidos,
    analisado_em: new Date().toISOString(),
  };
}

function lerSeekHead(dados: Buffer, destino: Map<number, number>): void {
  for (const seek of elementosEm(dados)) {
    if (seek.id !== EBML_SEEK) continue;

    let alvo: number | null = null;
    let posicao: number | null = null;
    for (const campo of elementosEm(seek.dados)) {
      if (campo.id === EBML_SEEK_ID) alvo = inteiroEbml(campo.dados);
      else if (campo.id === EBML_SEEK_POSITION) posicao = inteiroEbml(campo.dados);
    }
    if (alvo !== null && posicao !== null && !destino.has(alvo)) {
      destino.set(alvo, posicao);
    }
  }
}

async function elementoApontado(
  leitor: LeitorEmBlocos,
  baseDoSegmento: number,
  deslocamento: number,
  idEsperado: number,
): Promise<Buffer | null> {
  const elemento = await elementoRemoto(leitor, baseDoSegmento + deslocamento);
  if (!elemento || elemento.id !== idEsperado) return null;

  const tamanho = elemento.fim - elemento.dados;
  if (tamanho <= 0 || tamanho > ELEMENTO_MAXIMO) return null;
  return leitor.ler(elemento.dados, tamanho);
}

/**
 * `CodecID` do Matroska para a nomenclatura do FFmpeg.
 *
 * Casa por prefixo onde a especificação permite sufixo — `A_AAC/MPEG4/LC` e
 * `A_AAC` são o mesmo codec, e `A_PCM/INT/LIT` tem parentes.
 */
function codecMatroska(id: string): string | null {
  const tabela: [string, string][] = [
    ["V_MPEG4/ISO/AVC", "h264"],
    ["V_MPEGH/ISO/HEVC", "hevc"],
    ["V_VP9", "vp9"],
    ["V_AV1", "av1"],
    ["A_AAC", "aac"],
    ["A_MPEG/L3", "mp3"],
    ["A_OPUS", "opus"],
    ["A_VORBIS", "vorbis"],
    ["A_PCM/INT/LIT", "pcm_s16le"],
    ["A_PCM/INT/BIG", "pcm_s16be"],
    ["A_PCM/FLOAT/IEEE", "pcm_f32le"],
  ];

  for (const [prefixo, codec] of tabela) {
    if (id === prefixo || id.startsWith(`${prefixo}/`)) return codec;
  }
  return null;
}
