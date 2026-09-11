"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  RotateCcwIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { bytesEmTexto } from "@/lib/formato";
import { extensaoAceita, FORMATOS_EM_TEXTO } from "@/lib/video/codecs";

/**
 * O envio em lote.
 *
 * O arquivo vai do navegador **direto para o R2**; este componente só conversa
 * com duas rotas nossas, e nenhuma delas recebe bytes de vídeo:
 *
 *   1. `POST /api/uploads/assinar`   → autorização de PUT para uma chave
 *   2. `PUT <url do R2>`             → o arquivo, sem passar pela Vercel
 *   3. `POST /api/uploads/confirmar` → o servidor sonda o codec e registra
 *
 * **`XMLHttpRequest`, e não `fetch`.** Não é legado: `fetch` não reporta
 * progresso de ENVIO em navegador nenhum de forma utilizável — o corpo em
 * fluxo exige HTTP/2 e `duplex: "half"`, que o Safari não tem. Sem progresso,
 * mandar 400 MB é uma tela parada por vários minutos, e tela parada é tela que
 * o usuário recarrega no meio. O `xhr.abort()` ainda dá o "Cancelar" de graça.
 */

type Estado =
  | "esperando"
  | "assinando"
  | "enviando"
  | "confirmando"
  | "pronto"
  | "recusado"
  | "erro"
  | "cancelado";

type Item = {
  id: string;
  nome: string;
  bytes: number;
  estado: Estado;
  progresso: number;
  mensagem?: string;
  /**
   * Preenchida quando o arquivo JÁ SUBIU para o R2.
   *
   * É o que permite que "Tentar de novo" refaça só a confirmação, sem mandar
   * os bytes outra vez. Sem isso, uma falha de servidor na confirmação deixava
   * um arquivo pago no bucket que ninguém conseguia mais registrar — e o
   * usuário reenviava os mesmos 400 MB.
   */
  chave?: string;
  /**
   * Vale a pena tentar de novo?
   *
   * Falha de rede, de servidor ou de confirmação: sim — a próxima tentativa
   * pode dar certo, e se o arquivo já subiu ela nem reenvia os bytes. Formato
   * errado, arquivo grande demais, cota estourada: não — tentar de novo daria
   * exatamente o mesmo resultado, e um botão que não resolve nada é pior que
   * botão nenhum.
   */
  podeTentar?: boolean;
};

/**
 * Três de cada vez.
 *
 * Um de cada vez desperdiça banda; todos de uma vez brigam entre si pela mesma
 * conexão e fazem cada barra andar em soluços — além de gastar o limite de 60
 * assinaturas por hora em rajada.
 */
const SIMULTANEOS = 3;

