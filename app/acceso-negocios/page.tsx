import Link from "next/link";

export default function AccesoNegociosPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          ¿Tienes un antro?
        </h1>
        <div className="flex flex-col gap-3">
          <Link
            href="/dueno/login"
            className="rounded-md border border-border px-4 py-3 text-center text-sm font-medium text-foreground hover:bg-muted/50"
          >
            Dueño de antro
          </Link>
        </div>
        <Link
          href="/"
          className="text-center text-xs text-muted-foreground underline underline-offset-4"
        >
          Volver
        </Link>
      </div>
    </div>
  );
}
