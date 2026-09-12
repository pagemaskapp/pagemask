"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FilmIcon } from "lucide-react";

import { AcoesDoVideo } from "@/app/app/projetos/[id]/acoes-do-video";
import { PainelDeEntrega } from "@/app/app/projetos/[id]/painel-de-entrega";
import { ProcessarSelecionados } from "@/app/app/projetos/[id]/processar-selecionados";
import { Card, CardContent } from "@/components/ui/card";
import { numero } from "@/lib/formato";
import { createRealtimeClient } from "@/lib/supabase/realtime";
import type { JobStatus } from "@/lib/supabase/database.types";

/**
 * A lista de vídeos, com progresso ao vivo.
 *
 * DUAS FONTES, DE PROPÓSITO
 * =========================
 *
 * 1. **Realtime** (Supabase), quando há credencial. É o caminho rápido: cada
 *    `UPDATE` em `jobs` chega em milissegundos e a barra anda de verdade.
 * 2. **Recarga periódica**, sempre. Enquanto houver job andando, um
 *    `router.refresh()` traz a verdade do servidor — a cada 8 s, dobrando até
 *    1 minuto enquanto nada mudar.
 *
 * A segunda não é redundância nervosa. O WebSocket cai, a aba dorme quando o
 * sistema suspende — e, sem credencial (`SUPABASE_JWT_SECRET` não
 * configurada), o Realtime nem começa. Em todos esses casos a tela continua
 * convergindo; ela só fica mais lenta. Uma barra de progresso que congela é
 * indistinguível, para quem olha, de um worker que morreu.
 *
 * Por que o cliente do Realtime é um à parte (`@/lib/supabase/realtime`) e não
 * o `@/lib/supabase/browser`: o segundo devolveria a chave `anon` ao
 * `realtime-js` no primeiro heartbeat e a inscrição pararia de receber
 * qualquer coisa, sem erro nenhum. O porquê completo está lá.
 *
 * O MERGE NUNCA ANDA PARA TRÁS
 * ============================
 *
 * As duas fontes correm juntas, e a recarga é mais velha que o Realtime por
 * construção (ela viajou até o servidor e voltou). Aplicá-la por cima faria a
 * barra pular de 62% para 48% — que o usuário lê como defeito. Por isso, na
 * recarga, linha de mesmo status mantém o MAIOR progresso.
 */

export type VideoNaTela = {
  id: string;
  nome: string;
  status: JobStatus;
  progresso: number;
  erro: string | null;
  temSaida: boolean;
  /**
   * O vídeo tem um SRT gravado (`jobs.r2_srt_key`). É o que decide se o botão
   * de legenda aparece — e ele só existe depois que o worker transcreveu, ou
   * seja, depois do primeiro render com legenda ligada no template.
   */
  temLegenda: boolean;
  /** Já formatados no servidor: o cliente não precisa do `probe` inteiro. */
  tamanho: string;
  detalhe: string;
  /**
   * Quando o Realtime alterou esta linha pela última vez. Só do cliente — o
   * servidor nunca preenche. É o que permite saber, na recarga, se o que está
   * na tela é mais novo do que o que voltou do servidor.
   */
  patchEm?: number;
};

const ESTADOS: Record<JobStatus, { texto: string; classe: string }> = {
  uploaded: { texto: "Enviado", classe: "bg-muted text-muted-foreground" },
  queued: { texto: "Na fila", classe: "bg-muted text-muted-foreground" },
  processing: { texto: "Processando", classe: "bg-primary/15 text-primary" },
  done: { texto: "Pronto", classe: "bg-primary/15 text-primary" },
  failed: { texto: "Falhou", classe: "bg-destructive/10 text-destructive" },
  rejected: { texto: "Recusado", classe: "bg-destructive/10 text-destructive" },
  canceled: { texto: "Cancelado", classe: "bg-muted text-muted-foreground" },
};

const ANDANDO: ReadonlySet<JobStatus> = new Set<JobStatus>(["queued", "processing"]);

