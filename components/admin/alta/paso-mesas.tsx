"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_MESAS, generarMesas } from "@/lib/domain/alta-club";
import { Campo } from "./campo";
import { nuevaClave, type FilaMesa } from "./estado";

export function PasoMesas({
  mesas,
  errores,
  onCambio,
}: {
  mesas: FilaMesa[];
  errores: Record<string, string>;
  onCambio: (m: FilaMesa[]) => void;
}) {
  const [cantidad, setCantidad] = useState("20");
  const [prefijo, setPrefijo] = useState("");
  const [capacidad, setCapacidad] = useState("8");
  const capacidadTotal = mesas.reduce((s, m) => s + (Number.isFinite(m.capacidad) ? m.capacidad : 0), 0);

  function generar() {
    const nuevas = generarMesas(mesas, Number(cantidad) || 0, prefijo, Math.max(1, Math.min(100, Number(capacidad) || 1)));
    onCambio([...mesas, ...nuevas.map((m) => ({ ...m, clave: nuevaClave() }))]);
  }
  const cambiar = (clave: string, cambio: Partial<FilaMesa>) => onCambio(mesas.map((m) => (m.clave === clave ? { ...m, ...cambio } : m)));

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">Generar mesas</legend>
        <div className="grid grid-cols-3 gap-3">
          <Campo id="gen-cantidad" etiqueta="Cantidad">
            <Input id="gen-cantidad" className="h-10" inputMode="numeric" value={cantidad} onChange={(e) => setCantidad(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Campo>
          <Campo id="gen-prefijo" etiqueta="Prefijo" opcional>
            <Input id="gen-prefijo" className="h-10" maxLength={20} placeholder="VIP" value={prefijo} onChange={(e) => setPrefijo(e.target.value)} />
          </Campo>
          <Campo id="gen-capacidad" etiqueta="Personas">
            <Input id="gen-capacidad" className="h-10" inputMode="numeric" value={capacidad} onChange={(e) => setCapacidad(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Campo>
        </div>
        <Button type="button" variant="outline" className="h-10 self-start" onClick={generar} disabled={mesas.length >= MAX_MESAS}>
          Agregar {Number(cantidad) || 0} mesas {prefijo.trim() ? `«${prefijo.trim()} 1…»` : "«1, 2, 3…»"}
        </Button>
      </fieldset>

      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">
          {mesas.length} {mesas.length === 1 ? "mesa" : "mesas"} · {capacidadTotal} personas
        </p>
        <div className="flex gap-2">
          {mesas.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onCambio([])}>
              Quitar todas
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => onCambio([...mesas, { clave: nuevaClave(), numero: "", capacidad: Number(capacidad) || 4 }])}>
            Agregar una
          </Button>
        </div>
      </div>

      {errores.mesas && (
        <p role="alert" className="text-xs font-medium text-status-err">
          {errores.mesas}
        </p>
      )}

      {mesas.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Sin mesas todavía. Puedes darlo de alta sin mesas y agregarlas después desde el panel del dueño.
        </p>
      ) : (
        <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1" aria-label="Mesas del antro">
          {mesas.map((m, i) => {
            const eNum = errores[`mesas.${i}.numero`];
            const eCap = errores[`mesas.${i}.capacidad`];
            return (
              <li key={m.clave} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Nombre de la mesa ${i + 1}`}
                    className="h-10 flex-1"
                    maxLength={30}
                    value={m.numero}
                    aria-invalid={!!eNum || undefined}
                    onChange={(e) => cambiar(m.clave, { numero: e.target.value })}
                  />
                  <Input
                    aria-label={`Personas en la mesa ${m.numero || i + 1}`}
                    className="h-10 w-20 tabular-nums"
                    inputMode="numeric"
                    value={Number.isFinite(m.capacidad) ? String(m.capacidad) : ""}
                    aria-invalid={!!eCap || undefined}
                    onChange={(e) => cambiar(m.clave, { capacidad: e.target.value === "" ? Number.NaN : Number(e.target.value.replace(/\D/g, "").slice(0, 3)) })}
                  />
                  <Button type="button" variant="ghost" size="icon-lg" aria-label={`Quitar la mesa ${m.numero || i + 1}`} onClick={() => onCambio(mesas.filter((x) => x.clave !== m.clave))}>
                    <Trash2 />
                  </Button>
                </div>
                {(eNum || eCap) && (
                  <p role="alert" className="text-xs font-medium text-status-err">
                    {eNum ?? eCap}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
