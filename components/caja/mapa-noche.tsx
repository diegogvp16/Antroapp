"use client";

import { memo, useDeferredValue, useMemo, useState } from "react";
import { CloudUpload, Search, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PESTANAS_MAPA,
  coincideBusqueda,
  enPestana,
  formatearCentavos,
  nombreMesa,
  type EstadoTarjeta,
  type PestanaMapa,
  type ResumenMesa,
} from "@/lib/domain/caja";

// Color del cuadro según el estado (el estado se lee por el color).
const CUADRO: Record<EstadoTarjeta, string> = {
  abierta: "border-caja-dorado/45 bg-caja-dorado/[0.07]",
  por_cuadrar: "border-caja-aviso/60 bg-caja-aviso/[0.08]",
  cuadrada: "border-caja-borde bg-caja-superficie",
  libre: "border-dashed border-caja-borde bg-transparent",
};

// El estado también en texto (no solo por color), para lectores de pantalla.
const ESTADO_TEXTO: Record<EstadoTarjeta, string> = { abierta: "abierta", por_cuadrar: "por cuadrar", cuadrada: "cuadrada", libre: "libre" };

function lineaInferior(m: ResumenMesa): { izquierda: string; derecha: string; tono: string } {
  const grupos = m.grupos > 1 ? `${m.grupos} grupos` : "";
  if (m.estado === "libre") return { izquierda: "Toca para recibir", derecha: "", tono: "text-caja-secundario" };
  if (m.estado === "por_cuadrar") return { izquierda: formatearCentavos(m.consumo), derecha: "por cuadrar", tono: "text-caja-aviso" };
  if (m.estado === "cuadrada") return { izquierda: formatearCentavos(m.consumoNoche), derecha: grupos || "cuadrada", tono: "text-caja-secundario" };
  return { izquierda: formatearCentavos(m.consumo), derecha: grupos || m.rps[0] || "Sin RP", tono: "text-caja-secundario" };
}

// memo: la caja se vuelve a pintar cuando cambia la cola o su estado
// (enviando, reintentos); el mapa de 50 mesas solo si cambian sus datos.
export const MapaNoche = memo(function MapaNoche({
  mesas,
  porMesa = {},
  onAbrirMesa,
}: {
  mesas: ResumenMesa[];
  // Cola de caja: movimientos por enviar y rechazados de cada mesa.
  porMesa?: Record<string, { pendientes: number; rechazados: number }>;
  onAbrirMesa: (mesaId: string) => void;
}) {
  const [pestana, setPestana] = useState<PestanaMapa>("todas");
  const [busqueda, setBusqueda] = useState("");

  const conteos = useMemo(
    () => Object.fromEntries(PESTANAS_MAPA.map((p) => [p.id, mesas.filter((m) => enPestana(m, p.id)).length])) as Record<PestanaMapa, number>,
    [mesas],
  );
  // La lista se filtra con el valor diferido: el campo responde a cada tecla
  // aunque el teléfono tarde en volver a pintar 50 mesas.
  const busquedaDiferida = useDeferredValue(busqueda);
  const visibles = useMemo(
    () => mesas.filter((m) => enPestana(m, pestana) && coincideBusqueda(m, busquedaDiferida)),
    [mesas, pestana, busquedaDiferida],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1 rounded-lg border border-caja-borde p-1" role="tablist" aria-label="Filtrar mesas">
        {PESTANAS_MAPA.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pestana === p.id}
            onClick={() => setPestana(p.id)}
            className={cn(
              "flex h-11 min-w-0 flex-col items-center justify-center rounded-md text-xs leading-tight text-caja-secundario",
              pestana === p.id && "bg-caja-superficie font-medium text-caja-texto ring-1 ring-caja-dorado/60",
            )}
          >
            <span className="truncate">{p.etiqueta}</span>
            <span className="tabular-nums">{conteos[p.id]}</span>
          </button>
        ))}
      </div>

      <label className="relative block">
        <span className="sr-only">Buscar mesa, cliente o RP</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-caja-secundario" />
        <input
          type="search"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar mesa, cliente o RP"
          className="h-11 w-full rounded-lg border border-caja-control bg-caja-superficie pl-9 pr-3 text-base text-caja-texto placeholder:text-caja-secundario outline-none focus-visible:border-caja-dorado"
        />
      </label>

      {visibles.length === 0 ? (
        <p className="py-6 text-center text-sm text-caja-secundario">
          {busquedaDiferida
            ? "Ninguna mesa coincide con la búsqueda."
            : mesas.length === 0
              ? "Este antro no tiene mesas dadas de alta. El dueño las agrega desde su panel."
              : "No hay mesas en esta pestaña."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {visibles.map((m) => {
            const abajo = lineaInferior(m);
            const nombre = m.estado === "libre" ? "Libre" : (m.cliente ?? "Sin cliente");
            const extra = m.estado !== "libre" && m.otrosClientes ? ` +${m.otrosClientes}` : "";
            const principal = nombre + extra;
            const cola = porMesa[m.mesa.id];
            const avisoCola = cola?.rechazados
              ? `${cola.rechazados} sin guardar`
              : cola?.pendientes
                ? `${cola.pendientes} por enviar`
                : "";
            return (
              <li key={m.mesa.id}>
                <button
                  type="button"
                  onClick={() => onAbrirMesa(m.mesa.id)}
                  className={cn(
                    "flex min-h-[92px] w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-caja-dorado",
                    CUADRO[m.estado],
                  )}
                  aria-label={`${nombreMesa(m.mesa.numero)}, ${principal}, ${ESTADO_TEXTO[m.estado]}${m.estado === "libre" ? "" : `, ${formatearCentavos(m.estado === "cuadrada" ? m.consumoNoche : m.consumo)}`}${avisoCola ? `, ${avisoCola}` : ""}`}
                >
                  <span className="flex items-center justify-between gap-2 text-xs text-caja-secundario">
                    <span className="shrink-0 whitespace-nowrap">{nombreMesa(m.mesa.numero)}</span>
                    {avisoCola && (
                      <span className={cn("flex min-w-0 items-center gap-1", cola?.rechazados ? "text-caja-rojo" : "text-caja-aviso")}>
                        {cola?.rechazados ? <TriangleAlert className="size-3 shrink-0" aria-hidden="true" /> : <CloudUpload className="size-3 shrink-0" aria-hidden="true" />}
                        <span className="truncate">{avisoCola}</span>
                      </span>
                    )}
                  </span>
                  <span className={cn("flex min-w-0 text-[15px] font-medium leading-snug", (m.estado === "libre" || m.estado === "cuadrada") && "text-caja-secundario")}>
                    <span className="truncate">{nombre}</span>
                    {extra && <span className="shrink-0 text-caja-secundario">{extra}</span>}
                  </span>
                  <span className={cn("mt-auto flex items-baseline justify-between gap-2 text-xs", abajo.tono)}>
                    <span className={cn("tabular-nums", m.estado === "libre" ? "text-caja-secundario" : "text-caja-texto/90")}>{abajo.izquierda}</span>
                    <span className="truncate">{abajo.derecha}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
