import { redirect } from "next/navigation";

import { exigirUsuario } from "@/lib/auth/sessao";

/**
 * `/app` não tem tela própria: a porta de entrada é a lista de projetos.
 *
 * O `exigirUsuario()` fica mesmo assim. A regra do projeto é "toda página sob
 * `/app/*` confere a própria sessão", e uma exceção — ainda que hoje inofensiva,
 * já que esta página não renderiza nada — é uma exceção que a próxima pessoa
 * copia ao criar a página seguinte.
 */
export default async function App() {
  await exigirUsuario("/app");
  redirect("/app/projetos");
}
