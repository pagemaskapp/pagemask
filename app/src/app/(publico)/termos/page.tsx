import type { Metadata } from "next";
import Link from "next/link";

import { ENCARREGADO } from "@/lib/legal/encarregado";

export const metadata: Metadata = {
  title: "Termos de uso",
  description:
    "As regras de uso do PageMask: o que entregamos, o que é responsabilidade sua, planos, cancelamento e limites.",
  // Mesma exceção de `/privacidade`: o App Review da Meta pede a URL desta
  // página, e ela precisa ser encontrável por quem vai contratar.
  robots: { index: true, follow: true },
};

const ATUALIZADA_EM = "12 de setembro de 2026";

/**
 * `/termos` — o contrato de uso (PLANO §8).
 *
 * Duas coisas que esta página **precisa** deixar escritas, e que são o motivo
 * de ela existir antes do lançamento:
 *
 *   1. o cliente é responsável pelo conteúdo que publica e pelos direitos
 *      sobre os vídeos que envia (a frase está no PLANO, e é ela que separa a
 *      responsabilidade de quem edita da de quem publica);
 *   2. publicar no Instagram acontece sob os termos da Meta, não sob os
 *      nossos — a conta que for suspensa lá é suspensa por eles.
 *
 * Sem login, como `/privacidade`: quem vai contratar precisa ler antes de
 * criar conta, e o App Review lê sem conta nenhuma.
 */
