// Exportables CSV de reservas, consumo y comisiones (B4).
//
// Los renglones los arma la base (sql/post-junta-2/31-exportes.sql:
// reporte_reservas, reporte_consumos, reporte_comisiones), que también decide
// quién puede descargarlos y qué teléfono ve cada quien. Aquí solo se
// normaliza lo que llega, se pide página por página (la API corta en 1000
// filas) y se escribe el CSV: UTF-8 con BOM para Excel en español, separador
// coma, CRLF, montos en pesos con dos decimales y horas en la zona del antro
// tal como las manda la base.

import { campoCsv, centavosAPesosCsv } from "@/lib/domain/nomina";
import type { RendimientoRp } from "@/lib/domain/grupo";

export type TipoExporte = "reservas" | "consumos" | "comisiones" | "rps";
export type NivelTelefono = "completo" | "enmascarado" | "sin_telefono";

export const FUNCION_EXPORTE: Record<Exclude<TipoExporte, "rps">, string> = {
  reservas: "reporte_reservas",
  consumos: "reporte_consumos",
  comisiones: "reporte_comisiones",
};

export const LIMITE_PAGINA = 1000;
// Tope de seguridad: 93 noches de un antro de 50 mesas son ~110,000
// renglones de caja. Más que eso es un error (o una base que no pagina).
export const MAX_PAGINAS = 300;

export interface InfoExportes {
  nivel: "completo" | "admin" | "grupo";
  telefono: NivelTelefono;
  club: { id: string; nombre: string; zona_horaria: string };
  noche_en_curso: string;
}

export interface FilaReserva {
  orden: string;
  folio: string;
  noche: string;
  creada_local: string | null;
  cliente_nombre: string;
  telefono: string | null;
  personas: number;
  origen: string;
  rp_nombre: string | null;
  estado: string;
  entrada_local: string | null;
  llegada_tarde: boolean;
  mesa: string | null;
  consumo_centavos: number;
}

export interface FilaConsumo {
  orden: string;
  noche: string;
  hora_local: string | null;
  mesa: string | null;
  grupo: number | null;
  cuenta: string | null;
  origen_cuenta: string | null;
  folio_reserva: string | null;
  rp_nombre: string | null;
  concepto: string | null;
  monto_centavos: number;
  anulado: boolean;
  motivo_anulacion: string | null;
  anulado_local: string | null;
  registrado_por: string | null;
  anulado_por: string | null;
}

export interface FilaComision {
  orden: string;
  noche: string;
  tipo: string;
  rp_nombre: string | null;
  rp_activo: boolean | null;
  folio_reserva: string | null;
  cliente_nombre: string | null;
  consumo_base_centavos: number | null;
  posicion_dia: number | null;
  monto_centavos: number;
  estado: string;
  creada_local: string | null;
  pagada_local: string | null;
  motivo_anulacion: string | null;
}

// ---------------------------------------------------------------------------
// Normalizar (bigint puede llegar como texto).
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const numONulo = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const txt = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const txtO = (v: unknown, otro = ""): string => txt(v) ?? otro;

export function normalizarInfo(d: unknown): InfoExportes | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const club = (o.club ?? {}) as Record<string, unknown>;
  const nivel = o.nivel === "completo" || o.nivel === "admin" || o.nivel === "grupo" ? o.nivel : null;
  const telefono = o.telefono === "completo" || o.telefono === "enmascarado" ? o.telefono : "sin_telefono";
  if (!nivel || typeof club.id !== "string") return null;
  return {
    nivel,
    telefono,
    club: { id: club.id, nombre: txtO(club.nombre, "Antro"), zona_horaria: txtO(club.zona_horaria, "America/Mexico_City") },
    noche_en_curso: txtO(o.noche_en_curso),
  };
}

export function normalizarReserva(f: Record<string, unknown>): FilaReserva {
  return {
    orden: txtO(f.orden),
    folio: txtO(f.folio),
    noche: txtO(f.noche),
    creada_local: txt(f.creada_local),
    cliente_nombre: txtO(f.cliente_nombre),
    telefono: txt(f.telefono),
    personas: num(f.personas),
    origen: txtO(f.origen),
    rp_nombre: txt(f.rp_nombre),
    estado: txtO(f.estado),
    entrada_local: txt(f.entrada_local),
    llegada_tarde: f.llegada_tarde === true,
    mesa: txt(f.mesa),
    consumo_centavos: num(f.consumo_centavos),
  };
}

export function normalizarConsumo(f: Record<string, unknown>): FilaConsumo {
  return {
    orden: txtO(f.orden),
    noche: txtO(f.noche),
    hora_local: txt(f.hora_local),
    mesa: txt(f.mesa),
    grupo: numONulo(f.grupo),
    cuenta: txt(f.cuenta),
    origen_cuenta: txt(f.origen_cuenta),
    folio_reserva: txt(f.folio_reserva),
    rp_nombre: txt(f.rp_nombre),
    concepto: txt(f.concepto),
    monto_centavos: num(f.monto_centavos),
    anulado: f.anulado === true,
    motivo_anulacion: txt(f.motivo_anulacion),
    anulado_local: txt(f.anulado_local),
    registrado_por: txt(f.registrado_por),
    anulado_por: txt(f.anulado_por),
  };
}

