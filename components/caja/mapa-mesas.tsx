"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ESTADO_MESA_BADGE,
  ESTADO_MESA_LABEL,
  estadoMesa,
  formatearCentavos,
  resumenSesion,
  type DatosCaja,
} from "@/lib/domain/caja";

// Cuadrícula de mesas de la noche con su estado, total consumido y saldo.
export function MapaMesas({
  datos,
  puedeAbrir,
  abriendoId,
  onSeleccionar,
  onAbrir,
}: {
  datos: DatosCaja;
  // Permiso abrir_mesa y noche sin cerrar.
  puedeAbrir: boolean;
  abriendoId: string | null;
  onSeleccionar: (mesaId: string) => void;
  onAbrir: (mesaId: string) => void;
}) {
  if (datos.mesas.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Este antro no tiene mesas dadas de alta. El dueño las agrega desde su panel.
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-2 min-[380px]:grid-cols-3 sm:grid-cols-4">
      {datos.mesas.map((mesa) => {
        const { estado, sesion, sePuedeAbrir } = estadoMesa(
          datos.sesiones.filter((s) => s.mesa_id === mesa.id),
        );
        const totales = sesion ? resumenSesion(sesion.id, datos.consumos, datos.pagos) : null;
        const cuentas = sesion ? datos.cuentas.filter((c) => c.sesion_id === sesion.id).length : 0;

        return (
          <li
            key={mesa.id}
            className={cn(
              "flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-2.5",
              estado === "abierta" && "border-status-ok/40",
              estado === "cerrada" && "border-status-warn/40",
            )}
          >
            <button
              type="button"
              onClick={() => onSeleccionar(mesa.id)}
              className="flex min-w-0 flex-col gap-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="text-base font-semibold whitespace-nowrap">{mesa.numero}</span>
                <Badge variant={ESTADO_MESA_BADGE[estado]}>{ESTADO_MESA_LABEL[estado]}</Badge>
              </div>
              {totales ? (
                <div className="flex flex-col text-xs">
                  <span className="text-muted-foreground">
                    {cuentas} {cuentas === 1 ? "cuenta" : "cuentas"}
                  </span>
                  <span className="tabular-nums">Consumo {formatearCentavos(totales.consumido)}</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      totales.saldo > 0 && "font-medium text-status-warn",
                      totales.saldo < 0 && "font-medium text-status-err",
                    )}
                  >
                    Saldo {formatearCentavos(totales.saldo)}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {mesa.capacidad} {mesa.capacidad === 1 ? "lugar" : "lugares"}
                </span>
              )}
            </button>
            {puedeAbrir && sePuedeAbrir && (
              <Button
                type="button"
                size="sm"
                variant={estado === "libre" ? "default" : "outline"}
                disabled={abriendoId !== null}
                onClick={() => onAbrir(mesa.id)}
              >
                {abriendoId === mesa.id
                  ? "Abriendo..."
                  : estado === "libre"
                    ? "Abrir mesa"
                    : "Abrir otra vez"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
