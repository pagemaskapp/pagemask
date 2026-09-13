import type { Metadata } from "next";

import { ChamadaFinal } from "@/components/landing/chamada-final";
import { ComoFunciona } from "@/components/landing/como-funciona";
import { Hero } from "@/components/landing/hero";
import { Perguntas } from "@/components/landing/perguntas";
import { Planos } from "@/components/landing/planos";
import { Verificacao } from "@/components/landing/verificacao";
import { estaLogado, planosDaLanding } from "@/lib/landing/visitante";

/**
 * `/` — a landing pública (Fase 11).
 *
 * Rota pública de verdade: não chama `exigirUsuario`, não depende de sessão e
 * continua de pé com o Supabase fora do ar (ver `lib/landing/visitante.ts`).
 * A sessão entra só para adaptar os CTAs.
 *
 * POR QUE O USUÁRIO LOGADO NÃO É REDIRECIONADO PARA `/app`
 * ========================================================
 *
 * Era uma das duas saídas aceitas pela fase, e a outra é melhor. `/` é o
 * endereço que a pessoa digita, que está no rodapé do e-mail e que ela manda
 * para um sócio; um redirecionamento faz com que quem está logado **nunca mais
 * consiga ver a própria página de vendas** — nem para conferir um preço, nem
 * para mandar o link a alguém, nem para ler os termos pelo rodapé. E é uma
 * porta difícil de fechar depois: link compartilhado por quem usa o produto é
 * justamente o que traz o próximo cliente.
 *
 * Então a página continua a mesma para todo mundo, e o que muda é o botão:
 * "Criar conta" vira "Ir para os seus projetos", em três lugares.
 */

const DESCRICAO =
  "Suba a pasta de vídeos, defina o template uma vez e receba o lote inteiro " +
  "editado — com sete checagens por vídeo que provam que o perfil antigo foi " +
  "coberto e que a imagem original continua intacta.";

export const metadata: Metadata = {
  // Sem `template`: na landing o título não é "X · PageMask", é a frase
  // inteira. É ela que aparece no resultado de busca e no cartão de link.
  title: {
    absolute: "PageMask · edição de vídeo em lote, com cada vídeo conferido",
  },
  description: DESCRICAO,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "pt_BR",
    siteName: "PageMask",
    title: "PageMask · edição de vídeo em lote, com cada vídeo conferido",
    description: DESCRICAO,
    url: "/",
  },
};

export default async function Landing() {
  // Em paralelo: são independentes, e a leitura dos planos não pode esperar a
  // conferência de sessão para começar.
  const [logado, planos] = await Promise.all([estaLogado(), planosDaLanding()]);

  return (
    <>
      <Hero logado={logado} />
      <ComoFunciona />
      <Verificacao />
      <Planos planos={planos} logado={logado} />
      <Perguntas />
      <ChamadaFinal logado={logado} />
    </>
  );
}
