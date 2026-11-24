"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportarError } from "@/lib/reportar-error";

// Pantalla de error de cualquier ruta. Avisa al admin (una vez) y deja
// reintentar.
export default function ErrorDeRuta({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportarError(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Algo salió mal</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Ya nos llegó el aviso. Intenta de nuevo; si sigue pasando, cierra la
        app y vuelve a abrirla.
      </p>
      <Button type="button" onClick={reset}>
        Reintentar
      </Button>
    </div>
  );
}