export function normalizarComision(f: Record<string, unknown>): FilaComision {
  return {
    orden: txtO(f.orden),
    noche: txtO(f.noche),
    tipo: txtO(f.tipo),
    rp_nombre: txt(f.rp_nombre),
    rp_activo: typeof f.rp_activo === "boolean" ? f.rp_activo : null,
    folio_reserva: txt(f.folio_reserva),
    cliente_nombre: txt(f.cliente_nombre),
    consumo_base_centavos: numONulo(f.consumo_base_centavos),
    posicion_dia: numONulo(f.posicion_dia),
    monto_centavos: num(f.monto_centavos),
    estado: txtO(f.estado),
    creada_local: txt(f.creada_local),
    pagada_local: txt(f.pagada_local),
    motivo_anulacion: txt(f.motivo_anulacion),
  };
}

// ---------------------------------------------------------------------------
// Paginación por llave: se pide la página siguiente con el `orden` de la
// última fila hasta que llega una página incompleta. Si una página no avanza
// (la misma llave o una menor), se detiene con error en vez de ciclarse.
// ---------------------------------------------------------------------------

export type PedirPagina = (despues: string | null) => Promise<{ filas: Record<string, unknown>[] } | { error: unknown }>;

export async function traerTodo(
  pedir: PedirPagina,
  opciones: { limite?: number; maxPaginas?: number; alAvanzar?: (renglones: number) => void } = {},
): Promise<{ filas: Record<string, unknown>[] } | { error: unknown }> {
  const limite = opciones.limite ?? LIMITE_PAGINA;
  const maxPaginas = opciones.maxPaginas ?? MAX_PAGINAS;
  const todas: Record<string, unknown>[] = [];
  let despues: string | null = null;
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const r = await pedir(despues);
    if ("error" in r) return r;
    todas.push(...r.filas);
    opciones.alAvanzar?.(todas.length);
    if (r.filas.length < limite) return { filas: todas };
    const ultima = String(r.filas[r.filas.length - 1]?.orden ?? "");
    if (!ultima || (despues !== null && ultima <= despues)) {
      return { error: { message: "La descarga no avanzó: intenta de nuevo." } };
    }
    despues = ultima;
  }
  return { error: { message: `La descarga pasa de ${maxPaginas * limite} renglones: elige un rango más corto.` } };
}

// ---------------------------------------------------------------------------
// Etiquetas.
// ---------------------------------------------------------------------------

const ESTADO_RESERVA: Record<string, string> = {
  consumio: "Consumió",
  llego_sin_consumo: "Llegó, sin consumo",
  en_puerta: "En puerta",
  no_llego: "No llegó",
  por_llegar: "Por llegar",
};
const ESTADO_COMISION: Record<string, string> = {
  pendiente: "Pendiente",
  en_revision: "En revisión",
  validada: "Validada",
  pagada: "Pagada",
  anulada: "Anulada",
};

export const etiquetaEstadoReserva = (e: string) => ESTADO_RESERVA[e] ?? e;
export const etiquetaEstadoComision = (e: string) => ESTADO_COMISION[e] ?? e;
export const etiquetaOrigen = (o: string) => (o === "rp" ? "RP" : o === "organica" ? "Orgánica" : o);
const etiquetaCuenta = (o: string | null) => (o === "reserva" ? "Con reserva" : o === "walk_in" ? "Sin reserva" : (o ?? ""));
const etiquetaTipoComision = (t: string) => (t === "reserva" ? "Comisión por reserva" : t === "dia" ? "Pago por día" : t);
const siNo = (b: boolean | null) => (b === null ? "" : b ? "Sí" : "No");

// ---------------------------------------------------------------------------
// CSV.
// ---------------------------------------------------------------------------

type Celda = string | number | null;
// Texto: siempre por campoCsv (un concepto "=HYPERLINK(...)" no se ejecuta).
// Números y fechas que arma la base van tal cual.
const t = (v: string | null) => campoCsv(v ?? "");
const n = (v: number | null) => (v === null ? "" : String(v));
const pesos = (c: number | null) => (c === null ? "" : centavosAPesosCsv(c));

function armar(encabezado: string[], filas: Celda[][]): string {
  const lineas = [encabezado.map(campoCsv).join(",")];
  for (const f of filas) lineas.push(f.map((c) => (c === null ? "" : String(c))).join(","));
  return "﻿" + lineas.join("\r\n") + "\r\n";
}

