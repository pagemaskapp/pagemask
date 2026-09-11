"use client";

import { useState } from "react";
import { DownloadIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Acao = "exportar" | "excluir";

const TEXTOS: Record<Acao, { titulo: string; descricao: string; detalhe: string }> = {
  exportar: {
    titulo: "Exportar meus dados",
    descricao:
      "Ainda não está no ar. A exportação chega na Fase 10, junto com o resto da adequação à LGPD.",
    detalhe:
      "Quando estiver pronta, você vai baixar um arquivo JSON com tudo que guardamos sobre você: cadastro, projetos, templates, histórico de jobs e contas do Instagram conectadas — sem os tokens, que não são seus dados e sim credenciais.",
  },
  excluir: {
    titulo: "Excluir minha conta",
    descricao:
      "Ainda não está no ar. A exclusão chega na Fase 10, junto com o resto da adequação à LGPD.",
    detalhe:
      "Quando estiver pronta, a exclusão vai revogar os tokens do Instagram na Meta, apagar seus arquivos no armazenamento, anonimizar o registro de auditoria e remover sua conta — tudo em até 72 horas, com e-mail de confirmação. É irreversível.",
  },
};

/**
 * Os dois botões de LGPD.
 *
 * O lugar existe desde já de propósito: se a exclusão só aparecer quando
 * estiver pronta, ela vira uma tela nova para desenhar no fim do projeto. Aqui
 * ela já tem endereço, e o modal diz com honestidade que ainda não funciona —
 * em vez de um botão que parece funcionar e não faz nada.
 */
export function AcoesLgpd() {
  // Dois estados em vez de um `Acao | null`. Qual ação está aberta e SE está
  // aberta são coisas diferentes: com um estado só, fechar zerava o texto no
  // primeiro quadro da animação de saída, e o modal sumia da tela já vazio,
  // título e tudo. Mantendo `acao`, o conteúdo acompanha a animação até o fim.
  const [acao, setAcao] = useState<Acao>("exportar");
  const [aberto, setAberto] = useState(false);
  const texto = TEXTOS[acao];

  const abrir = (qual: Acao) => {
    setAcao(qual);
    setAberto(true);
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          variant="outline"
          onClick={() => abrir("exportar")}
          className="sm:flex-1"
        >
          <DownloadIcon />
          Exportar meus dados
        </Button>
        <Button
          variant="outline"
          onClick={() => abrir("excluir")}
          className="text-destructive hover:text-destructive sm:flex-1"
        >
          <Trash2Icon />
          Excluir minha conta
        </Button>
      </div>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{texto.titulo}</DialogTitle>
            <DialogDescription>{texto.descricao}</DialogDescription>
          </DialogHeader>

          <p className="text-muted-foreground text-sm">{texto.detalhe}</p>

          <p className="text-muted-foreground text-sm">
            Precisa de qualquer uma das duas antes disso? Escreva para o suporte
            e resolvemos no manual, dentro do mesmo prazo.
          </p>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Entendi</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
