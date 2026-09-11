"use client";

import { useState } from "react";
import { PlugIcon, RefreshCwIcon } from "lucide-react";

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
import { abrirJanelaDeConexao } from "@/lib/ig/janela";

/**
 * "Conectar Instagram" — a tela de um passo e a janela do Instagram.
 *
 * A TELA DE UM PASSO NÃO É ENFEITE
 * ================================
 *
 * Ela existe porque o erro mais comum deste fluxo acontece ANTES de qualquer
 * código nosso rodar: a pessoa tenta conectar uma conta pessoal. O Business
 * Login recusa, e a mensagem que a Meta mostra não explica o que fazer. Dizer o
 * caminho exato do app do Instagram aqui, antes de abrir a janela, é mais
 * barato que tratar o erro depois — e é o que o prompt da Fase 4 pede.
 *
 * POR QUE O POPUP APONTA PARA UMA ROTA NOSSA
 * ==========================================
 *
 * `window.open` precisa ser SÍNCRONO com o clique, senão o bloqueador de
 * pop-up o barra. A URL do Instagram depende de um `state` assinado no
 * servidor; buscá-la antes significaria um `await` no meio. Apontando a janela
 * para `/api/ig/iniciar`, que redireciona, o clique abre a janela na hora e o
 * `state` nasce onde deve.
 *
 * Quem escuta o fim do fluxo é `OuvirRetorno`, montado uma vez pela página —
 * não este componente, que aparece várias vezes na mesma tela.
 */
export function ConectarInstagram({
  cabeMaisUma,
  motivoDeNaoCaber,
  reconectar,
}: {
  cabeMaisUma: boolean;
  motivoDeNaoCaber: string;
  /** Quando é o botão "Reconectar" de uma conta que já está na lista. */
  reconectar?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const [bloqueado, setBloqueado] = useState(false);

  function abrirJanela() {
    const abriu = abrirJanelaDeConexao();
    setBloqueado(!abriu);
    // Com o pop-up barrado, o diálogo FICA aberto para mostrar o porquê.
    // Fechá-lo assim mesmo deixaria a pessoa olhando uma tela onde nada
    // aconteceu depois de clicar em Continuar.
    if (abriu) setAberto(false);
  }

  const rotulo = reconectar ? "Reconectar" : "Conectar Instagram";

  return (
    <Dialog
      open={aberto}
      onOpenChange={(valor) => {
        setAberto(valor);
        if (!valor) setBloqueado(false);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={reconectar ? "outline" : "default"}
          size={reconectar ? "sm" : "default"}
          disabled={!cabeMaisUma && !reconectar}
          title={cabeMaisUma || reconectar ? undefined : motivoDeNaoCaber}
        >
          {reconectar ? <RefreshCwIcon /> : <PlugIcon />}
          {rotulo}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Sua conta precisa estar como Profissional (Empresa ou Criador)
          </DialogTitle>
          <DialogDescription>
            O Instagram só deixa outro aplicativo publicar em contas
            profissionais. A mudança é gratuita, leva menos de um minuto e não
            muda nada no seu perfil para quem te segue.
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm">
          <p className="mb-2 font-medium">No aplicativo do Instagram:</p>
          <ol className="text-muted-foreground list-decimal space-y-1 pl-5">
            <li>Abra seu perfil e toque no menu ☰, no canto superior direito</li>
            <li>
              Toque em <strong>Configurações e privacidade</strong>
            </li>
            <li>
              Toque em <strong>Tipo de conta e ferramentas</strong>
            </li>
            <li>
              Toque em <strong>Mudar para conta profissional</strong> e escolha{" "}
              <strong>Empresa</strong> ou <strong>Criador de conteúdo</strong>
            </li>
          </ol>
          <p className="text-muted-foreground mt-3">
            Se a sua conta já é profissional, pode seguir direto.
          </p>
        </div>

        {bloqueado ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              O navegador bloqueou a janela do Instagram. Libere os pop-ups para
              este site (o ícone costuma aparecer no fim da barra de endereço) e
              clique em Continuar de novo.
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setAberto(false)}>
            Cancelar
          </Button>
          <Button onClick={abrirJanela}>Continuar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
