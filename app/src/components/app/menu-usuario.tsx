"use client";

import Link from "next/link";
import { ChevronDownIcon, LogOutIcon, UserIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sair } from "@/app/(auth)/acoes";

/** Liga o botão de sair, que vive dentro do menu, ao formulário fora dele. */
const FORMULARIO_SAIR = "formulario-sair";

export function MenuUsuario({ email }: { email: string }) {
  return (
    <>
      {/*
        O formulário fica FORA do menu porque `DropdownMenuContent` é um
        `role="menu"`, e menu só aceita filhos da família `menuitem` — um
        `<form>` ali dentro faz leitor de tela em modo menu contar itens a
        menos, ou pular o "Sair". Com `form=`, o botão continua sendo o item de
        menu (e o teclado continua ativando ele) e o formulário mora onde não
        atrapalha a semântica.
      */}
      <form id={FORMULARIO_SAIR} action={sair} className="hidden" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="max-w-[16rem] gap-2">
            <span
              aria-hidden
              className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            >
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate text-sm font-normal">{email}</span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <span className="text-muted-foreground block text-xs">
              Conectado como
            </span>
            <span className="block truncate text-sm">{email}</span>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            <Link href="/app/conta">
              <UserIcon />
              Minha conta
            </Link>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/*
            Sair é uma server action num <form>, não um onClick com fetch: o
            cookie de sessão é HttpOnly, e só o servidor consegue apagá-lo.

            Ainda assim, este caminho depende de JavaScript: o Radix só monta o
            conteúdo do menu depois que ele abre, então o BOTÃO não existe no
            HTML inicial (o formulário, agora fora do menu, existe). Por isso
            `/app/conta` tem um botão de sair próprio, num formulário de verdade
            na página — sem ele, quem estivesse sem JS ficaria sem nenhuma forma
            de encerrar a sessão.

            `onSelect` precisa do `preventDefault`. Sem ele, o Radix fecha o
            menu dentro do próprio clique e desmonta o portal — junto com este
            botão. Um botão já removido do documento não executa a ação padrão
            de envio, então o clique fechava o menu e não saía de lugar nenhum.
            Prevenindo, o item continua montado, o envio acontece, e quem fecha
            a tela é o redirect da server action.
          */}
          <DropdownMenuItem
            asChild
            variant="destructive"
            onSelect={(evento) => evento.preventDefault()}
          >
            <button type="submit" form={FORMULARIO_SAIR} className="w-full">
              <LogOutIcon />
              Sair
            </button>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
