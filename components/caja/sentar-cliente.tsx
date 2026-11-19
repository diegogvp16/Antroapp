"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { cn } from "@/lib/utils";
import { nombreODefault, type ReservaSentable } from "@/lib/domain/caja";

type Modo = "reserva" | "walk_in";

// Sienta a un cliente en la mesa: una reserva de esta noche con la entrada
// ya confirmada en la puerta, o un walk-in con nombre. El RP lo decide la
// base a partir de la reserva (un walk-in nunca trae RP).
export function SentarCliente({
  sesionId,
  reservas,
  nombres,
  onCambio,
}: {
  sesionId: string;
  reservas: ReservaSentable[];
  nombres: Record<string, string>;
  onCambio: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [modo, setModo] = useState<Modo>(reservas.length > 0 ? "reserva" : "walk_in");
  const [reservaId, setReservaId] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [personas, setPersonas] = useState("");
  const { ocupado, error, ejecutar, limpiarError } = useAccion();

  function cerrar() {
    setAbierto(false);
    setReservaId(null);
    setNombre("");
    setPersonas("");
    limpiarError();
  }

  if (!abierto) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => {
          setModo(reservas.length > 0 ? "reserva" : "walk_in");
          setAbierto(true);
        }}
      >
        + Sentar cliente
      </Button>
    );
  }

  const personasNum = personas.trim() === "" ? null : Number(personas);
  const personasValidas =
    personasNum === null || (Number.isInteger(personasNum) && personasNum >= 1 && personasNum <= 50);
  const valido =
    modo === "reserva" ? reservaId !== null : nombre.trim().length > 0 && personasValidas;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valido) return;
        const ok = await ejecutar(
          () =>
            createClient().rpc(
              "caja_sentar_cliente",
              modo === "reserva"
                ? { p_sesion_id: sesionId, p_reservation_id: reservaId }
                : {
                    p_sesion_id: sesionId,
                    p_cliente_nombre: nombre.trim(),
                    p_personas: personasNum,
                  },
            ),
          onCambio,
        );
        if (ok) cerrar();
      }}
    >
      <p className="font-medium">Sentar cliente</p>

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
        {(["reserva", "walk_in"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={modo === m}
            onClick={() => setModo(m)}
            className={cn(
              "h-7 rounded-md text-sm font-medium text-muted-foreground",
              modo === m && "bg-background text-foreground shadow-sm",
            )}
          >
            {m === "reserva" ? "Con reserva" : "Walk-in"}
          </button>
        ))}
      </div>

      {modo === "reserva" ? (
        reservas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay reservas de esta noche con la entrada confirmada que falten por sentar.
            Primero se confirma la entrada en la puerta.
          </p>
        ) : (
          <fieldset className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            <legend className="sr-only">Reserva</legend>
            {reservas.map((r) => (
              <label
                key={r.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm",
                  reservaId === r.id && "border-foreground",
                )}
              >
                <input
                  type="radio"
                  name={`reserva-${sesionId}`}
                  value={r.id}
                  checked={reservaId === r.id}
                  onChange={() => setReservaId(r.id)}
                  className="shrink-0 accent-current"
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium">{r.cliente_nombre}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.personas} pers. · RP:{" "}
                    {r.source === "rp" && r.rp_id
                      ? nombreODefault(nombres, r.rp_id, "RP")
                      : "Sin RP"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )
      ) : (
        <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`walkin-nombre-${sesionId}`}>Nombre</Label>
            <Input
              id={`walkin-nombre-${sesionId}`}
              value={nombre}
              maxLength={120}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Nombre del cliente"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`walkin-personas-${sesionId}`}>Personas</Label>
            <Input
              id={`walkin-personas-${sesionId}`}
              inputMode="numeric"
              value={personas}
              onChange={(e) => setPersonas(e.target.value.replace(/\D/g, ""))}
              placeholder="—"
              aria-invalid={!personasValidas}
            />
          </div>
          {!personasValidas && (
            <p className="col-span-2 text-xs text-muted-foreground">Personas: de 1 a 50.</p>
          )}
          <p className="col-span-2 text-xs text-muted-foreground">
            Un walk-in no genera comisión de RP.
          </p>
        </div>
      )}

      <MensajeError mensaje={error} />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!valido || ocupado}>
          {ocupado ? "Sentando..." : "Sentar"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={ocupado} onClick={cerrar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
