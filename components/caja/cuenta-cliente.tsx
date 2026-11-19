"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccionConMotivo, MensajeError, useAccion } from "@/components/caja/accion";
import { cn } from "@/lib/utils";
import {
  formatearCentavos,
  horaCorta,
  montoValido,
  nombreODefault,
  pesosACentavos,
  sumarVigentes,
  type CajaConsumo,
  type MesaCuenta,
} from "@/lib/domain/caja";

// Una cuenta (cliente o grupo sentado) con su RP, sus cargos y la captura de
// consumo. Los cargos no se borran: se anulan con motivo.
export function CuentaCliente({
  cuenta,
  consumos,
  nombres,
  editable,
  puedeRegistrar,
  puedeAnular,
  onCambio,
}: {
  cuenta: MesaCuenta;
  consumos: CajaConsumo[];
  nombres: Record<string, string>;
  // Sesión abierta y noche sin cerrar.
  editable: boolean;
  puedeRegistrar: boolean;
  puedeAnular: boolean;
  onCambio: () => Promise<void>;
}) {
  const consumoVigente = sumarVigentes(consumos);
  const rp =
    cuenta.origen === "walk_in"
      ? "Walk-in"
      : cuenta.rp_id
        ? nombreODefault(nombres, cuenta.rp_id, "RP")
        : "Sin RP";
  const { error, ejecutar } = useAccion();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium">{cuenta.cliente_nombre}</p>
          <p className="text-xs text-muted-foreground">
            {cuenta.personas ? `${cuenta.personas} pers. · ` : ""}RP: {rp}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="neutral">{cuenta.origen === "reserva" ? "Reserva" : "Walk-in"}</Badge>
          <span className="text-sm font-semibold tabular-nums">
            {formatearCentavos(consumoVigente)}
          </span>
        </div>
      </div>

      {consumos.length > 0 && (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {consumos.map((c) => (
            <li key={c.id} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className={cn("min-w-0", c.anulado && "text-muted-foreground line-through")}>
                  <p className="break-words">{c.concepto ?? "Consumo"}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    c.anulado && "text-muted-foreground line-through",
                  )}
                >
                  {formatearCentavos(c.monto_centavos)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {nombreODefault(nombres, c.registrado_por, "Equipo")} · {horaCorta(c.registrado_en)}
              </p>
              {c.anulado ? (
                <p className="text-xs break-words text-status-err">
                  Anulado por {nombreODefault(nombres, c.anulado_por, "Equipo")}
                  {c.anulado_en ? ` · ${horaCorta(c.anulado_en)}` : ""}: {c.motivo_anulacion}
                </p>
              ) : (
                editable &&
                puedeAnular && (
                  <AccionConMotivo
                    etiqueta="Anular"
                    etiquetaConfirmar="Anular cargo"
                    placeholder="Motivo de la anulación"
                    variante="destructive"
                    onConfirmar={(motivo) =>
                      ejecutar(
                        () =>
                          createClient().rpc("caja_anular_consumo", {
                            p_consumo_id: c.id,
                            p_motivo: motivo,
                          }),
                        onCambio,
                      )
                    }
                  />
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <MensajeError mensaje={error} />

      {editable && puedeRegistrar && <AgregarConsumo cuentaId={cuenta.id} onCambio={onCambio} />}
    </div>
  );
}

function AgregarConsumo({
  cuentaId,
  onCambio,
}: {
  cuentaId: string;
  onCambio: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [monto, setMonto] = useState("");
  const [concepto, setConcepto] = useState("");
  const { ocupado, error, ejecutar, limpiarError } = useAccion();

  if (!abierto) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setAbierto(true)}>
        + Agregar consumo
      </Button>
    );
  }

  const centavos = pesosACentavos(monto);
  const valido = montoValido(centavos);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!montoValido(centavos)) return;
        const ok = await ejecutar(
          () =>
            createClient().rpc("caja_registrar_consumo", {
              p_cuenta_id: cuentaId,
              p_monto_centavos: centavos,
              p_concepto: concepto.trim() || null,
            }),
          onCambio,
        );
        if (ok) {
          setMonto("");
          setConcepto("");
          setAbierto(false);
        }
      }}
    >
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`monto-${cuentaId}`}>Monto ($)</Label>
          <Input
            id={`monto-${cuentaId}`}
            autoFocus
            inputMode="decimal"
            placeholder="0.00"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            aria-invalid={monto.length > 0 && !valido}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`concepto-${cuentaId}`}>Concepto</Label>
          <Input
            id={`concepto-${cuentaId}`}
            placeholder="Opcional"
            maxLength={120}
            value={concepto}
            onChange={(e) => setConcepto(e.target.value)}
          />
        </div>
      </div>
      {monto.length > 0 && !valido && (
        <p className="text-xs text-muted-foreground">
          Escribe un monto entre $0.01 y $1,000,000 (ej. 1250.50).
        </p>
      )}
      <MensajeError mensaje={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!valido || ocupado}>
          {ocupado ? "Guardando..." : "Registrar consumo"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={ocupado}
          onClick={() => {
            setAbierto(false);
            setMonto("");
            setConcepto("");
            limpiarError();
          }}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}
