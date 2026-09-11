import { Card, CardContent } from "@/components/ui/card";

/**
 * Seção que já tem lugar na navegação mas ainda não tem conteúdo.
 *
 * Diz qual fase entrega aquilo, para a tela vazia não parecer defeito.
 */
export function PaginaEmConstrucao({
  titulo,
  descricao,
  fase,
}: {
  titulo: string;
  descricao: string;
  fase: string;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        {titulo}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{descricao}</p>

      <Card className="mt-6">
        <CardContent className="text-muted-foreground text-sm">
          Esta seção ainda não está pronta — ela chega na <strong>{fase}</strong>.
          O lugar já existe para a navegação ficar estável enquanto o resto é
          construído.
        </CardContent>
      </Card>
    </div>
  );
}
