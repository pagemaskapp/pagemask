"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { SaveIcon } from "lucide-react";

import { salvarTemplate } from "@/app/app/templates/acoes";
import {
  Campo,
  Cor,
  Deslizante,
  Escolha,
  Interruptor,
  Numero,
  Secao,
} from "@/app/app/templates/[id]/campos";
import {
  EscolherHeader,
  type HeaderDisponivel,
} from "@/app/app/templates/[id]/escolher-header";
import { Previa, type EstadoDaPrevia } from "@/app/app/templates/[id]/previa";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ENQUADRAMENTOS,
  FONTES,
  MAXIMO_DA_FRASE,
  type ConfigDoTemplate,
} from "@/lib/template/esquema";

export type { HeaderDisponivel };

type Amostragem = { projeto: string; video: string | null };

export type Amostra = {
  projetoId: string;
  projetoNome: string;
  videos: { id: string; nome: string }[];
};

/**
 * O editor de template.
 *
 * A PRÉVIA É O PRODUTO DESTA TELA, e o desenho todo gira em torno de uma
 * pergunta: quantas prévias um ajuste custa? Três coisas respondem isso:
 *
 *   · **debounce de 600 ms** — quem digita uma frase de 40 caracteres pede uma
 *     prévia, não quarenta;
 *   · **geração** (o `useRef` abaixo) — toda resposta que chega conferindo um
 *     número de geração velho é descartada. Sem isso, a prévia de "Parabé"
 *     chegando depois da de "Parabéns" sobrescreve a certa pela errada, e o
 *     usuário vê a tela voltar no tempo;
 *   · **supersede no banco** — `request_preview` apaga a prévia anterior que
 *     ainda estava na fila, para o worker não renderizar estado que ninguém
 *     mais quer ver.
 *
 * O limite de 30 prévias por 10 minutos existe no servidor, independente disso
 * tudo: debounce é cortesia com o usuário honesto, limite é defesa.
 *
 * SALVAR NÃO É AUTOMÁTICO, de propósito. Um projeto pode estar usando este
 * template agora; salvar a cada tecla mudaria o visual do próximo lote de
 * alguém no meio de um ajuste que talvez seja descartado.
 */
