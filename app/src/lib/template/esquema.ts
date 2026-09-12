import { z } from "zod";

/**
 * O contrato do template — o mesmo JSON que o worker consome.
 *
 * ESTE ARQUIVO É UM ESPELHO, e o original está em
 * `worker/src/servico/molde.py` (a tabela `PERMITIDAS`). Toda faixa daqui
 * existe lá, com o mesmo mínimo e o mesmo máximo. As duas validações não são
 * redundância: elas defendem coisas diferentes.
 *
 *   · o `zod` aqui defende a **experiência**: recusa na hora, em pt-BR, com o
 *     campo apontado, antes de gastar um worker para descobrir a mesma coisa;
 *   · o `molde.py` lá defende o **desenho**: ele não valida o que veio, ele
 *     monta a config do zero e copia só o que conhece. É o que continua de pé
 *     se este arquivo tiver um furo, e é onde `header` e `fonte` deixam de ser
 *     texto e viram caminho de arquivo de verdade.
 *
 * `z.strictObject` em todos os níveis, e isso é parte do cross-check da fase:
 * campo desconhecido **reprova** em vez de ser ignorado. Ignorar seria pior do
 * que parece — o usuário mandaria `caption.font: "/etc/shadow"` (o nome que o
 * worker usa internamente, em vez de `fonte`), veria o salvamento dar certo e
 * ficaria esperando um efeito que nunca vem.
 *
 * MUDAR UMA OPÇÃO AQUI É SEMPRE MUDANÇA NOS DOIS LADOS. Campo novo que o
 * `molde.py` não conheça é silenciosamente descartado lá: o template salva, a
 * tela mostra a opção, e o vídeo sai igual ao de antes.
 */

/** Sobe quando o formato do JSON mudar de forma incompatível. */
export const VERSAO_DO_TEMPLATE = 1;

/**
 * As fontes embarcadas na imagem do worker, por apelido.
 *
 * Lista fechada, e o usuário nunca escolhe um arquivo: um caminho de `.ttf`
 * vindo do navegador é um decoder (FreeType) apontado para onde o atacante
 * quiser, dentro do container. O apelido resolve para um caminho que o worker
 * conhece — ver `FONTES` em `worker/src/servico/molde.py`.
 */
export const FONTES = [
  {
    apelido: "sans-bold",
    nome: "Sem serifa, negrito",
    descricao: "A do post original. Métrica igual à da Arial Bold.",
    // Só para a prévia da tela: a fonte que desenha o vídeo é a do worker.
    familia: "Arial, 'Liberation Sans', 'Helvetica Neue', sans-serif",
    peso: 700,
  },
  {
    apelido: "sans",
    nome: "Sem serifa",
    descricao: "Mesma família, sem negrito.",
    familia: "Arial, 'Liberation Sans', 'Helvetica Neue', sans-serif",
    peso: 400,
  },
  {
    apelido: "serif-bold",
    nome: "Com serifa, negrito",
    descricao: "Ar mais editorial, contraste maior.",
    familia: "'Times New Roman', 'Liberation Serif', Georgia, serif",
    peso: 700,
  },
] as const;

export type ApelidoDeFonte = (typeof FONTES)[number]["apelido"];

const APELIDOS = FONTES.map((f) => f.apelido) as [ApelidoDeFonte, ...ApelidoDeFonte[]];

export const ENQUADRAMENTOS = [
  {
    modo: "fit",
    nome: "Ajustar",
    descricao: "O vídeo inteiro aparece, com faixas na cor de fundo.",
  },
  {
    modo: "cover",
    nome: "Preencher",
    descricao: "O vídeo ocupa toda a largura; as bordas são cortadas.",
  },
  {
    modo: "blur",
    nome: "Fundo desfocado",
    descricao: "O vídeo inteiro aparece sobre uma versão desfocada dele.",
  },
] as const;

/** `#RGB` ou `#RRGGBB`. A mesma expressão do `molde.py`. */
const COR = /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$/;

const cor = z
  .string()
  .regex(COR, "Use uma cor no formato #RRGGBB.");

/**
 * A faixa de cobertura aceita `auto`, que é "a cor de fundo que o worker
 * detectar no vídeo". É a opção certa para lote de vídeos com fundos
 * diferentes, e por isso ela existe além do seletor de cor.
 */
const corOuAuto = z.union([z.literal("auto"), cor]);

const LIMITE_DA_FRASE = 400;
export const MAXIMO_DA_FRASE = LIMITE_DA_FRASE;

/**
 * Os invisíveis, escritos como escape pela mesma razão de `lib/r2/chaves.ts`:
 * um caractere de controle literal no fonte some em revisão e em diff.
 *
 * `\n` fica de fora da faixa recusada de propósito — ele é a quebra de linha
 * manual que o pipeline entende. As marcas de direção (U+202A–U+202E,
 * U+2066–U+2069) entram: elas invertem a ordem do texto DESENHADO no vídeo,
 * e o usuário veria a frase certa na tela e outra no arquivo entregue.
 */
