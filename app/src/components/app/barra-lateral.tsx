"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClockIcon,
  FolderIcon,
  LayoutTemplateIcon,
  PlugIcon,
  UserIcon,
} from "lucide-react";

const ITENS = [
  { href: "/app/projetos", rotulo: "Projetos", Icone: FolderIcon },
  { href: "/app/templates", rotulo: "Templates", Icone: LayoutTemplateIcon },
  { href: "/app/conectores", rotulo: "Conectores", Icone: PlugIcon },
  { href: "/app/agenda", rotulo: "Agenda", Icone: CalendarClockIcon },
  { href: "/app/conta", rotulo: "Conta", Icone: UserIcon },
] as const;

export function BarraLateral() {
  const pathname = usePathname();

  return (
    <nav aria-label="Seções" className="p-3">
      <ul className="space-y-1">
        {ITENS.map(({ href, rotulo, Icone }) => {
          const ativo = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                // `aria-current` é o que faz o leitor de tela anunciar "página
                // atual". A cor sozinha não diz nada para quem não a vê.
                aria-current={ativo ? "page" : undefined}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  ativo
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icone className="size-4 shrink-0" />
                {rotulo}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
