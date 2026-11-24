// Nómina semanal de RPs: semana ISO, estados, transiciones y CSV.
//
// La nómina la paga el antro; AntroApp solo la calcula. Los montos vienen de
// la base en CENTAVOS (nomina_semana) y la semana es lunes a domingo por la
// NOCHE de cada reserva o asistencia. Aquí solo hay funciones puras: las
// transiciones las hace cumplir la base (nomina_transicion_valida).

import { etiquetaRango, sumarDiasISO } from "@/lib/fechas";

// ---------------------------------------------------------------------------
// Semana ISO (lunes a domingo). Todo con Date.UTC: la zona del dispositivo
// no mueve ninguna fecha.
// ---------------------------------------------------------------------------

export interface SemanaIso {
  anio: number;
  semana: number;
}

// Rango que acepta la base (nomina_lunes_iso).
export const ANIO_MIN = 2020;
export const ANIO_MAX = 2100;

function partes(fechaISO: string): { anio: number; mes: number; dia: number } {
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  return { anio, mes, dia };
}

function aISO(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

// "2026-11-19" -> { anio: 2026, semana: 47 }. El año ISO puede no ser el del
// calendario (el 31 de diciembre puede caer en la semana 1 del año siguiente).
export function semanaIsoDe(fechaISO: string): SemanaIso {
  const { anio, mes, dia } = partes(fechaISO);
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  const diaIso = d.getUTCDay() || 7; // lunes = 1 ... domingo = 7
  // El jueves de esa semana decide a qué año pertenece.
  d.setUTCDate(d.getUTCDate() + 4 - diaIso);
  const anioIso = d.getUTCFullYear();
  const semana = Math.ceil(((d.getTime() - Date.UTC(anioIso, 0, 1)) / 86_400_000 + 1) / 7);
  return { anio: anioIso, semana };
}

// Lunes de la semana ISO, como "YYYY-MM-DD". La semana 1 es la que contiene
// el 4 de enero.
export function lunesDeSemana({ anio, semana }: SemanaIso): string {
  const cuatroEnero = new Date(Date.UTC(anio, 0, 4));
  const diaIso = cuatroEnero.getUTCDay() || 7;
  const lunesSemana1 = Date.UTC(anio, 0, 4 - (diaIso - 1));
  return aISO(lunesSemana1 + (semana - 1) * 7 * 86_400_000);
}

export function domingoDeSemana(s: SemanaIso): string {
  return sumarDiasISO(lunesDeSemana(s), 6);
}

export function semanaAnterior(s: SemanaIso): SemanaIso {
  return semanaIsoDe(sumarDiasISO(lunesDeSemana(s), -7));
}

export function semanaSiguiente(s: SemanaIso): SemanaIso {
  return semanaIsoDe(sumarDiasISO(lunesDeSemana(s), 7));
}

// -1 si a es antes que b, 0 si es la misma, 1 si es después.
export function compararSemanas(a: SemanaIso, b: SemanaIso): number {
  if (a.anio !== b.anio) return a.anio < b.anio ? -1 : 1;
  if (a.semana !== b.semana) return a.semana < b.semana ? -1 : 1;
  return 0;
}

// "Semana 47 · lun 16 nov – dom 22 nov 2026". Si la semana cruza de año:
// "Semana 1 · lun 28 dic 2026 – dom 3 ene 2027".
export function etiquetaSemana(s: SemanaIso): string {
  const desde = lunesDeSemana(s);
  const hasta = domingoDeSemana(s);
  const anioDesde = partes(desde).anio;
  const anioHasta = partes(hasta).anio;
  const rango =
    anioDesde === anioHasta
      ? `${etiquetaRango({ desde, hasta })} ${anioHasta}`
      : `${etiquetaRango({ desde, hasta }).replace(" – ", ` ${anioDesde} – `)} ${anioHasta}`;
  return `Semana ${s.semana} · ${rango}`;
}

// ---------------------------------------------------------------------------
// Estados y transiciones (igual que nomina_transicion_valida en la base).
// ---------------------------------------------------------------------------

export const ESTADOS_NOMINA = [
  "pendiente",
  "en_revision",
  "validada",
  "pagada",
  "anulada",
] as const;

export type EstadoNomina = (typeof ESTADOS_NOMINA)[number];

export const ESTADO_NOMINA_LABEL: Record<EstadoNomina, string> = {
  pendiente: "Pendiente",
  en_revision: "En revisión",
  validada: "Validada",
  pagada: "Pagada",
  anulada: "Anulada",
};

// Variante de Badge (tema control: el color solo marca estados).
export const ESTADO_NOMINA_BADGE: Record<EstadoNomina, "neutral" | "warn" | "outline" | "ok" | "err"> = {
  pendiente: "neutral",
  en_revision: "warn",
  validada: "outline",
  pagada: "ok",
  anulada: "err",
};

export interface TransicionNomina {
  desde: EstadoNomina;
  hacia: EstadoNomina;
  // Texto del botón.
  etiqueta: string;
  // Anular pide motivo obligatorio.
  requiereMotivo: boolean;
  // Pagada y anulada son finales: se confirma antes.
  final: boolean;
}

export const TRANSICIONES_NOMINA: readonly TransicionNomina[] = [
  { desde: "pendiente", hacia: "en_revision", etiqueta: "Enviar a revisión", requiereMotivo: false, final: false },
  { desde: "en_revision", hacia: "validada", etiqueta: "Validar", requiereMotivo: false, final: false },
  { desde: "validada", hacia: "pagada", etiqueta: "Marcar pagada", requiereMotivo: false, final: true },
  { desde: "en_revision", hacia: "pendiente", etiqueta: "Regresar a pendiente", requiereMotivo: false, final: false },
  { desde: "validada", hacia: "en_revision", etiqueta: "Regresar a revisión", requiereMotivo: false, final: false },
  { desde: "pendiente", hacia: "anulada", etiqueta: "Anular", requiereMotivo: true, final: true },
  { desde: "en_revision", hacia: "anulada", etiqueta: "Anular", requiereMotivo: true, final: true },
  { desde: "validada", hacia: "anulada", etiqueta: "Anular", requiereMotivo: true, final: true },
];

export function transicionValida(desde: EstadoNomina, hacia: EstadoNomina): boolean {
  return TRANSICIONES_NOMINA.some((t) => t.desde === desde && t.hacia === hacia);
}

export function transicionesDesde(desde: EstadoNomina): TransicionNomina[] {
  return TRANSICIONES_NOMINA.filter((t) => t.desde === desde);
}

// Mínimo del motivo de anulación (igual que en la base).
export const MIN_MOTIVO_ANULACION = 3;
export const MAX_MOTIVO_ANULACION = 300;

export function motivoAnulacionValido(motivo: string): boolean {
  return motivo.trim().length >= MIN_MOTIVO_ANULACION;
}

// ---------------------------------------------------------------------------
// Filas de nomina_semana.
// ---------------------------------------------------------------------------

export interface FilaNomina {
  rp_id: string;
  rp_nombre: string | null;
  rp_activo: boolean;
  reservas_entraron: number;
  comisiones: number; // sin anuladas
  dias_asistidos: number; // sin anulados
  comision_centavos: number; // sin anuladas
  dia_centavos: number; // sin anulados
  pendiente_centavos: number;
  en_revision_centavos: number;
  validada_centavos: number;
  pagada_centavos: number;
  anulada_centavos: number;
  total_centavos: number; // todo lo no anulado
}

export function montoPorEstado(fila: FilaNomina, estado: EstadoNomina): number {
  switch (estado) {
    case "pendiente":
      return fila.pendiente_centavos;
    case "en_revision":
      return fila.en_revision_centavos;
    case "validada":
      return fila.validada_centavos;
    case "pagada":
      return fila.pagada_centavos;
    case "anulada":
      return fila.anulada_centavos;
  }
}

// Estados del RP con monto mayor a 0, en orden del flujo.
export function estadosConMonto(fila: FilaNomina): EstadoNomina[] {
  return ESTADOS_NOMINA.filter((e) => montoPorEstado(fila, e) > 0);
}

// ¿El RP tuvo algo esta semana? (reservas, comisiones, días o montos).
export function tieneMovimiento(fila: FilaNomina): boolean {
  return (
    fila.reservas_entraron > 0 ||
    fila.comisiones > 0 ||
    fila.dias_asistidos > 0 ||
    estadosConMonto(fila).length > 0
  );
}

export function nombreRp(fila: FilaNomina): string {
  return fila.rp_nombre?.trim() || "RP sin nombre";
}

export interface TotalesNomina {
  porEstado: Record<EstadoNomina, number>;
  comision: number;
  dia: number;
  total: number; // sin anuladas
  reservasEntraron: number;
  comisiones: number;
  dias: number;
}

export function totalesSemana(filas: FilaNomina[]): TotalesNomina {
  const porEstado: Record<EstadoNomina, number> = {
    pendiente: 0,
    en_revision: 0,
    validada: 0,
    pagada: 0,
    anulada: 0,
  };
  let comision = 0;
  let dia = 0;
  let total = 0;
  let reservasEntraron = 0;
  let comisiones = 0;
  let dias = 0;
  for (const f of filas) {
    for (const e of ESTADOS_NOMINA) porEstado[e] += montoPorEstado(f, e);
    comision += f.comision_centavos;
    dia += f.dia_centavos;
    total += f.total_centavos;
    reservasEntraron += f.reservas_entraron;
    comisiones += f.comisiones;
    dias += f.dias_asistidos;
  }
  return { porEstado, comision, dia, total, reservasEntraron, comisiones, dias };
}

// ---------------------------------------------------------------------------
// CSV (UTF-8 con BOM para que Excel respete los acentos, separador coma).
// Los montos se convierten de centavos a pesos SOLO aquí, sin flotantes.
// ---------------------------------------------------------------------------

export const COLUMNAS_CSV = [
  "RP",
  "Activo",
  "Reservas que entraron",
  "Comisiones",
  "Días",
  "Comisión",
  "Pago por día",
  "Pendiente",
  "En revisión",
  "Validada",
  "Pagada",
  "Anulada",
  "Total",
] as const;

// 15050 -> "150.50"; -50 -> "-0.50".
export function centavosAPesosCsv(centavos: number): string {
  const c = Math.trunc(centavos);
  const signo = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// Escapa un campo de texto. Un nombre que empiece con = + - @ se prefija con
// un apóstrofo para que la hoja de cálculo no lo ejecute como fórmula.
export function campoCsv(valor: string): string {
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return /[",\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

function filaCsv(campos: string[]): string {
  return campos.join(",");
}

// Una fila por RP y al final la fila "Total de la semana".
export function generarCsvNomina(filas: FilaNomina[]): string {
  const lineas = [filaCsv(COLUMNAS_CSV.map(campoCsv))];
  for (const f of filas) {
    lineas.push(
      filaCsv([
        campoCsv(nombreRp(f)),
        f.rp_activo ? "Sí" : "No",
        String(f.reservas_entraron),
        String(f.comisiones),
        String(f.dias_asistidos),
        centavosAPesosCsv(f.comision_centavos),
        centavosAPesosCsv(f.dia_centavos),
        centavosAPesosCsv(f.pendiente_centavos),
        centavosAPesosCsv(f.en_revision_centavos),
        centavosAPesosCsv(f.validada_centavos),
        centavosAPesosCsv(f.pagada_centavos),
        centavosAPesosCsv(f.anulada_centavos),
        centavosAPesosCsv(f.total_centavos),
      ]),
    );
  }
  const t = totalesSemana(filas);
  lineas.push(
    filaCsv([
      campoCsv("Total de la semana"),
      "",
      String(t.reservasEntraron),
      String(t.comisiones),
      String(t.dias),
      centavosAPesosCsv(t.comision),
      centavosAPesosCsv(t.dia),
      ...ESTADOS_NOMINA.map((e) => centavosAPesosCsv(t.porEstado[e])),
      centavosAPesosCsv(t.total),
    ]),
  );
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

// "nomina-club-demo-2026-S47.csv"
export function nombreArchivoNomina(nombreAntro: string, s: SemanaIso): string {
  const slug =
    nombreAntro
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "antro";
  return `nomina-${slug}-${s.anio}-S${String(s.semana).padStart(2, "0")}.csv`;
}
