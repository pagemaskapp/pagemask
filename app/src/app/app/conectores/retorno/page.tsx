import type { Metadata } from "next";

import { FecharRetorno } from "@/app/app/conectores/retorno/fechar";
import { exigirUsuario } from "@/lib/auth/sessao";
import { ehMotivo, recadoDaFalha } from "@/lib/ig/mensagens";

export const metadata: Metadata = { title: "Conectando o Instagram" };

/**
 * Onde a janela do OAuth aterrissa.
 *
 * Esta página existe por um motivo de CSP: a resposta de um route handler não
 * recebe o nonce que o proxy injeta, então qualquer `<script>` que o callback
 * escrevesse à mão seria bloqueado pelo navegador. Uma página de verdade recebe
 * o nonce, e com ele o componente de cliente que avisa a aba de origem e fecha
 * a janela.
 *
 * Fica sob `/app/`, então herda a exigência de sessão do proxy e do
 * `exigirUsuario` — ninguém deslogado vê esta tela.
 *
 * O `motivo` vem da URL e é validado contra a lista fechada de
 * `lib/ig/mensagens`. O que não estiver nela vira o recado genérico: a URL é
 * escrita por quem quiser, e o texto mostrado aqui nunca pode vir de fora.
 */
export default async function RetornoDaConexao({
  searchParams,
}: {
  searchParams: Promise<{ r?: string; motivo?: string }>;
}) {
  await exigirUsuario("/app/conectores");

  const { r, motivo } = await searchParams;
  const deuCerto = r === "ok";
  const recado = deuCerto
    ? null
    : recadoDaFalha(ehMotivo(motivo) ? motivo : "interno");

  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <h1 className="font-heading text-xl font-semibold tracking-tight">
        {deuCerto ? "Conta conectada" : recado?.titulo}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        {deuCerto
          ? "Pode fechar esta janela. A lista de conectores já foi atualizada."
          : recado?.texto}
      </p>

      <FecharRetorno ok={deuCerto} />
    </div>
  );
}
