"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OPCIONES_COVER, esCoverModo } from "@/lib/cover";
import type { CoverModo } from "@/types";

const SELECT_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

interface CoverCampoProps {
  // Prefijo de los id de los controles, para que no choquen si hay dos
  // formularios en la misma página.
  idPrefix: string;
  modo: CoverModo;
  monto: string;
  onModoChange: (modo: CoverModo) => void;
  onMontoChange: (monto: string) => void;
  disabled?: boolean;
}

// Campo "Cover en la puerta". Es solo informativo: la validación vive en
// validarCover (lib/cover.ts) y la hace el formulario que lo usa al guardar.
export function CoverCampo({
  idPrefix,
  modo,
  monto,
  onModoChange,
  onMontoChange,
  disabled = false,
}: CoverCampoProps) {
  const idModo = `${idPrefix}_cover_modo`;
  const idMonto = `${idPrefix}_cover_monto`;
  const idAyuda = `${idPrefix}_cover_ayuda`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={idModo}>Cover en la puerta</Label>
      <select
        id={idModo}
        className={SELECT_CLASSES}
        value={modo}
        disabled={disabled}
        aria-describedby={idAyuda}
        onChange={(e) => {
          if (esCoverModo(e.target.value)) onModoChange(e.target.value);
        }}
      >
        {OPCIONES_COVER.map((opcion) => (
          <option key={opcion.valor} value={opcion.valor}>
            {opcion.etiqueta}
          </option>
        ))}
      </select>

      {modo === "monto" && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <Label htmlFor={idMonto}>Monto del cover (pesos)</Label>
          <Input
            id={idMonto}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="ej. 350"
            value={monto}
            disabled={disabled}
            aria-describedby={idAyuda}
            onChange={(e) => onMontoChange(e.target.value)}
            required
          />
        </div>
      )}

      <p id={idAyuda} className="text-xs text-muted-foreground">
        Solo informativo: la app no cobra nada; el antro cobra su cover en la
        puerta.
      </p>
    </div>
  );
}