export function Editor({
  template,
  configInicial,
  configIlegivel,
  amostras,
  headers: headersIniciais,
  acoes,
}: {
  template: { id: string; nome: string; versao: number };
  configInicial: ConfigDoTemplate;
  configIlegivel: boolean;
  amostras: Amostra[];
  headers: HeaderDisponivel[];
  acoes: React.ReactNode;
}) {
  const [nome, setNome] = useState(template.nome);
  const [config, setConfig] = useState(configInicial);
  const [headers, setHeaders] = useState(headersIniciais);
  const [versao, setVersao] = useState(template.versao);

  // O tipo é escrito à mão porque `video` pode ser nulo mesmo quando a
  // inferência a partir do valor inicial diz que não: um projeto sem vídeo
  // nenhum entra aqui com `video: null`, e o servidor escolhe a amostra.
  const [amostra, setAmostra] = useState<Amostragem | null>(() => {
    const primeira = amostras[0];
    if (!primeira) return null;
    return { projeto: primeira.projetoId, video: primeira.videos[0]?.id ?? null };
  });

  const [previa, setPrevia] = useState<EstadoDaPrevia>({ carregando: false });
  const [salvando, iniciarSalvamento] = useTransition();
  const [mensagem, setMensagem] = useState<{ erro?: string; aviso?: string }>({});

  /** Muda um bloco do config sem tocar nos outros. */
  const mudar = useCallback(
    <S extends Exclude<keyof ConfigDoTemplate, "versao">>(
      secao: S,
      mudanca: Partial<ConfigDoTemplate[S]>,
    ) => {
      setConfig(
        (atual) =>
          ({
            ...atual,
            [secao]: { ...atual[secao], ...mudanca },
            // A asserção existe porque a chave computada faz o TypeScript
            // alargar o objeto para `{ [x: string]: … }` e perder o vínculo com
            // `ConfigDoTemplate`. O que garante o formato é a assinatura
            // genérica acima, e o `zod` do servidor confere de novo.
          }) as ConfigDoTemplate,
      );
    },
    [],
  );

  // --- a prévia ----------------------------------------------------------

  const geracao = useRef(0);

  const pedirPrevia = useCallback(
    async (config: ConfigDoTemplate, projeto: string, video: string | null) => {
      const minha = ++geracao.current;
      setPrevia((atual) => ({ ...atual, carregando: true, erro: undefined }));

      const desatualizada = () => minha !== geracao.current;

      const pedido = await postJson("/api/templates/previa", {
        projeto,
        video,
        config,
      });
      if (desatualizada()) return;
      if (pedido.erro) {
        setPrevia({ carregando: false, erro: pedido.erro });
        return;
      }

      const limite = Date.now() + ESPERA_MAXIMA_MS;
      while (Date.now() < limite) {
        await esperar(INTERVALO_MS);
        if (desatualizada()) return;

        const estado = await getJson(`/api/templates/previa/${pedido.id}`);
        if (desatualizada()) return;

        if (estado.erro) {
          setPrevia({ carregando: false, erro: estado.erro });
          return;
        }
        if (estado.status === "done") {
          setPrevia({ carregando: false, url: estado.url as string });
          return;
        }
        if (estado.status === "failed" || estado.status === "expirada") {
          setPrevia({
            carregando: false,
            erro:
              (estado.erro as string) ??
              "Não conseguimos gerar a prévia deste vídeo. Tente outro vídeo de amostra.",
          });
          return;
        }
      }

      setPrevia((atual) => ({
        ...atual,
        carregando: false,
        erro:
          "A prévia está demorando mais que o normal. O processamento pode " +
          "estar com fila. Tente de novo em instantes.",
      }));
    },
    [],
  );

  // O efeito depende do TEXTO do config, não do objeto: `setConfig` cria um
  // objeto novo a cada tecla, e um efeito que dependesse da referência
  // dispararia igual mesmo quando nada mudou de verdade (voltar a cor para a
  // mesma cor, por exemplo).
  const assinatura = JSON.stringify(config);

  useEffect(() => {
    if (!amostra) return;

    const timer = setTimeout(() => {
      void pedirPrevia(JSON.parse(assinatura) as ConfigDoTemplate, amostra.projeto, amostra.video);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [assinatura, amostra, pedirPrevia]);

  // --- salvar ------------------------------------------------------------

  function salvar() {
    setMensagem({});
    iniciarSalvamento(async () => {
      const resposta = await salvarTemplate({ id: template.id, nome, config });
      setMensagem({ erro: resposta.erro, aviso: resposta.aviso });
      if (resposta.versao) setVersao(resposta.versao);
    });
  }

  const projetoAtual = amostras.find((a) => a.projetoId === amostra?.projeto);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor="nome">Nome do template</Label>
          <Input
            id="nome"
            value={nome}
            maxLength={60}
            onChange={(evento) => setNome(evento.target.value)}
            className="mt-1.5 max-w-sm"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Versão {versao} · a versão sobe a cada mudança de desenho salva.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {acoes}
          <Button type="button" onClick={salvar} disabled={salvando}>
            <SaveIcon />
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </div>

      <CampoMensagem erro={mensagem.erro} aviso={mensagem.aviso} />

      {configIlegivel ? (
        <CampoMensagem erro="Este template estava com uma configuração que não reconhecemos, então o editor abriu com o modelo padrão. Ajuste e salve para consertá-lo." />
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 lg:order-1">
          <Secao
            titulo="Cabeçalho"
            descricao="A imagem que cobre o cabeçalho do post original."
          >
            <EscolherHeader
              header={config.profile.header}
              headers={headers}
              aoEscolher={(header) => mudar("profile", { header })}
              aoEnviar={(novo) => setHeaders((atual) => [novo, ...atual])}
            />

            <Campo
              id="align"
              rotulo="Posição vertical"
              ajuda={
                config.profile.align === "auto"
                  ? "O topo da imagem nova é alinhado ao topo do cabeçalho antigo, detectado em cada vídeo. É o que faz um cabeçalho novo se posicionar sozinho."
                  : "A imagem é colocada na altura fixa abaixo, igual em todos os vídeos do lote."
              }
            >
              <Escolha
                id="align"
                valor={config.profile.align}
                opcoes={[
                  { valor: "auto", rotulo: "Automática (detectar em cada vídeo)" },
                  { valor: "fixed", rotulo: "Fixa" },
                ]}
                aoMudar={(align) => mudar("profile", { align })}
              />
            </Campo>

            <div className="grid grid-cols-2 gap-3">
              <Campo
                id="offset_y"
                rotulo={config.profile.align === "auto" ? "Ajuste vertical" : "Altura"}
              >
                <Numero
                  id="offset_y"
                  valor={config.profile.offset_y}
                  minimo={-500}
                  maximo={500}
                  sufixo="px"
                  aoMudar={(offset_y) => mudar("profile", { offset_y })}
                />
              </Campo>

              <Campo id="offset_x" rotulo="Ajuste horizontal">
                <Numero
                  id="offset_x"
                  valor={config.profile.offset_x}
                  minimo={-500}
                  maximo={500}
                  sufixo="px"
                  aoMudar={(offset_x) => mudar("profile", { offset_x })}
                />
              </Campo>
            </div>

            <Campo id="scale" rotulo="Tamanho da imagem">
              <Deslizante
                id="scale"
                valor={config.profile.scale}
                minimo={0.2}
                maximo={3}
                passo={0.05}
                formatar={(valor) => `${Math.round(valor * 100)}%`}
                aoMudar={(scale) => mudar("profile", { scale })}
              />
            </Campo>

            <Interruptor
              id="trim"
              rotulo="Aparar as bordas vazias da imagem"
              ajuda="Recomendado. Sem isso, a margem transparente do arquivo conta como parte do cabeçalho e o posicionamento erra."
              marcado={config.profile.trim_to_content}
              aoMudar={(trim_to_content) => mudar("profile", { trim_to_content })}
            />
          </Secao>

          <Secao titulo="Frase" descricao="O texto desenhado abaixo do cabeçalho.">
            <Campo id="texto" rotulo="Texto">
              <textarea
                id="texto"
                value={config.caption.text}
                maxLength={MAXIMO_DA_FRASE}
                rows={3}
                onChange={(evento) =>
                  mudar("caption", { text: evento.target.value })
                }
                className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:ring-3"
              />
              <p className="text-muted-foreground mt-1 text-right text-xs tabular-nums">
                {config.caption.text.length}/{MAXIMO_DA_FRASE}
              </p>
            </Campo>

            <Campo id="fonte" rotulo="Fonte">
              <Escolha
                id="fonte"
                valor={config.caption.fonte}
                opcoes={FONTES.map((fonte) => ({
                  valor: fonte.apelido,
                  rotulo: fonte.nome,
                }))}
                aoMudar={(fonte) => mudar("caption", { fonte })}
              />
            </Campo>

            <Campo
              id="size_px"
              rotulo="Corpo"
              ajuda={
                config.caption.autofit
                  ? "Tamanho máximo. Se a frase não couber no espaço entre o cabeçalho e o vídeo, ela diminui sozinha até caber."
                  : "Tamanho fixo. Uma frase longa pode transbordar."
              }
            >
              <Deslizante
                id="size_px"
                valor={config.caption.size_px}
                minimo={20}
                maximo={140}
                formatar={(valor) => `${valor} px`}
                aoMudar={(size_px) => mudar("caption", { size_px })}
              />
            </Campo>

            <Interruptor
              id="autofit"
              rotulo="Diminuir a fonte para caber"
              marcado={config.caption.autofit}
              aoMudar={(autofit) => mudar("caption", { autofit })}
            />

            <Campo id="cor-frase" rotulo="Cor do texto">
              <Cor
                id="cor-frase"
                valor={config.caption.color}
                aoMudar={(color) => mudar("caption", { color })}
              />
            </Campo>

            <Campo
              id="largura"
              rotulo="Largura máxima do bloco de texto"
              ajuda="Em relação à largura do quadro. Menor deixa mais respiro nas laterais."
            >
              <Deslizante
                id="largura"
                valor={config.caption.max_width_pct}
                minimo={0.3}
                maximo={1}
                passo={0.05}
                formatar={(valor) => `${Math.round(valor * 100)}%`}
                aoMudar={(max_width_pct) => mudar("caption", { max_width_pct })}
              />
            </Campo>

            <Campo id="entrelinha" rotulo="Entrelinha">
              <Deslizante
                id="entrelinha"
                valor={config.caption.line_spacing}
                minimo={0.8}
                maximo={2}
                passo={0.02}
                formatar={(valor) => valor.toFixed(2).replace(".", ",")}
                aoMudar={(line_spacing) => mudar("caption", { line_spacing })}
              />
            </Campo>
          </Secao>

          <Secao
            titulo="Vídeo e fundo"
            descricao="Como o vídeo original se encaixa no quadro 1080×1920."
          >
            <Campo
              id="framing"
              rotulo="Enquadramento"
              ajuda={
                ENQUADRAMENTOS.find((e) => e.modo === config.framing.mode)?.descricao
              }
            >
              <Escolha
                id="framing"
                valor={config.framing.mode}
                opcoes={ENQUADRAMENTOS.map((e) => ({ valor: e.modo, rotulo: e.nome }))}
                aoMudar={(mode) => mudar("framing", { mode })}
              />
            </Campo>

            <Campo id="fundo" rotulo="Cor de fundo">
              <Cor
                id="fundo"
                valor={config.canvas.background}
                aoMudar={(background) => mudar("canvas", { background })}
              />
            </Campo>
          </Secao>

          <Secao
            titulo="Faixa de cobertura"
            descricao="A faixa que apaga o cabeçalho antigo antes de a imagem nova entrar."
          >
            <Interruptor
              id="cover"
              rotulo="Cobrir o cabeçalho antigo"
              ajuda="Desligar só faz sentido quando o vídeo de origem não tem cabeçalho nenhum."
              marcado={config.cover.enabled}
              aoMudar={(enabled) => mudar("cover", { enabled })}
            />

            {config.cover.enabled ? (
              <>
                <Campo
                  id="cover-cor"
                  rotulo="Cor da faixa"
                  ajuda="“Detectar no vídeo” usa a cor de fundo que o próprio vídeo tiver — é a opção certa para um lote com fundos diferentes."
                >
                  <div className="space-y-2">
                    <Escolha
                      id="cover-cor"
                      valor={config.cover.color === "auto" ? "auto" : "fixa"}
                      opcoes={[
                        { valor: "auto", rotulo: "Detectar no vídeo" },
                        { valor: "fixa", rotulo: "Cor fixa" },
                      ]}
                      aoMudar={(escolha) =>
                        mudar("cover", {
                          color: escolha === "auto" ? "auto" : config.canvas.background,
                        })
                      }
                    />
                    {config.cover.color === "auto" ? null : (
                      <Cor
                        id="cover-cor-valor"
                        valor={config.cover.color}
                        aoMudar={(color) => mudar("cover", { color })}
                      />
                    )}
                  </div>
                </Campo>

                <Campo
                  id="extra"
                  rotulo="Ajuste da altura da faixa"
                  ajuda="Positivo invade o vídeo; negativo deixa uma sobra do cabeçalho antigo aparecendo."
                >
                  <Numero
                    id="extra"
                    valor={config.cover.extra_px}
                    minimo={-200}
                    maximo={400}
                    sufixo="px"
                    aoMudar={(extra_px) => mudar("cover", { extra_px })}
                  />
                </Campo>
              </>
            ) : null}
          </Secao>
        </div>

        <div className="order-1 lg:order-2">
          <div className="lg:sticky lg:top-6">
            <Previa
              estado={previa}
              aoTentarDeNovo={() => {
                if (amostra) void pedirPrevia(config, amostra.projeto, amostra.video);
              }}
            />

            {amostras.length === 0 ? (
              <p className="text-muted-foreground mt-4 text-center text-xs">
                Envie um vídeo em algum projeto para ver a prévia deste template.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                <Campo id="amostra-projeto" rotulo="Projeto de amostra">
                  <Escolha
                    id="amostra-projeto"
                    valor={amostra?.projeto ?? ""}
                    opcoes={amostras.map((a) => ({
                      valor: a.projetoId,
                      rotulo: a.projetoNome,
                    }))}
                    aoMudar={(projeto) => {
                      const grupo = amostras.find((a) => a.projetoId === projeto);
                      setAmostra({ projeto, video: grupo?.videos[0]?.id ?? null });
                    }}
                  />
                </Campo>

                {projetoAtual && projetoAtual.videos.length > 1 ? (
                  <Campo id="amostra-video" rotulo="Vídeo">
                    <Escolha
                      id="amostra-video"
                      valor={amostra?.video ?? ""}
                      opcoes={projetoAtual.videos.map((video) => ({
                        valor: video.id,
                        rotulo: video.nome,
                      }))}
                      aoMudar={(video) =>
                        setAmostra((atual) =>
                          atual ? { ...atual, video } : atual,
                        )
                      }
                    />
                  </Campo>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const DEBOUNCE_MS = 600;
const INTERVALO_MS = 1000;
const ESPERA_MAXIMA_MS = 90_000;

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

type Resposta = Record<string, unknown> & { erro?: string };

async function postJson(url: string, corpo: unknown): Promise<Resposta> {
  try {
    const resposta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    return await ler(resposta);
  } catch {
    return { erro: "Não conseguimos falar com o servidor. Tente de novo." };
  }
}

async function getJson(url: string): Promise<Resposta> {
  try {
    const resposta = await fetch(url, { cache: "no-store" });
    return await ler(resposta);
  } catch {
    return { erro: "Não conseguimos falar com o servidor. Tente de novo." };
  }
}

async function ler(resposta: Response): Promise<Resposta> {
  let dados: unknown = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  if (!resposta.ok) {
    const mensagem =
      dados && typeof dados === "object" && "erro" in dados
        ? String((dados as { erro: unknown }).erro)
        : "Não conseguimos falar com o servidor. Tente de novo.";
    return { erro: mensagem };
  }

  return (dados ?? {}) as Resposta;
}
