import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeNoche } from "@/components/theme-noche";

export default function Home() {
  return (
    <ThemeNoche className="p-3">
      {/* Marco fino, como el borde de una invitación impresa. */}
      <div className="flex flex-1 flex-col border border-noche-accent/35 px-6 pb-6 pt-8">
        <p className="font-display text-2xl">AntroApp</p>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-10">
          <div className="noche-rise flex flex-col gap-5">
            <h1 className="text-[3.5rem] leading-[0.95] sm:text-7xl">
              La noche se reserva{" "}
              <span className="italic text-noche-accent">antes de salir.</span>
            </h1>
            <p className="max-w-xs text-base text-noche-muted">
              Elige tu antro, aparta tu lugar en segundos y llega con tu
              código.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              render={<Link href="/cliente/signup" />}
              nativeButton={false}
              size="lg"
              className="h-14 w-full text-base font-semibold"
            >
              Crear cuenta
            </Button>
            <Button
              render={<Link href="/cliente/login" />}
              nativeButton={false}
              size="lg"
              variant="outline"
              className="h-12 w-full text-base text-noche-text"
            >
              Ya tengo cuenta
            </Button>
          </div>
        </div>

        <Link
          href="/acceso-negocios"
          className="mx-auto pt-8 text-xs text-noche-muted underline underline-offset-4"
        >
          ¿Eres RP o tienes un antro? Accede aquí
        </Link>
      </div>
    </ThemeNoche>
  );
}
