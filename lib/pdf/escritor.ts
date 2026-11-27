// Escritor de PDF mínimo, sin dependencias (reportes PDF del dueño,
// docs/post-junta-3/reportes.md).
//
// Solo lo que necesitan los reportes: hojas tamaño carta, texto en las
// fuentes estándar Helvetica y Helvetica-Bold (todo lector de PDF las trae,
// no se incrustan) con la codificación WinAnsi, líneas y rectángulos de
// color. WinAnsi cubre el español completo: á é í ó ú ü ñ Á É Í Ó Ú Ü Ñ ¿ ¡
// $ « » – — y €. Lo que no esté en WinAnsi se le quitan los acentos
// (NFKD) y, si aun así no está, sale "?". Invisibles y emojis no se imprimen.
//
// El archivo queda en ASCII puro (el texto va en cadenas hexadecimales), sin
// compresión: fácil de revisar y de probar (pdftotext lo lee).
//
// Sin imports a propósito: así las pruebas de Node lo cargan directo
// (node --experimental-strip-types no resuelve los alias "@/").

export type Fuente = "normal" | "negrita";
export type Color = readonly [number, number, number];
export type Alineacion = "izq" | "der" | "centro";

export interface EstiloTexto {
  fuente?: Fuente;
  tam?: number;
  color?: Color;
  alinear?: Alineacion;
}

// Carta (8.5 × 11 in), en puntos.
export const ANCHO_HOJA = 612;
export const ALTO_HOJA = 792;

// ---------------------------------------------------------------------------
// Anchos de los glifos (milésimas del tamaño), de los AFM de Adobe para
// Helvetica y Helvetica-Bold. Sirven para alinear a la derecha y partir
// renglones; no se escriben en el PDF (las fuentes estándar ya los traen).
// ---------------------------------------------------------------------------

// Códigos 32–126.
const ASCII_NORMAL = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ASCII_NEGRITA = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// Códigos 160–255 (Latin-1, igual en WinAnsi).
const LATIN_NORMAL = [
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278,
  333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500,
  556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];
const LATIN_NEGRITA = [
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278,
  333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556,
  556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

// Unicode → byte WinAnsi para los códigos 128–159 (comillas, guiones, €…).
const ESPECIALES: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
// Anchos de esos códigos (normal, negrita).
const ANCHO_ESPECIAL: Record<number, readonly [number, number]> = {
  0x80: [556, 556], 0x82: [222, 278], 0x83: [556, 556], 0x84: [333, 500], 0x85: [1000, 1000], 0x86: [556, 556],
  0x87: [556, 556], 0x88: [333, 333], 0x89: [1000, 1000], 0x8a: [667, 667], 0x8b: [333, 333], 0x8c: [1000, 1000],
  0x8e: [611, 611], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350],
  0x96: [556, 556], 0x97: [1000, 1000], 0x98: [333, 333], 0x99: [1000, 1000], 0x9a: [500, 556], 0x9b: [333, 333],
  0x9c: [944, 944], 0x9e: [500, 500], 0x9f: [667, 667],
};

// Espacios "raros" que da Intl (es-MX) y que se escriben como espacio normal.
const ESPACIOS = new Set([0x00a0, 0x2007, 0x2009, 0x200a, 0x202f, 0x2002, 0x2003]);

function byteDe(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa1 && cp <= 0xff) return cp;
  if (ESPACIOS.has(cp)) return 0x20;
  if (cp === 0x2212) return 0x2d; // signo menos → guion
  return ESPECIALES[cp] ?? null;
}

// No se imprimen: invisibles (marcas de dirección, unión de emojis U+200D,
// selectores de variante U+FE0F…), emojis y pictogramas, tonos de piel y
// letras de bandera. Así «Ana ❤️» sale «Ana », no «Ana ??».
const SE_QUITA = /[\p{Default_Ignorable_Code_Point}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;
const MARCA = /\p{M}/u;

/** Bytes WinAnsi de UNA letra: ninguno (invisible), uno, o varios (ﬁ → f i). */
function bytesDeLetra(ch: string): number[] {
  const cp = ch.codePointAt(0) ?? 0x3f;
  if (cp === 0x0a || cp === 0x0d || cp === 0x09 || cp === 0x2028 || cp === 0x2029) return [0x20];
  const b = byteDe(cp);
  if (b !== null) return [b];
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || SE_QUITA.test(ch) || MARCA.test(ch)) return [];
  // Compatibilidad (NFKD): letras de ancho completo, ligaduras, acentos fuera
  // de Latin-1 (ő → o). Si alguna parte no tiene lugar en WinAnsi, "?".
  const salida: number[] = [];
  for (const c of ch.normalize("NFKD")) {
    if (MARCA.test(c) || SE_QUITA.test(c)) continue;
    const bb = byteDe(c.codePointAt(0) ?? 0);
    if (bb === null) return [0x3f];
    salida.push(bb);
  }
  return salida.length > 0 ? salida : [0x3f];
}

