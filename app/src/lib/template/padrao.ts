/**
 * O template que o lote leva quando é enfileirado.
 *
 * `template_snapshot` é **cópia congelada**: o PLANO pede isso para que editar
 * o template no meio de um lote não mude os vídeos que já estão na fila. Ele é
 * gravado por `enqueue_project` (migration 0015) no momento do clique em
 * Processar, e o worker renderiza a partir dele — nunca do template "atual".
 *
 * POR QUE ELE É UMA CONSTANTE AQUI, E ATÉ QUANDO
 * ==============================================
 *
 * O editor visual de template é a **Fase 6**. Até lá não há de onde tirar um
 * template do usuário: a tabela `templates` existe e está vazia, e
 * `projects.template_id` é nulo em todo projeto. Inventar uma tela de edição
 * agora seria adiantar a Fase 6 pela metade; deixar o worker sem template
 * nenhum seria não ter Fase 3.
 *
 * Então o lote inteiro sai com este molde. Quando a Fase 6 chegar, o que muda
 * é UMA linha em `processarLote`: em vez desta constante, o `config` do
 * template do projeto. O formato já é o mesmo, e o worker já valida campo por
 * campo (`worker/src/servico/molde.py`) justamente porque nessa hora o
 * conteúdo passa a vir do usuário.
 *
 * O QUE PODE E O QUE NÃO PODE ESTAR AQUI
 * ======================================
 *
 * Só as chaves que o worker aceita. Ele não confia neste arquivo: monta a
 * config dele do zero e copia daqui apenas o que estiver na lista dele, com
 * faixa fechada por campo. Chave a mais aqui é silenciosamente ignorada lá —
 * então acrescentar uma opção nova é sempre uma mudança nos DOIS lados.
 *
 * E imagem nunca é caminho de arquivo: é uma referência (`embutido` + nome de
 * asset da imagem do worker, ou `r2` + chave do próprio usuário). A fonte é um
 * apelido de uma lista fechada, nunca um `.ttf` solto.
 */

export const VERSAO_DO_TEMPLATE = 1;

export type TemplateSnapshot = {
  versao: number;
  canvas: { background: string };
  framing: { mode: "fit" | "cover" | "blur" };
  profile: {
    header: { fonte: "embutido"; nome: string } | { fonte: "r2"; chave: string };
    align: "auto" | "fixed";
    offset_x: number;
    offset_y: number;
    scale: number;
    trim_to_content: boolean;
  };
  caption: {
    text: string;
    fonte: "sans-bold" | "sans" | "serif-bold";
    size_px: number;
    autofit: boolean;
    color: string;
    max_width_pct: number;
    line_spacing: number;
    position: "between" | "fixed";
  };
  cover: { enabled: boolean; color: string; extra_px: number };
  output: { crf: number; preset: string };
};

export const TEMPLATE_PADRAO: TemplateSnapshot = {
  versao: VERSAO_DO_TEMPLATE,
  canvas: { background: "#FFFFFF" },
  framing: { mode: "fit" },
  profile: {
    header: { fonte: "embutido", nome: "header_pretamente.png" },
    align: "auto",
    offset_x: 0,
    offset_y: 0,
    scale: 1,
    trim_to_content: true,
  },
  caption: {
    text: "Parabéns! Você achou a página certa",
    fonte: "sans-bold",
    size_px: 58,
    autofit: true,
    color: "#000000",
    max_width_pct: 0.9,
    line_spacing: 1.16,
    position: "between",
  },
  cover: { enabled: true, color: "#FFFFFF", extra_px: 0 },
  output: { crf: 20, preset: "medium" },
};

/** Cópia nova a cada chamada: o snapshot vai para o banco e não pode ser compartilhado. */
export function templateDoProjeto(): TemplateSnapshot {
  return structuredClone(TEMPLATE_PADRAO);
}
