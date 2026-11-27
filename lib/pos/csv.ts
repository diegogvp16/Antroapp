// Adaptador CSV de ventas del POS. Puro (sin "@/").
//
// - Codificación: UTF-8 (con o sin BOM), UTF-16 con BOM (el «Texto Unicode»
//   de Excel) y, si el UTF-8 no es válido, Windows-1252 / Latin-1 (lo que
//   exportan muchos programas en Windows: «Café», «Año»).
// - Separador: coma, punto y coma, tabulador o barra vertical. Se elige el
//   que da el mismo número de columnas en las primeras filas; una primera
//   línea «sep=;» (pista de Excel) lo fija.
// - Comillas dobles: un campo entre comillas puede traer el separador y
//   saltos de línea; "" dentro de comillas es una comilla.
// - Las filas vacías no cuentan, pero conservan su número de línea.

import type { AdaptadorPos, FilaCruda, TablaCruda } from "./tipos";

export function decodificarTexto(bytes: Uint8Array): { texto: string; codificacion: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { texto: new TextDecoder("utf-8").decode(bytes.subarray(3)), codificacion: "UTF-8" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { texto: new TextDecoder("utf-16le").decode(bytes.subarray(2)), codificacion: "UTF-16" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { texto: new TextDecoder("utf-16be").decode(bytes.subarray(2)), codificacion: "UTF-16" };
  }
  try {
    return { texto: new TextDecoder("utf-8", { fatal: true }).decode(bytes), codificacion: "UTF-8" };
  } catch {
    return { texto: new TextDecoder("windows-1252").decode(bytes), codificacion: "Windows-1252" };
  }
}

const CANDIDATOS = ["\t", ";", ",", "|"] as const;

// Cuántas veces aparece `sep` fuera de comillas en cada una de las primeras
// filas (las comillas pueden abarcar varias líneas físicas).
function conteosPorFila(texto: string, sep: string, maxFilas = 12): number[] {
  const conteos: number[] = [];
  let n = 0;
  let comillas = false;
  let vacia = true;
  for (let i = 0; i < texto.length && conteos.length < maxFilas; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') i++;
      else if (c === '"') comillas = false;
      continue;
    }
    if (c === '"') {
      comillas = true;
      vacia = false;
    } else if (c === sep) {
      n++;
      vacia = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      if (!vacia) conteos.push(n);
      n = 0;
      vacia = true;
    } else if (c.trim()) vacia = false;
  }
  if (!vacia && conteos.length < maxFilas) conteos.push(n);
  return conteos;
}

/** Elige el separador: el que más filas tienen con el mismo número (> 0) de
 *  separadores; en empate, el que da más columnas; luego tab > ; > , > |. */
export function detectarSeparador(texto: string): string {
  let mejor: { sep: string; filas: number; columnas: number } | null = null;
  for (const sep of CANDIDATOS) {
    const conteos = conteosPorFila(texto, sep).filter((x) => x > 0);
    if (!conteos.length) continue;
    const moda = new Map<number, number>();
    conteos.forEach((x) => moda.set(x, (moda.get(x) ?? 0) + 1));
    const [columnas, filas] = [...moda.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (!mejor || filas > mejor.filas || (filas === mejor.filas && columnas > mejor.columnas)) mejor = { sep, filas, columnas };
  }
  return mejor?.sep ?? ",";
}

/** Parte el texto en filas y campos (comillas con saltos de línea incluidas). */
export function partirCsv(texto: string, sep?: string): { filas: FilaCruda[]; separador: string; avisos: string[] } {
  const avisos: string[] = [];
  let t = texto.replace(/^﻿/, "");
  let lineaInicial = 1;
  const pista = /^sep=(.)\r?\n/i.exec(t);
  if (pista) {
    sep ??= pista[1];
    t = t.slice(pista[0].length);
    lineaInicial = 2;
  }
  const separador = sep ?? detectarSeparador(t);
  const filas: FilaCruda[] = [];
  let campos: string[] = [];
  let campo = "";
  let comillas = false;
  let linea = lineaInicial;
  let inicioFila = linea;
  let algo = false;
  const cerrarFila = () => {
    campos.push(campo);
    if (algo || campos.some((x) => x.trim() !== "")) filas.push({ n: inicioFila, celdas: campos.map((x) => x.trim()) });
    campos = [];
    campo = "";
    algo = false;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') comillas = false;
      else {
        if (c === "\n") linea++;
        campo += c;
      }
      continue;
    }
    if (c === '"' && campo.trim() === "") {
      campo = "";
      comillas = true;
      algo = true;
    } else if (c === separador) {
      campos.push(campo);
      campo = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      cerrarFila();
      linea++;
      inicioFila = linea;
    } else campo += c;
  }
  if (comillas) avisos.push(`Hay unas comillas sin cerrar desde la línea ${inicioFila}: revisa el archivo.`);
  if (campo !== "" || campos.length) cerrarFila();
  // Saltos de línea dentro de un campo: se vuelven espacio.
  for (const f of filas) f.celdas = f.celdas.map((x) => x.replace(/\s*[\r\n]+\s*/g, " "));
  return { filas, separador, avisos };
}

const NOMBRE_SEP: Record<string, string> = { "\t": "tabulador", ";": "punto y coma", ",": "coma", "|": "barra vertical" };

export const adaptadorCsv: AdaptadorPos = {
  formato: "csv",
  nombre: "CSV o texto separado",
  extensiones: [".csv", ".txt", ".tsv"],
  reconoce(bytes, nombre) {
    // Un .xlsx es un zip («PK»): nunca es CSV aunque se llame .csv.
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return false;
    return /\.(csv|txt|tsv)$/i.test(nombre) || !/\.\w+$/.test(nombre);
  },
  async leer(bytes): Promise<TablaCruda> {
    const { texto, codificacion } = decodificarTexto(bytes);
    const { filas, separador, avisos } = partirCsv(texto);
    return {
      filas,
      avisos: [`Leído como ${codificacion}, separado por ${NOMBRE_SEP[separador] ?? `«${separador}»`}.`, ...avisos],
    };
  },
};
