// Adaptador Excel (.xlsx) de ventas del POS, sin dependencias. Puro (sin
// "@/"); corre igual en el navegador y en Node 18+ (pruebas).
//
// Un .xlsx es un zip con XML adentro. Se lee:
//   - el directorio central del zip (sin ZIP64: archivos de menos de 4 GB);
//   - cada parte con DecompressionStream("deflate-raw") (o sin comprimir);
//   - xl/workbook.xml + sus relaciones → la PRIMERA hoja del libro;
//   - xl/sharedStrings.xml (textos), xl/styles.xml (qué celdas son fecha);
//   - la hoja: filas <row r>, celdas <c r t s> con <v> o <is><t>.
// El XML se recorre con expresiones regulares (con o sin prefijo de
// espacio de nombres, «x:row»): en Node no hay DOMParser y así la prueba
// es la misma que corre en la pantalla.
//
// Números de fecha de Excel (seriales) en celdas con formato de fecha u
// hora → «AAAA-MM-DD HH:MM:SS», «AAAA-MM-DD» o «HH:MM:SS» (sistema 1900 y
// 1904). Otros números → texto con punto decimal («1234.5»).

import type { AdaptadorPos, FilaCruda, TablaCruda } from "./tipos";

// ---------------------------------------------------------------- zip ------
interface EntradaZip {
  nombre: string;
  metodo: number;
  comprimido: number;
  offsetLocal: number;
}

function leerU16(b: Uint8Array, i: number) {
  return b[i] | (b[i + 1] << 8);
}
function leerU32(b: Uint8Array, i: number) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

export function entradasZip(b: Uint8Array): Map<string, EntradaZip> {
  // Fin del directorio central: firma 0x06054b50 en los últimos 64 KB.
  let fin = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new Error("El archivo no es un Excel válido (no se encontró el índice del zip).");
  const total = leerU16(b, fin + 10);
  let p = leerU32(b, fin + 16);
  const salida = new Map<string, EntradaZip>();
  const dec = new TextDecoder("utf-8");
  for (let k = 0; k < total; k++) {
    if (leerU32(b, p) !== 0x02014b50) throw new Error("El archivo de Excel está dañado (índice del zip).");
    const metodo = leerU16(b, p + 10);
    const comprimido = leerU32(b, p + 20);
    const largoNombre = leerU16(b, p + 28);
    const largoExtra = leerU16(b, p + 30);
    const largoComentario = leerU16(b, p + 32);
    const offsetLocal = leerU32(b, p + 42);
    const nombre = dec.decode(b.subarray(p + 46, p + 46 + largoNombre));
    salida.set(nombre, { nombre, metodo, comprimido, offsetLocal });
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  return salida;
}

/** Tope de una parte descomprimida: un zip pequeño puede inflarse a
 *  gigabytes («bomba zip»); se corta antes de llenar la memoria. */
export const MAX_DESCOMPRIMIDO = 50_000_000;

async function inflar(datos: Uint8Array, max = MAX_DESCOMPRIMIDO): Promise<Uint8Array> {
  const copia = new Uint8Array(datos); // ArrayBuffer propio (Blob no acepta vistas compartidas)
  const lector = new Blob([copia]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await lector.cancel().catch(() => {});
      throw new Error(`El archivo de Excel descomprimido pasa de ${Math.round(max / 1_000_000)} MB: exporta menos días o usa CSV.`);
    }
    trozos.push(value);
  }
  const salida = new Uint8Array(total);
  let p = 0;
  for (const t of trozos) {
    salida.set(t, p);
    p += t.length;
  }
  return salida;
}

export async function leerParteZip(b: Uint8Array, e: EntradaZip, max = MAX_DESCOMPRIMIDO): Promise<string> {
  const p = e.offsetLocal;
  if (leerU32(b, p) !== 0x04034b50) throw new Error("El archivo de Excel está dañado (encabezado local).");
  const inicio = p + 30 + leerU16(b, p + 26) + leerU16(b, p + 28);
  const datos = b.subarray(inicio, inicio + e.comprimido);
  let crudo: Uint8Array;
  if (e.metodo === 0) crudo = datos;
  else if (e.metodo === 8) crudo = await inflar(datos, max);
  else throw new Error(`El archivo de Excel usa una compresión que no se reconoce (${e.metodo}).`);
  return new TextDecoder("utf-8").decode(crudo);
}

// ---------------------------------------------------------------- xml ------
export function decodificarXml(t: string): string {
  return t
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      if (e === "amp") return "&";
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
        throw new Error(`El archivo de Excel trae un carácter inválido («&${e};»): no se puede leer.`);
      }
      return String.fromCodePoint(cp);
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function atributos(t: string): Record<string, string> {
  const a: Record<string, string> = {};
  for (const m of t.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) a[m[1]] = decodificarXml(m[2]);
  return a;
}