/** Texto → bytes WinAnsi. Saltos de línea y tabuladores salen como espacio. */
export function aWinAnsi(texto: string): number[] {
  const bytes: number[] = [];
  for (const ch of texto.normalize("NFC")) for (const b of bytesDeLetra(ch)) bytes.push(b);
  return bytes;
}

function anchoByte(b: number, fuente: Fuente): number {
  const negrita = fuente === "negrita";
  if (b >= 32 && b <= 126) return (negrita ? ASCII_NEGRITA : ASCII_NORMAL)[b - 32];
  if (b >= 160 && b <= 255) return (negrita ? LATIN_NEGRITA : LATIN_NORMAL)[b - 160];
  const e = ANCHO_ESPECIAL[b];
  return e ? e[negrita ? 1 : 0] : 556;
}

/** Ancho en puntos de bytes ya codificados (lo usan las pruebas para revisar márgenes). */
export function anchoBytes(bytes: readonly number[], fuente: Fuente = "normal", tam = 10): number {
  let milesimas = 0;
  for (const b of bytes) milesimas += anchoByte(b, fuente);
  return (milesimas * tam) / 1000;
}

/** Ancho del texto en puntos. */
export function anchoTexto(texto: string, fuente: Fuente = "normal", tam = 10): number {
  return anchoBytes(aWinAnsi(texto), fuente, tam);
}

// Letras (NFC) con su ancho: se miden UNA vez y luego todo es sumar
// (partir y recortar son de una pasada, aunque el texto sea enorme).
function letrasConAncho(texto: string, fuente: Fuente, tam: number): { t: string; a: number }[] {
  return Array.from(texto.normalize("NFC"), (t) => ({ t, a: anchoBytes(bytesDeLetra(t), fuente, tam) }));
}

/** Recorta con "…" para que quepa en `ancho`. */
export function recortarTexto(texto: string, ancho: number, fuente: Fuente = "normal", tam = 10): string {
  const letras = letrasConAncho(texto, fuente, tam);
  if (letras.reduce((s, l) => s + l.a, 0) <= ancho) return texto;
  const elipsis = anchoTexto("…", fuente, tam);
  let usado = 0;
  let n = 0;
  while (n < letras.length && usado + letras[n].a + elipsis <= ancho) {
    usado += letras[n].a;
    n++;
  }
  return letras.slice(0, n).map((l) => l.t).join("").trimEnd() + "…";
}

/** Parte el texto en renglones de `ancho` como máximo (por palabras; una
 *  palabra más larga que el renglón se corta por letras). Con
 *  `maxRenglones`, lo que sobra se recorta con "…" en el último renglón. */
export function partirTexto(texto: string, ancho: number, fuente: Fuente = "normal", tam = 10, maxRenglones = Infinity): string[] {
  const renglones: string[] = [];
  const espacio = anchoBytes([0x20], fuente, tam);
  for (const parrafo of texto.split("\n")) {
    let actual = "";
    let anchoActual = 0;
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      const letras = letrasConAncho(palabra, fuente, tam);
      const anchoPalabra = letras.reduce((s, l) => s + l.a, 0);
      if (actual && anchoActual + espacio + anchoPalabra <= ancho) {
        actual += " " + palabra;
        anchoActual += espacio + anchoPalabra;
        continue;
      }
      if (actual) renglones.push(actual);
      if (anchoPalabra <= ancho) {
        actual = palabra;
        anchoActual = anchoPalabra;
        continue;
      }
      // La palabra sola no cabe: se corta por letras, en una sola pasada.
      let trozo = "";
      let anchoTrozo = 0;
      for (const l of letras) {
        if (trozo && anchoTrozo + l.a > ancho) {
          renglones.push(trozo);
          trozo = "";
          anchoTrozo = 0;
        }
        trozo += l.t;
        anchoTrozo += l.a;
      }
      actual = trozo;
      anchoActual = anchoTrozo;
    }
    renglones.push(actual);
  }
  if (renglones.length <= maxRenglones) return renglones;
  const max = Math.max(1, maxRenglones);
  return [...renglones.slice(0, max - 1), recortarTexto(renglones.slice(max - 1).join(" "), ancho, fuente, tam)];
}

// ---------------------------------------------------------------------------
// Documento.
// ---------------------------------------------------------------------------

const num = (n: number) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "") || "0";
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const colorOp = (c: Color, op: "rg" | "RG") => `${num(c[0])} ${num(c[1])} ${num(c[2])} ${op}`;

