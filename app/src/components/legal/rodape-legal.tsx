import Link from "next/link";

import { ENCARREGADO } from "@/lib/legal/encarregado";

/**
 * A linha legal que precisa existir em toda tela alcançável sem login.
 *
 * Duas exigências, uma peça:
 *
 *   · ANPD 18/2024 — nome e contato do Encarregado em local de destaque no
 *     site. "Destaque" não é a última seção de uma política que ninguém abriu:
 *     é estar visível de onde a pessoa está;
 *   · App Review da Meta — as URLs de política de privacidade, termos e
 *     exclusão de dados precisam ser encontráveis a partir do site, não só
 *     digitadas direto na barra de endereço.
 *
 * Os layouts de `(publico)` e `(marketing)` têm os seus próprios rodapés, mais
 * completos; este é para as telas de entrada, que não passam por nenhum dos
 * dois — hoje, o único lugar que o usa.
 *
 * `encarregado` desliga só a linha do DPO. O padrão é **ligado**, e não
 * desligado, mesmo com o único chamador de hoje passando `false`: quem
 * acrescentar este rodapé a uma tela pública nova precisa herdar a linha por
 * omissão, não descobrir a falta dela numa auditoria. A exceção existe por
 * causa das telas de autenticação: ali ela era a última coisa abaixo do botão "Entrar" — um nome
 * próprio e um e-mail de contato competindo com o formulário, num lugar onde
 * ninguém está procurando quem responde por dados pessoais. A exigência da
 * ANPD continua cumprida: o link "Privacidade" segue neste mesmo rodapé, a um
 * clique, e a linha completa está em `/privacidade`, no rodapé de `(publico)`,
 * no de `(marketing)` e nas perguntas da landing — que é o caminho por onde a
 * pessoa de fato chega ao PageMask.
 */
export function RodapeLegal({
  className = "",
  encarregado = true,
}: {
  className?: string;
  encarregado?: boolean;
}) {
  return (
    <footer
      className={`text-muted-foreground text-center text-xs ${className}`.trim()}
    >
      <nav aria-label="Informações legais" className="flex justify-center gap-4">
        <Link href="/privacidade" className="hover:text-foreground">
          Privacidade
        </Link>
        <Link href="/termos" className="hover:text-foreground">
          Termos
        </Link>
        <Link href="/exclusao-de-dados" className="hover:text-foreground">
          Exclusão de dados
        </Link>
      </nav>
      {encarregado ? (
        <p className="mt-2">
          Encarregado de dados: {ENCARREGADO.nome} —{" "}
          <a
            href={`mailto:${ENCARREGADO.email}`}
            className="underline underline-offset-4"
          >
            {ENCARREGADO.email}
          </a>
        </p>
      ) : null}
    </footer>
  );
}