/**
 * Os tres grupos da Fase 7: concluidos, com falha, pendentes.
 *
 * `rejected` fica em "com falha" porque e assim que o usuario le a tela — o
 * video nao saiu. Ele NAO entra no botao de reprocessar: arquivo recusado teve
 * a entrada apagada (Fase 2) e nao ha o que reprocessar. Por isso a contagem
 * do botao e outra (`reprocessaveis`), e so de `failed`.
 */
const GRUPOS = {
  prontos: ["done"],
  falhados: ["failed", "rejected", "canceled"],
  pendentes: ["uploaded", "queued", "processing"],
} as const satisfies Record<string, readonly JobStatus[]>;

/**
 * Os tres grupos precisam cobrir o enum INTEIRO, e esta linha é quem cobra.
 *
 * Um status fora deles não daria erro nenhum em tempo de execução: o vídeo
 * apareceria em "Todos" e em aba nenhuma — invisível justamente para quem está
 * filtrando. `Exclude` sobra vazio quando tudo está coberto, e `never` é o
 * único tipo que o parâmetro aceita; um status novo no enum quebra o build
 * aqui, que é onde a correção é barata.
 */
type Coberto = (typeof GRUPOS)[keyof typeof GRUPOS][number];
type SemSobra<T extends never> = T;
export type _TodosOsStatusTemAba = SemSobra<Exclude<JobStatus, Coberto>>;

type Filtro = "todos" | keyof typeof GRUPOS;

/**
 * `GRUPOS.x.includes(status)` não compila sozinho: com `as const` cada grupo é
 * uma tupla de literais, e `includes` então só aceita os literais daquele
 * grupo. A função alarga o parâmetro — que é o que permite perguntar por um
 * `JobStatus` qualquer sem perder a checagem de cobertura acima.
 */
function noGrupo(grupo: readonly JobStatus[], status: JobStatus): boolean {
  return grupo.includes(status);
}

const ABAS: { chave: Filtro; texto: string }[] = [
  { chave: "todos", texto: "Todos" },
  { chave: "prontos", texto: "Concluídos" },
  { chave: "falhados", texto: "Com falha" },
  { chave: "pendentes", texto: "Pendentes" },
];

const RECARGA_MS = 8000;
const RECARGA_MAXIMA_MS = 60000;

type Patch = {
  status?: JobStatus;
  progress?: number;
  error?: string | null;
  r2_output_key?: string | null;
  r2_srt_key?: string | null;
};

