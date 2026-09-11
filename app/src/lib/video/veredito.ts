/**
 * A decisão: este arquivo entra ou não entra.
 *
 * Separado da sondagem de propósito. `./sonda` só LÊ — ela responde "o que este
 * arquivo declara ser". Aqui está a POLÍTICA — "o que a gente aceita" — e é ela
 * que muda quando a lista de `docs/PLANO.md` §4 mudar. Misturar as duas faria
 * cada ajuste de política mexer no parser de contêiner, que é o código onde
 * menos se quer mexer.
 */

import { audioPermitido, videoPermitido } from "@/lib/video/codecs";
import type { Sonda, Trilha } from "@/lib/video/sonda";

export type Veredito =
  | { ok: true }
  /** `motivo` é em pt-BR e vai direto para a tela e para `jobs.error`. */
  | { ok: false; motivo: string };

export function avaliarSonda(sonda: Sonda): Veredito {
  const video = sonda.trilhas.filter((t) => t.tipo === "video");
  const audio = sonda.trilhas.filter((t) => t.tipo === "audio");

  if (video.length === 0) {
    return {
      ok: false,
      motivo:
        "Este arquivo não tem trilha de vídeo. Se for só áudio ou só legenda, " +
        "ele não pode virar um Reels.",
    };
  }

  for (const trilha of video) {
    if (!videoPermitido(trilha.codec)) {
      return { ok: false, motivo: recusa("vídeo", trilha, "H.264, HEVC, VP9 ou AV1") };
    }
  }

  for (const trilha of audio) {
    if (!audioPermitido(trilha.codec)) {
      return { ok: false, motivo: recusa("áudio", trilha, "AAC, MP3, Opus, Vorbis ou PCM") };
    }
  }

  return { ok: true };
}

/**
 * Trilha que não é de vídeo nem de áudio — legenda, código de tempo, dados — é
 * ignorada de propósito, e isso precisa estar escrito porque parece uma brecha.
 *
 * Não é: a lista fechada existe para não acionar **decoder** exótico (PLANO §4,
 * o CVE do MagicYUV), e o pipeline de render nunca decodifica essas trilhas —
 * ele lê vídeo e áudio e descarta o resto. Recusar por causa delas quebraria
 * caso comum e legítimo: todo vídeo gravado por iPhone vem com uma trilha
 * `tmcd` de código de tempo.
 */
function recusa(qual: string, trilha: Trilha, aceitos: string): string {
  const nome = trilha.codec ?? trilha.declarado;
  return (
    `O ${qual} deste arquivo está em ${nome}, que não processamos. ` +
    `Aceitamos ${aceitos} — reexporte o vídeo em um deles e envie de novo.`
  );
}
