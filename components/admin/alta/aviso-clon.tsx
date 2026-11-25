"use client";

import { Button } from "@/components/ui/button";
import type { Borrador } from "./estado";

// Aviso arriba del primer paso de un clon (B2): de dónde sale, qué hay que
// escribir (nombre, dirección, equipo) y lo que no se copió igual.
export function AvisoClon({ clon, onEnBlanco }: { clon: NonNullable<Borrador["clon"]>; onEnBlanco: () => void }) {
  return (
    <section aria-label="Clon" className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <p>
        Precargado con la configuración de <strong className="break-words">{clon.origen.nombre}</strong>: horario, cover y
        políticas, mesas, reglas de comisión, qué ven los RPs, permisos de caja
        {clon.productos ? " y el catálogo de productos (sin existencias)" : ""}. Revisa cada paso; puedes cambiar todo.
      </p>
      <p className="text-muted-foreground">
        Escribe el nombre y la dirección del antro nuevo, y su equipo. No se copian reservas, caja, comisiones, turnos, fotos,
        documentos ni personal.
      </p>
      {clon.avisos.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Para revisar">
          {clon.avisos.map((a) => (
            <li key={a} className="rounded-md border border-status-warn/40 bg-status-warn/10 p-2.5">
              {a}
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" className="h-10 self-start" onClick={onEnBlanco}>
        Mejor hacer un alta en blanco
      </Button>
    </section>
  );
}
