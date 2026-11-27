// Archivos de prueba para las ventas del POS: arma un .xlsx de verdad (zip
// con deflate, CRC32, [Content_Types], workbook, rels, styles,
// sharedStrings y hojas) sin dependencias. Solo lo usan las pruebas:
// scripts/dev/probar-pos-dominio.mjs y scripts/dev/probar-pos-pantalla.mjs.
// No ejecuta nada al importarse.

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABLA_CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflateRaw(b) {
  const flujo = new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

/** Zip con las partes dadas ({ nombre: texto }). comprimir=false → sin comprimir (método 0). */
export async function crearZip(partes, { comprimir = true } = {}) {
  const enc = new TextEncoder();
  const locales = [];
  const centrales = [];
  let offset = 0;
  for (const [nombre, texto] of Object.entries(partes)) {
    const datos = typeof texto === "string" ? enc.encode(texto) : texto;
    const nom = enc.encode(nombre);
    const comp = comprimir ? await deflateRaw(datos) : datos;
    const crc = crc32(datos);
    const metodo = comprimir ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nom.length, 26);
    locales.push(local, Buffer.from(nom), Buffer.from(comp));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nom.length, 28);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, Buffer.from(nom));
    offset += 30 + nom.length + comp.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(partes).length, 8);
  fin.writeUInt16LE(Object.keys(partes).length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locales, dir, fin]));
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const letra = (i) => {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Serial de Excel (sistema 1900) de «AAAA-MM-DD HH:MM[:SS]». */
export function serialExcel(texto, sistema1904 = false) {
  const [f, h = "00:00:00"] = texto.split(/[ T]/);
  const [a, m, d] = f.split("-").map(Number);
  const [hh, mm, ss = 0] = h.split(":").map(Number);
  const base = sistema1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return (Date.UTC(a, m - 1, d) - base) / 86400000 + (hh * 3600 + mm * 60 + ss) / 86400;
}

/**
 * Libro .xlsx. `filas`: arreglo de filas; cada celda es
 *   - string → texto compartido (o en línea con { enLinea: true });
 *   - number → número;
 *   - { fecha: "AAAA-MM-DD HH:MM" } → serial con formato de fecha y hora;
 *   - { hora: "HH:MM" } → serial con formato de hora;
 *   - { num, estilo: "moneda" } → número con formato de moneda;
 *   - null → vacía (no se escribe).
 * Opciones: hojas extra (nombres), prefijo "x:" en el XML, date1904,
 * filaInicial (para dejar filas vacías arriba), comprimir.
 */
export async function crearXlsx(filas, { enLinea = false, prefijo = "", date1904 = false, hojasExtra = [], filaInicial = 1, comprimir = true, nombreHoja = "Ventas" } = {}) {
  const p = prefijo;
  const compartidos = [];
  const idx = new Map();
  const sst = (t) => {
    if (!idx.has(t)) {
      idx.set(t, compartidos.length);
      compartidos.push(t);
    }
    return idx.get(t);
  };
  const filasXml = filas
    .map((fila, i) => {
      const r = filaInicial + i;
      const celdas = fila
        .map((v, j) => {
          const ref = `${letra(j)}${r}`;
          if (v === null || v === undefined) return "";
          if (typeof v === "number") return `<${p}c r="${ref}"><${p}v>${v}</${p}v></${p}c>`;
          if (typeof v === "string") {
            if (enLinea) return `<${p}c r="${ref}" t="inlineStr"><${p}is><${p}t>${esc(v)}</${p}t></${p}is></${p}c>`;
            return `<${p}c r="${ref}" t="s"><${p}v>${sst(v)}</${p}v></${p}c>`;
          }
          if (v.fecha) return `<${p}c r="${ref}" s="1"><${p}v>${serialExcel(v.fecha, date1904)}</${p}v></${p}c>`;
          if (v.hora) return `<${p}c r="${ref}" s="2"><${p}v>${serialExcel("1899-12-30 " + v.hora) % 1}</${p}v></${p}c>`;
          if (v.num !== undefined) return `<${p}c r="${ref}" s="3"><${p}v>${v.num}</${p}v></${p}c>`;
          return "";
        })
        .join("");
      return `<${p}row r="${r}">${celdas}</${p}row>`;
    })
    .join("");
  const ns = p ? ` xmlns:${p.slice(0, -1)}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` : ` xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;
  const hoja = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}worksheet${ns}><${p}sheetData>${filasXml}</${p}sheetData></${p}worksheet>`;
  const nombres = [nombreHoja, ...hojasExtra];
  const libro = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}workbook${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? `<${p}workbookPr date1904="1"/>` : ""}<${p}sheets>${nombres
    .map((n, i) => `<${p}sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</${p}sheets></${p}workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${nombres
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")}<Relationship Id="rId${nombres.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${nombres.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}styleSheet${ns}><${p}numFmts count="2"><${p}numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/><${p}numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></${p}numFmts><${p}cellXfs count="4"><${p}xf numFmtId="0"/><${p}xf numFmtId="164" applyNumberFormat="1"/><${p}xf numFmtId="20" applyNumberFormat="1"/><${p}xf numFmtId="165" applyNumberFormat="1"/></${p}cellXfs></${p}styleSheet>`;
  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}sst${ns} count="${compartidos.length}" uniqueCount="${compartidos.length}">${compartidos.map((t) => `<${p}si><${p}t xml:space="preserve">${esc(t)}</${p}t></${p}si>`).join("")}</${p}sst>`;
  const tipos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${nombres
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const raizRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const partes = {
    "[Content_Types].xml": tipos,
    "_rels/.rels": raizRels,
    "xl/workbook.xml": libro,
    "xl/_rels/workbook.xml.rels": rels,
    "xl/styles.xml": estilos,
    "xl/sharedStrings.xml": sharedXml,
    "xl/worksheets/sheet1.xml": hoja,
  };
  hojasExtra.forEach((_, i) => {
    partes[`xl/worksheets/sheet${i + 2}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>otra hoja</t></is></c></row></sheetData></worksheet>`;
  });
  return crearZip(partes, { comprimir });
}

/** Texto en Windows-1252 (para probar archivos de Windows con acentos). */
export function aWindows1252(texto) {
  const mapa = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97 };
  const salida = [];
  for (const ch of texto) {
    const cp = ch.codePointAt(0);
    if (mapa[ch] !== undefined) salida.push(mapa[ch]);
    else if (cp < 256) salida.push(cp);
    else salida.push(0x3f);
  }
  return new Uint8Array(salida);
}
