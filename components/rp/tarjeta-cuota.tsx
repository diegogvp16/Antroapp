"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatearCentavos } from "@/lib/domain/caja";
import { etiquetaRango } from "@/lib/fechas";
import { leerProgreso, type ProgresoCuota } from "@/lib/domain/rp-reservas";

// Solo si el antro usa regla con cuota (hoy: desbloqueo semanal).
export function TarjetaCuota({ p }: { p: Extract<ProgresoCuota, { tiene_cuota: true }> }) {
  const paga = p.tipo === "fijo" ? formatearCentavos(Math.round(p.monto * 100)) : `${p.monto}% del consumo`;
  const alcanzada = p.llevas >= p.cuota;
  const avance = Math.min(1, p.llevas / Math.max(1, p.cuota));
  return (
    <div className="rounded-lg border border-caja-dorado/45 bg-caja-dorado/[0.07] px-3 py-3">
      <p className="text-sm">
        {alcanzada ? (
          <>
            <span className="font-semibold">Cuota alcanzada</span>
            <span className="text-caja-secundario"> · cada reserva que consume paga {paga}</span>
          </>
        ) : (
          <>
            <span className="font-semibold tabular-nums">
              {p.llevas} de {p.cuota}
            </span>{" "}
            reservas que consumen
            <span className="text-caja-secundario">
              {" "}
              · {p.siguiente_paga ? `la siguiente paga ${paga}` : `faltan ${p.cuota - 1 - p.llevas} para que empiecen a pagar`}
            </span>
          </>
        )}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-caja-fondo" aria-hidden="true">
        <span className="block h-full bg-caja-dorado" style={{ width: `${avance * 100}%` }} />
      </div>
      <p className="mt-1 text-xs text-caja-secundario">Semana del {etiquetaRango({ desde: p.semana_desde, hasta: p.semana_hasta })}</p>
    </div>
  );
}

// La tarjeta con su propia consulta (pestaña Nómina). La base decide si hay
// cuota y cuánto lleva el RP (rp_progreso_cuota): cuenta las reservas que
// consumieron y respeta la regla personalizada del RP.
export function CuotaDeLaSemana() {
  const [progreso, setProgreso] = useState<ProgresoCuota>({ tiene_cuota: false });
  useEffect(() => {
    let vigente = true;
    createClient()
      .rpc("rp_progreso_cuota")
      .then(({ data, error }) => {
        if (vigente) setProgreso(error ? { tiene_cuota: false } : leerProgreso(data));
      });
    return () => {
      vigente = false;
    };
  }, []);
  return progreso.tiene_cuota ? <TarjetaCuota p={progreso} /> : null;
}
