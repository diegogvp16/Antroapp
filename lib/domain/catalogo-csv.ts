// Catálogo desde un CSV sencillo (fase 2). Reglas puras, sin React ni
// Supabase; no importa nada con "@/" (las pruebas lo cargan con Node).
//
// Una fila por producto: nombre, categoría, precio[, mínimo[, existencias]]
// Separador: coma, punto y coma o tabulador (copiado de una hoja de cálculo).
// El encabezado es opcional. Un campo con comas va entre comillas: "Whisky, 750 ml".
// Precio en pesos con punto decimal: 350 o 350.50 (con coma de miles solo si
// el separador no es coma, o entre comillas: "1,250.50").

export interface FilaCatalogo {
  nombre: string;
  categoria: string;
  precio_centavos: number;
  existencias_minimas: number;
  existencias: number;
}

export const MAX_FILAS_CSV = 500;

function separadorDe(linea: string): string {
  const cuenta = (c: string) => linea.split(c).length - 1;
  if (cuenta("\t") > 0) return "\t";
  return cuenta(";") > cuenta(",") ? ";" : ",";
}

// Divide una línea respetando comillas dobles ("" dentro de comillas = ").
export function partirLinea(linea: string, sep: string): string[] {
  const campos: string[] = [];
  let actual = "";
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (comillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') comillas = false;
      else actual += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) {
      campos.push(actual.trim());
      actual = "";
    } else actual += c;
  }
  campos.push(actual.trim());
  return campos;
}

// "350" → 35000; "1,250.50" → 125050; "$350" → 35000. Nulo si no es válido.
export function pesosACentavos(texto: string): number | null {
  const t = texto.replace(/[\s$]/g, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
  const [enteros, dec = ""] = t.replace(/,/g, "").split(".");
  const c = Number(enteros) * 100 + Number(dec.padEnd(2, "0"));
  return Number.isSafeInteger(c) ? c : null;
}

const entero = (t: string | undefined, def: number): number | null => {
  if (t === undefined || t.trim() === "") return def;
  return /^\d{1,6}$/.test(t.trim()) ? Number(t.trim()) : null;
};
const quitarAcentos = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function leerCatalogoCsv(texto: string): { filas: FilaCatalogo[]; errores: string[] } {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/);
  const filas: FilaCatalogo[] = [];
  const errores: string[] = [];
  const vistos = new Map<string, number>();
  let sep: string | null = null;
  lineas.forEach((linea, i) => {
    if (!linea.trim()) return;
    sep ??= separadorDe(linea);
    const c = partirLinea(linea, sep);
    const n = i + 1;
    // Encabezado: primera línea con "nombre" y "precio".
    if (filas.length === 0 && errores.length === 0 && /nombre/.test(quitarAcentos(c[0] ?? "")) && c.some((x) => /precio/.test(quitarAcentos(x)))) return;
    const [nombre = "", categoria = "", precio = "", minimo, existencias] = c;
    if (!nombre || nombre.length > 80) return errores.push(`Línea ${n}: el nombre va de 1 a 80 caracteres.`);
    if (!categoria || categoria.length > 40) return errores.push(`Línea ${n}: la categoría va de 1 a 40 caracteres.`);
    const centavos = pesosACentavos(precio);
    if (centavos == null || centavos < 1 || centavos > 100_000_000) return errores.push(`Línea ${n}: precio inválido («${precio}»).`);
    const min = entero(minimo, 0);
    if (min == null) return errores.push(`Línea ${n}: el mínimo es un número entero.`);
    const exi = entero(existencias, 0);
    if (exi == null) return errores.push(`Línea ${n}: las existencias son un número entero.`);
    const clave = nombre.trim().toLowerCase();
    if (vistos.has(clave)) return errores.push(`Línea ${n}: «${nombre}» ya viene en la línea ${vistos.get(clave)}.`);
    vistos.set(clave, n);
    filas.push({ nombre, categoria, precio_centavos: centavos, existencias_minimas: min, existencias: exi });
  });
  if (filas.length > MAX_FILAS_CSV) errores.push(`Máximo ${MAX_FILAS_CSV} productos por importación (vienen ${filas.length}).`);
  return { filas, errores };
}
