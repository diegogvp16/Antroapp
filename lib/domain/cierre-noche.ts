// Reporte "Cierre de la noche" (reporte_cierre_noche en la base,
// sql/post-junta-2/30-cierre-noche.sql). Aquí solo se normaliza lo que
// devuelve la base y se arma el CSV: ningún número se calcula en el
// navegador salvo los porcentajes para mostrar.

import { campoCsv, centavosAPesosCsv } from "@/lib/domain/nomina";

export type EstadoNocheCaja = "abierta" | "cerrada" | "sin_caja";
export type MomentoNoche = "pasada" | "en_curso" | "futura";

export interface AsistenciaReservas {
  reservas: number;
  personas: number;
  entraron: number;
  en_puerta: number;
  consumieron: number;
  entraron_sin_consumo: number;
  no_llegaron: number;
  por_llegar: number;
  consumo_centavos: number;
}

export interface ReservasPorOrigen extends AsistenciaReservas {
  origen: string;
}

export interface RpCierre {
  rp_id: string;
  rp_nombre: string;
  rp_activo: boolean;
  reservas: number;
  entraron: number;
  consumieron: number;
  consumo_centavos: number;
  ticket_centavos: number;
  comisiones_centavos: number;
}

export interface CuadreCierre {
  registrado_centavos: number;
  cobrado_efectivo_centavos: number;
  cobrado_tarjeta_centavos: number;
  cobrado_otro_centavos: number;
  saldo_sin_cobrar_centavos: number;
  contado_efectivo_centavos: number | null;
  contado_tarjeta_centavos: number | null;
  contado_otro_centavos: number | null;
  diferencia_centavos: number;
  notas: string | null;
  hecho_en: string | null;
  hecho_por_nombre: string | null;
}

export interface ReporteCierre {
  club: { id: string; nombre: string; zona_horaria: string };
  fecha: string;
  noche_en_curso: string;
  momento: MomentoNoche;
  termino: boolean;
  noche: {
    estado: EstadoNocheCaja;
    abierta_en: string | null;
    abierta_por_nombre: string | null;
    cerrada_en: string | null;
    cerrada_por_nombre: string | null;
  };
  reservas: AsistenciaReservas;
  por_origen: ReservasPorOrigen[];
  consumo: {
    total_centavos: number;
    con_reserva_centavos: number;
    sin_reserva_centavos: number;
    cuentas_con_consumo: number;
    renglones: number;
    ticket_promedio_centavos: number;
  };
  walk_ins: {
    cuentas_total: number;
    cuentas_reserva: number;
    cuentas: number;
    personas: number;
    con_consumo: number;
    consumo_centavos: number;
  };
  cobros: {
    efectivo_centavos: number;
    tarjeta_centavos: number;
    otro_centavos: number;
    total_centavos: number;
    cobros: number;
    por_cobrar_centavos: number;
  };
  cuadre: CuadreCierre | null;
  anulaciones: {
    consumos: number;
    consumos_centavos: number;
    cobros: number;
    cobros_centavos: number;
    mesas_reabiertas: number;
  };
  mesas: {
    mesas_antro: number;
    mesas_usadas: number;
    grupos: number;
    grupos_abiertos: number;
    grupos_cerrados: number;
    grupos_cuadrados: number;
    mesas_varios_grupos: number;
  };
  comisiones: {
    comisiones: number;
    comisiones_en_cero: number;
    comision_centavos: number;
    pagos_dia: number;
    pago_dia_centavos: number;
    cuentas_rp_sin_cuadrar: number;
    total_centavos: number;
  };
  rps: RpCierre[];
  generado_en: string;
}

type Crudo = Record<string, unknown>;

