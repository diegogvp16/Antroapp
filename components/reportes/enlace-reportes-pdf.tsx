"use client";

// Enlace a /grupo/reportes (reportes PDF). Solo aparece si la bandera
// 'reportes_pdf' está encendida para alguno de los antros dados; mientras
// pregunta, y si está apagada, no ocupa lugar.
import { useEffect, useState } from "react";
import Link from "next/link";
import { FileDown } from "lucide-react";
import { leerFunciones } from "@/lib/funciones";
import { cn } from "@/lib/utils";

export function EnlaceReportesPdf({ clubIds, className }: { clubIds: readonly string[]; className?: string }) {
  const clave = Array.from(new Set(clubIds)).sort().join(",");
  const [destino, setDestino] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const ids = clave ? clave.split(",") : [];
    if (ids.length === 0) {
      setDestino(null);
      return;
    }
    void Promise.all(ids.map((id) => leerFunciones(id))).then((banderas) => {
      if (!vivo) return;
      const activos = ids.filter((_, i) => banderas[i].has("reportes_pdf"));
      setDestino(activos.length === 0 ? null : activos.length === 1 ? `/grupo/reportes?club=${activos[0]}` : "/grupo/reportes");
    });
    return () => {
      vivo = false;
    };
  }, [clave]);

  if (!destino) return null;
  return (
    <Link
      href={destino}
      className={cn(
        "inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted",
        className,
      )}
    >
      <FileDown className="size-4" aria-hidden="true" />
      Reportes PDF (noche y semana)
    </Link>
  );
}
