"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, GripVerticalIcon, Loader2Icon } from "lucide-react";

import { cancelarAgendamento, reagendar } from "@/app/app/agenda/acoes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DIAS_CURTOS, lerChaveDoDia } from "@/lib/agenda/fuso";
import { EDITAVEIS, ESTADOS_DA_AGENDA } from "@/lib/agenda/mensagens";
import type { ScheduleStatus } from "@/lib/supabase/database.types";

export type DiaDaGrade = {
  /** `YYYY-MM-DD` no fuso da tela. */
  chave: string;
  numero: number;
  /** Fora do mês em foco (os dias de enchimento da grade). */
  doMes: boolean;
  passado: boolean;
};

export type ItemDaAgenda = {
  id: string;
  dia: string;
  hora: string;
  quandoIso: string;
  video: string;
  username: string;
  status: ScheduleStatus;
  erro: string | null;
  permalink: string | null;
  legenda: string | null;
};

/**
 * O calendário, com arrastar-e-soltar nativo.
 *
 * ARRASTAR MUDA O DIA E MANTÉM A HORA
 * ===================================
 *
 * Soltar um item em outro dia chama `reagendar` com a mesma `HH:mm`. Para
 * mudar a hora existe o campo no detalhe. A tela é otimista — o item pula para
 * o dia novo na hora — e volta atrás se o servidor recusar, com a mensagem.
 *
 * Só `scheduled` e `deferred` são arrastáveis (EDITAVEIS): `publishing` está
 * com o worker e `published`/`failed` são história. A RLS cobra o mesmo
 * (migration 0019); aqui é só para o cursor não prometer o que o banco nega.
 */