export function EnviarVideos({
  projeto,
  bytesPorArquivo,
  vagas,
  maxMb,
  nomeDoPlano,
}: {
  projeto: string;
  bytesPorArquivo: number;
  /** Quantos vídeos ainda cabem na cota do período. */
  vagas: number;
  maxMb: number;
  nomeDoPlano: string;
}) {
  const router = useRouter();
  const [fila, setFila] = useState<Item[]>([]);
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const entradaRef = useRef<HTMLInputElement>(null);
  const cancelamentos = useRef(new Map<string, () => void>());
  /** O `File` de cada item, para "Tentar de novo" não precisar do disco. */
  const arquivos = useRef(new Map<string, File>());

  /**
   * Quantas vagas da cota já foram gastas por esta tela e o servidor ainda não
   * contou.
   *
   * `vagas` chega como prop, calculada no servidor. Entre o último vídeo
   * confirmar e o `router.refresh()` voltar com o número novo existe uma
   * janela, e nela a fila local já foi esvaziada — quem soltasse mais arquivos
   * ali reservaria vagas que não existem mais.
   *
   * É estado, e não `ref`, porque a TELA também precisa ler o número: a faixa
   * de envio anuncia quantos vídeos restam, e ela tem que dizer o mesmo que
   * `receber` usa para decidir.
   */
  const [gastasAqui, setGastasAqui] = useState(0);

  // Zerar quando `vagas` muda é o servidor avisando que já contou. O ajuste
  // acontece durante o render, que é o lugar que o React indica para estado
  // derivado de prop — dentro de um efeito ele causaria um render a mais e a
  // tela piscaria o número velho.
  const [vagasVistas, setVagasVistas] = useState(vagas);
  if (vagasVistas !== vagas) {
    setVagasVistas(vagas);
    setGastasAqui(0);
  }

  /**
   * A fila vive num `ref` E num estado, de propósito.
   *
   * O estado é o que a tela desenha. O `ref` é o que o código LÊ enquanto o
   * lote roda — e ele precisa existir porque contar quantos itens já reservaram
   * vaga na cota é uma leitura que acontece no meio de uma função assíncrona,
   * onde o `fila` capturado pelo closure já está velho. Lendo do estado, soltar
   * dez arquivos e logo depois mais cinco faria a segunda leva contar as vagas
   * como se a primeira não existisse.
   */
  const filaRef = useRef<Item[]>([]);

  const aplicar = useCallback((mudar: (atual: Item[]) => Item[]) => {
    filaRef.current = mudar(filaRef.current);
    setFila(filaRef.current);
  }, []);

  const atualizar = useCallback(
    (id: string, mudanca: Partial<Item>) => {
      aplicar((atual) =>
        atual.map((item) => (item.id === id ? { ...item, ...mudanca } : item)),
      );
    },
    [aplicar],
  );

  const confirmarUm = useCallback(
    async (id: string, chave: string, nome: string) => {
      atualizar(id, { estado: "confirmando", progresso: 100, chave });

      const confirmacao = await postJson("/api/uploads/confirmar", {
        projeto,
        chave,
        nome,
      });

      if (confirmacao.erro) {
        atualizar(id, {
          estado: "erro",
          podeTentar: valeTentarDeNovo(confirmacao.http),
          mensagem: confirmacao.erro,
        });
        return;
      }
      if (confirmacao.status === "rejected") {
        atualizar(id, {
          estado: "recusado",
          mensagem: (confirmacao.motivo as string) ?? "Arquivo recusado.",
        });
        return;
      }

      setGastasAqui((n) => n + 1);
      atualizar(id, { estado: "pronto" });
    },
    [atualizar, projeto],
  );

  /**
   * Fim de rodada: o servidor já tem as linhas novas.
   *
   * O `refresh` redesenha a lista de baixo (server component) com os dados de
   * verdade, e os itens que viraram linha saem da fila local para não
   * aparecerem duas vezes na tela.
   */
  const fechar = useCallback(() => {
    router.refresh();
    aplicar((atual) => {
      const sobram = atual.filter(
        (i) => i.estado !== "pronto" && i.estado !== "recusado",
      );
      // Sem esta limpeza, o `File` de cada envio concluído ficaria preso na
      // memória da aba até ela ser fechada — e um lote de cinco vídeos de
      // 500 MB são 2,5 GB de referência viva por lote enviado.
      const vivos = new Set(sobram.map((i) => i.id));
      for (const id of arquivos.current.keys()) {
        if (!vivos.has(id)) arquivos.current.delete(id);
      }
      for (const id of cancelamentos.current.keys()) {
        if (!vivos.has(id)) cancelamentos.current.delete(id);
      }
      return sobram;
    });
  }, [aplicar, router]);

  const enviarUm = useCallback(
    async (arquivo: File, id: string) => {
      try {
        arquivos.current.set(id, arquivo);
        atualizar(id, { estado: "assinando" });

        const assinatura = await postJson("/api/uploads/assinar", {
          projeto,
          nome: arquivo.name,
          bytes: arquivo.size,
        });
        if (assinatura.erro) {
          atualizar(id, {
            estado: "erro",
            podeTentar: valeTentarDeNovo(assinatura.http),
            mensagem: assinatura.erro,
          });
          return;
        }

        atualizar(id, { estado: "enviando", progresso: 0 });
        const enviado = await putNoR2(assinatura, arquivo, {
          aoProgredir: (pct) => atualizar(id, { progresso: pct }),
          registrarCancelamento: (cancelar) => cancelamentos.current.set(id, cancelar),
        });

        cancelamentos.current.delete(id);

        if (enviado === "cancelado") {
          atualizar(id, {
            estado: "cancelado",
            podeTentar: true,
            mensagem: "Envio cancelado.",
          });
          return;
        }
        if (enviado !== "ok") {
          atualizar(id, { estado: "erro", podeTentar: true, mensagem: enviado });
          return;
        }

        await confirmarUm(id, assinatura.chave as string, arquivo.name);
      } catch (erro) {
        atualizar(id, {
          estado: "erro",
          podeTentar: true,
          mensagem:
            erro instanceof Error && erro.message
              ? erro.message
              : "Não foi possível enviar. Tente de novo.",
        });
      }
    },
    [atualizar, confirmarUm, projeto],
  );

  /**
   * Tira da fila um item que não vai a lugar nenhum.
   *
   * Arrastar três PDFs por engano deixava três linhas vermelhas na tela sem
   * nenhum jeito de fechá-las: `fechar()` só poda o que deu certo, e para elas
   * não há "Tentar de novo" porque tentar daria o mesmo resultado.
   */
  const dispensar = useCallback(
    (id: string) => {
      arquivos.current.delete(id);
      cancelamentos.current.delete(id);
      aplicar((atual) => atual.filter((item) => item.id !== id));
    },
    [aplicar],
  );

  const receber = useCallback(
    async (arquivos: File[]) => {
      if (arquivos.length === 0) return;

      // A conferência local é cortesia, não segurança: ela evita subir 400 MB
      // para o servidor recusar no fim. Quem decide de verdade é a assinatura
      // (que trava tipo e tamanho) e a sondagem de codec na confirmação.
      let restantes = vagas - gastasAqui - contarOcupando(filaRef.current);

      const novos: Item[] = arquivos.map((arquivo) => {
        const base: Item = {
          id: crypto.randomUUID(),
          nome: arquivo.name,
          bytes: arquivo.size,
          estado: "esperando",
          progresso: 0,
        };

        if (!extensaoAceita(arquivo.name)) {
          return {
            ...base,
            estado: "erro",
            podeTentar: false,
            mensagem: `Formato não aceito. Envie ${FORMATOS_EM_TEXTO}.`,
          };
        }
        if (arquivo.size === 0) {
          return {
            ...base,
            estado: "erro",
            podeTentar: false,
            mensagem: "O arquivo está vazio.",
          };
        }
        if (arquivo.size > bytesPorArquivo) {
          return {
            ...base,
            estado: "erro",
            podeTentar: false,
            mensagem: `Tem ${bytesEmTexto(arquivo.size)} e o limite do plano ${nomeDoPlano} é ${maxMb} MB por vídeo.`,
          };
        }
        if (restantes <= 0) {
          return {
            ...base,
            estado: "erro",
            podeTentar: false,
            mensagem: "Não há mais cota de vídeos no seu plano neste período.",
          };
        }

        restantes -= 1;
        return base;
      });

      aplicar((atual) => [...atual, ...novos]);
      setEnviando(true);

      const aFazer = novos
        .map((item, indice) => ({ item, arquivo: arquivos[indice] }))
        .filter(({ item }) => item.estado === "esperando");

      await emParalelo(aFazer, SIMULTANEOS, ({ item, arquivo }) =>
        enviarUm(arquivo, item.id),
      );

      setEnviando(false);
      fechar();
    },
    [aplicar, bytesPorArquivo, enviarUm, fechar, gastasAqui, maxMb, nomeDoPlano, vagas],
  );

  /**
   * Tentar de novo.
   *
   * Se o arquivo já chegou ao R2 — o erro foi na confirmação —, refaz só a
   * confirmação, com a MESMA chave. É o caso que importa: o servidor guarda o
   * objeto de propósito quando falha por conta própria, e sem este botão aquele
   * arquivo ficava inalcançável até o lifecycle de 30 dias passar, enquanto o
   * usuário reenviava tudo de novo.
   */
  const tentarDeNovo = useCallback(
    async (item: Item) => {
      setEnviando(true);
      atualizar(item.id, { mensagem: undefined, progresso: 0 });

      if (item.chave) {
        await confirmarUm(item.id, item.chave, item.nome);
      } else {
        const arquivo = arquivos.current.get(item.id);
        if (!arquivo) {
          atualizar(item.id, {
            estado: "erro",
            mensagem: "Escolha o arquivo de novo para reenviar.",
          });
          setEnviando(false);
          return;
        }
        await enviarUm(arquivo, item.id);
      }

      setEnviando(false);
      fechar();
    },
    [atualizar, confirmarUm, enviarUm, fechar],
  );

  // O que a TELA anuncia precisa ser o mesmo número que `receber` usa para
  // decidir. Usar a prop crua faria a faixa dizer "3 vídeos restantes" logo
  // depois de três terem sido confirmados, e aceitar arquivos que erram na hora.
  const vagasNaTela = Math.max(vagas - gastasAqui - contarOcupando(fila), 0);
  const semCota = vagasNaTela <= 0;

  return (
    <div className="mb-8">
      <div
        onDragOver={(evento) => {
          evento.preventDefault();
          if (!semCota) setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(evento) => {
          evento.preventDefault();
          setArrastando(false);
          if (semCota) return;
          void receber(Array.from(evento.dataTransfer.files));
        }}
        className={[
          "rounded-xl border-2 border-dashed p-8 text-center transition-colors",
          arrastando ? "border-primary bg-primary/5" : "border-muted-foreground/25",
          semCota ? "opacity-60" : "",
        ].join(" ")}
      >
        <UploadIcon className="text-muted-foreground mx-auto size-7" />

        {semCota ? (
          <p className="mt-3 text-sm font-medium">
            Você usou toda a cota de vídeos do plano {nomeDoPlano} neste período.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm font-medium">
              Arraste os vídeos aqui ou escolha no computador
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {FORMATOS_EM_TEXTO} · até {maxMb} MB por arquivo · {vagasNaTela}{" "}
              {vagasNaTela === 1 ? "vídeo restante" : "vídeos restantes"} na cota
            </p>

            <Button
              type="button"
              variant="outline"
              className="mt-4"
              disabled={enviando}
              onClick={() => entradaRef.current?.click()}
            >
              Escolher arquivos
            </Button>
          </>
        )}

        <input
          ref={entradaRef}
          type="file"
          multiple
          accept=".mp4,.mov,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska"
          className="hidden"
          onChange={(evento) => {
            const arquivos = Array.from(evento.target.files ?? []);
            // Zerar o valor faz o `change` disparar de novo se a pessoa
            // escolher exatamente os mesmos arquivos depois de um erro.
            evento.target.value = "";
            void receber(arquivos);
          }}
        />
      </div>

      {fila.length > 0 ? (
        <ul aria-label="Envios em andamento" className="mt-4 space-y-2">
          {fila.map((item) => (
            <li
              key={item.id}
              className="bg-card flex items-center gap-3 rounded-lg border px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{item.nome}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {bytesEmTexto(item.bytes)}
                  </span>
                </div>

                {item.estado === "enviando" || item.estado === "confirmando" ? (
                  <div
                    role="progressbar"
                    aria-valuenow={item.progresso}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Enviando ${item.nome}`}
                    className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
                  >
                    <div
                      className="bg-primary h-full transition-[width] duration-200"
                      style={{ width: `${item.progresso}%` }}
                    />
                  </div>
                ) : null}

                <p className="text-muted-foreground mt-1 text-xs">
                  {item.mensagem ?? TEXTO_DO_ESTADO[item.estado]}
                </p>
              </div>

              {item.estado === "erro" || item.estado === "recusado" ? (
                <AlertCircleIcon className="text-destructive size-4 shrink-0" />
              ) : null}
              {item.estado === "pronto" ? (
                <CheckCircle2Icon className="text-primary size-4 shrink-0" />
              ) : null}

              {item.estado === "enviando" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Cancelar o envio de ${item.nome}`}
                  onClick={() => cancelamentos.current.get(item.id)?.()}
                >
                  <XIcon />
                </Button>
              ) : null}

              {(item.estado === "erro" || item.estado === "cancelado") &&
              !item.podeTentar ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Tirar ${item.nome} da lista`}
                  onClick={() => dispensar(item.id)}
                >
                  <XIcon />
                </Button>
              ) : null}

              {item.podeTentar ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={enviando}
                  aria-label={`Tentar enviar ${item.nome} de novo`}
                  onClick={() => void tentarDeNovo(item)}
                >
                  <RotateCcwIcon />
                  Tentar de novo
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const TEXTO_DO_ESTADO: Record<Estado, string> = {
  esperando: "Na fila",
  assinando: "Preparando o envio…",
  enviando: "Enviando…",
  confirmando: "Conferindo o arquivo…",
  pronto: "Enviado",
  recusado: "Recusado",
  erro: "Não enviado",
  cancelado: "Cancelado",
};

/**
 * Itens da fila local que ainda vão reservar uma vaga da cota.
 *
 * `pronto` NÃO entra: quem contabiliza o que já foi confirmado é `gastasAqui`,
 * e contar nos dois lugares reservaria a mesma vaga duas vezes na janela entre
 * o vídeo confirmar e a fila ser esvaziada.
 */
function contarOcupando(fila: Item[]): number {
  const gastam: Estado[] = ["esperando", "assinando", "enviando", "confirmando"];
  return fila.filter((item) => gastam.includes(item.estado)).length;
}

type Resposta = Record<string, unknown> & { erro?: string; http: number };

async function postJson(url: string, corpo: unknown): Promise<Resposta> {
  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  } catch {
    // A requisição nem saiu: rede caída, aba offline. `http: 0` diz isso a
    // quem decide se vale tentar de novo — e vale.
    return { erro: "Não conseguimos falar com o servidor. Tente de novo.", http: 0 };
  }

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
    return { erro: mensagem, http: resposta.status };
  }

  return { ...((dados ?? {}) as Record<string, unknown>), http: resposta.status };
}

/**
 * Vale a pena tentar de novo depois deste código HTTP?
 *
 * Só onde a próxima tentativa pode dar outro resultado: rede que caiu (0),
 * limite de taxa (429) e falha nossa (5xx). **Não** nos 4xx de decisão — e o
 * caso que obriga esta distinção é o 409 de cota estourada: ali o servidor já
 * APAGOU o objeto do bucket, então a retentativa confirma uma chave morta,
 * leva 404 e rearma o botão para sempre.
 */
function valeTentarDeNovo(http: number): boolean {
  return http === 0 || http === 429 || http >= 500;
}

type Assinatura = { url: string; cabecalhos: Record<string, string> };

function putNoR2(
  assinatura: Record<string, unknown>,
  arquivo: File,
  opcoes: {
    aoProgredir: (pct: number) => void;
    registrarCancelamento: (cancelar: () => void) => void;
  },
): Promise<"ok" | "cancelado" | string> {
  const { url, cabecalhos } = assinatura as unknown as Assinatura;

  return new Promise((resolver) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);

    for (const [nome, valor] of Object.entries(cabecalhos ?? {})) {
      xhr.setRequestHeader(nome, valor);
    }

    xhr.upload.onprogress = (evento) => {
      if (!evento.lengthComputable) return;
      opcoes.aoProgredir(Math.round((evento.loaded / evento.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolver("ok");

      // 412 é a escrita condicional dizendo "essa chave já existe". Numa
      // repetição do PUT — a resposta do primeiro se perdeu, a pessoa clicou
      // em "Tentar de novo" — isso não é falha: o arquivo ESTÁ lá, e o que
      // falta é confirmar. Tratar como erro mandaria reenviar bytes que já
      // chegaram.
      if (xhr.status === 412) return resolver("ok");

      if (xhr.status === 403) {
        // A assinatura vale 15 minutos e trava tipo e tamanho. Um 403 aqui é,
        // quase sempre, o arquivo tendo mudado no disco entre escolher e
        // enviar, ou a janela tendo passado numa conexão muito lenta.
        return resolver(
          "O envio não foi autorizado. Isso acontece quando o arquivo muda " +
            "depois de escolhido ou quando a autorização expira. Tente de novo.",
        );
      }
      resolver(`O armazenamento recusou o envio (erro ${xhr.status}). Tente de novo.`);
    };

    xhr.onerror = () =>
      resolver("A conexão caiu durante o envio. Confira a internet e tente de novo.");
    xhr.ontimeout = () => resolver("O envio demorou demais e foi interrompido.");
    xhr.onabort = () => resolver("cancelado");

    opcoes.registrarCancelamento(() => xhr.abort());
    xhr.send(arquivo);
  });
}

/** Roda `tarefa` sobre `itens` com no máximo `limite` em voo ao mesmo tempo. */
async function emParalelo<T>(
  itens: T[],
  limite: number,
  tarefa: (item: T) => Promise<void>,
): Promise<void> {
  let proximo = 0;

  const trabalhador = async () => {
    while (proximo < itens.length) {
      const meu = itens[proximo];
      proximo += 1;
      await tarefa(meu);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limite, itens.length) }, trabalhador),
  );
}