export function ListaDeVideos({
  projeto,
  videos,
}: {
  projeto: string;
  videos: VideoNaTela[];
}) {
  const router = useRouter();
  const [lista, setLista] = useState(videos);
  const [servidor, setServidor] = useState(videos);
  /** Quando o último `router.refresh()` foi PEDIDO. Ver `juntar`. */
  const [pedidoEm, setPedidoEm] = useState(0);
  /**
   * A seleção para "processar só estes".
   *
   * O estado guarda a INTENÇÃO (o que foi marcado); quem vale é a lista
   * filtrada logo antes do render, contra o estado atual de cada vídeo. Só
   * `uploaded` pode ser processado, e a mudança para `queued` chega pelo
   * Realtime, sem passar pelas props — podar num efeito ou no ajuste de prop
   * deixaria a barra contando vídeos que já entraram na fila, e o botão
   * mandaria uma lista que o servidor ignora inteira ("nenhum vídeo novo para
   * processar" depois de um clique que parecia certo).
   */
  const [selecionados, setSelecionados] = useState<string[]>([]);
  const [filtro, setFiltro] = useState<Filtro>("todos");

  // Padrão do React para "ajustar estado quando a prop muda", sem `useEffect`:
  // roda no próprio render, então a tela nunca pisca com o valor velho.
  if (servidor !== videos) {
    setServidor(videos);
    setLista((atual) => juntar(videos, atual, pedidoEm));
  }

  const temTrabalho = lista.some((v) => ANDANDO.has(v.status));

  // --- rede de segurança: recarrega enquanto houver job andando ------------
  //
  // Com recuo. O caso que obriga a isso é um aberto: worker parado (ou fila
  // longa) e a aba esquecida aberta a noite inteira. Num intervalo fixo de 8 s
  // isso são ~10.800 renderizações da página no servidor para mostrar a mesma
  // tela. O intervalo dobra a cada recarga que não traz novidade, até 1 minuto,
  // e volta para 8 s no instante em que alguma coisa muda — que é quando a
  // pessoa está de fato olhando.
  const assinatura = lista.map((v) => `${v.id}:${v.status}:${v.progresso}`).join("|");

  useEffect(() => {
    if (!temTrabalho) return;

    let paradas = 0;
    let timer: ReturnType<typeof setTimeout>;

    const agendar = () => {
      const espera = Math.min(RECARGA_MS * 2 ** paradas, RECARGA_MAXIMA_MS);
      timer = setTimeout(() => {
        paradas += 1;
        setPedidoEm(Date.now());
        router.refresh();
        agendar();
      }, espera);
    };

    agendar();
    return () => clearTimeout(timer);
    // `assinatura` na lista de dependências é o que reinicia o recuo: quando o
    // conteúdo muda, este efeito é refeito e `paradas` volta a zero.
  }, [temTrabalho, assinatura, router]);

  // --- caminho rápido: Realtime ------------------------------------------
  // O efeito do Realtime não pode depender de `lista` (recriaria a inscrição a
  // cada tique de progresso), mas precisa consultá-la. A gravação fica num
  // efeito, e não no corpo do render: escrever em ref durante o render quebra
  // o modo estrito do React e a regra `react-hooks/refs`.
  const listaRef = useRef(lista);
  useEffect(() => {
    listaRef.current = lista;
  }, [lista]);

  useEffect(() => {
    let vivo = true;
    let guardado: { token: string; expira_em: number } | null = null;
    let agrupador: ReturnType<typeof setTimeout> | undefined;

    /**
     * O token de 5 minutos, buscado sob demanda.
     *
     * Não há temporizador de renovação: quem pergunta é o próprio
     * `supabase-js`, na conexão e a cada heartbeat (ver
     * `@/lib/supabase/realtime`). Aqui só se guarda o último e se busca outro
     * quando faltar menos de um minuto para vencer.
     */
    async function tokenAtual(): Promise<string | null> {
      const agora = Date.now() / 1000;
      if (guardado && guardado.expira_em - agora > 60) return guardado.token;

      const resposta = await fetch("/api/realtime/credencial", { cache: "no-store" });
      // 204 = projeto sem `SUPABASE_JWT_SECRET`. Não é erro: é o modo sem
      // Realtime, e a recarga periódica já cobre a tela.
      if (resposta.status === 204 || !resposta.ok) return null;

      const dados = (await resposta.json()) as { token: string; expira_em: number };
      if (!dados?.token) return null;

      guardado = dados;
      return dados.token;
    }

    let supabase: ReturnType<typeof createRealtimeClient> | null = null;

    (async () => {
      // A credencial é pedida ANTES de o cliente existir. Criá-lo primeiro
      // custaria uma segunda ida ao servidor à toa: o `supabase-js` chama o
      // callback de token já na construção.
      const primeiro = await tokenAtual().catch(() => null);
      // Sem credencial não se abre socket nenhum: conectar como `anon` seria
      // manter uma conexão aberta para não receber nada.
      if (!vivo || primeiro === null) return;

      supabase = createRealtimeClient(tokenAtual);

      supabase
        .channel(`jobs-do-projeto-${projeto}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "jobs",
            // O filtro é do servidor: sem ele, o navegador receberia os
            // eventos de TODOS os projetos do usuário e descartaria a maioria.
            filter: `project_id=eq.${projeto}`,
          },
          (evento) => {
            if (!vivo) return;

            // Na prática este ramo quase nunca roda, e isso está certo: com
            // `replica identity default`, o registro antigo de um DELETE só
            // tem a chave primária, então o filtro `project_id=eq.…` o
            // descarta antes de chegar aqui (ver a migration 0016, que explica
            // por que não vale a pena mudar). Remoção some da lista pela
            // recarga periódica. O ramo fica porque é barato e porque volta a
            // funcionar sozinho se a identidade de réplica mudar um dia.
            if (evento.eventType === "DELETE") {
              const id = (evento.old as { id?: string })?.id;
              if (id) setLista((atual) => atual.filter((v) => v.id !== id));
              return;
            }

            const novo = evento.new as Patch & { id?: string };
            if (!novo?.id) return;

            // Linha que ainda não está na tela (vídeo enviado em outra aba):
            // a recarga traz os campos que o Realtime não publica.
            //
            // Agrupado, e não um `refresh()` por evento. Um lote de 50 envios
            // produz 50 INSERTs em poucos segundos, e um refresh por evento
            // seriam 50 renderizações completas da página no servidor — para
            // mostrar uma lista que uma única recarga já mostraria inteira.
            if (!listaRef.current.some((v) => v.id === novo.id)) {
              if (agrupador) clearTimeout(agrupador);
              agrupador = setTimeout(() => {
                if (!vivo) return;
                setPedidoEm(Date.now());
                router.refresh();
              }, 600);
              return;
            }

            const em = Date.now();
            setLista((atual) =>
              atual.map((v) => (v.id === novo.id ? aplicar(v, novo, em) : v)),
            );
          },
        )
        .subscribe();
    })();

    return () => {
      vivo = false;
      if (agrupador) clearTimeout(agrupador);
      // `removeAllChannels` cancela a inscrição; `disconnect` fecha o
      // WebSocket. Só o primeiro deixaria o socket aberto para sempre — e
      // navegar entre projetos abriria um por projeto visitado.
      if (supabase) {
        supabase.removeAllChannels();
        supabase.realtime.disconnect();
      }
    };
  }, [projeto, router]);

  if (lista.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <FilmIcon className="text-muted-foreground size-7" />
          <p className="text-muted-foreground text-sm">
            Nenhum vídeo neste projeto ainda.
          </p>
        </CardContent>
      </Card>
    );
  }

  const selecionaveis = lista.filter((v) => v.status === "uploaded");
  const marcados = selecionados.filter((id) =>
    selecionaveis.some((v) => v.id === id),
  );

  // Contagens tiradas da LISTA da tela, e nao do servidor: o Realtime muda o
  // status de uma linha sem recarregar a pagina, e uma contagem do servidor
  // ficaria parada em "3 concluidos" depois de o quarto terminar na frente do
  // usuario.
  const resumo = {
    prontos: lista.filter((v) => noGrupo(GRUPOS.prontos, v.status)).length,
    falhados: lista.filter((v) => noGrupo(GRUPOS.falhados, v.status)).length,
    reprocessaveis: lista.filter((v) => v.status === "failed").length,
    pendentes: lista.filter((v) => noGrupo(GRUPOS.pendentes, v.status)).length,
  };

  // A aba escolhida pode ficar vazia enquanto o lote anda (o ultimo "pendente"
  // vira "concluido"). Voltar para "todos" sozinho seria pior: a tela mudaria
  // de conteudo sem ninguem ter pedido. O vazio ganha uma frase, logo abaixo.
  const visiveis =
    filtro === "todos"
      ? lista
      : lista.filter((v) => noGrupo(GRUPOS[filtro], v.status));

  return (
    <>
      <PainelDeEntrega projeto={projeto} resumo={resumo} />

      <ProcessarSelecionados
        projeto={projeto}
        selecionados={marcados}
        aoLimpar={() => setSelecionados([])}
      />

      <div
        className="mb-3 flex flex-wrap items-center gap-1"
        role="tablist"
        aria-label="Filtrar vídeos por situação"
      >
        {ABAS.map((aba) => {
          const quantos =
            aba.chave === "todos" ? lista.length : resumo[aba.chave];
          const ativa = filtro === aba.chave;

          return (
            <button
              key={aba.chave}
              type="button"
              role="tab"
              aria-selected={ativa}
              onClick={() => setFiltro(aba.chave)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                ativa
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {aba.texto} ({numero.format(quantos)})
            </button>
          );
        })}
      </div>

      {visiveis.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground text-sm">
              Nenhum vídeo nesta situação agora.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <ul aria-label="Vídeos do projeto" className="space-y-2">
        {visiveis.map((video) => {
          const estado = ESTADOS[video.status];
          const processando = video.status === "processing";
          const selecionavel = video.status === "uploaded";

          return (
            <li
              key={video.id}
              className="bg-card flex items-center gap-4 rounded-lg border px-4 py-3"
            >
              {selecionaveis.length > 0 ? (
                <input
                  type="checkbox"
                  className="accent-primary size-4 shrink-0 disabled:opacity-0"
                  checked={marcados.includes(video.id)}
                  disabled={!selecionavel}
                  aria-label={`Selecionar ${video.nome}`}
                  onChange={(evento) =>
                    setSelecionados((atual) =>
                      evento.target.checked
                        ? [...atual, video.id]
                        : atual.filter((id) => id !== video.id),
                    )
                  }
                />
              ) : null}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{video.nome}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${estado.classe}`}
                  >
                    {estado.texto}
                  </span>
                </div>

                <p className="text-muted-foreground mt-1 text-xs">
                  {video.tamanho}
                  {video.detalhe}
                </p>

                {processando ? (
                  <div
                    className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
                    role="progressbar"
                    aria-label={`Progresso de ${video.nome}`}
                    aria-valuenow={video.progresso}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="bg-primary h-full transition-[width] duration-500"
                      style={{ width: `${video.progresso}%` }}
                    />
                  </div>
                ) : null}

                {video.erro ? (
                  <p className="text-destructive mt-1.5 text-xs">{video.erro}</p>
                ) : null}
              </div>

              <AcoesDoVideo
                video={video.id}
                projeto={projeto}
                nome={video.nome}
                podeBaixar={video.status === "done" && video.temSaida}
                devolveCota={video.status === "uploaded"}
                temLegenda={video.temLegenda}
              />
            </li>
          );
        })}
      </ul>
    </>
  );
}

