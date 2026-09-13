/**
 * O texto da landing, fora do JSX.
 *
 * Copy é a coisa que mais muda numa página de lançamento, e revisar mudança de
 * texto dentro de marcação é caro. Separado aqui, um diff de copy é um diff de
 * copy.
 *
 * REGRA DO LANÇAMENTO: **nenhum número inventado, nenhum depoimento**. O
 * produto é novo e não tem cliente para citar. Todo número que aparece na
 * página vem de um destes três lugares, nunca de outro:
 *
 *   · a tabela `plans` (preço, cota, contas, projetos);
 *   · `prova.json`, que é saída literal do pipeline de render;
 *   · uma constante do próprio produto (retenção de 30 dias, prazo da LGPD).
 */

export const PASSOS = [
  {
    titulo: "Suba a pasta de vídeos",
    texto:
      "Arraste o lote inteiro. Cada arquivo vai do seu navegador direto para o " +
      "armazenamento, e é inspecionado antes de entrar na fila — codec, " +
      "duração e tamanho conferidos, um por um.",
  },
  {
    titulo: "Defina o template uma vez",
    texto:
      "Cabeçalho da sua página, frase de chamada e enquadramento. O mesmo " +
      "padrão vale para todos os vídeos do projeto e para os próximos lotes: " +
      "você não repete a configuração a cada envio.",
  },
  {
    titulo: "Receba editado e conferido",
    texto:
      "Cada vídeo sai com o relatório das sete checagens que provam que a " +
      "edição fez o que devia. O lote inteiro desce em um ZIP, com o " +
      "relatório junto.",
  },
] as const;

export const PERGUNTAS = [
  {
    pergunta: "Preciso instalar alguma coisa?",
    resposta:
      "Não. O envio acontece no navegador e a edição roda nos nossos " +
      "servidores. Você só precisa dos arquivos de vídeo.",
  },
  {
    pergunta: "O PageMask publica sozinho no Instagram?",
    resposta:
      "Ainda não. A conexão com a conta do Instagram já existe no produto, mas " +
      "a publicação automática depende da aprovação do aplicativo pela Meta, " +
      "que está em análise. Até ela sair, você baixa o lote pronto e publica " +
      "como já publica hoje — e nós avisamos quando a publicação automática " +
      "for liberada.",
  },
  {
    pergunta: "O que acontece se um vídeo não passar na verificação?",
    resposta:
      "Ele não é entregue como pronto. O relatório aponta qual checagem " +
      "falhou e com que medida, e o vídeo volta para a fila em vez de sair " +
      "errado sem ninguém perceber.",
  },
  {
    pergunta: "Vocês usam IA para editar o vídeo?",
    resposta:
      "No render, não. O recorte, a cobertura do perfil antigo e a composição " +
      "são determinísticos: o mesmo arquivo com o mesmo template dá sempre o " +
      "mesmo resultado, e é isso que permite conferir a saída por medida. IA " +
      "entra só na transcrição da legenda, e o texto transcrito fica gravado " +
      "antes do render — dá para revisar e corrigir antes de o vídeo sair.",
  },
  {
    pergunta: "Por quanto tempo vocês guardam meus vídeos?",
    resposta:
      "Trinta dias no armazenamento, depois os arquivos expiram sozinhos. " +
      "Você pode excluir um projeto antes disso quando quiser, e a exclusão da " +
      "conta apaga vídeos, tokens e dados de cadastro na mesma hora.",
  },
  {
    pergunta: "Posso cancelar quando quiser?",
    resposta:
      "Sim. A assinatura é mensal, sem fidelidade, e o cancelamento acontece " +
      "no portal da Stripe, em português. O pagamento é processado pela " +
      "Stripe: o PageMask não recebe nem guarda o número do seu cartão.",
  },
] as const;
