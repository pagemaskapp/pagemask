/**
 * Leitura de pedaços de um arquivo remoto, com cache de blocos.
 *
 * A sondagem de contêiner (`./sonda`) faz dois tipos de leitura, e este arquivo
 * existe para servir bem aos dois:
 *
 *   · **muitas e pequenas** — o cabeçalho de uma caixa tem 8 bytes, e logo
 *     depois vem o cabeçalho da próxima. Uma requisição HTTP por 8 bytes seria
 *     absurdo, e são dezenas por arquivo. O bloco de 64 KiB transforma isso em
 *     uma requisição por trecho, e as leituras seguintes saem da memória.
 *
 *   · **uma grande** — a `moov` inteira, que num MP4 longo passa de meio mega
 *     (medido: 499 KB num vídeo de 10 minutos). Buscá-la bloco a bloco seriam
 *     dezenas de idas e voltas **em série**, e a soma dos tempos de resposta
 *     estoura o tempo de vida de uma função de servidor antes de o arquivo ser
 *     registrado. Por isso o que falta de uma faixa contígua vai numa
 *     requisição só.
 *
 * O cache é por instância e vive o que durar a sondagem de UM arquivo. Não há
 * cache entre requisições: seria memória crescendo sem limite num servidor sem
 * estado, e um objeto do R2 lido por um usuário não deve sobrar em lugar nenhum
 * quando o próximo chegar.
 */

const BLOCO = 64 * 1024;

/** Teto de bytes lidos por sondagem. Cabeçalho não passa nem perto disso. */
const TETO_DE_LEITURA = 32 * 1024 * 1024;

export class LeituraExcedidaError extends Error {
  constructor() {
    super("A sondagem leu mais bytes do que o permitido.");
    this.name = "LeituraExcedidaError";
  }
}

/**
 * O armazenamento devolveu menos bytes do que o intervalo pedido.
 *
 * É deliberadamente uma classe SEPARADA de `SondaError`, e a diferença decide o
 * destino do arquivo do usuário. `SondaError` significa "o arquivo tem
 * problema": quem chama grava um job `rejected` e **apaga o objeto**. Um
 * `Range` curto não é problema do arquivo — é do caminho até ele. Se as duas
 * coisas caíssem no mesmo lugar, uma resposta truncada do R2 faria o PageMask
 * apagar um vídeo perfeitamente bom e dizer ao dono que ele estava corrompido.
 *
 * Aqui o certo é falhar alto: erro de servidor, objeto intacto, confirme de
 * novo.
 */
export class LeituraIncompletaError extends Error {
  constructor(pedidos: number, recebidos: number) {
    super(
      `O armazenamento devolveu ${recebidos} bytes para um intervalo de ${pedidos}.`,
    );
    this.name = "LeituraIncompletaError";
  }
}

/** Busca crua de um intervalo fechado `[inicio, fim]`, como o HTTP Range. */
export type BuscaDeIntervalo = (inicio: number, fim: number) => Promise<Buffer>;

export class LeitorEmBlocos {
  readonly tamanho: number;

  private readonly buscar: BuscaDeIntervalo;
  private readonly blocos = new Map<number, Buffer>();
  private lidos = 0;

  constructor(tamanho: number, buscar: BuscaDeIntervalo) {
    this.tamanho = tamanho;
    this.buscar = buscar;
  }

  /**
   * Quantos bytes de verdade saíram da rede. Entra no `probe`, como prova — e
   * por isso conta o que TRAFEGOU, não o que foi pedido: byte servido do cache
   * não viajou e não entra na conta duas vezes.
   */
  get bytesLidos(): number {
    return this.lidos;
  }

  /**
   * Lê `quantidade` bytes a partir de `inicio`.
   *
   * Devolve **menos** bytes se o arquivo acabar antes — quem chama precisa
   * conferir o `length`, porque um arquivo truncado é justamente o caso em que
   * um parser desatento lê lixo e segue em frente.
   */
  async ler(inicio: number, quantidade: number): Promise<Buffer> {
    if (inicio < 0 || quantidade <= 0) return Buffer.alloc(0);
    if (inicio >= this.tamanho) return Buffer.alloc(0);

    const fim = Math.min(inicio + quantidade, this.tamanho); // exclusivo
    const primeiro = Math.floor(inicio / BLOCO);
    const ultimo = Math.floor((fim - 1) / BLOCO);

    await this.carregarFaixa(primeiro, ultimo);

    const partes: Buffer[] = [];
    for (let indice = primeiro; indice <= ultimo; indice += 1) {
      partes.push(this.blocos.get(indice) ?? Buffer.alloc(0));
    }

    const juntos = partes.length === 1 ? partes[0] : Buffer.concat(partes);
    const deslocamento = inicio - primeiro * BLOCO;
    return juntos.subarray(deslocamento, deslocamento + (fim - inicio));
  }

  /**
   * Garante que os blocos de `[primeiro, ultimo]` estão em memória, numa
   * requisição só.
   *
   * A faixa buscada vai do primeiro bloco FALTANTE ao último faltante — o que
   * já está em cache nas pontas não é pedido de novo. Bloco já presente no meio
   * da faixa viaja junto, porque não existe intervalo com buraco no HTTP; esses
   * bytes contam em `lidos` (passaram pela rede de fato) mas não sobrescrevem o
   * que já estava guardado.
   */
  private async carregarFaixa(primeiro: number, ultimo: number): Promise<void> {
    let a = primeiro;
    while (a <= ultimo && this.blocos.has(a)) a += 1;
    if (a > ultimo) return; // tudo já em memória

    let b = ultimo;
    while (b > a && this.blocos.has(b)) b -= 1;

    const inicio = a * BLOCO;
    const fim = Math.min((b + 1) * BLOCO, this.tamanho) - 1; // inclusivo
    const esperado = fim - inicio + 1;

    if (this.lidos + esperado > TETO_DE_LEITURA) throw new LeituraExcedidaError();

    const dados = await this.buscar(inicio, fim);

    // A aritmética de `ler()` — concatenar blocos e recortar pelo deslocamento
    // — só fecha se todo bloco que não é o último do arquivo tiver exatamente
    // `BLOCO` bytes. Um bloco curto no meio desalinha tudo que vem depois, e o
    // parser passa a ler campo de tamanho em cima de conteúdo: o resultado não
    // é um erro, é uma resposta ERRADA com cara de certa.
    if (dados.length !== esperado) {
      throw new LeituraIncompletaError(esperado, dados.length);
    }

    this.lidos += dados.length;

    for (let indice = a; indice <= b; indice += 1) {
      if (this.blocos.has(indice)) continue;
      const desloc = indice * BLOCO - inicio;
      this.blocos.set(indice, dados.subarray(desloc, desloc + BLOCO));
    }
  }
}
