"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatearCentavos } from "@/lib/domain/caja";
import { normalizarRendimiento, porcentajeEntrada, reservasOcurridas, textoPorcentaje, type RendimientoRp } from "@/lib/domain/grupo";
import { mensajeParaUsuario } from "@/lib/errores-base";
import type { RangoNoches } from "@/lib/fechas";
import { cn } from "@/lib/utils";

// Rendimiento por RP de un antro en el rango (grupo_rendimiento_rp): lo
// calcula la base con el mismo acceso que /grupo. Se pide al abrir la
// sección, no antes.
export function RendimientoPorRp({
  clubId,
  rango,
  abiertoAlInicio = false,
}: {
  clubId: string;
  rango: RangoNoches;
  abiertoAlInicio?: boolean;
}) {
  const [abierto, setAbierto] = useState(abiertoAlInicio);
  const [filas, setFilas] = useState<RendimientoRp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const ultima = useRef(0);

  const cargar = useCallback(async () => {
    const numero = ++ultima.current;
    setCargando(true);
    const { data, error: errorBase } = await createClient().rpc("grupo_rendimiento_rp", {
      p_club_id: clubId,
      p_desde: rango.desde,
      p_hasta: rango.hasta,
    });
    if (numero !== ultima.current) return;
    setCargando(false);
    if (errorBase) {
      setError(
        errorBase.code === "PGRST202"
          ? "El rendimiento por RP todavía no está disponible."
          : mensajeParaUsuario(errorBase, "No pudimos cargar el rendimiento por RP. Intenta de nuevo."),
      );
      return;
    }
    setError(null);
    setFilas((Array.isArray(data) ? data : []).map((f) => normalizarRendimiento(f as Record<string, unknown>)));
  }, [clubId, rango.desde, rango.hasta]);

  useEffect(() => {
    if (abierto) void cargar();
  }, [abierto, cargar]);

  const conDatos = filas?.filter((f) => f.reservas > 0 || f.comisiones_centavos > 0) ?? [];
  const sinDatos = (filas?.length ?? 0) - conDatos.length;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex min-h-11 items-center justify-between gap-2 text-left text-sm font-medium"
      >
        Rendimiento por RP
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", abierto && "rotate-180")} aria-hidden="true" />
      </button>
      {abierto && (
        <div className="flex flex-col gap-2">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {!filas && !error && <p className="text-sm text-muted-foreground">{cargando ? "Cargando…" : ""}</p>}
          {filas && conDatos.length === 0 && (
            <p className="text-sm text-muted-foreground">Ningún RP tuvo reservas en estas fechas.</p>
          )}
          {conDatos.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {conDatos.map((r) => {
                // Conversión solo con noches cerradas; sin esas columnas, la de antes.
                const conv =
                  r.noches_cerradas_reservas !== null && r.noches_cerradas_consumieron !== null
                    ? porcentajeEntrada(r.noches_cerradas_consumieron, r.noches_cerradas_reservas)
                    : porcentajeEntrada(r.consumieron, reservasOcurridas(r.reservas, r.por_venir));
                return (
                  <li key={r.rp_id} className="flex flex-col gap-1 px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {r.rp_nombre}
                        {!r.rp_activo && <span className="ml-1 text-xs font-normal text-muted-foreground">(de baja)</span>}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">{formatearCentavos(r.consumo_centavos)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {r.reservas} {r.reservas === 1 ? "reserva" : "reservas"}
                      {r.por_venir > 0 ? ` (${r.por_venir} por venir)` : ""} · {r.entraron} entraron · {r.consumieron} consumieron ({textoPorcentaje(conv)} en
                      noches cerradas)
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Ticket {formatearCentavos(r.ticket_centavos)} por reserva que consumió · Comisiones y pagos{" "}
                      {formatearCentavos(r.comisiones_centavos)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {sinDatos > 0 && (
            <p className="text-xs text-muted-foreground">
              {sinDatos} {sinDatos === 1 ? "RP más sin reservas" : "RPs más sin reservas"} en estas fechas.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
