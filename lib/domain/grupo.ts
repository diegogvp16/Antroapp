// Panel de grupo: tipos de la fila de grupo_resumen y cálculos de
// presentación (totales, agrupar por ciudad, % de entrada, zona horaria).
//
// Todo el dinero viene de la base en CENTAVOS. Las cifras por antro las
// calcula la base (sql/2026-11-20-nomina-y-grupo.sql, grupo_resumen); aquí
// solo se suman para los totales del grupo. Funciones puras.

import { etiquetaNoche, sumarDiasISO, type RangoNoches } from "@/lib/fechas";

// ---------------------------------------------------------------------------
// Fila de grupo_resumen(p_desde, p_hasta).
// ---------------------------------------------------------------------------

export interface ResumenAntro {
  club_id: string;
  nombre: string;
  ciudad: string | null;
  zona_horaria: string | null;
  publicado: boolean;
  reservas: number;
  entraron: number;
  cuentas_con_consumo: number;
  consumo_centavos: number;
  ticket_promedio_centavos: number;
  comisiones_centavos: number;
  noches_cerradas: number;
}

function numero(valor: unknown): number {
  const n = typeof valor === "number" ? valor : Number(valor ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function textoONulo(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

// Normaliza una fila cruda de la base (los bigint pueden llegar como texto
// según el cliente; se pasan a número para sumar sin sorpresas).
export function normalizarResumen(fila: Record<string, unknown>): ResumenAntro {
  return {
    club_id: String(fila.club_id ?? ""),
    nombre: typeof fila.nombre === "string" ? fila.nombre : "",
    ciudad: textoONulo(fila.ciudad),
    zona_horaria: textoONulo(fila.zona_horaria),
    publicado: fila.publicado === true,
    reservas: numero(fila.reservas),
    entraron: numero(fila.entraron),
    cuentas_con_consumo: numero(fila.cuentas_con_consumo),
    consumo_centavos: numero(fila.consumo_centavos),
    ticket_promedio_centavos: numero(fila.ticket_promedio_centavos),
    comisiones_centavos: numero(fila.comisiones_centavos),
    noches_cerradas: numero(fila.noches_cerradas),
  };
}

// ---------------------------------------------------------------------------
// Totales del grupo.
// ---------------------------------------------------------------------------

export interface TotalesGrupo {
  antros: number;
  reservas: number;
  entraron: number;
  cuentas_con_consumo: number;
  consumo_centavos: number;
  // Ponderado: consumo total / cuentas con consumo totales (no el promedio
  // de los tickets de cada antro).
  ticket_promedio_centavos: number;
  comisiones_centavos: number;
  noches_cerradas: number;
}

export function ticketPromedio(consumoCentavos: number, cuentas: number): number {
  return cuentas > 0 ? Math.round(consumoCentavos / cuentas) : 0;
}

export function totalesGrupo(filas: ResumenAntro[]): TotalesGrupo {
  const t = filas.reduce(
    (acc, f) => ({
      reservas: acc.reservas + f.reservas,
      entraron: acc.entraron + f.entraron,
      cuentas_con_consumo: acc.cuentas_con_consumo + f.cuentas_con_consumo,
      consumo_centavos: acc.consumo_centavos + f.consumo_centavos,
      comisiones_centavos: acc.comisiones_centavos + f.comisiones_centavos,
      noches_cerradas: acc.noches_cerradas + f.noches_cerradas,
    }),
    {
      reservas: 0,
      entraron: 0,
      cuentas_con_consumo: 0,
      consumo_centavos: 0,
      comisiones_centavos: 0,
      noches_cerradas: 0,
    },
  );
  return {
    ...t,
    antros: filas.length,
    ticket_promedio_centavos: ticketPromedio(t.consumo_centavos, t.cuentas_con_consumo),
  };
}

// ---------------------------------------------------------------------------
// Porcentaje de entrada.
// ---------------------------------------------------------------------------

// Entraron / reservas, en % entero. null si no hubo reservas.
export function porcentajeEntrada(entraron: number, reservas: number): number | null {
  if (reservas <= 0) return null;
  return Math.round((entraron / reservas) * 100);
}

export function textoPorcentaje(pct: number | null): string {
  return pct === null ? "—" : `${pct}%`;
}

// ---------------------------------------------------------------------------
// Agrupar por ciudad.
// ---------------------------------------------------------------------------

export const SIN_CIUDAD = "Sin ciudad";

export interface GrupoCiudad {
  ciudad: string;
  antros: ResumenAntro[];
}

// Respeta el orden en que llegan las filas (la base ya ordena por ciudad y
// nombre); "Sin ciudad" siempre al final.
export function agruparPorCiudad(filas: ResumenAntro[]): GrupoCiudad[] {
  const grupos = new Map<string, ResumenAntro[]>();
  const sinCiudad: ResumenAntro[] = [];
  for (const f of filas) {
    const ciudad = f.ciudad?.trim();
    if (!ciudad) {
      sinCiudad.push(f);
      continue;
    }
    const lista = grupos.get(ciudad);
    if (lista) lista.push(f);
    else grupos.set(ciudad, [f]);
  }
  const resultado: GrupoCiudad[] = Array.from(grupos, ([ciudad, antros]) => ({ ciudad, antros }));
  if (sinCiudad.length > 0) resultado.push({ ciudad: SIN_CIUDAD, antros: sinCiudad });
  return resultado;
}

// ---------------------------------------------------------------------------
// Zona horaria legible.
// ---------------------------------------------------------------------------

// Nombres en español de las zonas de México que no se leen bien tal cual.
const NOMBRES_ZONA: Record<string, string> = {
  Mexico_City: "Ciudad de México",
  Cancun: "Cancún",
  Merida: "Mérida",
  Mazatlan: "Mazatlán",
  Bahia_Banderas: "Bahía de Banderas",
};

// "America/Tijuana" -> "Hora de Tijuana". null si no hay zona.
export function nombreZona(zona: string | null): string | null {
  if (!zona) return null;
  const ultimo = zona.split("/").pop()?.trim();
  if (!ultimo) return null;
  return `Hora de ${NOMBRES_ZONA[ultimo] ?? ultimo.replace(/_/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Rango de noches.
// ---------------------------------------------------------------------------

// Igual que la base: hasta - desde no puede pasar de 93 días.
export const MAX_DIAS_RANGO = 93;

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

// Días de calendario entre dos fechas "YYYY-MM-DD" (hasta - desde).
export function diasEntre(desde: string, hasta: string): number {
  const [a1, m1, d1] = desde.split("-").map(Number);
  const [a2, m2, d2] = hasta.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
}

// Mensaje de error del rango, o null si se puede consultar.
export function validarRango(rango: RangoNoches): string | null {
  if (!FECHA_ISO.test(rango.desde) || !FECHA_ISO.test(rango.hasta)) {
    return "Elige la fecha de inicio y la de fin.";
  }
  const dias = diasEntre(rango.desde, rango.hasta);
  if (dias < 0) return "La fecha de inicio no puede ser después de la fecha de fin.";
  if (dias > MAX_DIAS_RANGO) {
    return `El rango máximo es de ${MAX_DIAS_RANGO} días (con ese inicio, hasta el ${etiquetaNoche(sumarDiasISO(rango.desde, MAX_DIAS_RANGO))}).`;
  }
  return null;
}