// Cadena de texto del diccionario Info en UTF-16BE (acentos en el título).
function textoInfo(texto: string): string {
  let h = "FEFF";
  for (let i = 0; i < texto.length; i++) h += texto.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${h}>`;
}

export interface MetadatosPdf {
  titulo: string;
  autor?: string;
  asunto?: string;
  /** Fecha de creación (por omisión, ahora). */
  creado?: Date;
}

export class DocumentoPdf {
  private paginas: string[][] = [];
  private actual = -1;

  constructor() {
    this.nuevaPagina();
  }

  get numeroPaginas(): number {
    return this.paginas.length;
  }

  /** Agrega una hoja y la deja como actual. Devuelve su índice (desde 0). */
  nuevaPagina(): number {
    this.paginas.push([]);
    this.actual = this.paginas.length - 1;
    return this.actual;
  }

  /** Vuelve a una hoja ya creada (para pies de página "1 de N"). */
  irAPagina(indice: number): void {
    if (indice < 0 || indice >= this.paginas.length) throw new Error("Página inexistente");
    this.actual = indice;
  }

  private op(linea: string) {
    this.paginas[this.actual].push(linea);
  }

  /** Texto en (x, y), con y medida desde ARRIBA de la hoja hasta la línea base. */
  texto(x: number, y: number, texto: string, estilo: EstiloTexto = {}): void {
    const fuente = estilo.fuente ?? "normal";
    const tam = estilo.tam ?? 10;
    const bytes = aWinAnsi(texto);
    if (bytes.length === 0) return;
    let xx = x;
    if (estilo.alinear === "der") xx = x - anchoTexto(texto, fuente, tam);
    else if (estilo.alinear === "centro") xx = x - anchoTexto(texto, fuente, tam) / 2;
    this.op(
      `BT /${fuente === "negrita" ? "F2" : "F1"} ${num(tam)} Tf ${colorOp(estilo.color ?? [0, 0, 0], "rg")} ` +
        `${num(xx)} ${num(ALTO_HOJA - y)} Td <${hex(bytes)}> Tj ET`,
    );
  }

  linea(x1: number, y1: number, x2: number, y2: number, grosor = 0.5, color: Color = [0, 0, 0]): void {
    this.op(`q ${colorOp(color, "RG")} ${num(grosor)} w ${num(x1)} ${num(ALTO_HOJA - y1)} m ${num(x2)} ${num(ALTO_HOJA - y2)} l S Q`);
  }

  /** Rectángulo relleno; (x, y) es la esquina de ARRIBA a la izquierda. */
  rect(x: number, y: number, ancho: number, alto: number, relleno: Color, borde?: Color): void {
    const pinta = borde ? `${colorOp(borde, "RG")} 0.5 w` : "";
    this.op(`q ${colorOp(relleno, "rg")} ${pinta} ${num(x)} ${num(ALTO_HOJA - y - alto)} ${num(ancho)} ${num(alto)} re ${borde ? "B" : "f"} Q`);
  }

  /** El archivo completo. */
  generar(meta: MetadatosPdf): Uint8Array {
    const objetos: string[] = [];
    const n = this.paginas.length;
    // 1 catálogo, 2 páginas, 3 y 4 fuentes, 5 info; luego hoja y contenido.
    const idHoja = (i: number) => 6 + i * 2;
    const idContenido = (i: number) => 7 + i * 2;
    objetos[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objetos[2] = `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${idHoja(i)} 0 R`).join(" ")}] /Count ${n} >>`;
    objetos[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objetos[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    const f = meta.creado ?? new Date();
    const dos = (v: number) => String(v).padStart(2, "0");
    const fechaPdf = `D:${f.getUTCFullYear()}${dos(f.getUTCMonth() + 1)}${dos(f.getUTCDate())}${dos(f.getUTCHours())}${dos(f.getUTCMinutes())}${dos(f.getUTCSeconds())}Z`;
    objetos[5] =
      `<< /Title ${textoInfo(meta.titulo)} /Author ${textoInfo(meta.autor ?? "AntroApp")}` +
      (meta.asunto ? ` /Subject ${textoInfo(meta.asunto)}` : "") +
      ` /Producer ${textoInfo("AntroApp")} /CreationDate (${fechaPdf}) >>`;
    for (let i = 0; i < n; i++) {
      const contenido = this.paginas[i].join("\n");
      objetos[idHoja(i)] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO_HOJA} ${ALTO_HOJA}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idContenido(i)} 0 R >>`;
      objetos[idContenido(i)] = `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`;
    }

    // Todo es ASCII salvo la marca binaria del encabezado (4 bytes > 127,
    // un carácter = un byte): la posición en la cadena es la del archivo.
    let salida = "%PDF-1.4\n%âãÏÓ\n";
    const posiciones: number[] = [];
    for (let id = 1; id < objetos.length; id++) {
      posiciones[id] = salida.length;
      salida += `${id} 0 obj\n${objetos[id]}\nendobj\n`;
    }
    const inicioXref = salida.length;
    salida += `xref\n0 ${objetos.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objetos.length; id++) salida += `${String(posiciones[id]).padStart(10, "0")} 00000 n \n`;
    salida += `trailer\n<< /Size ${objetos.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;

    const bytes = new Uint8Array(salida.length);
    for (let i = 0; i < salida.length; i++) bytes[i] = salida.charCodeAt(i) & 0xff;
    return bytes;
  }
}
