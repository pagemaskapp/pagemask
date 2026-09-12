import type { Metadata } from "next";
import Link from "next/link";

import { ENCARREGADO, PRAZO_DE_EXCLUSAO_HORAS } from "@/lib/legal/encarregado";

export const metadata: Metadata = {
  title: "Política de privacidade",
  description:
    "O que o PageMask coleta, para quê, por quanto tempo, com quem compartilha e como excluir seus dados.",
  // A única exceção ao `noindex` do layout raiz: esta página existe para ser
  // encontrada — pelo App Review da Meta e por quem quer saber o que fazemos
  // com os dados.
  robots: { index: true, follow: true },
};

const ATUALIZADA_EM = "11 de setembro de 2026";

/**
 * `/privacidade` — em português, com a seção de exclusão em `#exclusao`
 * (PLANO §8). O App Review exige a URL desta página e a de exclusão de dados;
 * a ANPD exige o Encarregado em local de destaque, e é por isso que ele está
 * no topo e não no rodapé.
 */
export default function Privacidade() {
  return (
    <article className="space-y-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Política de privacidade
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Atualizada em {ATUALIZADA_EM}.
        </p>
      </header>

      <Secao titulo="Quem somos e quem responde pelos seus dados">
        <p>
          O PageMask é um serviço de edição de vídeo em lote para páginas do
          Instagram. Você envia uma pasta de vídeos, define um padrão visual e
          recebe o lote editado e publicado nas contas que conectou.
        </p>
        <p>
          <strong>Encarregado de dados (DPO):</strong> {ENCARREGADO.nome} —{" "}
          <a href={`mailto:${ENCARREGADO.email}`}>{ENCARREGADO.email}</a>. É por
          esse endereço que você exerce qualquer direito descrito aqui.
        </p>
      </Secao>

      <Secao titulo="O que coletamos">
        <ul>
          <li>
            <strong>Cadastro:</strong> e-mail, nome (opcional) e senha, guardada
            como hash pelo nosso provedor de autenticação.
          </li>
          <li>
            <strong>Vídeos e imagens que você envia</strong> e os vídeos que
            produzimos a partir deles.
          </li>
          <li>
            <strong>Conexão com o Instagram:</strong> o identificador e o nome de
            usuário da conta profissional que você autorizou, a foto de perfil e
            um token de acesso, que fica cifrado em repouso e nunca é mostrado a
            ninguém.
          </li>
          <li>
            <strong>Agendamentos e publicações:</strong> legenda, horário, estado
            de cada publicação e o link do post publicado.
          </li>
          <li>
            <strong>Cobrança:</strong> processada pela Stripe. Não guardamos
            número de cartão; guardamos só o identificador do cliente e o estado
            da assinatura.
          </li>
          <li>
            <strong>Registros técnicos:</strong> endereço IP e horário de ações
            sensíveis (entrar, conectar conta, publicar, excluir), para
            segurança e auditoria.
          </li>
        </ul>
      </Secao>

      <Secao titulo="Para quê, e com que base legal">
        <p>
          Tudo acima serve para prestar o serviço que você contratou —{" "}
          <strong>execução de contrato</strong> (LGPD, art. 7º, V). Os registros
          técnicos atendem ao <strong>legítimo interesse</strong> de manter o
          serviço seguro (art. 7º, IX). Não usamos seus dados para publicidade
          nem os vendemos.
        </p>
      </Secao>

      <Secao titulo="Por quanto tempo guardamos">
        <ul>
          <li>
            <strong>Vídeos enviados e produzidos:</strong> 30 dias após o envio,
            e depois são apagados automaticamente do armazenamento.
          </li>
          <li>
            <strong>Conta, agendamentos e histórico:</strong> enquanto a sua
            conta existir.
          </li>
          <li>
            <strong>Token do Instagram:</strong> até você desconectar a conta,
            remover o app no Instagram ou excluir sua conta — o que vier antes.
          </li>
          <li>
            <strong>Registros de auditoria:</strong> anonimizados na exclusão da
            conta.
          </li>
        </ul>
      </Secao>

      <Secao titulo="Com quem compartilhamos">
        <p>
          Só com os fornecedores que fazem o serviço funcionar, cada um com a
          parte que precisa:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — banco de dados e autenticação.
          </li>
          <li>
            <strong>Cloudflare (R2)</strong> — armazenamento dos vídeos.
          </li>
          <li>
            <strong>Meta (Instagram)</strong> — publicação nas contas que você
            conectou. A Meta baixa o vídeo por um link temporário para publicar.
          </li>
          <li>
            <strong>Stripe</strong> — cobrança.
          </li>
          <li>
            <strong>Sentry</strong> — registro de erros da aplicação, sem
            token nem vídeo.
          </li>
          <li>
            <strong>Resend</strong> — e-mails transacionais (por exemplo, o
            aviso para reconectar uma conta).
          </li>
        </ul>
      </Secao>

      <Secao titulo="Seus direitos">
        <p>
          Você pode, a qualquer momento: confirmar que tratamos seus dados,
          acessá-los, corrigi-los, pedir a exportação em formato legível
          (JSON), revogar o consentimento das conexões e pedir a exclusão.
          Escreva para o Encarregado no endereço acima; respondemos em até 15
          dias, como manda a LGPD.
        </p>
      </Secao>

      <Secao id="exclusao" titulo="Exclusão de dados">
        <p>Há três caminhos, e todos levam ao mesmo resultado:</p>
        <ol>
          <li>
            <strong>Pelo PageMask:</strong> em{" "}
            <Link href="/app/conta">Conta › Excluir minha conta</Link>.
          </li>
          <li>
            <strong>Pelo Instagram:</strong> em Configurações › Segurança ›{" "}
            <em>Apps e sites</em>, remova o PageMask. O Instagram nos avisa; nós
            apagamos o token na hora e abrimos uma solicitação de exclusão com
            um código de confirmação, que você pode acompanhar em{" "}
            <Link href="/exclusao-de-dados">/exclusao-de-dados</Link>.
          </li>
          <li>
            <strong>Por e-mail:</strong> escreva para{" "}
            <a href={`mailto:${ENCARREGADO.email}`}>{ENCARREGADO.email}</a> a
            partir do e-mail cadastrado.
          </li>
        </ol>
        <p>
          O que é apagado: o token do Instagram (revogado também na Meta), seus
          vídeos no armazenamento, projetos, templates, agendamentos e a sua
          conta. Os registros de auditoria são anonimizados. Tudo em até{" "}
          <strong>{PRAZO_DE_EXCLUSAO_HORAS} horas</strong>, com confirmação por
          e-mail. A exclusão é irreversível. O que a lei nos obriga a manter
          (registros fiscais da cobrança) fica pelo prazo legal, sem ligação com
          a sua conta.
        </p>
        <p>
          Instruções detalhadas e consulta do estado de um pedido:{" "}
          <Link href="/exclusao-de-dados">/exclusao-de-dados</Link>.
        </p>
      </Secao>

      <Secao titulo="Segurança">
        <p>
          Tráfego cifrado (HTTPS), tokens do Instagram cifrados em repouso com
          chave que fica só no servidor, arquivos em armazenamento privado com
          links temporários e controle de acesso por linha no banco de dados.
          Em caso de incidente de segurança que afete seus dados, comunicamos a
          ANPD e você conforme a regulamentação vigente.
        </p>
      </Secao>

      <Secao titulo="Mudanças nesta política">
        <p>
          Quando mudar algo relevante, a data no topo muda e avisamos por e-mail
          quem tem conta. A versão vigente é sempre a publicada nesta página.
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
