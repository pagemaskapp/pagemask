"use client";

import { useId, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Campo de senha com o botão de olho para revelar o que foi digitado.
 *
 * O botão existe para reduzir erro de digitação, que numa senha não tem
 * correção: quem erra só descobre no "senha incorreta", sem saber onde errou.
 * Em pt-BR isso pesa mais — acento e cedilha entram por teclado morto, e num
 * campo mascarado não dá para ver que saiu `ç` onde se queria `c`.
 *
 * Três detalhes que mudam se isso funciona de verdade:
 *
 *   · `type="button"`. Dentro de um `<form>` o padrão de `<button>` é
 *     `submit` — sem isto, revelar a senha ENVIA o formulário.
 *   · `aria-pressed` + `aria-label`. O ícone sozinho não diz nada a leitor de
 *     tela, e o estado (mostrando ou escondendo) é a informação que importa.
 *   · `tabIndex={-1}`. O Tab vai do campo de senha para o próximo campo, não
 *     para o olho. Quem usa teclado está preenchendo o formulário, e um botão
 *     decorativo no meio do caminho atrapalha mais do que ajuda; o botão
 *     continua alcançável por leitor de tela e por clique.
 *
 * O `type` alterna entre `password` e `text`. `autoComplete` fica a cargo de
 * quem chama: `current-password` no login, `new-password` no cadastro e na
 * troca — o gerenciador de senhas do navegador decide por esse valor se
 * oferece a senha guardada ou propõe uma nova.
 */
export function CampoSenha({
  id,
  name,
  label,
  autoComplete,
  minLength,
  ajuda,
  defaultValue,
  required = true,
}: {
  id?: string;
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  /** Texto de apoio abaixo do campo, ligado por `aria-describedby`. */
  ajuda?: React.ReactNode;
  defaultValue?: string;
  required?: boolean;
}) {
  const [visivel, setVisivel] = useState(false);
  // `useId` porque este componente aparece duas vezes na mesma tela (senha e
  // confirmação): um id fixo daria dois elementos com o mesmo id, e aí o
  // `htmlFor` do segundo `Label` apontaria para o primeiro campo.
  const gerado = useId();
  const campoId = id ?? `senha-${gerado}`;
  const ajudaId = `${campoId}-ajuda`;

  return (
    <div className="space-y-2">
      <Label htmlFor={campoId}>{label}</Label>
      <div className="relative">
        <Input
          id={campoId}
          name={name}
          type={visivel ? "text" : "password"}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          defaultValue={defaultValue}
          aria-describedby={ajuda ? ajudaId : undefined}
          // Espaço para o botão não cobrir o fim do texto digitado.
          className="pr-9"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisivel((atual) => !atual)}
          aria-pressed={visivel}
          aria-label={visivel ? "Ocultar senha" : "Mostrar senha"}
          title={visivel ? "Ocultar senha" : "Mostrar senha"}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg transition-colors focus-visible:ring-3 focus-visible:outline-none"
        >
          {visivel ? (
            <EyeOffIcon className="size-4" aria-hidden="true" />
          ) : (
            <EyeIcon className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {ajuda ? (
        <p id={ajudaId} className="text-muted-foreground text-xs">
          {ajuda}
        </p>
      ) : null}
    </div>
  );
}