export default function Termos() {
  return (
    <article className="space-y-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Termos de uso
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Atualizados em {ATUALIZADA_EM}. Ao criar uma conta, você concorda com
          o que está aqui.
        </p>
      </header>

      <Secao titulo="1. O que o PageMask faz">
        <p>
          O PageMask edita vídeos em lote e, quando você pede, publica o
          resultado nas contas profissionais do Instagram que você conectou.
          Você define um padrão visual uma vez; nós aplicamos esse padrão a
          todos os vídeos do lote e devolvemos os arquivos prontos.
        </p>
        <p>
          A edição é determinística: o mesmo vídeo com o mesmo padrão produz
          sempre o mesmo resultado. Não geramos conteúdo novo nem alteramos o
          que você enviou além do que o padrão descreve.
        </p>
      </Secao>

      <Secao titulo="2. Sua conta">
        <ul>
          <li>
            Uma conta pertence a uma pessoa ou empresa. Você é responsável por
            manter a senha em segredo e por tudo que acontecer na sua conta.
          </li>
          <li>
            Você precisa ter pelo menos 18 anos, ou a idade mínima exigida pela
            Meta para operar uma conta profissional no Instagram.
          </li>
          <li>
            Suspeitou de acesso indevido? Use{" "}
            <strong>Conta › Sair de todos os aparelhos</strong> e troque a
            senha.
          </li>
        </ul>
      </Secao>

      <Secao titulo="3. O conteúdo é seu — e a responsabilidade por ele também">
        <p>
          Você continua sendo o dono de tudo que envia e de tudo que produzimos
          a partir disso. Não usamos seus vídeos para nada além de executar o
          serviço: não treinamos modelo, não publicamos em lugar nenhum que você
          não tenha pedido, não mostramos a terceiros.
        </p>
        <p>
          Em contrapartida, <strong>você declara ter os direitos</strong> sobre
          o que envia — imagem das pessoas que aparecem, trilha sonora, marca,
          material de terceiros — e é responsável pelo que publica através do
          PageMask. Não temos como verificar a origem de um vídeo, e não
          verificamos.
        </p>
        <p>Não é permitido usar o serviço para:</p>
        <ul>
          <li>
            publicar conteúdo ilegal, enganoso, de ódio, sexual envolvendo
            menores, ou que viole direito de terceiro;
          </li>
          <li>
            tentar contornar limites técnicos, sondar a infraestrutura, enviar
            arquivo preparado para explorar o processamento, ou automatizar o
            uso além do que a interface oferece;
          </li>
          <li>
            revender o serviço como se fosse seu sem acordo escrito conosco.
          </li>
        </ul>
        <p>
          Descoberto um uso assim, podemos suspender a conta. Quando o caso
          permitir, avisamos antes e damos prazo para corrigir.
        </p>
      </Secao>

      <Secao titulo="4. Publicação no Instagram">
        <p>
          A publicação acontece pela API oficial da Meta, com a autorização que
          você concede ao conectar cada conta. Isso significa que:
        </p>
        <ul>
          <li>
            valem <strong>os termos e as políticas da Meta</strong>, além
            destes. Conta suspensa, conteúdo removido ou limite de publicação
            aplicado lá são decisão deles, e não temos como reverter;
          </li>
          <li>
            a Meta limita quantas publicações uma conta pode fazer pela API por
            período. Quando esse limite é atingido, a publicação é adiada — não
            perdida;
          </li>
          <li>
            a autorização vence se ficar muito tempo sem uso. Avisamos por
            e-mail e a tela pede reconexão;
          </li>
          <li>
            você pode revogar a autorização a qualquer momento, aqui ou no
            próprio Instagram, em <em>Apps e sites</em>.
          </li>
        </ul>
      </Secao>

      <Secao titulo="5. Planos, cobrança e cancelamento">
        <ul>
          <li>
            Os limites de cada plano — vídeos por mês, contas conectadas,
            projetos, tamanho de arquivo e minutos de transcrição — estão na
            página de planos e valem por período de cobrança.
          </li>
          <li>
            A cobrança é mensal e recorrente, processada pela Stripe. Não
            guardamos dados de cartão.
          </li>
          <li>
            Você cancela quando quiser, pela própria tela de assinatura. O
            acesso continua até o fim do período já pago; não há devolução
            proporcional de período iniciado.
          </li>
          <li>
            Excluir a conta <strong>não cancela</strong> a assinatura na
            Stripe. Cancele antes.
          </li>
          <li>
            Pagamento que falhar é tentado de novo. Se não for regularizado, o
            processamento de novos lotes para — o que já existe continua
            acessível dentro do prazo de retenção.
          </li>
          <li>
            Mudança de preço é avisada por e-mail com pelo menos 30 dias de
            antecedência e vale a partir do período seguinte.
          </li>
        </ul>
      </Secao>

      <Secao titulo="6. Retenção dos arquivos">
        <p>
          Vídeos enviados e produzidos ficam no armazenamento por{" "}
          <strong>30 dias</strong> e depois são apagados automaticamente. Isso
          não é uma promessa de backup: baixe o que precisar guardar. O
          histórico do que foi processado continua na sua conta.
        </p>
      </Secao>

      <Secao titulo="7. Disponibilidade e limites do serviço">
        <p>
          Trabalhamos para manter o PageMask no ar, mas não prometemos
          disponibilidade ininterrupta: dependemos de fornecedores (Supabase,
          Cloudflare, Stripe, Meta) e de manutenções programadas. O serviço é
          oferecido como está.
        </p>
        <p>
          Nossa responsabilidade por qualquer perda ligada ao uso do serviço
          está limitada ao valor que você pagou nos 12 meses anteriores ao
          fato. Isso não afeta direitos que a lei brasileira garanta e não
          permita limitar — inclusive os do Código de Defesa do Consumidor,
          quando aplicável.
        </p>
      </Secao>

      <Secao titulo="8. Seus dados">
        <p>
          O tratamento dos seus dados pessoais está descrito na{" "}
          <Link href="/privacidade">Política de privacidade</Link>, que faz
          parte destes termos. Lá estão o que coletamos, por quanto tempo
          guardamos, com quem compartilhamos e como exportar ou excluir tudo.
        </p>
      </Secao>

      <Secao titulo="9. Encerramento">
        <p>
          Você pode encerrar quando quiser, em{" "}
          <Link href="/app/conta">Conta › Excluir minha conta</Link>. Podemos
          encerrar a sua conta por descumprimento destes termos, por exigência
          legal ou se descontinuarmos o serviço — neste último caso, com aviso
          de pelo menos 30 dias e tempo para você baixar seus arquivos.
        </p>
      </Secao>

      <Secao titulo="10. Mudanças nestes termos">
        <p>
          Quando algo relevante mudar, a data no topo muda e avisamos por
          e-mail quem tem conta, com pelo menos 15 dias de antecedência.
          Continuar usando depois disso vale como concordância. Quem não
          concordar pode cancelar sem custo adicional.
        </p>
      </Secao>

      <Secao titulo="11. Lei aplicável e contato">
        <p>
          Estes termos são regidos pela lei brasileira. Fica eleito o foro do
          domicílio do consumidor para as questões que envolvam relação de
          consumo.
        </p>
        <p>
          Contato: <a href={`mailto:${ENCARREGADO.email}`}>{ENCARREGADO.email}</a>
          .
        </p>
      </Secao>
    </article>
  );
}

function Secao({
  id,
  titulo,
  children,
}: {
  id?: string;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="font-heading mb-3 text-xl font-semibold tracking-tight">
        {titulo}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
