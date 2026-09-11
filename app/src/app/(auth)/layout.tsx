import Link from "next/link";

export default function LayoutAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <Link
        href="/"
        className="font-heading mb-8 text-2xl font-semibold tracking-tight"
      >
        Page<span className="text-primary">Mask</span>
      </Link>
      {/*
        `main` e não `div`: sem um marco principal, quem navega por leitor de
        tela não tem como pular direto para o formulário — e estas telas são
        quase só formulário. O layout de `/app/*` já tem o dele.
      */}
      <main className="w-full max-w-sm">{children}</main>
    </div>
  );
}