export function csvReservas(filas: FilaReserva[], telefono: NivelTelefono): string {
  const conTel = telefono !== "sin_telefono";
  const enc = [
    "Noche", "Folio", "Creada (hora del antro)", "Cliente",
    ...(conTel ? [telefono === "completo" ? "Teléfono" : "Teléfono (últimos 4)"] : []),
    "Personas", "Origen", "RP", "Estado", "Entrada (hora del antro)", "Llegó tarde", "Mesa", "Consumo",
  ];
  return armar(
    enc,
    filas.map((f) => [
      t(f.noche), t(f.folio), t(f.creada_local), t(f.cliente_nombre),
      ...(conTel ? [t(f.telefono)] : []),
      n(f.personas), t(etiquetaOrigen(f.origen)), t(f.rp_nombre), t(etiquetaEstadoReserva(f.estado)),
      t(f.entrada_local), siNo(f.llegada_tarde), t(f.mesa), pesos(f.consumo_centavos),
    ]),
  );
}

export function csvConsumos(filas: FilaConsumo[]): string {
  return armar(
    [
      "Noche", "Hora (hora del antro)", "Mesa", "Grupo de la mesa", "Cuenta", "Tipo de cuenta", "Folio de reserva", "RP",
      "Concepto", "Monto", "Anulado", "Motivo de anulación", "Anulado a las", "Registró", "Anuló",
    ],
    filas.map((f) => [
      t(f.noche), t(f.hora_local), t(f.mesa), n(f.grupo), t(f.cuenta), t(etiquetaCuenta(f.origen_cuenta)), t(f.folio_reserva),
      t(f.rp_nombre), t(f.concepto), pesos(f.monto_centavos), siNo(f.anulado), t(f.motivo_anulacion), t(f.anulado_local),
      t(f.registrado_por), t(f.anulado_por),
    ]),
  );
}

export function csvComisiones(filas: FilaComision[]): string {
  return armar(
    [
      "Noche", "Tipo", "RP", "RP activo", "Folio de reserva", "Cliente", "Consumo de la cuenta", "Día de asistencia en la semana",
      "Monto", "Estado", "Creada (hora del antro)", "Pagada (hora del antro)", "Motivo de anulación",
    ],
    filas.map((f) => [
      t(f.noche), t(etiquetaTipoComision(f.tipo)), t(f.rp_nombre), siNo(f.rp_activo), t(f.folio_reserva), t(f.cliente_nombre),
      pesos(f.consumo_base_centavos), n(f.posicion_dia), pesos(f.monto_centavos), t(etiquetaEstadoComision(f.estado)),
      t(f.creada_local), t(f.pagada_local), t(f.motivo_anulacion),
    ]),
  );
}

export function csvRendimientoRp(filas: RendimientoRp[]): string {
  return armar(
    ["RP", "Activo", "Reservas", "Por venir", "Entraron", "Consumieron", "Consumo", "Ticket por reserva que consumió", "Comisiones y pagos"],
    filas.map((f) => [
      t(f.rp_nombre), siNo(f.rp_activo), n(f.reservas), n(f.por_venir), n(f.entraron), n(f.consumieron),
      pesos(f.consumo_centavos), pesos(f.ticket_centavos), pesos(f.comisiones_centavos),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Totales para mostrar al terminar (los mismos que /grupo y el cierre).
// ---------------------------------------------------------------------------

export interface ResumenExporte {
  renglones: number;
  // Suma sin anulados: consumo (consumos), consumo de las reservas
  // (reservas), comisiones y pagos (comisiones), consumo de RPs (rps).
  suma_centavos: number;
  anulados: number;
}

export function resumenReservas(filas: FilaReserva[]): ResumenExporte {
  return { renglones: filas.length, suma_centavos: filas.reduce((a, f) => a + f.consumo_centavos, 0), anulados: 0 };
}
export function resumenConsumos(filas: FilaConsumo[]): ResumenExporte {
  const vigentes = filas.filter((f) => !f.anulado);
  return { renglones: filas.length, suma_centavos: vigentes.reduce((a, f) => a + f.monto_centavos, 0), anulados: filas.length - vigentes.length };
}
export function resumenComisiones(filas: FilaComision[]): ResumenExporte {
  const vigentes = filas.filter((f) => f.estado !== "anulada");
  return { renglones: filas.length, suma_centavos: vigentes.reduce((a, f) => a + f.monto_centavos, 0), anulados: filas.length - vigentes.length };
}
export function resumenRps(filas: RendimientoRp[]): ResumenExporte {
  return { renglones: filas.length, suma_centavos: filas.reduce((a, f) => a + f.comisiones_centavos, 0), anulados: 0 };
}

// "reservas-club-demo-2026-11-25.csv" o "consumo-club-demo-2026-11-01_2026-11-30.csv"
const PREFIJO: Record<TipoExporte, string> = { reservas: "reservas", consumos: "consumo", comisiones: "comisiones", rps: "rendimiento-rp" };

export function nombreArchivoExporte(tipo: TipoExporte, nombreAntro: string, desde: string, hasta: string): string {
  const slug =
    nombreAntro
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "antro";
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const d = iso.test(desde) ? desde : "inicio";
  const h = iso.test(hasta) ? hasta : "fin";
  return `${PREFIJO[tipo]}-${slug}-${d === h ? d : `${d}_${h}`}.csv`;
}
