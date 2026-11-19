// Cover informativo del antro. La app NO cobra nada al cliente: el cover es
// lo que el antro cobra por su cuenta en la puerta y aquí solo se informa.
//
// En la base (sql/2026-11-20-cover.sql): clubs.cover_modo y clubs.cover_monto
// (numeric(10,2), en PESOS, no en centavos). El CHECK clubs_cover_monto_coherente
// exige monto > 0 y <= 100000 en modo 'monto', y nulo en cualquier otro modo.
// validarCover replica esa regla para avisar antes de mandar el UPDATE.

import type { Club, CoverModo } from "@/types";
import { formatearPesos } from "@/lib/dinero";

// Tope del CHECK de la base, en pesos.
export const COVER_MONTO_MAXIMO = 100000;

// Opciones del selector, en el orden en que se muestran.
export const OPCIONES_COVER: ReadonlyArray<{ valor: CoverModo; etiqueta: string }> = [
  { valor: "oculto", etiqueta: "No mostrar" },
  { valor: "monto", etiqueta: "Monto" },
  { valor: "libre", etiqueta: "Entrada libre" },
  { valor: "consultar", etiqueta: "Consultar con el antro" },
];

export function esCoverModo(valor: string): valor is CoverModo {
  return OPCIONES_COVER.some((opcion) => opcion.valor === valor);
}

// Montos con centavos ($150.50) se muestran con dos decimales; formatearPesos
// los redondea al peso y mostraría un cover distinto al real.
const formatoPesosConCentavos = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatearCover(pesos: number): string {
  return Number.isInteger(pesos)
    ? formatearPesos(pesos)
    : formatoPesosConCentavos.format(pesos);
}

// Texto a mostrar, o null si no hay que mostrar nada.
export function textoCover(club: Pick<Club, "cover_modo" | "cover_monto">): string | null {
  switch (club.cover_modo) {
    case "monto": {
      // PostgREST puede mandar numeric como texto: se normaliza con Number.
      const monto = club.cover_monto == null ? NaN : Number(club.cover_monto);
      return Number.isFinite(monto) && monto > 0 ? `Cover ${formatearCover(monto)}` : null;
    }
    case "libre":
      return "Entrada libre";
    case "consultar":
      return "Cover: consultar con el antro";
    default:
      return null;
  }
}

// Convierte lo que escribe el usuario ("350", "1250.5", "1,250.50", "$350")
// a centavos enteros, sin pasar por flotantes. Devuelve null si no es un
// monto válido (negativo, más de dos decimales, letras, coma decimal...).
export function parsearPesosACentavos(texto: string): number | null {
  let limpio = texto.replace(/[\s$]/g, "");
  if (limpio.includes(",")) {
    // La coma solo se acepta como separador de miles ("1,250.50"): "12,50"
    // es ambiguo y se rechaza en vez de adivinar.
    if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(limpio)) return null;
    limpio = limpio.replace(/,/g, "");
  }
  const partes = /^(\d+)(?:\.(\d{0,2}))?$/.exec(limpio);
  if (!partes) return null;
  const enteros = partes[1].replace(/^0+(?=\d)/, "");
  // Más de 13 dígitos ya no cabe exacto en un number; ningún cover llega ahí.
  if (enteros.length > 13) return null;
  const decimales = (partes[2] ?? "").padEnd(2, "0");
  return Number(enteros) * 100 + Number(decimales);
}

// Texto inicial del input a partir del monto guardado en la base (pesos).
export function coverMontoATexto(pesos: number | null): string {
  if (pesos == null) return "";
  const centavos = Math.round(Number(pesos) * 100);
  if (!Number.isFinite(centavos) || centavos <= 0) return "";
  const enteros = Math.floor(centavos / 100);
  const resto = centavos % 100;
  return resto === 0 ? String(enteros) : `${enteros}.${String(resto).padStart(2, "0")}`;
}

export type ResultadoCover =
  | { ok: true; cover_modo: CoverModo; cover_monto: number | null }
  | { ok: false; error: string };

// Valida el campo y devuelve lo que se manda a la base. En 'monto' el monto
// es obligatorio, > 0 y <= 100,000; en cualquier otro modo va null.
export function validarCover(modo: CoverModo, montoTexto: string): ResultadoCover {
  if (modo !== "monto") return { ok: true, cover_modo: modo, cover_monto: null };

  if (!montoTexto.trim()) {
    return { ok: false, error: "Escribe el monto del cover o elige otra opción." };
  }
  const centavos = parsearPesosACentavos(montoTexto);
  if (centavos == null) {
    return { ok: false, error: "El cover debe ser un monto en pesos, por ejemplo 350 o 350.50." };
  }
  if (centavos <= 0) {
    return { ok: false, error: "El cover debe ser mayor a $0." };
  }
  if (centavos > COVER_MONTO_MAXIMO * 100) {
    return { ok: false, error: `El cover no puede pasar de ${formatearPesos(COVER_MONTO_MAXIMO)}.` };
  }
  // La columna es numeric(10,2) en pesos: centavos / 100 es exacto a 2 decimales.
  return { ok: true, cover_modo: "monto", cover_monto: centavos / 100 };
}