function aplicar(video: VideoNaTela, patch: Patch, em: number): VideoNaTela {
  return {
    ...video,
    patchEm: em,
    status: patch.status ?? video.status,
    progresso: typeof patch.progress === "number" ? patch.progress : video.progresso,
    erro: patch.error === undefined ? video.erro : patch.error,
    temSaida: patch.r2_output_key === undefined
      ? video.temSaida
      : Boolean(patch.r2_output_key),
    // O botão de legenda aparece assim que o worker grava o SRT — antes de o
    // render terminar. É deliberado: o SRT é gravado ANTES do render (ver
    // `worker/src/servico/trabalho.py`), e quem vê a transcrição sair errada
    // pode já abrir o editor em vez de esperar um vídeo que vai ser refeito.
    temLegenda: patch.r2_srt_key === undefined
      ? video.temLegenda
      : Boolean(patch.r2_srt_key),
  };
}

/**
 * Junta o que veio do servidor com o que já está na tela, sem andar para trás.
 *
 * O SERVIDOR NEM SEMPRE É O MAIS NOVO, e essa é a sutileza inteira. A recarga
 * leva um tempo entre ser pedida e voltar; o Realtime, nesse meio-tempo, pode
 * ter entregado uma mudança mais recente. O caso concreto que isto conserta:
 * o progresso fica parado em 99% durante a validação e o upload, que é
 * exatamente quando o temporizador de 8 s dispara — então a resposta "ainda
 * está em `processing`" chega DEPOIS de o Realtime já ter dito `done`, e a
 * linha voltava de "Pronto" para "Processando" na cara do usuário.
 *
 * A regra é de recência, e não de sentido: linha que recebeu patch do Realtime
 * depois de a recarga ter sido PEDIDA é mais nova que a resposta, e fica.
 * Linha sem patch nesse intervalo aceita o servidor — que é o que mantém o
 * modo sem Realtime funcionando, e o que deixa um job voltar de `processing`
 * para `queued` quando o zelador o devolve.
 */
function juntar(
  doServidor: VideoNaTela[],
  naTela: VideoNaTela[],
  pedidoEm: number,
): VideoNaTela[] {
  const anterior = new Map(naTela.map((v) => [v.id, v]));

  return doServidor.map((novo) => {
    const velho = anterior.get(novo.id);
    if (!velho) return novo;

    if ((velho.patchEm ?? 0) > pedidoEm) return velho;

    if (velho.status !== novo.status) return novo;
    return { ...novo, progresso: Math.max(novo.progresso, velho.progresso) };
  });
}
