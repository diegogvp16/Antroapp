import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col items-center gap-10">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
            AntroApp
          </h1>
          <p className="text-base text-zinc-600 dark:text-zinc-400">
            Reserva tu lugar en el antro en segundos.
          </p>
        </div>

        <div className="flex w-full flex-col gap-4">
          <Button
            render={<Link href="/cliente" />}
            nativeButton={false}
            size="lg"
            className="h-14 w-full text-base"
          >
            Soy Cliente
          </Button>
          <Button
            render={<Link href="/rp/login" />}
            nativeButton={false}
            size="lg"
            variant="outline"
            className="h-14 w-full text-base"
          >
            Soy RP
          </Button>
          <Button
            render={<Link href="/antro" />}
            nativeButton={false}
            size="lg"
            variant="secondary"
            className="h-14 w-full text-base"
          >
            Soy Antro
          </Button>
        </div>
      </div>
    </div>
  );
}