const P = "(?:[\\w-]+:)?"; // prefijo opcional de espacio de nombres

/** Texto de un <si> o <is>: todos los <t>, sin los <rPh> (fonética). */
function textoDe(xml: string): string {
  const sinFonetica = xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, "g"), "");
  let s = "";
  for (const m of sinFonetica.matchAll(new RegExp(`<${P}t\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}t>)`, "g"))) s += decodificarXml(m[1] ?? "");
  return s;
}

export function textosCompartidos(xml: string): string[] {
  return [...xml.matchAll(new RegExp(`<${P}si\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}si>)`, "g"))].map((m) => textoDe(m[1] ?? ""));
}

/** Qué muestra un formato de número: fecha, hora, las dos, o ninguna. */
export type TipoFecha = "fecha" | "hora" | "fechahora";

// Formatos de número integrados de Excel que son fecha u hora.
const INTEGRADOS: Record<number, TipoFecha> = {
  14: "fecha", 15: "fecha", 16: "fecha", 17: "fecha", 18: "hora", 19: "hora", 20: "hora", 21: "hora", 22: "fechahora",
  45: "hora", 46: "hora", 47: "hora",
  27: "fecha", 28: "fecha", 29: "fecha", 30: "fecha", 31: "fecha", 32: "hora", 33: "hora", 34: "hora", 35: "hora", 36: "fecha",
  50: "fecha", 51: "fecha", 52: "fecha", 53: "fecha", 54: "fecha", 55: "hora", 56: "hora", 57: "fecha", 58: "fecha",
};

/** Tipo de un código de formato propio («dd/mm/yyyy hh:mm» → fechahora). */
export function tipoFormato(codigo: string): TipoFecha | null {
  const limpio = codigo
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
    .replace(/[_*]./g, "")
    .replace(/General/gi, "");
  const conFecha = /[dy]/i.test(limpio) || (/m/i.test(limpio) && !/[hs]/i.test(limpio));
  const conHora = /[hs]/i.test(limpio);
  if (conFecha && conHora) return "fechahora";
  if (conHora) return "hora";
  return conFecha ? "fecha" : null;
}

// «General», números y moneda no tienen d/m/y/h/s fuera de comillas.
export const esFormatoFecha = (codigo: string): boolean => tipoFormato(codigo) !== null;

