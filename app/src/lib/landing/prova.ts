import relatorio from "./prova.json";

/**
 * A prova visual da landing — o relatório de validação que a seção "A
 * verificação é o produto" mostra.
 *
 * O JSON ao lado **não é escrito à mão**. Ele sai de
 * `scripts/gerar-prova-visual.py`, que monta um vídeo de origem sintético (o
 * material real em `worker/input/` é repost de página de terceiro e não tem
 * autorização nenhuma de uso) e o passa pelo `worker/run.py` de verdade:
 * mesma detecção de layout, mesmo FFmpeg, mesma `validate.py`. Os números que
 * aparecem na página são a saída literal dessas checagens.
 *
 * Isso importa para a regra "sem número inventado" do lançamento: tudo o que
 * a landing afirma em número tem um comando que o reproduz. Se o pipeline
 * regredir, roda-se o script de novo e a landing passa a mostrar a regressão —
 * ela não tem número próprio para esconder atrás.
 */
export type Checagem = {
  name: string;
  ok: boolean;
  detail: string;
  metrics: Record<string, unknown>;
};

export type Relatorio = {
  gerado_por: string;
  origem: string;
  media: { width: number; height: number; fps: number; duration: number };
  layout: { old_header_top: number; old_header_bottom: number; video_top: number };
  checks: Checagem[];
  passed: boolean;
  elapsed_s: number;
};

export const PROVA: Relatorio = relatorio;

/**
 * O nome legível de cada checagem.
 *
 * O `name` do relatório é identificador de código (`cobertura_header`), não
 * texto de interface. A tradução mora aqui e não no worker porque é decisão de
 * produto: o worker precisa do nome estável para comparar entre versões.
 *
 * Uma checagem nova no worker aparece na landing com o próprio identificador
 * até alguém escrever a linha dela aqui — visível e feio, que é melhor do que
 * sumir da página em silêncio.
 */
const NOMES: Record<string, string> = {
  resolucao: "Resolução, taxa de quadros e formato de cor",
  duracao: "Duração idêntica à do original",
  audio: "Trilha de áudio presente e audível",
  cobertura_header: "Faixa de cobertura aplicada pixel a pixel",
  header_antigo_dentro_da_cobertura:
    "Perfil antigo inteiramente dentro da faixa coberta",
  vazamento_do_header_antigo: "Nenhum pixel do perfil antigo ficou de fora",
  faixa_de_video_preservada: "Imagem original preservada e em movimento",
};

export function nomeDaChecagem(name: string): string {
  return NOMES[name] ?? name;
}
