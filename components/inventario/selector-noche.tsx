"use client";

import { Button } from "@/components/ui/button";
import { etiquetaNoche, sumarDiasISO } from "@/lib/fechas";

// Elegir la noche operativa de un reporte (fase 2): anterior, siguiente o una
// fecha. No deja pasar de la noche de hoy.
export function SelectorNoche({ fecha, hoy, onCambio }: { fecha: string; hoy: string; onCambio: (f: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" className="h-11 px-3" aria-label="Noche anterior" onClick={() => onCambio(sumarDiasISO(fecha, -1))}>
          ←
        </Button>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Noche</span>
          <input
            type="date"
            value={fecha}
            max={hoy}
            onChange={(e) => e.target.value && onCambio(e.target.value > hoy ? hoy : e.target.value)}
            className="h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-base"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-3"
          aria-label="Noche siguiente"
          disabled={fecha >= hoy}
          onClick={() => onCambio(sumarDiasISO(fecha, 1))}
        >
          →
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Noche del {etiquetaNoche(fecha)}
        {fecha === hoy ? " (en curso)" : ""}. La noche va de las 08:00 a las 07:59 del día siguiente.
      </p>
    </div>
  );
}
