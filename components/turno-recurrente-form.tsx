"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { DIAS_SEMANA, formatearDias } from "@/lib/turnos";

interface TurnoRecurrenteFormProps {
  rpId: string;
  clubId: string;
  existingFechas: string[];
  tieneTurnoFijo: boolean;
  onAssigned: () => void | Promise<void>;
}

function localDateToISO(d: Date) {
  const copy = new Date(d);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 10);
}

function todayISO() {
  return localDateToISO(new Date());
}

export function TurnoRecurrenteForm({
  rpId,
  clubId,
  existingFechas,
  tieneTurnoFijo,
  onAssigned,
}: TurnoRecurrenteFormProps) {
  const [mode, setMode] = useState<"individual" | "fijo">("individual");
  const [dateInput, setDateInput] = useState("");
  const [pendingDates, setPendingDates] = useState<string[]>([]);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [fechaInicio, setFechaInicio] = useState(todayISO());
  const [genError, setGenError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingSet = new Set(existingFechas);

  // ----- Modo "Fechas sueltas" (sin cambios respecto a como funcionaba) -----

  function handleAddSingleDate() {
    setGenError(null);
    if (!dateInput) {
      setGenError("Selecciona una fecha.");
      return;
    }
    if (dateInput < todayISO()) {
      setGenError("La fecha no puede ser en el pasado.");
      return;
    }
    if (existingSet.has(dateInput)) {
      setGenError("Ese RP ya tiene turno ese día.");
      return;
    }
    setPendingDates((prev) =>
      prev.includes(dateInput) ? prev : [...prev, dateInput].sort(),
    );
    setDateInput("");
  }

  function removePendingDate(fecha: string) {
    setPendingDates((prev) => prev.filter((f) => f !== fecha));
  }

  async function handleSubmitFechas() {
    if (pendingDates.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error: upsertError } = await supabase.from("rp_schedule").upsert(
        pendingDates.map((fecha) => ({
          rp_id: rpId,
          club_id: clubId,
          fecha,
          es_fijo: false,
        })),
        { onConflict: "rp_id,club_id,fecha", ignoreDuplicates: true },
      );

      if (upsertError) throw upsertError;

      setPendingDates([]);
      await onAssigned();
    } catch (err) {
      console.error("Error asignando turnos:", err);
      setError("No pudimos asignar los turnos. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  // ----- Modo "Días fijos": una sola fila, sin fecha de fin -----

  function toggleWeekday(value: number) {
    setWeekdays((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value],
    );
  }

  async function handleSubmitFijo() {
    setError(null);
    setGenError(null);

    if (weekdays.length === 0) {
      setGenError("Selecciona al menos un día de la semana.");
      return;
    }
    if (!fechaInicio) {
      setGenError("Indica desde cuándo aplica.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      // Una sola fila describe el turno completo. `fecha` sigue siendo NOT
      // NULL en la tabla, así que guarda la misma fecha de inicio; lo que
      // manda para interpretar el turno es es_fijo + dias_semana.
      const { error: insertError } = await supabase.from("rp_schedule").insert({
        rp_id: rpId,
        club_id: clubId,
        fecha: fechaInicio,
        es_fijo: true,
        dias_semana: [...weekdays].sort((a, b) => a - b),
        fecha_inicio: fechaInicio,
      });

      if (insertError) {
        // Choca con el índice único (rp_id, club_id, fecha) si ese RP ya
        // tiene una fecha suelta justo ese día.
        if (insertError.code === "23505") {
          setError(
            "Ese RP ya tiene un turno guardado con esa fecha de inicio. Elige otra fecha o quita el turno suelto de ese día.",
          );
          return;
        }
        throw insertError;
      }

      setWeekdays([]);
      setFechaInicio(todayISO());
      await onAssigned();
    } catch (err) {
      console.error("Error guardando turno fijo:", err);
      setError("No pudimos guardar el turno fijo. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-1 rounded-lg border border-input p-1"
        role="group"
        aria-label="Tipo de turno"
      >
        <Button
          type="button"
          variant={mode === "individual" ? "default" : "ghost"}
          size="sm"
          className="flex-1"
          onClick={() => setMode("individual")}
        >
          Fechas sueltas
        </Button>
        <Button
          type="button"
          variant={mode === "fijo" ? "default" : "ghost"}
          size="sm"
          className="flex-1"
          onClick={() => setMode("fijo")}
        >
          Días fijos
        </Button>
      </div>

      {mode === "individual" ? (
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={`turno-fecha-${rpId}`}>Fecha</Label>
            <Input
              id={`turno-fecha-${rpId}`}
              type="date"
              min={todayISO()}
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
            />
          </div>
          <Button type="button" size="sm" onClick={handleAddSingleDate}>
            Agregar fecha
          </Button>
        </div>
      ) : tieneTurnoFijo ? (
        <p className="text-sm text-muted-foreground">
          Este RP ya tiene un turno fijo. Quítalo abajo si quieres cambiar los
          días.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Días de la semana</Label>
            <div
              className="flex gap-1.5"
              role="group"
              aria-label="Días de la semana"
            >
              {DIAS_SEMANA.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleWeekday(d.value)}
                  aria-pressed={weekdays.includes(d.value)}
                  aria-label={d.nombre}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md border text-xs font-semibold transition-colors",
                    weekdays.includes(d.value)
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-input text-muted-foreground hover:bg-muted",
                  )}
                >
                  {d.corto}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`turno-desde-${rpId}`}>Desde</Label>
            <Input
              id={`turno-desde-${rpId}`}
              type="date"
              value={fechaInicio}
              onChange={(e) => setFechaInicio(e.target.value)}
            />
          </div>
          {weekdays.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Trabajará {formatearDias(weekdays)} cada semana, sin fecha de
              término.
            </p>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSubmitFijo}
            disabled={submitting}
          >
            {submitting ? "Guardando..." : "Guardar turno fijo"}
          </Button>
        </div>
      )}

      {genError && (
        <p className="text-sm text-destructive" role="alert">
          {genError}
        </p>
      )}

      {mode === "individual" && pendingDates.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {pendingDates.map((fecha) => (
              <span
                key={fecha}
                className="inline-flex items-center gap-1 rounded-md bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
              >
                {fecha}
                <button
                  type="button"
                  onClick={() => removePendingDate(fecha)}
                  aria-label={`Quitar ${fecha}`}
                  className="font-semibold text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmitFechas}
            disabled={submitting}
          >
            {submitting
              ? "Asignando..."
              : `Asignar ${pendingDates.length} turno${pendingDates.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