const obj = (v: unknown): Crudo => (v && typeof v === "object" && !Array.isArray(v) ? (v as Crudo) : {});
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const numONulo = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const texto = (v: unknown): string => (typeof v === "string" ? v : "");
const textoONulo = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// Toma solo los campos numéricos de `claves` (lo que falte queda en 0).
function numeros<K extends string>(fuente: unknown, claves: readonly K[]): Record<K, number> {
  const o = obj(fuente);
  return Object.fromEntries(claves.map((k) => [k, num(o[k])])) as Record<K, number>;
}

const CLAVES_ASISTENCIA = [
  "reservas",
  "personas",
  "entraron",
  "en_puerta",
  "consumieron",
  "entraron_sin_consumo",
  "no_llegaron",
  "por_llegar",
  "consumo_centavos",
] as const;

function estadoNoche(v: unknown): EstadoNocheCaja {
  return v === "abierta" || v === "cerrada" ? v : "sin_caja";
}
function momento(v: unknown): MomentoNoche {
  return v === "pasada" || v === "futura" ? v : "en_curso";
}

export function normalizarReporte(crudo: unknown): ReporteCierre {
  const r = obj(crudo);
  const club = obj(r.club);
  const noche = obj(r.noche);
  const cuadre = r.cuadre && typeof r.cuadre === "object" ? obj(r.cuadre) : null;
  return {
    club: { id: texto(club.id), nombre: texto(club.nombre), zona_horaria: texto(club.zona_horaria) || "America/Mexico_City" },
    fecha: texto(r.fecha),
    noche_en_curso: texto(r.noche_en_curso),
    momento: momento(r.momento),
    termino: r.termino === true,
    noche: {
      estado: estadoNoche(noche.estado),
      abierta_en: textoONulo(noche.abierta_en),
      abierta_por_nombre: textoONulo(noche.abierta_por_nombre),
      cerrada_en: textoONulo(noche.cerrada_en),
      cerrada_por_nombre: textoONulo(noche.cerrada_por_nombre),
    },
    reservas: numeros(r.reservas, CLAVES_ASISTENCIA),
    por_origen: (Array.isArray(r.por_origen) ? r.por_origen : []).map((o) => ({
      origen: texto(obj(o).origen),
      ...numeros(o, CLAVES_ASISTENCIA),
    })),
    consumo: numeros(r.consumo, [
      "total_centavos",
      "con_reserva_centavos",
      "sin_reserva_centavos",
      "cuentas_con_consumo",
      "renglones",
      "ticket_promedio_centavos",
    ] as const),
    walk_ins: numeros(r.walk_ins, ["cuentas_total", "cuentas_reserva", "cuentas", "personas", "con_consumo", "consumo_centavos"] as const),
    cobros: numeros(r.cobros, [
      "efectivo_centavos",
      "tarjeta_centavos",
      "otro_centavos",
      "total_centavos",
      "cobros",
      "por_cobrar_centavos",
    ] as const),
    cuadre: cuadre
      ? {
          registrado_centavos: num(cuadre.registrado_centavos),
          cobrado_efectivo_centavos: num(cuadre.cobrado_efectivo_centavos),
          cobrado_tarjeta_centavos: num(cuadre.cobrado_tarjeta_centavos),
          cobrado_otro_centavos: num(cuadre.cobrado_otro_centavos),
          saldo_sin_cobrar_centavos: num(cuadre.saldo_sin_cobrar_centavos),
          contado_efectivo_centavos: numONulo(cuadre.contado_efectivo_centavos),
          contado_tarjeta_centavos: numONulo(cuadre.contado_tarjeta_centavos),
          contado_otro_centavos: numONulo(cuadre.contado_otro_centavos),
          diferencia_centavos: num(cuadre.diferencia_centavos),
          notas: textoONulo(cuadre.notas),
          hecho_en: textoONulo(cuadre.hecho_en),
          hecho_por_nombre: textoONulo(cuadre.hecho_por_nombre),
        }
      : null,
    anulaciones: numeros(r.anulaciones, ["consumos", "consumos_centavos", "cobros", "cobros_centavos", "mesas_reabiertas"] as const),
    mesas: numeros(r.mesas, [
      "mesas_antro",
      "mesas_usadas",
      "grupos",
      "grupos_abiertos",
      "grupos_cerrados",
      "grupos_cuadrados",
      "mesas_varios_grupos",
    ] as const),
    comisiones: numeros(r.comisiones, [
      "comisiones",
      "comisiones_en_cero",
      "comision_centavos",
      "pagos_dia",
      "pago_dia_centavos",
      "cuentas_rp_sin_cuadrar",
      "total_centavos",
    ] as const),
    rps: (Array.isArray(r.rps) ? r.rps : []).map((x) => {
      const o = obj(x);
      return {
        rp_id: texto(o.rp_id),
        rp_nombre: texto(o.rp_nombre) || "RP sin nombre",
        rp_activo: o.rp_activo !== false,
        ...numeros(o, ["reservas", "entraron", "consumieron", "consumo_centavos", "ticket_centavos", "comisiones_centavos"] as const),
      };
    }),
    generado_en: texto(r.generado_en),
  };
}

