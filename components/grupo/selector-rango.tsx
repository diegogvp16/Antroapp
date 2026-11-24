"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validarRango } from "@/lib/domain/grupo";
import { mesOperativo, semanaOperativa, type RangoNoches } from "@/lib/fechas";
import { cn } from "@/lib/utils";

export type Atajo = "semana" | "anterior" | "mes" | "personalizado";

const ATAJOS: readonly (readonly [Atajo, string])[] = [
  ["semana", "Esta semana"],
  ["anterior", "Semana anterior"],
  ["mes", "Este mes"],
  ["personalizado", "Personalizado"],
];

// Rango de un atajo, calculado en el momento (noche operativa de México).
export function rangoDeAtajo(atajo: Exclude<Atajo, "personalizado">): RangoNoches {
  if (atajo === "anterior") return semanaOperativa(new Date(), 1);
  if (atajo === "mes") return mesOperativo();
  return semanaOperativa();
}

// Atajos de rango y, en "Personalizado", dos fechas que se validan (máximo
// 93 días) antes de llamar a la base.
export function SelectorRango({
  atajo,
  rango,
  deshabilitado,
  onCambiar,
}: {
  atajo: Atajo;
  rango: RangoNoches;
  deshabilitado?: boolean;
  onCambiar: (atajo: Atajo, rango: RangoNoches) => void;
}) {
  const [mostrarPersonalizado, setMostrarPersonalizado] = useState(atajo === "personalizado");
  const [desde, setDesde] = useState(rango.desde);
  const [hasta, setHasta] = useState(rango.hasta);
  const [error, setError] = useState<string | null>(null);

  const activo: Atajo = mostrarPersonalizado ? "personalizado" : atajo;

  function elegir(a: Atajo) {
    setError(null);
    if (a === "personalizado") {
      // Empieza con el rango que se está viendo.
      setDesde(rango.desde);
      setHasta(rango.hasta);
      setMostrarPersonalizado(true);
      return;
    }
    setMostrarPersonalizado(false);
    onCambiar(a, rangoDeAtajo(a));
  }

  function consultar(e: React.FormEvent) {
    e.preventDefault();
    const nuevo = { desde, hasta };
    const mensaje = validarRango(nuevo);
    setError(mensaje);
    if (mensaje) return;
    onCambiar("personalizado", nuevo);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-4" role="tablist">
        {ATAJOS.map(([a, etiqueta]) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={activo === a}
            disabled={deshabilitado}
            onClick={() => elegir(a)}
            className={cn(
              "h-10 rounded-md px-2 text-sm font-medium text-muted-foreground disabled:opacity-50",
              activo === a && "bg-background text-foreground shadow-sm",
            )}
          >
            {etiqueta}
          </button>
        ))}
      </div>

      {mostrarPersonalizado && (
        <form onSubmit={consultar} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="grupo-desde">Desde</Label>
              <Input
                id="grupo-desde"
                type="date"
                value={desde}
                max={hasta || undefined}
                onChange={(e) => {
                  setDesde(e.target.value);
                  setError(null);
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="grupo-hasta">Hasta</Label>
              <Input
                id="grupo-hasta"
                type="date"
                value={hasta}
                min={desde || undefined}
                onChange={(e) => {
                  setHasta(e.target.value);
                  setError(null);
                }}
              />
            </div>
          </div>
          {error && (
            <p className="text-sm text-status-warn" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="outline" className="w-fit" disabled={deshabilitado}>
            Consultar
          </Button>
        </form>
      )}
    </div>
  );
}
