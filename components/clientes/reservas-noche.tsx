"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { cn } from "@/lib/utils";
import { etiquetaNoche } from "@/lib/fechas";
import { Button } from "@/components/ui/button";
import {
  AVISO_ENLACE_WA,
  INFO_PLANTILLA,
  datosDeReserva,
  enlaceWa,
  plantillaEfectiva,
  renderPlantilla,
  tiposParaEstado,
  type TipoPlantilla,
} from "@/lib/domain/whatsapp";

// Reservas de una noche (clientes_noche): para la puerta y los gestores.
// Con 'lista_negra': cuántas veces no llegó antes (sin motivo) y si está
// bloqueado. Con 'whatsapp': enlaces wa.me de confirmación, recordatorio o
// aviso de no-show según el estado. Nada se envía solo.

type Fila = {
  reservation_id: string;
  fecha: string;
  cliente_nombre: string;
  cliente_telefono: string | null;
  personas: number;
  source: string;
  rp_nombre: string | null;
  qr_code: string | null;
  estado: "consumio" | "llego_sin_consumo" | "no_llego" | "por_llegar";
  no_shows: number | null;
  aviso: boolean | null;
  bloqueado: boolean | null;
};

const ESTADO: Record<Fila["estado"], { etiqueta: string; clase: string }> = {
  consumio: { etiqueta: "Consumió", clase: "text-status-ok" },
  llego_sin_consumo: { etiqueta: "Llegó, sin consumo", clase: "text-status-warn" },
  no_llego: { etiqueta: "No llegó", clase: "text-status-err" },
  por_llegar: { etiqueta: "Por llegar", clase: "text-muted-foreground" },
};

const NOCHES = [
  { desfase: -1, etiqueta: "Anoche" },
  { desfase: 0, etiqueta: "Esta noche" },
  { desfase: 1, etiqueta: "Mañana" },
] as const;

export function ReservasNoche({
  clubId,
  antro,
  horario,
  lnActiva,
  waActiva,
  propias,
}: {
  clubId: string;
  antro: string;
  horario: string | null;
  lnActiva: boolean;
  waActiva: boolean;
  propias: Partial<Record<TipoPlantilla, string>>;
}) {
  const [desfase, setDesfase] = useState<number>(0);
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soloAvisos, setSoloAvisos] = useState(false);
  const ultima = useRef(0);

  const cargar = useCallback(async () => {
    const n = ++ultima.current;
    setFilas(null);
    setError(null);
    const { data, error: e } = await createClient().rpc("clientes_noche", { p_club: clubId, p_desfase: desfase });
    if (n !== ultima.current) return;
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar las reservas. Intenta de nuevo."));
      setFilas([]);
      return;
    }
    setFilas((data ?? []) as Fila[]);
  }, [clubId, desfase]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const origen = typeof window !== "undefined" ? window.location.origin : "";
  const visibles = (filas ?? []).filter((f) => !soloAvisos || f.aviso || f.bloqueado);
  const conAviso = (filas ?? []).filter((f) => f.aviso || f.bloqueado).length;
  const fecha = filas?.[0]?.fecha ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-border p-1" role="tablist" aria-label="Noche">
        {NOCHES.map((x) => (
          <button
            key={x.desfase}
            type="button"
            role="tab"
            aria-selected={desfase === x.desfase}
            onClick={() => setDesfase(x.desfase)}
            className={cn("h-10 rounded-md text-sm text-muted-foreground", desfase === x.desfase && "bg-muted font-medium text-foreground ring-1 ring-border")}
          >
            {x.etiqueta}
          </button>
        ))}
      </div>

      {waActiva && <p className="text-xs text-muted-foreground">{AVISO_ENLACE_WA}</p>}

      {lnActiva && filas && filas.length > 0 && (
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5" checked={soloAvisos} onChange={(e) => setSoloAvisos(e.target.checked)} />
          Solo con aviso ({conAviso})
        </label>
      )}

      {error && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
          <p className="text-status-err">{error}</p>
          <Button type="button" variant="outline" className="h-10 self-start" onClick={() => void cargar()}>
            Reintentar
          </Button>
        </div>
      )}
      {filas === null ? (
        <p className="py-4 text-sm text-muted-foreground">Cargando reservas…</p>
      ) : !error && visibles.length === 0 ? (
        <p className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">
          {filas.length === 0 ? "Sin reservas para esa noche." : "Ninguna reserva con aviso."}
        </p>
      ) : (
        <>
          {fecha && <p className="text-sm text-muted-foreground">{etiquetaNoche(fecha)} · {filas.length} reservas</p>}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {visibles.map((f) => {
              const tipos = waActiva ? tiposParaEstado(f.estado) : [];
              const datos = datosDeReserva({ ...f, antro, horario, origen });
              return (
                <li key={f.reservation_id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{f.cliente_nombre}</p>
                      <p className="text-xs text-muted-foreground">
                        {f.personas} pers. · {f.source === "rp" ? `RP ${f.rp_nombre ?? ""}`.trim() : "Orgánica"}
                      </p>
                    </div>
                    <span className={cn("shrink-0 text-xs", ESTADO[f.estado].clase)}>{ESTADO[f.estado].etiqueta}</span>
                  </div>
                  {(f.aviso || f.bloqueado) && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {f.bloqueado && (
                        <span className="rounded-md border border-status-err/40 px-2 py-1 text-status-err">Bloqueado en este antro: habla con el gerente</span>
                      )}
                      {f.aviso && f.no_shows !== null && (
                        <span className="rounded-md border border-status-warn/40 px-2 py-1 text-status-warn">
                          {f.no_shows} {f.no_shows === 1 ? "noche" : "noches"} sin llegar antes
                        </span>
                      )}
                    </div>
                  )}
                  {tipos.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {tipos.map((t) => {
                        const e = enlaceWa(f.cliente_telefono, renderPlantilla(plantillaEfectiva(t, propias), datos));
                        return (
                          <a
                            key={t}
                            href={e.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-muted"
                          >
                            <MessageCircle className="size-4" aria-hidden="true" />
                            {INFO_PLANTILLA[t].nombre}
                            {!e.directo && <span className="text-xs text-muted-foreground">(sin teléfono)</span>}
                          </a>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
