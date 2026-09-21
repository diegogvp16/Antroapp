import Link from "next/link";
import { ThemeNoche } from "@/components/theme-noche";

export default function AccesoNegociosPage() {
  return (
    <ThemeNoche className="items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center text-4xl">¿Tienes un antro?</h1>
        <div className="flex flex-col gap-3">
          <Link
            href="/dueno/login"
            className="rounded-md border border-border px-4 py-3.5 text-center text-sm font-medium text-foreground hover:bg-muted"
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
    </ThemeNoche>
  );
}
