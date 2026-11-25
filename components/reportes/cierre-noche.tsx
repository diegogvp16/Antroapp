"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilaMonto } from "@/components/caja/accion";
import { formatearCentavos } from "@/lib/domain/caja";
import {
  esParcial,
  etiquetaEstado,
  etiquetaOrigen,
  fechaHoraEnZona,
  textoDiferencia,
  type ReporteCierre,
} from "@/lib/domain/cierre-noche";
import { porcentajeEntrada, textoPorcentaje } from "@/lib/domain/grupo";
import { cn } from "@/lib/utils";

// Una cifra con su etiqueta arriba (mismo lenguaje que /grupo).
function Cifra({ etiqueta, valor, detalle, grande = false }: { etiqueta: string; valor: string; detalle?: string; grande?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 break-inside-avoid">
      <span className="text-xs text-muted-foreground">{etiqueta}</span>
      <span className={cn("font-semibold break-words tabular-nums", grande ? "text-xl" : "text-base")}>{valor}</span>
      {detalle && <span className="text-xs text-muted-foreground tabular-nums">{detalle}</span>}
    </div>
  );
}

function Seccion({ titulo, descripcion, children }: { titulo: string; descripcion?: string; children: React.ReactNode }) {
  return (
    <Card size="sm" className="break-inside-avoid print:ring-0 print:border print:border-border">
      <CardHeader className="px-4">
        <CardTitle>{titulo}</CardTitle>
        {descripcion && <CardDescription>{descripcion}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">{children}</CardContent>
    </Card>
  );
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

function TextoDiferencia({ centavos }: { centavos: number }) {
  const texto = textoDiferencia(centavos, formatearCentavos);
  const clase = centavos === 0 ? "text-status-ok" : centavos > 0 ? "text-status-warn" : "text-status-err";
  return <span className={cn("tabular-nums", clase)}>{texto}</span>;
}

// El reporte completo. Todo viene calculado de la base (reporte_cierre_noche).
export function ReporteCierreNoche({ rep }: { rep: ReporteCierre }) {
  const zona = rep.club.zona_horaria;
  const parcial = esParcial(rep);
  const r = rep.reservas;
  const pctEntrada = porcentajeEntrada(r.entraron, r.reservas);
  const pctConsumo = porcentajeEntrada(r.consumieron, r.reservas);
  const estadoBadge = rep.noche.estado === "cerrada" ? "ok" : rep.noche.estado === "abierta" ? (rep.termino ? "warn" : "neutral") : "outline";
  const rpsActivos = rep.rps;

  return (
    <div className="flex flex-col gap-4">
      {/* ---------- Estado de la noche ---------- */}
      <Seccion titulo="Estado de la noche">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={estadoBadge}>{etiquetaEstado(rep)}</Badge>
          {parcial && <span className="text-xs text-muted-foreground">Cifras parciales: la noche sigue.</span>}
        </div>
        <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          <div className="flex flex-wrap gap-x-1">
            <dt className="text-muted-foreground">Abrió la caja:</dt>
            <dd>
              {rep.noche.abierta_en ? `${rep.noche.abierta_por_nombre ?? "Equipo"} · ${fechaHoraEnZona(rep.noche.abierta_en, zona)}` : "—"}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-1">
            <dt className="text-muted-foreground">Cerró la noche:</dt>
            <dd>
              {rep.noche.cerrada_en ? `${rep.noche.cerrada_por_nombre ?? "Equipo"} · ${fechaHoraEnZona(rep.noche.cerrada_en, zona)}` : "—"}
            </dd>
          </div>
        </dl>
        {rep.noche.estado === "abierta" && rep.termino && (
          <p className="text-xs text-status-warn">
            La noche ya pasó su corte de las 08:00 pero nadie la cerró en caja: no hay conteo físico ni diferencia.
          </p>
        )}
        {rep.noche.estado === "sin_caja" && (
          <p className="text-xs text-muted-foreground">No se abrió ninguna mesa en caja esta noche; las reservas sí se cuentan.</p>
        )}
      </Seccion>

      {/* ---------- Resumen ---------- */}
      <Seccion titulo="Resumen">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
          <Cifra etiqueta="Consumo en caja" valor={formatearCentavos(rep.consumo.total_centavos)} grande />
          <Cifra etiqueta="Cobrado" valor={formatearCentavos(rep.cobros.total_centavos)} grande
            detalle={rep.cobros.por_cobrar_centavos ? `${formatearCentavos(rep.cobros.por_cobrar_centavos)} por cobrar` : undefined} />
          <Cifra
            etiqueta="Ticket promedio por cuenta"
            valor={formatearCentavos(rep.consumo.ticket_promedio_centavos)}
            detalle={plural(rep.consumo.cuentas_con_consumo, "cuenta con consumo", "cuentas con consumo")}
          />
          <Cifra etiqueta="Reservas" valor={String(r.reservas)} detalle={plural(r.personas, "persona", "personas")} />
          <Cifra etiqueta="Entraron" valor={String(r.entraron)} detalle={`${textoPorcentaje(pctEntrada)} de las reservas`} />
          <Cifra etiqueta="Comisiones y pagos a RPs" valor={formatearCentavos(rep.comisiones.total_centavos)}
            detalle={parcial ? "Nacen al cuadrar cada mesa" : undefined} />
        </div>
      </Seccion>

      {/* ---------- Reservas y asistencia ---------- */}
      <Seccion titulo="Reservas y asistencia" descripcion="Por la noche de la reserva. Consumió = su cuenta tuvo consumo sin anular.">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Cifra etiqueta="Consumieron" valor={String(r.consumieron)} detalle={`${textoPorcentaje(pctConsumo)} de las reservas`} />
          <Cifra etiqueta="Entraron sin consumir" valor={String(r.entraron_sin_consumo)} />
          {rep.termino ? (
            <Cifra etiqueta="No llegaron" valor={String(r.no_llegaron)} />
          ) : (
            <Cifra etiqueta="Por llegar" valor={String(r.por_llegar)} detalle={r.en_puerta ? `${r.en_puerta} en la puerta` : undefined} />
          )}
        </div>
        {rep.por_origen.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left align-bottom text-xs leading-tight text-muted-foreground">
                  {/* Guion suave (­): en 360 px los encabezados se parten en dos renglones. */}
                  <th className="py-1 pr-2 font-normal">Origen</th>
                  <th className="hyphens-manual py-1 px-1 text-right font-normal">{"Reser­vas"}</th>
                  <th className="hyphens-manual py-1 px-1 text-right font-normal">{"Entra­ron"}</th>
                  <th className="hyphens-manual py-1 px-1 text-right font-normal">{"Consu­mieron"}</th>
                  <th className="py-1 pl-1 text-right font-normal">{rep.termino ? "No llegaron" : "Por llegar"}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rep.por_origen.map((o) => (
                  <tr key={o.origen} className="border-t border-border">
                    <td className="py-1.5 pr-2">{etiquetaOrigen(o.origen)}</td>
                    <td className="py-1.5 px-1 text-right">{o.reservas}</td>
                    <td className="py-1.5 px-1 text-right">{o.entraron}</td>
                    <td className="py-1.5 px-1 text-right">{o.consumieron}</td>
                    <td className="py-1.5 pl-1 text-right">{rep.termino ? o.no_llegaron : o.por_llegar}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No hubo reservas para esta noche.</p>
        )}
      </Seccion>

      {/* ---------- Consumo ---------- */}
      <Seccion titulo="Consumo" descripcion="Todo lo registrado en las mesas esa noche, sin anulados.">
        <div className="flex flex-col gap-1 text-sm">
          <FilaMonto etiqueta="Con reserva" valor={formatearCentavos(rep.consumo.con_reserva_centavos)} />
          <FilaMonto
            etiqueta={`Sin reserva (${plural(rep.walk_ins.cuentas, "walk-in", "walk-ins")}, ${plural(rep.walk_ins.personas, "persona", "personas")})`}
            valor={formatearCentavos(rep.consumo.sin_reserva_centavos)}
          />
          <FilaMonto etiqueta="Total en caja" valor={formatearCentavos(rep.consumo.total_centavos)} fuerte />
        </div>
      </Seccion>

      {/* ---------- Cobros y cuadre ---------- */}
      <Seccion
        titulo="Cobros y cuadre"
        descripcion={rep.cuadre ? `Cuadre de ${rep.cuadre.hecho_por_nombre ?? "Equipo"} · ${fechaHoraEnZona(rep.cuadre.hecho_en, zona)}` : "Sin cuadre general: la noche no se ha cerrado en caja."}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Método</span>
          <span className="text-right text-xs text-muted-foreground">Cobrado</span>
          <span className="text-right text-xs text-muted-foreground">Contado</span>
          {(
            [
              ["Efectivo", rep.cobros.efectivo_centavos, rep.cuadre?.contado_efectivo_centavos ?? null],
              ["Tarjeta", rep.cobros.tarjeta_centavos, rep.cuadre?.contado_tarjeta_centavos ?? null],
              ["Otro", rep.cobros.otro_centavos, rep.cuadre?.contado_otro_centavos ?? null],
            ] as const
          ).map(([metodo, cobrado, contado]) => (
            <div key={metodo} className="contents">
              <span>{metodo}</span>
              <span className="text-right tabular-nums">{formatearCentavos(cobrado)}</span>
              <span className="text-right tabular-nums">{contado === null ? "—" : formatearCentavos(contado)}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
          <FilaMonto etiqueta="Total cobrado" valor={formatearCentavos(rep.cobros.total_centavos)} fuerte />
          <FilaMonto etiqueta="Por cobrar" valor={formatearCentavos(rep.cobros.por_cobrar_centavos)} />
          <div className="flex items-baseline justify-between gap-3 font-semibold">
            <span>Diferencia del cuadre</span>
            {rep.cuadre ? <TextoDiferencia centavos={rep.cuadre.diferencia_centavos} /> : <span className="text-muted-foreground">—</span>}
          </div>
        </div>
        {rep.cuadre?.notas && <p className="break-words text-sm text-muted-foreground">Notas: {rep.cuadre.notas}</p>}
      </Seccion>

      {/* ---------- Anulaciones ---------- */}
      <Seccion titulo="Anulaciones">
        <div className="flex flex-col gap-1 text-sm">
          <FilaMonto etiqueta={`Consumos anulados (${rep.anulaciones.consumos})`} valor={formatearCentavos(rep.anulaciones.consumos_centavos)} />
          <FilaMonto etiqueta={`Cobros anulados (${rep.anulaciones.cobros})`} valor={formatearCentavos(rep.anulaciones.cobros_centavos)} />
          <FilaMonto etiqueta="Mesas reabiertas" valor={String(rep.anulaciones.mesas_reabiertas)} />
        </div>
        {rep.anulaciones.consumos + rep.anulaciones.cobros + rep.anulaciones.mesas_reabiertas > 0 && (
          <p className="text-xs text-muted-foreground print:hidden">El detalle (quién, a qué hora y por qué) está en &quot;Equipo y actividad&quot;.</p>
        )}
      </Seccion>

      {/* ---------- Mesas ---------- */}
      <Seccion titulo="Mesas y grupos" descripcion="Cada grupo es una sesión de mesa; al cuadrarla, el siguiente grupo abre otra.">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Cifra etiqueta="Mesas usadas" valor={`${rep.mesas.mesas_usadas} de ${rep.mesas.mesas_antro}`} />
          <Cifra etiqueta="Grupos" valor={String(rep.mesas.grupos)}
            detalle={rep.mesas.mesas_varios_grupos ? plural(rep.mesas.mesas_varios_grupos, "mesa con más de un grupo", "mesas con más de un grupo") : undefined} />
          <Cifra etiqueta="Cuadrados" valor={String(rep.mesas.grupos_cuadrados)}
            detalle={rep.mesas.grupos_abiertos + rep.mesas.grupos_cerrados > 0 ? `${rep.mesas.grupos_abiertos} abiertos · ${rep.mesas.grupos_cerrados} por cuadrar` : undefined} />
        </div>
      </Seccion>

      {/* ---------- Comisiones ---------- */}
      <Seccion titulo="Comisiones y pagos a RPs" descripcion="Sin anuladas. Nacen al cuadrar cada mesa.">
        <div className="flex flex-col gap-1 text-sm">
          <FilaMonto
            etiqueta={`Comisiones (${rep.comisiones.comisiones}${rep.comisiones.comisiones_en_cero ? `, ${rep.comisiones.comisiones_en_cero} en $0 por la cuota` : ""})`}
            valor={formatearCentavos(rep.comisiones.comision_centavos)}
          />
          <FilaMonto etiqueta={`Pagos por día (${rep.comisiones.pagos_dia})`} valor={formatearCentavos(rep.comisiones.pago_dia_centavos)} />
          <FilaMonto etiqueta="Total a RPs" valor={formatearCentavos(rep.comisiones.total_centavos)} fuerte />
        </div>
        {rep.comisiones.cuentas_rp_sin_cuadrar > 0 && (
          <p className="text-xs text-status-warn">
            {plural(rep.comisiones.cuentas_rp_sin_cuadrar, "cuenta de RP sigue", "cuentas de RP siguen")} sin cuadrar: su comisión todavía no nace.
          </p>
        )}
      </Seccion>

      {/* ---------- Rendimiento por RP ---------- */}
      <Seccion titulo="Rendimiento por RP">
        {rpsActivos.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ningún RP tuvo reservas ni pagos esta noche.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {rpsActivos.map((x) => (
              <li key={x.rp_id} className="flex flex-col gap-1 px-3 py-2.5 break-inside-avoid">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {x.rp_nombre}
                    {!x.rp_activo && <span className="ml-1 text-xs font-normal text-muted-foreground">(de baja)</span>}
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{formatearCentavos(x.consumo_centavos)}</span>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {plural(x.reservas, "reserva", "reservas")} · {x.entraron} entraron · {x.consumieron} consumieron
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  Ticket {formatearCentavos(x.ticket_centavos)} por reserva que consumió · Comisión y pagos {formatearCentavos(x.comisiones_centavos)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Seccion>

      <p className="text-xs text-muted-foreground">
        Generado {fechaHoraEnZona(rep.generado_en, zona)} (hora del antro). Noche operativa: de las 08:00 a las 07:59 del día siguiente.
      </p>
    </div>
  );
}
