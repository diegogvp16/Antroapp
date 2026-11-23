"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { CLASE_TEMA_REPORTES, esTemaReportes, TEMA_REPORTES, type TemaReportes } from "@/lib/tema-reportes";

// Para comparar los temas en la vista previa sin cambiar el código:
// ?tema=oscuro | claro | actual. En producción no aplica (manda TEMA_REPORTES).
const SE_PUEDE_COMPARAR = process.env.NEXT_PUBLIC_VERCEL_ENV !== "production";

function leerTema(): TemaReportes {
  if (!SE_PUEDE_COMPARAR) return TEMA_REPORTES;
  const pedido = new URLSearchParams(window.location.search).get("tema");
  return esTemaReportes(pedido) ? pedido : TEMA_REPORTES;
}
const sinSuscripcion = () => () => {};

// Envuelve la pantalla con la clase del tema elegido en lib/tema-reportes.ts.
export function TemaReportesContenedor({ className, children }: { className?: string; children: React.ReactNode }) {
  const tema = useSyncExternalStore(sinSuscripcion, leerTema, () => TEMA_REPORTES);
  return <div className={cn(CLASE_TEMA_REPORTES[tema], tema !== "actual" && "font-sans", className)}>{children}</div>;
}
