"use client";

import { useActionState, useState } from "react";
import { DownloadIcon, Trash2Icon } from "lucide-react";

import { excluirMinhaConta } from "@/app/app/conta/acoes";
import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EstadoFormulario } from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * Exportar e excluir — os dois direitos que a LGPD manda oferecer em
 * self-service (PLANO §8), agora ligados de verdade.
 *
 * A EXPORTAÇÃO É UM LINK, NÃO UM BOTÃO COM `fetch`
 * ================================================
 *
 * `<a href="/api/conta/exportar">` deixa o navegador fazer o que ele já sabe
 * fazer com `Content-Disposition: attachment`: baixar, com barra de progresso,
 * sem segurar o JSON inteiro na memória do JavaScript e sem `URL.createObjectURL`
 * para lembrar de revogar depois. Também funciona sem JS.
 *
 * A EXCLUSÃO PEDE O E-MAIL DIGITADO
 * =================================
 *
 * Não é teatro de segurança nem desconfiança de quem clicou: é o que separa
 * "eu quero excluir minha conta" de um clique acidental num botão vermelho.
 * O porquê de ser o e-mail e não a senha está em `acoes.ts` — resumo: quem
 * entrou por magic link não tem senha, e exigi-la deixaria essa pessoa sem
 * caminho self-service para um direito que a lei garante.
 */
export function AcoesLgpd() {
  const [aberto, setAberto] = useState(false);
  const [estado, acao] = useActionState(excluirMinhaConta, INICIAL);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="outline" asChild className="sm:flex-1">
          {/*
            SEM O ATRIBUTO `download`, e isso não é esquecimento.

            Ele parecia o certo — "é um download, marque como download" — e
            engolia todos os erros da rota. `download` manda o navegador
            **salvar a resposta, qualquer resposta**: o 401 de sessão vencida,
            o 429 do limite e o 500 viram um arquivo chamado `exportar` na
            pasta de downloads, com o JSON de erro dentro. A pessoa clica,
            aparentemente funciona, e o "seus dados" que ela abre depois diz
            `{"erro":"Sua sessão expirou…"}`.

            Sem ele, o `Content-Disposition: attachment` da rota continua
            fazendo o download no caso de sucesso — que é o único caso em que a
            rota manda esse cabeçalho — e o erro é exibido como página, em
            pt-BR, que é para isso que aquelas mensagens foram escritas.
          */}
          <a href="/api/conta/exportar">
            <DownloadIcon />
            Exportar meus dados
          </a>
        </Button>

        <Button
          variant="outline"
          onClick={() => setAberto(true)}
          className="text-destructive hover:text-destructive sm:flex-1"
        >
          <Trash2Icon />
          Excluir minha conta
        </Button>
      </div>

      <p className="text-muted-foreground mt-3 text-sm">
        A exportação vem em JSON e traz cadastro, projetos, templates,
        histórico de vídeos, agendamentos e registros de auditoria — sem os
        tokens do Instagram, que são credencial de acesso e não dado seu.
      </p>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <form action={acao}>
            <DialogHeader>
              <DialogTitle>Excluir minha conta</DialogTitle>
              <DialogDescription>
                Isto é irreversível. Não há como recuperar depois.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div className="text-muted-foreground space-y-2 text-sm">
                <p>O que acontece assim que você confirmar:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    a autorização das contas do Instagram é devolvida à Meta e
                    os tokens são apagados;
                  </li>
                  <li>
                    todos os seus vídeos — os enviados e os produzidos — saem do
                    armazenamento;
                  </li>
                  <li>
                    projetos, templates, agendamentos, cadastro e login são
                    apagados;
                  </li>
                  <li>
                    os registros de auditoria são anonimizados: o que aconteceu
                    e quando continua registrado, sem nada que ligue àquilo a
                    você.
                  </li>
                </ul>
                <p>
                  Se você tem assinatura ativa, cancele antes em{" "}
                  <strong>Assinatura</strong> — excluir a conta aqui não
                  interrompe a cobrança na Stripe.
                </p>
              </div>

              <CampoMensagem erro={estado.erro} aviso={estado.aviso} />

              <div className="space-y-2">
                <Label htmlFor="confirmacao">
                  Digite o e-mail desta conta para confirmar
                </Label>
                <Input
                  id="confirmacao"
                  name="confirmacao"
                  type="email"
                  autoComplete="off"
                  required
                  placeholder="voce@exemplo.com"
                />
              </div>
            </div>

            <DialogFooter className="mt-6">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <BotaoEnvio variant="destructive" carregando="Excluindo…">
                Excluir permanentemente
              </BotaoEnvio>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
