"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface TurnoRecurrenteFormProps {
  rpId: string;
  clubId: string;
  existingFechas: string[];
  onAssigned: () => void | Promise<void>;
}

const DIAS_SEMANA = [
  { value: 1, label: "L" },
  { value: 2, label: "M" },
  { value: 3, label: "M" },
  { value: 4, label: "J" },
  { value: 5, label: "V" },
  { value: 6, label: "S" },
  { value: 0, label: "D" },
];

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
  onAssigned,
}: TurnoRecurrenteFormProps) {
  const [mode, setMode] = useState<"individual" | "semanal">("individual");
  const [dateInput, setDateInput] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [pendingDates, setPendingDates] = useState<string[]>([]);
  const [genError, setGenError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingSet = new Set(existingFechas);

  function addDates(fechas: string[]) {
    setPendingDates((prev) => {
      const merged = new Set(prev);
      for (const f of fechas) merged.add(f);
      return Array.from(merged).sort();
    });
  }

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
    addDates([dateInput]);
    setDateInput("");
  }

  function toggleWeekday(value: number) {
    setWeekdays((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value],
    );
  }

  function handleGenerateWeekly() {
    setGenError(null);
    if (weekdays.length === 0) {
      setGenError("Selecciona al menos un día de la semana.");
      return;
    }
    if (!rangeStart || !rangeEnd) {
      setGenError("Selecciona desde y hasta cuándo repetir.");
      return;
    }
    if (rangeStart < todayISO()) {
      setGenError("La fecha de inicio no puede ser en el pasado.");
      return;
    }
    if (rangeEnd < rangeStart) {
      setGenError("La fecha final debe ser después de la fecha de inicio.");
      return;
    }

    const start = new Date(`${rangeStart}T00:00:00`);
    const end = new Date(`${rangeEnd}T00:00:00`);
    const generated: string[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      if (weekdays.includes(cursor.getDay())) {
        const iso = localDateToISO(cursor);
        if (!existingSet.has(iso)) generated.push(iso);
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    if (generated.length === 0) {
      setGenError("No se generó ninguna fecha nueva en ese rango.");
      return;
    }
    addDates(generated);
  }

  function removePendingDate(fecha: string) {
    setPendingDates((prev) => prev.filter((f) => f !== fecha));
  }

  async function handleSubmit() {
    if (pendingDates.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error: upsertError } = await supabase.from("rp_schedule").upsert(
        pendingDates.map((fecha) => ({ rp_id: rpId, club_id: clubId, fecha })),
        { onConflict: "rp_id,club_id,fecha", ignoreDuplicates: true },
      );

      if (upsertError) throw upsertError;

      setPendingDates([]);
      setWeekdays([]);
      setRangeStart("");
      setRangeEnd("");
      await onAssigned();
    } catch (err) {
      console.error("Error asignando turnos:", err);
      setError("No pudimos asignar los turnos. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-1 rounded-lg border border-input p-1"
        role="group"
        aria-label="Tipo de asignación"
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
          variant={mode === "semanal" ? "default" : "ghost"}
          size="sm"
          className="flex-1"
          onClick={() => setMode("semanal")}
        >
          Repetir semanal
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
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Días de la semana</Label>
            <div className="flex gap-1.5" role="group" aria-label="Días de la semana">
              {DIAS_SEMANA.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleWeekday(d.value)}
                  aria-pressed={weekdays.includes(d.value)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md border text-xs font-semibold transition-colors",
                    weekdays.includes(d.value)
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-input text-muted-foreground hover:bg-muted",
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`turno-desde-${rpId}`}>Desde</Label>
              <Input
                id={`turno-desde-${rpId}`}
                type="date"
                min={todayISO()}
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`turno-hasta-${rpId}`}>Hasta</Label>
              <Input
                id={`turno-hasta-${rpId}`}
                type="date"
                min={rangeStart || todayISO()}
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
              />
            </div>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={handleGenerateWeekly}>
            Generar fechas
          </Button>
        </div>
      )}

      {genError && (
        <p className="text-sm text-destructive" role="alert">
          {genError}
        </p>
      )}

      {pendingDates.length > 0 && (
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
          <Button type="button" size="sm" onClick={handleSubmit} disabled={submitting}>
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
