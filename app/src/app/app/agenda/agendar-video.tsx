"use client";

import { useActionState, useState, useTransition } from "react";
import { CalendarPlusIcon, Loader2Icon } from "lucide-react";

import {
  agendarVideo,
  consultarLimite,
  type EstadoAgendamento,
  type Limite,
} from "@/app/app/agenda/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LIMITE_LEGENDA, partesLocais } from "@/lib/agenda/fuso";

const INICIAL: EstadoAgendamento = {};

const CAMPO =
  "border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3 dark:bg-input/30";

/**
 * "Agendar vídeo": conta, vídeo pronto, data, hora e legenda com contador.
 *
 * Ao escolher a conta, a tela pergunta ao servidor quantas publicações a Meta
 * já contou nas últimas 24 h — o "X de Y" do prompt. A action de gravar
 * confere de novo, com o horário escolhido, e quando não cabe devolve o
 * próximo horário livre como sugestão, que o botão abaixo aplica nos campos.
 */
export function AgendarVideo({
  contas,
  videos,
  hoje,
}: {
  contas: { id: string; username: string }[];
  videos: { id: string; nome: string; projeto: string }[];
  hoje: string;
}) {
  const [estado, acao] = useActionState(agendarVideo, INICIAL);
  const [aberto, setAberto] = useState(false);
  const [conta, setConta] = useState(contas[0]?.id ?? "");
  const [data, setData] = useState(hoje);
  const [hora, setHora] = useState(proximaHoraCheia());
  const [legenda, setLegenda] = useState("");
  const [limite, setLimite] = useState<Limite | null>(null);
  const [consultando, startConsulta] = useTransition();

  const podeAgendar = contas.length > 0 && videos.length > 0;
  const restantes = LIMITE_LEGENDA - legenda.length;

  function escolherConta(id: string) {
    setConta(id);
    setLimite(null);
    if (!id) return;
    startConsulta(async () => {
      setLimite(await consultarLimite(id));
    });
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        setAberto(v);
        if (v && conta && limite === null) escolherConta(conta);
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={!podeAgendar} title={podeAgendar ? undefined : MOTIVO}>
          <CalendarPlusIcon />
          Agendar vídeo
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <form action={acao} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Agendar publicação</DialogTitle>
            <DialogDescription>
              O vídeo sai como Reels na conta e no horário escolhidos (horário de
              São Paulo).
            </DialogDescription>
          </DialogHeader>

          <CampoMensagem erro={estado.erro} aviso={estado.aviso} />

          {estado.sugestao ? (
            <Alert>
              <AlertDescription>
                <span>Próximo horário livre: {estado.sugestao.texto}.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setData(estado.sugestao!.data);
                    setHora(estado.sugestao!.hora);
                  }}
                >
                  Usar esse horário
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="conta">Conta do Instagram</Label>
            <select
              id="conta"
              name="conta"
              required
              value={conta}
              onChange={(e) => escolherConta(e.target.value)}
              className={CAMPO}
            >
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  @{c.username}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground flex min-h-4 items-center gap-1.5 text-xs" aria-live="polite">
              {consultando ? (
                <>
                  <Loader2Icon className="size-3 animate-spin" /> Consultando o limite…
                </>
              ) : limite?.ok ? (
                `${limite.usados} de ${limite.total} publicações usadas nas últimas 24 h em @${limite.username}.`
              ) : limite ? (
                <span className="text-destructive">{limite.erro}</span>
              ) : null}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="video">Vídeo pronto</Label>
            <select id="video" name="video" required className={CAMPO} defaultValue="">
              <option value="" disabled>
                Escolha um vídeo
              </option>
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nome}
                  {v.projeto ? ` · ${v.projeto}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="data">Data</Label>
              <Input
                id="data"
                name="data"
                type="date"
                required
                min={hoje}
                value={data}
                onChange={(e) => setData(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hora">Hora</Label>
              <Input
                id="hora"
                name="hora"
                type="time"
                required
                value={hora}
                onChange={(e) => setHora(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="legenda">Legenda</Label>
              <span
                className={`text-xs tabular-nums ${restantes < 0 ? "text-destructive" : "text-muted-foreground"}`}
                aria-live="polite"
              >
                {legenda.length.toLocaleString("pt-BR")} / {LIMITE_LEGENDA.toLocaleString("pt-BR")}
              </span>
            </div>
            <textarea
              id="legenda"
              name="legenda"
              rows={4}
              maxLength={LIMITE_LEGENDA}
              value={legenda}
              onChange={(e) => setLegenda(e.target.value)}
              placeholder="Opcional. Até 2.200 caracteres, 30 hashtags e 20 menções."
              className={`${CAMPO} h-auto resize-y py-2 leading-relaxed`}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAberto(false)}>
              Fechar
            </Button>
            <BotaoEnvio carregando="Agendando…">Agendar</BotaoEnvio>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const MOTIVO =
  "Para agendar, você precisa de uma conta ativa em Conectores e de um vídeo pronto em algum projeto.";

/**
 * Só valor inicial do campo; o servidor decide o instante de verdade.
 *
 * No fuso da TELA (São Paulo), e não no do navegador: `hoje` vem do servidor
 * nesse fuso, e um padrão de hora em outro fuso combinaria data de hoje com
 * uma hora que já passou — e o servidor recusaria um padrão que parecia bom.
 */
function proximaHoraCheia(): string {
  const hora = (partesLocais(new Date()).hora + 1) % 24;
  return `${String(hora).padStart(2, "0")}:00`;
}