export function Calendario({
  visao,
  dias,
  itens,
  hoje,
}: {
  visao: "mes" | "semana";
  dias: DiaDaGrade[];
  itens: ItemDaAgenda[];
  hoje: string;
}) {
  const router = useRouter();
  const [lista, setLista] = useState(itens);
  const [servidor, setServidor] = useState(itens);
  // O id arrastado vive num ref, e nao so em estado: `dragover` e `drop`
  // podem chegar antes de o React ter renderizado de novo depois do
  // `dragstart`, e um handler que lesse o estado veria `null`. O estado
  // existe so para o visual (opacidade e realce do dia).
  const arrastandoRef = useRef<string | null>(null);
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [sobre, setSobre] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<ItemDaAgenda | null>(null);
  const [pendente, startTransition] = useTransition();

  if (servidor !== itens) {
    setServidor(itens);
    setLista(itens);
  }

  const porDia = new Map<string, ItemDaAgenda[]>();
  for (const item of lista) {
    const doDia = porDia.get(item.dia) ?? [];
    doDia.push(item);
    porDia.set(item.dia, doDia);
  }
  for (const doDia of porDia.values()) doDia.sort((a, b) => a.hora.localeCompare(b.hora));

  function soltar(chave: string, doEvento: string) {
    const id = arrastandoRef.current ?? (doEvento || null);
    arrastandoRef.current = null;
    setArrastando(null);
    setSobre(null);
    if (!id) return;

    const item = lista.find((i) => i.id === id);
    if (!item || item.dia === chave || !EDITAVEIS.has(item.status)) return;
    if (chave < hoje) {
      setErro("Escolha um dia de hoje em diante.");
      return;
    }

    const anterior = lista;
    setErro(null);
    setLista((atual) => atual.map((i) => (i.id === id ? { ...i, dia: chave } : i)));

    startTransition(async () => {
      const resultado = await reagendar({ id, data: chave, hora: item.hora });
      if (!resultado.ok) {
        setLista(anterior);
        setErro(resultado.erro);
        return;
      }
      router.refresh();
    });
  }

  const colunas = "grid grid-cols-7 gap-px";

  return (
    <div>
      {erro ? (
        <Alert variant="destructive" role="alert" className="mb-3">
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      ) : null}

      <div className="bg-border overflow-hidden rounded-xl border">
        <div className={`${colunas} bg-muted text-muted-foreground text-xs font-medium`}>
          {DIAS_CURTOS.map((d) => (
            <div key={d} className="bg-muted px-2 py-1.5 text-center uppercase">
              {d}
            </div>
          ))}
        </div>

        <div className={colunas}>
          {dias.map((dia) => {
            const doDia = porDia.get(dia.chave) ?? [];
            const alvo = sobre === dia.chave && arrastando !== null;
            return (
              <div
                key={dia.chave}
                data-dia={dia.chave}
                onDragOver={(e) => {
                  if (!arrastandoRef.current) return;
                  e.preventDefault();
                  if (sobre !== dia.chave) setSobre(dia.chave);
                }}
                onDragLeave={() => {
                  if (sobre === dia.chave) setSobre(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  soltar(dia.chave, e.dataTransfer.getData("text/plain"));
                }}
                className={`flex flex-col gap-1 p-1.5 transition-colors ${
                  visao === "mes" ? "min-h-24" : "min-h-72"
                } ${dia.doMes ? "bg-card" : "bg-muted/40"} ${
                  alvo ? "bg-primary/10 ring-primary/40 ring-2 ring-inset" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-medium ${
                      dia.chave === hoje
                        ? "bg-primary text-primary-foreground rounded-full px-1.5 py-0.5"
                        : dia.doMes
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {visao === "semana" ? rotuloDaSemana(dia.chave) : dia.numero}
                  </span>
                </div>

                {doDia.map((item) => {
                  const editavel = EDITAVEIS.has(item.status);
                  const estado = ESTADOS_DA_AGENDA[item.status];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-item={item.id}
                      draggable={editavel}
                      onDragStart={(e) => {
                        if (!editavel) return;
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", item.id);
                        arrastandoRef.current = item.id;
                        setArrastando(item.id);
                      }}
                      onDragEnd={() => {
                        arrastandoRef.current = null;
                        setArrastando(null);
                        setSobre(null);
                      }}
                      onClick={() => setAberto(item)}
                      title={`${item.hora} · ${item.video} · @${item.username}`}
                      className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs leading-tight ${estado.classe} ${
                        editavel ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                      } ${arrastando === item.id ? "opacity-40" : ""}`}
                    >
                      {editavel ? <GripVerticalIcon className="size-3 shrink-0 opacity-60" /> : null}
                      <span className="shrink-0 font-semibold tabular-nums">{item.hora}</span>
                      <span className="truncate">{item.video}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {pendente ? (
        <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
          <Loader2Icon className="size-3 animate-spin" /> Salvando…
        </p>
      ) : null}

      <Detalhe
        item={aberto}
        hoje={hoje}
        aoFechar={() => setAberto(null)}
        aoMudar={(atualizado) => {
          setLista((atual) => atual.map((i) => (i.id === atualizado.id ? atualizado : i)));
          setAberto(null);
          router.refresh();
        }}
        aoRemover={(id) => {
          setLista((atual) => atual.filter((i) => i.id !== id));
          setAberto(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function rotuloDaSemana(chave: string): string {
  const p = lerChaveDoDia(chave);
  return p ? `${p.dia}/${String(p.mes).padStart(2, "0")}` : chave;
}

/**
 * O detalhe de um item: data e hora editáveis (o caminho pelo teclado para o
 * que o arrastar faz com o mouse), cancelar, e o link do post quando existe.
 */
function Detalhe({
  item,
  hoje,
  aoFechar,
  aoMudar,
  aoRemover,
}: {
  item: ItemDaAgenda | null;
  hoje: string;
  aoFechar: () => void;
  aoMudar: (item: ItemDaAgenda) => void;
  aoRemover: (id: string) => void;
}) {
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");
  const [chaveDoItem, setChaveDoItem] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  // Sincroniza os campos quando um item é aberto — no render, sem efeito. Ao
  // fechar, a chave é zerada: reabrir o MESMO item precisa recarregar os
  // campos, senão uma edição não salva (ou um arrasto feito depois) ficaria na
  // tela como se fosse o horário atual.
  if (!item && chaveDoItem !== null) setChaveDoItem(null);
  if (item && item.id !== chaveDoItem) {
    setChaveDoItem(item.id);
    setData(item.dia);
    setHora(item.hora);
    setErro(null);
  }

  const editavel = item ? EDITAVEIS.has(item.status) : false;
  const estado = item ? ESTADOS_DA_AGENDA[item.status] : null;

  return (
    <Dialog open={item !== null} onOpenChange={(v) => (!v ? aoFechar() : null)}>
      <DialogContent className="sm:max-w-md">
        {item && estado ? (
          <>
            <DialogHeader>
              <DialogTitle className="truncate">{item.video}</DialogTitle>
              <DialogDescription>
                @{item.username} ·{" "}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${estado.classe}`}>
                  {estado.rotulo}
                </span>
              </DialogDescription>
            </DialogHeader>

            {item.legenda ? (
              <p className="text-muted-foreground line-clamp-4 text-sm whitespace-pre-line">
                {item.legenda}
              </p>
            ) : null}

            {item.erro ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{item.erro}</AlertDescription>
              </Alert>
            ) : null}

            {item.permalink ? (
              <Button asChild variant="outline">
                <a href={item.permalink} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon />
                  Ver no Instagram
                </a>
              </Button>
            ) : null}

            {editavel ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="detalhe-data">Data</Label>
                  <Input
                    id="detalhe-data"
                    type="date"
                    min={hoje}
                    value={data}
                    onChange={(e) => setData(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="detalhe-hora">Hora</Label>
                  <Input
                    id="detalhe-hora"
                    type="time"
                    value={hora}
                    onChange={(e) => setHora(e.target.value)}
                  />
                </div>
              </div>
            ) : null}

            {erro ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{erro}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              {editavel ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={pendente}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await cancelarAgendamento(item.id);
                      if (!r.ok) {
                        setErro(r.erro ?? "Não foi possível cancelar.");
                        return;
                      }
                      aoRemover(item.id);
                    })
                  }
                >
                  Cancelar agendamento
                </Button>
              ) : null}
              {editavel ? (
                <Button
                  type="button"
                  disabled={pendente || !data || !hora}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await reagendar({ id: item.id, data, hora });
                      if (!r.ok) {
                        setErro(r.erro);
                        return;
                      }
                      aoMudar({ ...item, dia: data, hora, quandoIso: r.quando });
                    })
                  }
                >
                  {pendente ? <Loader2Icon className="animate-spin" /> : null}
                  Salvar horário
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={aoFechar}>
                  Fechar
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