/** Para cada índice de estilo (atributo s de la celda): fecha, hora, las dos o nulo. */
export function estilosFecha(xml: string): (TipoFecha | null)[] {
  const propios = new Map<number, string>();
  for (const m of xml.matchAll(new RegExp(`<${P}numFmt\\b([^>]*)/?>`, "g"))) {
    const a = atributos(m[1]);
    if (a.numFmtId) propios.set(Number(a.numFmtId), a.formatCode ?? "");
  }
  const bloque = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`).exec(xml)?.[1] ?? "";
  return [...bloque.matchAll(new RegExp(`<${P}xf\\b([^>]*?)(?:/>|>)`, "g"))].map((m) => {
    const id = Number(atributos(m[1]).numFmtId ?? 0);
    if (INTEGRADOS[id]) return INTEGRADOS[id];
    const codigo = propios.get(id);
    return codigo === undefined ? null : tipoFormato(codigo);
  });
}

const dos = (n: number) => String(n).padStart(2, "0");

/** Serial de Excel → «AAAA-MM-DD HH:MM:SS», «AAAA-MM-DD» o «HH:MM:SS».
 *  Con formato de fecha y hora, SIEMPRE fecha y hora (también a las 00:00);
 *  con formato de solo hora, la hora (también en libros 1904). */
export function serialAFecha(serial: number, sistema1904 = false, tipo?: TipoFecha): string {
  const segundosTotales = Math.round(serial * 86400);
  const dias = Math.floor(segundosTotales / 86400);
  const seg = segundosTotales - dias * 86400;
  const hora = `${dos(Math.floor(seg / 3600))}:${dos(Math.floor((seg % 3600) / 60))}:${dos(seg % 60)}`;
  if (tipo === "hora" || (serial < 1 && tipo !== "fechahora" && (tipo !== "fecha" || !sistema1904))) return hora;
  const base = sistema1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + dias * 86400000);
  const fecha = `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}`;
  return seg === 0 && tipo !== "fechahora" ? fecha : `${fecha} ${hora}`;
}

/** «AB12» → columna 27 (desde 0). */
export function columnaDe(ref: string): number {
  const letras = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "";
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function numeroATexto(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n)) return String(n);
  // Quita el ruido de punto flotante (123.45000000000002) sin perder centavos.
  return String(Math.round(n * 1e6) / 1e6);
}

export function filasDeHoja(xml: string, compartidos: string[], fechas: (TipoFecha | null)[], sistema1904: boolean): FilaCruda[] {
  const filas: FilaCruda[] = [];
  let siguiente = 1;
  const reFila = new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, "g");
  const reCelda = new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, "g");
  const reV = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)</${P}v>`);
  const reIs = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)</${P}is>`);
  for (const m of xml.matchAll(reFila)) {
    const af = atributos(m[1]);
    const n = af.r ? Number(af.r) : siguiente;
    siguiente = n + 1;
    const celdas: string[] = [];
    let col = 0;
    for (const c of (m[2] ?? "").matchAll(reCelda)) {
      const a = atributos(c[1]);
      if (a.r) col = columnaDe(a.r);
      const cuerpo = c[2] ?? "";
      const v = reV.exec(cuerpo)?.[1];
      let texto = "";
      switch (a.t) {
        case "s":
          texto = compartidos[Number(v)] ?? "";
          break;
        case "inlineStr":
          texto = textoDe(reIs.exec(cuerpo)?.[1] ?? "");
          break;
        case "str":
        case "e":
          texto = decodificarXml(v ?? "");
          break;
        case "b":
          texto = v === "1" ? "VERDADERO" : "FALSO";
          break;
        default:
          if (v !== undefined && v !== "") {
            const estilo = a.s ? Number(a.s) : 0;
            const tipo = fechas[estilo];
            texto = tipo && Number.isFinite(Number(v)) ? serialAFecha(Number(v), sistema1904, tipo) : numeroATexto(v);
          }
      }
      while (celdas.length < col) celdas.push("");
      celdas[col] = texto.trim();
      col++;
    }
    if (celdas.some((x) => x !== "")) filas.push({ n, celdas });
  }
  return filas;
}

function rutaRelativa(base: string, destino: string): string {
  if (destino.startsWith("/")) return destino.slice(1);
  const partes = base.split("/").slice(0, -1);
  for (const p of destino.split("/")) {
    if (p === "..") partes.pop();
    else if (p !== ".") partes.push(p);
  }
  return partes.join("/");
}

export function esZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function leerXlsx(bytes: Uint8Array): Promise<TablaCruda> {
  if (!esZip(bytes)) throw new Error("El archivo no es un Excel .xlsx (los .xls viejos no se leen: guárdalo como .xlsx o CSV).");
  const zip = entradasZip(bytes);
  const parte = async (ruta: string) => {
    const e = zip.get(ruta);
    return e ? leerParteZip(bytes, e) : null;
  };
  const libro = await parte("xl/workbook.xml");
  if (!libro) throw new Error("El archivo no es un libro de Excel (falta xl/workbook.xml).");
  const sistema1904 = new RegExp(`<${P}workbookPr\\b[^>]*date1904\\s*=\\s*"(1|true)"`).test(libro);
  const hojas = [...libro.matchAll(new RegExp(`<${P}sheet\\b([^>]*?)/?>`, "g"))].map((m) => atributos(m[1]));
  const avisos: string[] = [];
  let rutaHoja = "xl/worksheets/sheet1.xml";
  const primera = hojas[0];
  if (primera) {
    const rid = Object.entries(primera).find(([k]) => /(^|:)id$/.test(k) && k !== "sheetId")?.[1];
    const rels = await parte("xl/_rels/workbook.xml.rels");
    if (rid && rels) {
      for (const m of rels.matchAll(/<(?:[\w-]+:)?Relationship\b([^>]*?)\/?>/g)) {
        const a = atributos(m[1]);
        if (a.Id === rid && a.Target) rutaHoja = rutaRelativa("xl/workbook.xml", a.Target);
      }
    }
    if (hojas.length > 1) avisos.push(`El libro tiene ${hojas.length} hojas: se lee solo la primera («${primera.name ?? "Hoja 1"}»).`);
  }
  const hoja = await parte(rutaHoja);
  if (!hoja) throw new Error("No se encontró la primera hoja del libro.");
  const compartidos = textosCompartidos((await parte("xl/sharedStrings.xml")) ?? "");
  const fechas = estilosFecha((await parte("xl/styles.xml")) ?? "");
  return { filas: filasDeHoja(hoja, compartidos, fechas, sistema1904), avisos };
}

export const adaptadorXlsx: AdaptadorPos = {
  formato: "xlsx",
  nombre: "Excel (.xlsx)",
  extensiones: [".xlsx"],
  reconoce: (bytes) => esZip(bytes),
  leer: leerXlsx,
};
