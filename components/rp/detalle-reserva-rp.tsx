"use client";

import { ArrowLeft, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatearCentavos, horaCorta } from "@/lib/domain/caja";
import { etiquetaNoche } from "@/lib/fechas";
import { FASE2_ACTIVA } from "@/lib/fase2";
import {
  ESTADO_COMISION_LABEL,
  ESTADO_RP,
  botellasParaRp,
  enlaceWhatsApp,
  lineaDeTiempo,
  type ReservaRpDetalle,
} from "@/lib/domain/rp-reservas";

export function DetalleReservaRp({
  r,
  clubNombre,
  sinCuotaAun,
  onVolver,
}: {
  r: ReservaRpDetalle;
  clubNombre: string | null;
  // El RP tiene regla con cuota y todavía no la alcanza esta semana.
  sinCuotaAun: boolean;
  onVolver: () => void;
}) {
  const wa = enlaceWhatsApp(
    r.cliente_telefono,
    `Hola ${r.cliente_nombre.split(" ")[0]}, soy tu RP de ${clubNombre ?? "el antro"}. `,
  );
  const pasos = lineaDeTiempo(r);
  // Solo con la fase 2 (catálogo) y el nivel «estado, monto y botellas».
  const botellas = botellasParaRp(r, FASE2_ACTIVA);
  return (
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onVolver} aria-label="Volver a mis reservas" className="-ml-2 flex size-11 items-center justify-center rounded-md text-caja-secundario hover:text-caja-texto">
          <ArrowLeft className="size-5" />
        </button>
        <span className="text-sm text-caja-secundario">{etiquetaNoche(r.fecha)}</span>
        <span className={cn("ml-auto flex items-center gap-1.5 text-sm", ESTADO_RP[r.estado].texto)}>
          <span className={cn("size-2 rounded-full", ESTADO_RP[r.estado].punto)} />
          {ESTADO_RP[r.estado].etiqueta}
        </span>
      </div>

      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-[21px] font-semibold leading-tight">{r.cliente_nombre}</p>
          <p className="mt-0.5 text-sm text-caja-secundario">
            {r.cliente_telefono ?? "Sin teléfono"} · {r.personas} personas{r.mesa ? ` · Mesa ${r.mesa}` : ""}
          </p>
        </div>
        {r.consumo_centavos !== null && (
          <div className="shrink-0 text-right">
            <p className="text-xs text-caja-secundario">Consumo</p>
            <p className="text-[21px] font-semibold leading-tight tabular-nums">{formatearCentavos(r.consumo_centavos)}</p>
          </div>
        )}
      </div>

      <section className="mt-4">
        <h3 className="mb-2 text-sm font-medium">Línea de tiempo</h3>
        <ol className="flex flex-col">
          {pasos.map((p, i) => (
            <li key={p.etiqueta} className="flex gap-3">
              <span className="flex flex-col items-center">
                <span className={cn("mt-1.5 size-2.5 rounded-full", p.instante ? "bg-caja-dorado" : "border border-caja-borde")} />
                {i < pasos.length - 1 && <span className={cn("w-px flex-1", p.instante ? "bg-caja-dorado/40" : "bg-caja-borde")} />}
              </span>
              <span className="flex min-h-10 flex-1 items-start justify-between gap-2 pb-2 text-sm">
                <span className={p.instante ? "text-caja-texto" : "text-caja-secundario"}>{p.etiqueta}</span>
                <span className="text-xs text-caja-secundario tabular-nums">{p.instante ? horaCorta(p.instante) : "—"}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {botellas && (
        <section className="mt-2">
          <h3 className="mb-1 text-sm font-medium">Botellas y productos</h3>
          <ul className="divide-y divide-caja-borde rounded-lg border border-caja-borde bg-caja-superficie text-sm">
            {botellas.items.map((x, i) => (
              <li key={`${x.producto}-${i}`} className="flex min-h-10 items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">
                    {x.cantidad} × {x.producto}
                  </span>
                  {x.categoria && <span className="block text-xs text-caja-secundario">{x.categoria}</span>}
                </span>
                <span className="shrink-0 tabular-nums">{formatearCentavos(x.monto_centavos)}</span>
              </li>
            ))}
            {botellas.otros > 0 && (
              <li className="flex min-h-10 items-center justify-between gap-2 px-3 py-2 text-caja-secundario">
                <span>Otros consumos</span>
                <span className="shrink-0 tabular-nums">{formatearCentavos(botellas.otros)}</span>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="mt-3 rounded-lg border border-caja-borde bg-caja-superficie px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Mi comisión</h3>
          {r.comision_estado ? (
            <span className="text-xs text-caja-secundario">{ESTADO_COMISION_LABEL[r.comision_estado] ?? r.comision_estado}</span>
          ) : null}
        </div>
        <p className={cn("mt-1 text-lg font-semibold tabular-nums", r.comision_estado === "anulada" && "line-through text-caja-secundario")}>
          {r.comision_centavos !== null ? formatearCentavos(r.comision_centavos) : "—"}
        </p>
        <p className="text-xs text-caja-secundario">
          {r.comision_centavos === 0 && sinCuotaAun
            ? "En $0 porque todavía no llegas a la cuota de la semana."
            : r.comision_centavos !== null
            ? "Nace al cuadrar la mesa y la paga el antro en su nómina."
            : r.estado === "consumio"
              ? "Se calcula cuando el gerente cuadre la mesa."
              : "Solo las reservas que consumen generan comisión."}
        </p>
      </section>

      {/* Por encima de la barra de pestañas del panel (fija abajo). */}
      <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] mt-auto bg-caja-fondo pt-3 pb-3">
        {wa ? (
          <a
            href={wa}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-caja-dorado text-base font-semibold text-primary-foreground"
          >
            <MessageCircle className="size-5" />
            Escribirle
          </a>
        ) : (
          <p className="text-center text-sm text-caja-secundario">Sin teléfono válido para escribirle.</p>
        )}
      </div>
    </div>
  );
}
