// Registro de adaptadores de archivos del POS. Puro (sin "@/").
// Un POS nuevo con otro formato de archivo = otro AdaptadorPos aquí; el
// mapeo, la vista previa y la base no cambian.

import { adaptadorCsv } from "./csv";
import { adaptadorXlsx } from "./xlsx";
import { elegirEncabezado } from "./mapeo";
import { MAX_BYTES_POS, type AdaptadorPos, type FormatoPos, type TablaPos } from "./tipos";

export const ADAPTADORES_POS: readonly AdaptadorPos[] = [adaptadorXlsx, adaptadorCsv];

export const EXTENSIONES_POS = ADAPTADORES_POS.flatMap((a) => a.extensiones).join(",");

/** El adaptador que reconoce estos bytes (Excel por contenido; si no, CSV). */
export function elegirAdaptador(bytes: Uint8Array, nombreArchivo: string): AdaptadorPos | null {
  if (/\.xls$/i.test(nombreArchivo) && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  return ADAPTADORES_POS.find((a) => a.reconoce(bytes, nombreArchivo)) ?? null;
}

export type ArchivoLeido = { ok: true; formato: FormatoPos; tabla: TablaPos } | { ok: false; error: string };

/** Bytes del archivo → tabla con encabezados. Nunca lanza: devuelve el error. */
export async function leerArchivoPos(bytes: Uint8Array, nombreArchivo: string): Promise<ArchivoLeido> {
  if (!bytes.length) return { ok: false, error: "El archivo está vacío." };
  if (bytes.length > MAX_BYTES_POS) {
    return { ok: false, error: `El archivo pesa más de ${Math.round(MAX_BYTES_POS / 1_000_000)} MB: parte el reporte por noche.` };
  }
  const adaptador = elegirAdaptador(bytes, nombreArchivo);
  if (!adaptador) {
    return { ok: false, error: "Ese archivo no se puede leer: usa CSV o Excel .xlsx (un .xls viejo: ábrelo y guárdalo como .xlsx)." };
  }
  try {
    const cruda = await adaptador.leer(bytes);
    const tabla = elegirEncabezado(cruda);
    if (!tabla.encabezados.length) return { ok: false, error: "El archivo no trae filas." };
    if (!tabla.filas.length) return { ok: false, error: "El archivo solo trae encabezados, sin ventas." };
    return { ok: true, formato: adaptador.formato, tabla };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : "No se pudo leer el archivo." };
  }
}

/** Huella SHA-256 del archivo (hex): el mismo archivo no se importa dos veces. */
export async function huellaArchivo(bytes: Uint8Array): Promise<string> {
  const copia = new Uint8Array(bytes);
  const h = await crypto.subtle.digest("SHA-256", copia);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
