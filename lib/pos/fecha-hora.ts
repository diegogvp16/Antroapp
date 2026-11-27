// Fechas y horas como las exportan los POS. Puro (sin "@/").
//
// Fecha: «25/11/2026», «25-11-26», «25.11.2026», «2026-11-25»,
// «2026/11/25», «25-nov-2026», «25 de noviembre de 2026», con o sin hora
// en la misma celda («25/11/2026 23:15», «2026-11-25T23:15:30»,
// «25/11/2026 11:15 p. m.»). Las de Excel ya llegan como
// «AAAA-MM-DD HH:MM:SS» (lib/pos/xlsx.ts).
// Hora (si viene aparte): «23:15», «23:15:30», «11:15 pm», «11:15 p. m.».
// Día/mes o mes/día: lo dice el mapeo (formato_fecha); en México, dmy.
// Sin zona horaria: es la hora del antro. Una fecha con «Z» o «-06:00» se
// rechaza (no sabríamos a qué hora del antro corresponde sin adivinar).

import type { FormatoFecha } from "./tipos";

export type LecturaFecha = { ok: true; fecha: string; hora: string | null } | { ok: false; error: string };

const MESES: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, apr: 4,
  may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8, aug: 8,
  sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9, oct: 10, octubre: 10,
  nov: 11, noviembre: 11, dic: 12, diciembre: 12, dec: 12,
};

const dos = (n: number) => String(n).padStart(2, "0");
const sinAcentos = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function fechaValida(a: number, m: number, d: number): boolean {
  if (a < 1900 || a > 2999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(a, m, 0)).getUTCDate();
}

const RE_HORA = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?$/i;

/** «23:15», «11:15 p. m.» → «23:15:00». */
export function leerHora(texto: string): { ok: true; hora: string } | { ok: false; error: string } {
  const t = (texto ?? "").trim();
  const m = RE_HORA.exec(t);
  if (!m) return { ok: false, error: `«${texto}» no es una hora` };
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  const ampm = m[4] ? sinAcentos(m[4]).replace(/[^ap]/g, "") : "";
  if (ampm) {
    if (h < 1 || h > 12) return { ok: false, error: `«${texto}» no es una hora` };
    if (ampm === "a" && h === 12) h = 0;
    if (ampm === "p" && h !== 12) h += 12;
  }
  if (h > 23 || mi > 59 || s > 59) return { ok: false, error: `«${texto}» no es una hora` };
  return { ok: true, hora: `${dos(h)}:${dos(mi)}:${dos(s)}` };
}

const anio = (t: string) => (t.length === 2 ? 2000 + Number(t) : Number(t));

/** Lee la fecha (y la hora, si viene en la misma celda). */
export function leerFecha(texto: string, formato: FormatoFecha = "dmy"): LecturaFecha {
  const t = (texto ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { ok: false, error: "falta la fecha" };
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(t) && /\d[T ]\d{1,2}:\d{2}/.test(t)) {
    return { ok: false, error: `«${texto}» trae zona horaria: exporta la hora local del antro` };
  }
  let a: number, m: number, d: number, resto: string;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ,]+(.*))?$/.exec(t))) {
    [a, m, d, resto] = [Number(r[1]), Number(r[2]), Number(r[3]), r[4] ?? ""];
  } else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:[T ,]+(.*))?$/.exec(t))) {
    const [x, y] = [Number(r[1]), Number(r[2])];
    [d, m] = formato === "mdy" ? [y, x] : [x, y];
    a = anio(r[3]);
    resto = r[4] ?? "";
  } else if ((r = /^(\d{1,2})(?:[-/. ]| de )([a-zA-ZáéíóúÁÉÍÓÚ]{3,10})\.?(?:[-/. ]| de )(\d{4}|\d{2})(?:[T ,]+(.*))?$/i.exec(t))) {
    const mes = MESES[sinAcentos(r[2])];
    if (!mes) return { ok: false, error: `«${texto}» no es una fecha` };
    [d, m, a, resto] = [Number(r[1]), mes, anio(r[3]), r[4] ?? ""];
  } else return { ok: false, error: `«${texto}» no es una fecha` };
  if (!fechaValida(a, m, d)) return { ok: false, error: `la fecha «${texto}» no existe` };
  const fecha = `${a}-${dos(m)}-${dos(d)}`;
  if (!resto.trim()) return { ok: true, fecha, hora: null };
  const h = leerHora(resto.replace(/^a las /i, ""));
  if (!h.ok) return { ok: false, error: `la hora de «${texto}» no se entiende` };
  return { ok: true, fecha, hora: h.hora };
}

/** Fecha + hora (de la misma celda o de otra) → «AAAA-MM-DDTHH:MM:SS». */
export function leerFechaHora(
  fecha: string,
  hora: string | null | undefined,
  formato: FormatoFecha = "dmy",
): { ok: true; valor: string } | { ok: false; error: string } {
  const f = leerFecha(fecha, formato);
  if (!f.ok) return f;
  let h = f.hora;
  if (hora && hora.trim()) {
    // Una celda de hora de Excel puede venir como «1899-12-30 23:15:00» o «23:15:00».
    const soloHora = hora.trim().replace(/^\d{4}-\d{2}-\d{2}[T ]/, "");
    const lh = leerHora(soloHora);
    if (!lh.ok) return { ok: false, error: lh.error };
    h = lh.hora;
  }
  if (!h) return { ok: false, error: "falta la hora (sin hora no se sabe de qué noche ni de qué mesa es)" };
  return { ok: true, valor: `${f.fecha}T${h}` };
}

/** Noche operativa de una fecha y hora local: de 00:00 a 07:59 cuenta para
 *  el día anterior (el mismo corte que club_fecha_operacion en la base). */
export function nocheDe(fechaHora: string, corteHora = 8): string {
  const [f, h] = fechaHora.split("T");
  const hora = Number((h ?? "00").slice(0, 2));
  if (hora >= corteHora) return f;
  const [a, m, d] = f.split("-").map(Number);
  const x = new Date(Date.UTC(a, m - 1, d - 1));
  return `${x.getUTCFullYear()}-${dos(x.getUTCMonth() + 1)}-${dos(x.getUTCDate())}`;
}

/** ¿Las fechas parecen día/mes o mes/día? Si algún primer número pasa de 12
 *  es dmy; si algún segundo pasa de 12, mdy; si no se sabe, dmy (México). */
export function sugerirFormatoFecha(valores: readonly string[]): FormatoFecha {
  let dmy = false;
  let mdy = false;
  for (const v of valores) {
    const r = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec((v ?? "").trim());
    if (!r) continue;
    if (Number(r[1]) > 12) dmy = true;
    if (Number(r[2]) > 12) mdy = true;
  }
  return mdy && !dmy ? "mdy" : "dmy";
}
