"use client";

import { useActionState, useState } from "react";

import { BotaoEnvio } from "@/components/auth/botao-envio";
import { CampoMensagem } from "@/components/auth/campo-mensagem";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmarCodigo, reenviarConfirmacao } from "@/app/(auth)/acoes";
import {
  CODIGO_MAX,
  CODIGO_MIN,
  TAMANHO_DO_CODIGO,
  type EstadoFormulario,
} from "@/lib/auth/formulario";

const INICIAL: EstadoFormulario = {};

/**
 * Digitação do código do e-mail, mais o botão de reenvio.
 *
 * **Não existe campo de e-mail aqui — nem visível, nem escondido.** O endereço
 * vive num cookie `httpOnly` escrito pelo servidor, e é de lá que as duas
 * actions o leem. Um `<input hidden>` com o e-mail seria entrada controlada
 * pelo cliente, e foi exatamente isso que abriu a fixação de sessão descrita em
 * `lib/auth/cadastro-pendente`: o atacante escolhia a conta, a vítima digitava
 * o código que recebeu por phishing, e o navegador da vítima terminava logado
 * na conta do atacante.
 *
 * São **dois `<form>` irmãos**, e não um com dois botões. Formulário aninhado
 * não existe em HTML, e dois `formAction` no mesmo form mandariam o código
 * digitado junto do pedido de reenvio — que não tem o que fazer com ele.
 */
export function FormularioConfirmacao({ proximo }: { proximo: string }) {
  const [estadoCodigo, acaoCodigo] = useActionState(confirmarCodigo, INICIAL);
  const [estadoReenvio, acaoReenvio] = useActionState(
    reenviarConfirmacao,
    INICIAL,
  );

  // Qual dos dois formulários falou por último.
  //
  // Sem isto a tela mentia: `useActionState` guarda o estado de cada action até
  // **aquela mesma action** rodar de novo, e `confirmarCodigo` só devolve erro.
  // Então quem digitasse um código errado e depois clicasse em "Reenviar
  // código" continuava vendo "Código incorreto" — sem nenhum sinal de que o
  // reenvio aconteceu, e com o aviso de limite de envio invisível junto.
  //
  // `onSubmit` não dispara sem JavaScript, e por isso `preferido` é só a
  // PREFERÊNCIA: quando o escolhido está vazio, vale o outro. No caminho sem
  // JavaScript a página inteira é renderizada de novo e só uma das duas actions
  // tem estado, então o desempate resolve sozinho.
  const [preferido, setPreferido] = useState<"codigo" | "reenvio">("codigo");

  const temAlgo = (estado: EstadoFormulario) =>
    Boolean(estado.erro || estado.aviso);
  const [primeiro, segundo] =
    preferido === "reenvio"
      ? [estadoReenvio, estadoCodigo]
      : [estadoCodigo, estadoReenvio];
  const exibido = temAlgo(primeiro) ? primeiro : segundo;

  return (
    <>
      <CampoMensagem
        erro={exibido.erro}
        aviso={exibido.aviso}
        acao={exibido.acao}
      />

      <form
        action={acaoCodigo}
        onSubmit={() => setPreferido("codigo")}
        className="space-y-3 text-left"
      >
        <input type="hidden" name="proximo" value={proximo} />

        <div className="space-y-2">
          {/*
            O rótulo não crava o número de dígitos, e isso é decisão, não
            descuido: quem define o tamanho é o `Email OTP Length` do painel do
            Supabase, e um rótulo dizendo "6" na frente de um e-mail com 8
            transforma uma configuração errada numa acusação ao usuário. O
            `placeholder` mostra o formato esperado sem prometer nada.
          */}
          <Label htmlFor="codigo">Código de confirmação</Label>
          <Input
            id="codigo"
            name="codigo"
            // `text` e não `number`: `number` aceita `e`, `+` e `-`, corta zero
            // à esquerda (um código começado em 0 perderia o primeiro dígito) e
            // ainda desenha as setinhas de incremento em cima do campo.
            type="text"
            inputMode="numeric"
            // `one-time-code` é o que faz o iOS e o Android oferecerem o código
            // do e-mail direto no teclado, e o gerenciador de senhas parar de
            // tentar preencher este campo com um login.
            autoComplete="one-time-code"
            // O `pattern` barra LETRA no navegador, antes de gastar uma
            // tentativa do limite por IP — mas deixa passar espaço e traço, de
            // propósito. O servidor os remove antes de contar (`acoes.ts`),
            // justamente porque colar do e-mail costuma trazer um espaço
            // invisível junto; um `\d{6,10}` aqui reprovaria esse colar com o
            // "corresponda ao formato solicitado" do navegador, a action nem
            // rodaria, e a tolerância do servidor seria código morto.
            pattern={`[\\d\\s-]{${CODIGO_MIN},${CODIGO_MAX * 2}}`}
            // Folga sobre `CODIGO_MAX` pelo mesmo motivo: o que se digita pode
            // ter separadores que só somem no servidor.
            maxLength={CODIGO_MAX * 2}
            required
            autoFocus
            placeholder={"0".repeat(TAMANHO_DO_CODIGO)}
            className="text-center font-mono text-lg tracking-[0.4em]"
          />
        </div>

        <BotaoEnvio carregando="Confirmando…" className="w-full">
          Confirmar
        </BotaoEnvio>
      </form>

      <form
        action={acaoReenvio}
        onSubmit={() => setPreferido("reenvio")}
        className="mt-3"
      >
        <input type="hidden" name="proximo" value={proximo} />
        <BotaoEnvio carregando="Enviando…" variant="outline" className="w-full">
          Reenviar código
        </BotaoEnvio>
      </form>
    </>
  );
}
