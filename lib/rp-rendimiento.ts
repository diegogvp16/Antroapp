// Resumen del rendimiento de un RP por periodo (semana, semana anterior,
// mes). Todo se agrupa por la NOCHE de la reserva (reservations.fecha), no
// por cuándo se creó el registro: una reserva hecha el lunes para el sábado
// cuenta en la semana del sábado, igual que su comisión.
import type { RangoNoches } from "@/lib/fechas";

export type EstadoReserva = "pendiente" | "confirmada" | "usada";

export interface ReservaRp {
  id: string;
  cliente_nombre: string;
  fecha: string;
  status: EstadoReserva;
}

// Comisión por reserva o pago por día: lo que el RP va ganando, con la noche
// a la que pertenece.
export interface GananciaRp {
  noche: string;
  monto: number;
  status: string;
}

export interface ResumenPeriodo {
  reservas: number;
  entraron: number;
  sinEntrar: number;
  ganado: number;
  // Monto por estado (pendiente, validada, pagada).
  ganadoPorEstado: Record<string, number>;
  registrosGanancia: number;
}

export function enRango(noche: string, rango: RangoNoches): boolean {
  return noche >= rango.desde && noche <= rango.hasta;
}

export function resumirPeriodo(
  reservas: ReservaRp[],
  ganancias: GananciaRp[],
  rango: RangoNoches,
): ResumenPeriodo {
  const delPeriodo = reservas.filter((r) => enRango(r.fecha, rango));
  const entraron = delPeriodo.filter((r) => r.status === "usada").length;
  const ganadoPorEstado: Record<string, number> = {};
  let ganado = 0;
  let registrosGanancia = 0;
  for (const g of ganancias) {
    if (!enRango(g.noche, rango)) continue;
    // Lo anulado se muestra en el desglose pero no cuenta como ganado.
    ganadoPorEstado[g.status] = (ganadoPorEstado[g.status] ?? 0) + g.monto;
    if (g.status === "anulada") continue;
    ganado += g.monto;
    registrosGanancia += 1;
  }
  return {
    reservas: delPeriodo.length,
    entraron,
    sinEntrar: delPeriodo.length - entraron,
    ganado,
    ganadoPorEstado,
    registrosGanancia,
  };
}

export const RESUMEN_VACIO: ResumenPeriodo = {
  reservas: 0,
  entraron: 0,
  sinEntrar: 0,
  ganado: 0,
  ganadoPorEstado: {},
  registrosGanancia: 0,
};

// Rango que cubre todos los periodos, para traer los datos en una sola
// consulta y repartirlos después.
export function rangoQueCubre(...rangos: RangoNoches[]): RangoNoches {
  return {
    desde: rangos.reduce((min, r) => (r.desde < min ? r.desde : min), rangos[0].desde),
    hasta: rangos.reduce((max, r) => (r.hasta > max ? r.hasta : max), rangos[0].hasta),
  };
}
