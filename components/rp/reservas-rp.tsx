"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { formatearCentavos } from "@/lib/domain/caja";
import { etiquetaNoche, etiquetaRango, mesOperativo, semanaOperativa, type RangoNoches } from "@/lib/fechas";
import {
  ESTADOS_RP,
  ESTADO_RP,
  FILTROS_RP,
  consumoTotal,
  contarEstados,
  filtrar,
  leerProgreso,
  type FiltroRp,
  type ProgresoCuota,
  type ReservaRpDetalle,
} from "@/lib/domain/rp-reservas";
import { DetalleReservaRp } from "@/components/rp/detalle-reserva-rp";

type Periodo = "semana" | "anterior" | "mes";
const PERIODOS: { id: Periodo; etiqueta: string }[] = [
  { id: "semana", etiqueta: "Esta semana" },
  { id: "anterior", etiqueta: "Anterior" },
  { id: "mes", etiqueta: "Mes" },
];
function rangoDe(p: Periodo): RangoNoches {
  if (p === "anterior") return semanaOperativa(new Date(), 1);
  if (p === "mes") return mesOperativo();
  return semanaOperativa();
}

export function ReservasRp({ clubNombre }: { clubNombre: string | null }) {
  const [periodo, setPeriodo] = useState<Periodo>("semana");
  const [filtro, setFiltro] = useState<FiltroRp>("todas");
  const [reservas, setReservas] = useState<ReservaRpDetalle[] | null>(null);
  const [progreso, setProgreso] = useState<ProgresoCuota>({ tiene_cuota: false });
  const [error, setError] = useState<string | null>(null);
  const [abiertaId, setAbiertaId] = useState<string | null>(null);
  const ultima = useRef(0);
  const rango = useMemo(() => rangoDe(periodo), [periodo]);

  const cargar = useCallback(async () => {
    const n = ++ultima.current;
    setError(null);
    // La base devuelve SOLO las reservas del RP que llama (rp_mis_reservas):
    // ningún dato de otros RPs llega al navegador.
    const supabase = createClient();
    const [r, q] = await Promise.all([
      supabase.rpc("rp_mis_reservas", { p_desde: rango.desde, p_hasta: rango.hasta }),
      supabase.rpc("rp_progreso_cuota"),
    ]);
    if (n !== ultima.current) return;
    if (r.error) {
      setError(r.error.message);
      setReservas([]);
    } else {
      setReservas((r.data ?? []) as ReservaRpDetalle[]);
    }
    setProgreso(q.error ? { tiene_cuota: false } : leerProgreso(q.data));
  }, [rango]);

  useEffect(() => {
    setReservas(null);
    void cargar();
  }, [cargar]);

  const abierta = reservas?.find((r) => r.reservation_id === abiertaId);
  if (abierta) return <DetalleReservaRp r={abierta} clubNombre={clubNombre} onVolver={() => setAbiertaId(null)} />;

  const conteo = reservas ? contarEstados(reservas) : null;
  const total = reservas?.length ?? 0;
  const visibles = reservas ? filtrar(reservas, filtro) : [];
  const consumo = reservas ? consumoTotal(reservas) : null;

  return (
    <div className="flex flex-col gap-3">
      {progreso.tiene_cuota && <TarjetaCuota p={progreso} />}

      <div className="grid grid-cols-3 gap-1 rounded-lg border border-caja-borde p-1" role="tablist" aria-label="Periodo">
        {PERIODOS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={periodo === p.id}
            onClick={() => setPeriodo(p.id)}
            className={cn("h-11 rounded-md text-sm text-caja-secundario", periodo === p.id && "bg-caja-superficie text-caja-texto")}
          >
            {p.etiqueta}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-caja-borde bg-caja-superficie px-3 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{total}</span> reservas
            <span className="text-caja-secundario"> · {etiquetaRango(rango)}</span>
          </p>
          {consumo !== null && total > 0 && <p className="text-sm font-medium tabular-nums">{formatearCentavos(consumo)}</p>}
        </div>
        {conteo && total > 0 && (
          <>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-caja-fondo" aria-hidden="true">
              {ESTADOS_RP.map((e) =>
                conteo[e] > 0 ? <span key={e} className={ESTADO_RP[e].barra} style={{ width: `${(conteo[e] / total) * 100}%` }} /> : null,
              )}
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {ESTADOS_RP.map((e) => (
                <li key={e} className="flex items-center gap-1.5">
                  <span className={cn("size-2 shrink-0 rounded-full", ESTADO_RP[e].punto)} />
                  <span className="text-caja-secundario">{ESTADO_RP[e].etiqueta}</span>
                  <span className="ml-auto tabular-nums">{conteo[e]}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="grid grid-cols-4 gap-1 rounded-lg border border-caja-borde p-1" role="tablist" aria-label="Filtrar reservas">
        {FILTROS_RP.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filtro === f.id}
            onClick={() => setFiltro(f.id)}
            className={cn(
              "flex h-11 min-w-0 items-center justify-center rounded-md px-1 text-center text-xs leading-tight text-caja-secundario",
              filtro === f.id && "bg-caja-superficie text-caja-texto",
            )}
          >
            {f.etiqueta}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {reservas === null ? (
        <p className="py-4 text-sm text-caja-secundario">Cargando reservas...</p>
      ) : visibles.length === 0 ? (
        <p className="py-4 text-center text-sm text-caja-secundario">
          {total === 0 ? "Sin reservas en este periodo." : "Ninguna reserva con este filtro."}
        </p>
      ) : (
        <ul className="divide-y divide-caja-borde rounded-lg border border-caja-borde bg-caja-superficie">
          {visibles.map((r) => (
            <li key={r.reservation_id}>
              <button
                type="button"
                onClick={() => setAbiertaId(r.reservation_id)}
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left"
                aria-label={`${r.cliente_nombre}, ${ESTADO_RP[r.estado].etiqueta}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.cliente_nombre}</span>
                  <span className="block truncate text-xs text-caja-secundario">
                    {etiquetaNoche(r.fecha)} · {r.personas} pers.{r.mesa ? ` · Mesa ${r.mesa}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className={cn("flex items-center gap-1.5 text-xs", ESTADO_RP[r.estado].texto)}>
                    <span className={cn("size-2 rounded-full", ESTADO_RP[r.estado].punto)} />
                    {ESTADO_RP[r.estado].etiqueta}
                  </span>
                  {r.consumo_centavos !== null && r.consumo_centavos > 0 && (
                    <span className="text-sm tabular-nums">{formatearCentavos(r.consumo_centavos)}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Solo si el antro usa regla con cuota (hoy: desbloqueo semanal).
function TarjetaCuota({ p }: { p: Extract<ProgresoCuota, { tiene_cuota: true }> }) {
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