export const ORIGEN_LABEL: Record<string, string> = {
  organica: "Orgánicas",
  rp: "De RPs",
};

export function etiquetaOrigen(origen: string): string {
  return ORIGEN_LABEL[origen] ?? "Sin origen";
}

// Texto del estado de la noche, para la pantalla y el CSV.
export function etiquetaEstado(rep: Pick<ReporteCierre, "noche" | "momento" | "termino">): string {
  if (rep.noche.estado === "cerrada") return "Cerrada en caja";
  if (rep.noche.estado === "abierta") return rep.termino ? "Abierta en caja (ya pasó su corte)" : "Abierta (noche en curso)";
  if (rep.momento === "futura") return "Todavía no empieza";
  return rep.momento === "en_curso" ? "Sin caja abierta todavía" : "Sin caja esa noche";
}

// La noche todavía puede cambiar: las cifras son parciales.
export function esParcial(rep: Pick<ReporteCierre, "noche" | "termino">): boolean {
  return rep.noche.estado !== "cerrada" && !rep.termino;
}

// "+$50" / "-$50" a texto: cuadra, sobran o faltan.
export function textoDiferencia(centavos: number, formato: (c: number) => string): string {
  if (centavos === 0) return "Cuadra";
  return centavos > 0 ? `Sobran ${formato(centavos)}` : `Faltan ${formato(-centavos)}`;
}

// Hora local del antro ("22:30") de un instante ISO.
export function horaEnZona(instante: string | null, zona: string): string {
  if (!instante) return "—";
  try {
    return new Intl.DateTimeFormat("es-MX", { timeZone: zona, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(instante));
  } catch {
    return "—";
  }
}

// Fecha y hora local del antro ("26 nov, 03:14").
export function fechaHoraEnZona(instante: string | null, zona: string): string {
  if (!instante) return "—";
  try {
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: zona,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(instante))
      .replace(/\./g, "");
  } catch {
    return "—";
  }
}