const INVISIVEIS =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

const frase = z
  .string()
  .max(LIMITE_DA_FRASE, `A frase pode ter até ${LIMITE_DA_FRASE} caracteres.`)
  .refine((valor) => !INVISIVEIS.test(valor), {
    message: "A frase tem caracteres invisíveis que não podem ser desenhados.",
  });

/**
 * A imagem de cabeçalho nunca é um caminho.
 *
 * `embutido` é um asset da imagem do worker, por nome; `r2` é um arquivo que o
 * próprio usuário enviou, por chave. A chave é conferida contra o dono **no
 * servidor** (a rota lê `assets`) e de novo no worker, que exige o prefixo do
 * usuário antes de baixar qualquer coisa.
 */
const header = z.discriminatedUnion("fonte", [
  z.strictObject({
    fonte: z.literal("embutido"),
    nome: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "Imagem de cabeçalho inválida."),
  }),
  z.strictObject({
    fonte: z.literal("r2"),
    // A forma exata que `montarChaveDeAsset` gera. Ela não prova posse — quem
    // prova é a linha em `assets`, conferida no servidor por
    // `lib/template/header.ts` — mas recusa aqui tudo que nem parece uma
    // chave, e é a conferência que o navegador também consegue fazer.
    chave: z
      .string()
      .regex(
        /^[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}\.(png|jpg)$/,
        "Imagem de cabeçalho inválida.",
      ),
  }),
]);

export const ConfigDoTemplate = z.strictObject({
  versao: z.literal(VERSAO_DO_TEMPLATE),

  canvas: z.strictObject({
    background: cor,
  }),

  framing: z.strictObject({
    mode: z.enum(["fit", "cover", "blur"]),
  }),

  profile: z.strictObject({
    header,
    align: z.enum(["auto", "fixed"]),
    offset_x: z.number().int().min(-500).max(500),
    offset_y: z.number().int().min(-500).max(500),
    scale: z.number().min(0.2).max(3),
    trim_to_content: z.boolean(),
  }),

  caption: z.strictObject({
    text: frase,
    fonte: z.enum(APELIDOS),
    size_px: z.number().int().min(20).max(140),
    autofit: z.boolean(),
    color: cor,
    max_width_pct: z.number().min(0.3).max(1),
    line_spacing: z.number().min(0.8).max(2),
    position: z.enum(["between", "fixed"]),
  }),

  cover: z.strictObject({
    enabled: z.boolean(),
    color: corOuAuto,
    extra_px: z.number().int().min(-200).max(400),
  }),

  output: z.strictObject({
    crf: z.number().int().min(14).max(32),
    preset: z.enum([
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "fast",
      "medium",
      "slow",
      "slower",
    ]),
  }),
});

export type ConfigDoTemplate = z.infer<typeof ConfigDoTemplate>;

/** O cabeçalho que acompanha o worker, para quem ainda não enviou um seu. */
export const HEADER_EMBUTIDO = "header_pretamente.png";

export const CONFIG_PADRAO: ConfigDoTemplate = {
  versao: VERSAO_DO_TEMPLATE,
  canvas: { background: "#FFFFFF" },
  framing: { mode: "fit" },
  profile: {
    header: { fonte: "embutido", nome: HEADER_EMBUTIDO },
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

/** Cópia nova a cada chamada — o objeto vai para estado de tela e para o banco. */
export function configPadrao(): ConfigDoTemplate {
  return structuredClone(CONFIG_PADRAO);
}

/**
 * O `config` que veio do banco, conferido.
 *
 * Um template gravado antes de uma mudança de formato — ou editado por fora —
 * não pode derrubar a tela nem ir para a fila como está. `null` diz "não serve",
 * e quem chama decide: o editor abre no padrão, o enfileiramento recusa.
 */
export function lerConfig(bruto: unknown): ConfigDoTemplate | null {
  const analisado = ConfigDoTemplate.safeParse(bruto);
  return analisado.success ? analisado.data : null;
}

/**
 * A primeira mensagem de erro do `zod`, com o caminho do campo.
 *
 * O `zod` devolve uma árvore; a tela mostra uma frase. Mostrar a frase com o
 * caminho ("caption.size_px: …") é o que evita o suporte por adivinhação
 * quando o erro vem de um campo que não está na aba aberta.
 */
export function primeiroErro(erro: z.ZodError): string {
  const issue = erro.issues[0];
  if (!issue) return "Configuração de template inválida.";
  const caminho = issue.path.join(".");
  return caminho ? `${caminho}: ${issue.message}` : issue.message;
}