// Fecha y hora local del antro para el CSV ("2026-11-21 21:30"), el mismo
// formato que los exportes (to_char(... at time zone zona, 'YYYY-MM-DD
// HH24:MI') en 31-exportes.sql). Vacío si no hay instante o no se entiende.
export function fechaHoraCsvEnZona(instante: string | null, zona: string): string {
  if (!instante) return "";
  const d = new Date(instante);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const partes = new Intl.DateTimeFormat("en-CA", {
      timeZone: zona,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const p = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
    return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// CSV: UTF-8 con BOM, separador coma, montos en pesos con dos decimales.
// Primero un bloque "Sección, Concepto, Valor" con todo el resumen y después
// la tabla de RPs. Solo agregados: sin nombres ni teléfonos de clientes.
// ---------------------------------------------------------------------------

type Fila = [string, string, string];

export function generarCsvCierre(rep: ReporteCierre): string {
  const pesos = centavosAPesosCsv;
  const n = (v: number) => String(v);
  const filas: Fila[] = [
    ["Antro", "Nombre", rep.club.nombre],
    ["Antro", "Noche", rep.fecha],
    ["Antro", "Zona horaria", rep.club.zona_horaria],
    ["Noche", "Estado", etiquetaEstado(rep)],
    ["Noche", "Cifras parciales", esParcial(rep) ? "Sí" : "No"],
    ["Noche", "Abierta por", rep.noche.abierta_por_nombre ?? ""],
    ["Noche", "Abierta en (hora del antro)", fechaHoraCsvEnZona(rep.noche.abierta_en, rep.club.zona_horaria)],
    ["Noche", "Cerrada por", rep.noche.cerrada_por_nombre ?? ""],
    ["Noche", "Cerrada en (hora del antro)", fechaHoraCsvEnZona(rep.noche.cerrada_en, rep.club.zona_horaria)],
    ["Reservas", "Total", n(rep.reservas.reservas)],
    ["Reservas", "Personas", n(rep.reservas.personas)],
  ];
  for (const o of rep.por_origen) filas.push(["Reservas", etiquetaOrigen(o.origen), n(o.reservas)]);
  filas.push(
    ["Asistencia", "Entraron", n(rep.reservas.entraron)],
    ["Asistencia", "Consumieron", n(rep.reservas.consumieron)],
    ["Asistencia", "Entraron sin consumo", n(rep.reservas.entraron_sin_consumo)],
    ["Asistencia", "En puerta", n(rep.reservas.en_puerta)],
    ["Asistencia", "No llegaron", n(rep.reservas.no_llegaron)],
    ["Asistencia", "Por llegar", n(rep.reservas.por_llegar)],
  );
  for (const o of rep.por_origen) {
    const e = etiquetaOrigen(o.origen);
    filas.push(
      ["Asistencia", `${e}: entraron`, n(o.entraron)],
      ["Asistencia", `${e}: consumieron`, n(o.consumieron)],
      ["Asistencia", `${e}: no llegaron`, n(o.no_llegaron)],
      ["Asistencia", `${e}: por llegar`, n(o.por_llegar)],
    );
  }
  filas.push(
    ["Consumo", "Total en caja", pesos(rep.consumo.total_centavos)],
    ["Consumo", "Con reserva", pesos(rep.consumo.con_reserva_centavos)],
    ["Consumo", "Sin reserva", pesos(rep.consumo.sin_reserva_centavos)],
    ["Consumo", "Cuentas con consumo", n(rep.consumo.cuentas_con_consumo)],
    ["Consumo", "Ticket promedio por cuenta", pesos(rep.consumo.ticket_promedio_centavos)],
    ["Sin reserva", "Cuentas (walk-in)", n(rep.walk_ins.cuentas)],
    ["Sin reserva", "Personas", n(rep.walk_ins.personas)],
    ["Sin reserva", "Con consumo", n(rep.walk_ins.con_consumo)],
    ["Cobros", "Efectivo", pesos(rep.cobros.efectivo_centavos)],
    ["Cobros", "Tarjeta", pesos(rep.cobros.tarjeta_centavos)],
    ["Cobros", "Otro", pesos(rep.cobros.otro_centavos)],
    ["Cobros", "Total cobrado", pesos(rep.cobros.total_centavos)],
    ["Cobros", "Por cobrar", pesos(rep.cobros.por_cobrar_centavos)],
  );
  if (rep.cuadre) {
    const q = rep.cuadre;
    filas.push(
      ["Cuadre", "Contado efectivo", q.contado_efectivo_centavos === null ? "" : pesos(q.contado_efectivo_centavos)],
      ["Cuadre", "Contado tarjeta", q.contado_tarjeta_centavos === null ? "" : pesos(q.contado_tarjeta_centavos)],
      ["Cuadre", "Contado otro", q.contado_otro_centavos === null ? "" : pesos(q.contado_otro_centavos)],
      ["Cuadre", "Diferencia (contado − cobrado)", pesos(q.diferencia_centavos)],
      ["Cuadre", "Hecho por", q.hecho_por_nombre ?? ""],
      ["Cuadre", "Hecho en (hora del antro)", fechaHoraCsvEnZona(q.hecho_en, rep.club.zona_horaria)],
      ["Cuadre", "Notas", q.notas ?? ""],
    );
  } else {
    filas.push(["Cuadre", "Diferencia (contado − cobrado)", "Sin cuadre: la noche no se ha cerrado"]);
  }
  filas.push(
    ["Anulaciones", "Consumos anulados", n(rep.anulaciones.consumos)],
    ["Anulaciones", "Monto de consumos anulados", pesos(rep.anulaciones.consumos_centavos)],
    ["Anulaciones", "Cobros anulados", n(rep.anulaciones.cobros)],
    ["Anulaciones", "Monto de cobros anulados", pesos(rep.anulaciones.cobros_centavos)],
    ["Anulaciones", "Mesas reabiertas", n(rep.anulaciones.mesas_reabiertas)],
    ["Mesas", "Mesas del antro", n(rep.mesas.mesas_antro)],
    ["Mesas", "Mesas usadas", n(rep.mesas.mesas_usadas)],
    ["Mesas", "Grupos", n(rep.mesas.grupos)],
    ["Mesas", "Grupos cuadrados", n(rep.mesas.grupos_cuadrados)],
    ["Mesas", "Mesas con más de un grupo", n(rep.mesas.mesas_varios_grupos)],
    ["Comisiones", "Comisiones de RP", n(rep.comisiones.comisiones)],
    ["Comisiones", "De ellas en $0 (cuota)", n(rep.comisiones.comisiones_en_cero)],
    ["Comisiones", "Monto de comisiones", pesos(rep.comisiones.comision_centavos)],
    ["Comisiones", "Pagos por día", n(rep.comisiones.pagos_dia)],
    ["Comisiones", "Monto de pagos por día", pesos(rep.comisiones.pago_dia_centavos)],
    ["Comisiones", "Total a RPs", pesos(rep.comisiones.total_centavos)],
    ["Comisiones", "Cuentas de RP sin cuadrar", n(rep.comisiones.cuentas_rp_sin_cuadrar)],
  );

  const lineas = [["Sección", "Concepto", "Valor"].map(campoCsv).join(",")];
  // Los números (también los negativos, como una diferencia) van tal cual:
  // campoCsv les pondría apóstrofo por empezar con "-".
  const valorCsv = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? v : campoCsv(v));
  for (const [seccion, concepto, valor] of filas) lineas.push([campoCsv(seccion), campoCsv(concepto), valorCsv(valor)].join(","));
  lineas.push("");
  lineas.push(
    ["RP", "Activo", "Reservas", "Entraron", "Consumieron", "Consumo", "Ticket por reserva que consumió", "Comisiones y pagos"]
      .map(campoCsv)
      .join(","),
  );
  for (const r of rep.rps) {
    lineas.push(
      [
        campoCsv(r.rp_nombre),
        r.rp_activo ? "Sí" : "No",
        n(r.reservas),
        n(r.entraron),
        n(r.consumieron),
        pesos(r.consumo_centavos),
        pesos(r.ticket_centavos),
        pesos(r.comisiones_centavos),
      ].join(","),
    );
  }
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

// "cierre-club-demo-2026-11-25.csv"
export function nombreArchivoCierre(nombreAntro: string, fecha: string): string {
  const slug =
    nombreAntro
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "antro";
  const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : "noche";
  return `cierre-${slug}-${f}.csv`;
}

// Fecha "YYYY-MM-DD" válida (para leerla de la URL).
export function esFechaISO(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// uuid (para leer el antro de la URL sin mandar basura a la base).
export function esUuid(v: string | null | undefined): v is string {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
