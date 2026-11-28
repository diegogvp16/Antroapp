// Archivos de ejemplo del importador de ventas del POS (fixtures/pos/):
// cada uno pasa por el camino real de la pantalla
// (components/pos/importar-ventas.tsx): leerArchivoPos → sugerirMapeo +
// sugerirFormatoFecha (con las mismas 50 muestras) → faltantesMapeo →
// normalizarVentas → lineasParaBase. Revisa que lo lea bien (montos al
// centavo, fechas, horas y textos con acentos) o que lo rechace con un
// mensaje claro en español.
//
// Con la base (por omisión), las ventas que la pantalla mandaría pasan
// además por la base de antroapp-dev, en UNA transacción que se deshace
// al final (no queda nada escrito):
//   - pos_leer_lineas (la validación y normalización de la base): mismos
//     montos, cantidades, fecha y hora, mesa y producto;
//   - pos_preparar (la vista previa de la pantalla) como dev_admin, con la
//     bandera pos_ventas de Club Demo Dev encendida solo dentro de la
//     transacción: responde sin error y con la noche esperada por línea.
//
//   node scripts/dev/probar-pos-fixtures.mjs            (con la base de dev)
//   node scripts/dev/probar-pos-fixtures.mjs --sin-base (solo el navegador)
//
// Los archivos se regeneran con scripts/dev/generar-pos-fixtures.mjs.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importarTs } from "./cargar-ts.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(RAIZ, "fixtures/pos");
const SIN_BASE = process.argv.includes("--sin-base");

const ad = await importarTs("../../lib/pos/adaptadores.ts", import.meta.url);
const mp = await importarTs("../../lib/pos/mapeo.ts", import.meta.url);
const fh = await importarTs("../../lib/pos/fecha-hora.ts", import.meta.url);

let pasan = 0, fallan = 0;
function ok(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK   " : "FALLA"}  ${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}
const json = (x) => JSON.stringify(x);

// ------------------------------------------------------------------ casos --
// lectura: el error de leerArchivoPos (rechazo del archivo entero).
// mapeo: columnas que debe proponer (subconjunto). faltan: lo que falta.
// ventas/total/noches/conError/ignoradas: el resultado de normalizarVentas.
// lineas: campos esperados por número de línea. errores: regex por línea.
// variantes: el mismo archivo con un cambio de mapeo que haría la persona.
const CASOS = [
  {
    archivo: "01-utf8-bom-titulos-totales.csv",
    bytes: (b) => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf && b.includes(0x0d),
    avisos: [/Leído como UTF-8, separado por coma/, /encabezados están en la fila 5/],
    mapeo: { ticket: "Folio", fecha: "Fecha", hora: "Hora", mesa: "Mesa", producto: "Producto", cantidad: "Cant.",
      precio_unitario: "Precio Unitario", total: "Importe", metodo_pago: "Forma de Pago", mesero: "Mesero" },
    ventas: 6, total: 396950, noches: ["2026-11-20"], conError: 0, ignoradas: 1,
    lineas: {
      6: { ticket: "A-1001", fechaHora: "2026-11-20T22:45:00", mesa: "Mesa 5", producto: "Piña colada", cantidad: 2,
        precioUnitarioCentavos: 14500, totalCentavos: 29000, metodoPago: "Efectivo", mesero: "Begoña" },
      7: { producto: "Jalapeño poppers", totalCentavos: 18550 },
      8: { producto: "Botella tequila añejo 750 ml", precioUnitarioCentavos: 285000, totalCentavos: 285000, mesero: "Andrés" },
      11: { fechaHora: "2026-11-21T00:35:00", mesa: "12", producto: "Café americano", cantidad: 3, totalCentavos: 11400, mesero: "Sofía" },
      12: { fechaHora: "2026-11-21T01:20:00", mesa: "Barra", mesero: "Íñigo", totalCentavos: 26000 },
    },
  },
  {
    archivo: "02-punto-y-coma-coma-decimal.csv",
    avisos: [/separado por punto y coma/],
    mapeo: { ticket: "FOLIO", fecha: "FECHA Y HORA", mesa: "MESA", producto: "DESCRIPCIÓN", cantidad: "CANTIDAD",
      precio_unitario: "PRECIO", total: "TOTAL", mesero: "MESERO" },
    formatoMontos: "coma",
    ventas: 5, total: 257070, noches: ["2026-11-20"], conError: 0, ignoradas: 0,
    lineas: {
      2: { ticket: "5501", fechaHora: "2026-11-20T22:05:00", producto: "Mojito de maracuyá", cantidad: 2, precioUnitarioCentavos: 9550, totalCentavos: 19100, mesero: "Raúl" },
      4: { fechaHora: "2026-11-20T23:40:15", producto: "Botella ron añejo", precioUnitarioCentavos: 185000, totalCentavos: 185000, mesero: "Begoña" },
      6: { fechaHora: "2026-11-21T02:30:00", producto: "Shot mezcal espadín", cantidad: 3, precioUnitarioCentavos: 8990, totalCentavos: 26970 },
    },
  },
  {
    archivo: "03-windows-1252.csv",
    bytes: (b) => !utf8Valido(b) && b.includes(0xf1) /* ñ en 1252 */,
    avisos: [/Leído como Windows-1252, separado por coma/],
    mapeo: { ticket: "Núm. Ticket", mesa: "No. Mesa", producto: "Descripción", total: "Total", precio_unitario: "Precio", mesero: "Mesero" },
    ventas: 4, total: 359400, noches: ["2026-11-21"], conError: 0, ignoradas: 0,
    lineas: {
      2: { ticket: "00871", mesa: "04", producto: "Café de olla", mesero: "Ángeles", totalCentavos: 8400 },
      3: { producto: "Limonada con chía", totalCentavos: 11000 },
      4: { producto: "Botella whisky 12 años", totalCentavos: 320000, mesero: "Martín" },
      5: { fechaHora: "2026-11-22T03:15:00", producto: "Agua de piña", cantidad: 5, totalCentavos: 20000 },
    },
  },
  {
    archivo: "04-utf16-tabuladores.txt",
    bytes: (b) => b[0] === 0xff && b[1] === 0xfe,
    avisos: [/Leído como UTF-16, separado por tabulador/],
    mapeo: { ticket: "Orden", producto: "Artículo", cantidad: "Cant", total: "Importe", mesero: "Mesera" },
    ventas: 3, total: 208000, noches: ["2026-11-20"], conError: 0, ignoradas: 0,
    lineas: {
      2: { ticket: "9001", producto: "Cubeta de cervezas (10)", totalCentavos: 65000, mesero: "Begoña" },
      4: { ticket: "9002", fechaHora: "2026-11-20T23:59:59", producto: "Champaña brut", totalCentavos: 125000, mesero: "Sofía" },
    },
  },
  {
    archivo: "05-encabezados-raros-12h.csv",
    mapeo: { ticket: "No. de Orden", fecha: "FECHA", hora: "Hora de Apertura", mesa: "Núm. de Mesa", producto: "Artículo / Descripción",
      cantidad: "Cant.", total: "Importe Total ($)", metodo_pago: "Método de Pago", mesero: "Atendió" },
    sinMapear: ["Hora de Cierre", "Descuento", "IVA", "Propina", "Estatus", "Área"],
    ventas: 3, total: 162000, noches: ["2026-11-20"], conError: 0, ignoradas: 0,
    lineas: {
      2: { ticket: "C-77", fechaHora: "2026-11-20T22:45:00", mesa: "T-3", producto: "Margarita de tamarindo", cantidad: 2,
        totalCentavos: 19000, metodoPago: "Efectivo", mesero: "Iñaki", precioUnitarioCentavos: null },
      3: { fechaHora: "2026-11-20T23:20:00", totalCentavos: 118000, metodoPago: "Tarjeta de crédito", mesero: "Ximena" },
      4: { fechaHora: "2026-11-21T00:15:00", producto: "Alitas búfalo", totalCentavos: 25000, metodoPago: "Tarjeta de débito" },
    },
  },
  {
    archivo: "06-por-ticket-devoluciones.csv",
    mapeo: { ticket: "Cheque", fecha: "Fecha Apertura", hora: "Hora Apertura", mesa: "Mesa", total: "Total", metodo_pago: "Tipo de Pago" },
    ventas: 5, total: 183050, noches: ["2026-11-21"], conError: 0, ignoradas: 1,
    lineas: {
      2: { ticket: "3301", fechaHora: "2026-11-21T22:10:00", producto: "(sin detalle)", cantidad: 1, totalCentavos: 154000 },
      3: { totalCentavos: 86050 },
      4: { fechaHora: "2026-11-22T01:30:00", totalCentavos: -25000, metodoPago: "Devolución" },
      5: { totalCentavos: 0 },
      6: { fechaHora: "2026-11-22T03:10:00", mesa: null, totalCentavos: -32000 },
    },
    avisosLinea: { 4: /devolución o cancelación/, 5: /cortesía/, 6: /Sin mesa/, 7: /Fila de totales/ },
  },
  {
    archivo: "07-sep-comillas-saltos.csv",
    avisos: [/separado por punto y coma/],
    mapeo: { ticket: "Ticket", cuenta: "Comensal", cantidad: "Cantidad", total: "Total" },
    ventas: 3, total: 86250, noches: ["2026-11-21"], conError: 0, ignoradas: 0,
    lineas: {
      3: { ticket: "T-10", producto: "Tabla de quesos; carnes frías", cuenta: "Mariana", totalCentavos: 34500 },
      4: { fechaHora: "2026-11-21T22:31:00", producto: 'Coctel "de la casa" (edición otoño)', cantidad: 2, totalCentavos: 30000 },
      6: { mesa: "VIP 2", producto: "Vino tinto copa", cantidad: 1.5, cuenta: null, totalCentavos: 21750 },
    },
  },
  {
    archivo: "08-montos-ambiguos.csv",
    ventas: 1, total: 35000, conError: 2, ignoradas: 0, noches: ["2026-11-20"],
    errores: { 2: /total: «1\.500» es ambiguo: elige en el mapeo si los montos usan punto decimal/, 3: /«2\.300» es ambiguo/ },
    variantes: [
      { nombre: "eligiendo «coma decimal» en el mapeo", mapeo: { formato_montos: "coma" }, ventas: 3, total: 415000, conError: 0,
        lineas: { 2: { totalCentavos: 150000 }, 3: { totalCentavos: 230000 }, 4: { totalCentavos: 35000 } } },
      { nombre: "eligiendo «punto decimal» en el mapeo", mapeo: { formato_montos: "punto" }, ventas: 3, total: 35380, conError: 0,
        lineas: { 2: { totalCentavos: 150 }, 3: { totalCentavos: 230 } } },
    ],
  },
  {
    archivo: "09-ingles-mes-dia.csv",
    formatoFecha: "mdy",
    mapeo: { ticket: "Ticket #", fecha: "Date", hora: "Time", mesa: "Table", producto: "Item", cantidad: "Qty", total: "Amount" },
    ventas: 3, total: 49250, noches: ["2026-11-20"], conError: 0, ignoradas: 0,
    lineas: {
      2: { fechaHora: "2026-11-20T22:15:00", producto: "Margarita", totalCentavos: 19000 },
      3: { fechaHora: "2026-11-20T22:16:00", totalCentavos: 12250 },
      4: { fechaHora: "2026-11-21T00:40:00", producto: "Beer", cantidad: 3, totalCentavos: 18000 },
    },
  },
  {
    archivo: "10-sin-total-con-precio.csv",
    mapeo: { precio_unitario: "Precio unitario", cantidad: "Cantidad" },
    sinMapear: ["total"],
    ventas: 3, total: 29999, noches: ["2026-11-22"], conError: 0, ignoradas: 0,
    lineas: {
      2: { cantidad: 3, precioUnitarioCentavos: 3333, totalCentavos: 9999 },
      3: { cantidad: 2.5, precioUnitarioCentavos: 4000, totalCentavos: 10000, producto: "Cerveza de barril (litro)" },
      4: { cantidad: 1, precioUnitarioCentavos: 10000, totalCentavos: 10000 },
    },
  },
  {
    archivo: "11-windows-1252-punto-y-coma.csv",
    bytes: (b) => !utf8Valido(b),
    avisos: [/Leído como Windows-1252, separado por punto y coma/],
    ventas: 3, total: 148250, noches: ["2026-11-22"], conError: 0, ignoradas: 0,
    lineas: {
      2: { producto: "Jarra de sangría", totalCentavos: 123450 },
      3: { producto: "Champiñones al ajillo", cantidad: 2, totalCentavos: 19000 },
      4: { producto: "Té chai", mesero: "Ñeco", totalCentavos: 5800, fechaHora: "2026-11-22T23:59:00" },
    },
  },
  {
    archivo: "12-titulo-largo-arriba.csv",
    avisos: [/encabezados están en la fila 3/],
    mapeo: { ticket: "Folio", fecha: "Fecha", hora: "Hora", total: "Importe" },
    ventas: 2, total: 155000, noches: ["2026-11-21"], conError: 0, ignoradas: 0,
    lineas: { 4: { ticket: "6001", totalCentavos: 35000 }, 5: { fechaHora: "2026-11-21T23:45:00", totalCentavos: 120000 } },
  },
  {
    archivo: "13-total-en-columna-folio.csv",
    ventas: 2, total: 16000, noches: ["2026-11-22"], conError: 1, ignoradas: 0,
    errores: { 4: /^falta la fecha$/ },
  },
  // ---------------------------------------------- rechazos del archivo --
  { archivo: "r01-vacio.csv", lectura: /^El archivo está vacío\.$/ },
  { archivo: "r02-solo-bom-y-renglones-vacios.csv", lectura: /^El archivo no trae filas\.$/ },
  { archivo: "r03-solo-encabezados.csv", lectura: /^El archivo solo trae encabezados, sin ventas\.$/ },
  { archivo: "r11-excel-viejo.xls", lectura: /no se puede leer: usa CSV o Excel \.xlsx \(un \.xls viejo: ábrelo y guárdalo como \.xlsx\)/ },
  { archivo: "r12-csv-renombrado.xlsx", lectura: /no se puede leer: usa CSV o Excel \.xlsx/ },
  { archivo: "r13-xlsx-danado.xlsx", lectura: /^El archivo de Excel está dañado/ },
  { archivo: "r14-xlsx-truncado.xlsx", lectura: /no es un Excel válido \(no se encontró el índice del zip\)/ },
  { archivo: "r15-zip-no-excel.xlsx", lectura: /no es un libro de Excel \(falta xl\/workbook\.xml\)/ },
  { archivo: "r16-xlsx-solo-encabezados.xlsx", lectura: /^El archivo solo trae encabezados, sin ventas\.$/ },
  // ---------------------------------------------- rechazos del mapeo ----
  { archivo: "r04-sin-columna-total.csv", faltan: ["Total (o precio unitario)"], erroresTodas: /^falta el total$/ },
  { archivo: "r05-encabezados-desconocidos.csv", faltan: ["Ticket o folio", "Fecha", "Total (o precio unitario)"] },
  // ---------------------------------------------- rechazos por línea ----
  {
    archivo: "r06-fechas-imposibles.csv",
    ventas: 1, total: 10000, conError: 9, ignoradas: 0, noches: ["2026-11-20"],
    errores: {
      2: /^la fecha «31\/11\/2026» no existe$/, 3: /^la fecha «29\/02\/2026» no existe$/, 4: /^la fecha «15\/13\/2026» no existe$/,
      5: /^la fecha «00\/11\/2026» no existe$/, 6: /^«25:10» no es una hora$/, 7: /^«23:61» no es una hora$/,
      8: /^la fecha es anterior a 2020$/, 9: /^la fecha es futura$/, 10: /^«ayer» no es una fecha$/,
    },
  },
  { archivo: "r07-sin-hora.csv", ventas: 0, conError: 2, erroresTodas: /^falta la hora \(sin hora no se sabe de qué noche ni de qué mesa es\)$/ },
  { archivo: "r08-zona-horaria.csv", ventas: 0, conError: 2, erroresTodas: /trae zona horaria: exporta la hora local del antro$/ },
  {
    archivo: "r09-montos-invalidos.csv",
    ventas: 1, total: 10000, conError: 7, ignoradas: 0, noches: ["2026-11-20"],
    errores: {
      2: /^total: «N\/A» no es un monto$/, 3: /^total: «12\.34\.5» no es un monto$/, 4: /^total: «\$» no es un monto$/,
      5: /^total: «\$2,000,000\.00» es demasiado grande$/, 6: /^la cantidad es 0$/, 7: /^cantidad: «dos» no es una cantidad$/,
      8: /^falta el total$/,
    },
  },
  { archivo: "r10-sin-folio.csv", ventas: 0, conError: 2, erroresTodas: /^falta el ticket o folio$/ },
  // ---------------------------------------------- Excel -----------------
  {
    archivo: "x01-excel-normal.xlsx",
    formato: "xlsx",
    avisos: [/El libro tiene 2 hojas: se lee solo la primera \(«Ventas»\)/, /encabezados están en la fila 3/],
    mapeo: { ticket: "Folio", fecha: "Fecha y hora", mesa: "Mesa", producto: "Producto", cantidad: "Cantidad", precio_unitario: "Precio", total: "Importe", mesero: "Mesero" },
    sinMapear: ["Propina", "hora"],
    ventas: 4, total: 344040, noches: ["2026-11-21"], conError: 0, ignoradas: 1,
    lineas: {
      4: { ticket: "B-200", fechaHora: "2026-11-21T22:15:00", mesa: "Mesa 3", producto: "Piña colada", cantidad: 2, precioUnitarioCentavos: 14500, totalCentavos: 29000, mesero: "Begoña" },
      5: { producto: "Jalapeños rellenos", totalCentavos: 18550 },
      6: { fechaHora: "2026-11-22T00:00:00", producto: "Botella tequila añejo", totalCentavos: 285000, mesero: "Iñaki" },
      7: { mesa: "5", cantidad: 3, precioUnitarioCentavos: 3830, totalCentavos: 11490 },
    },
  },
  {
    archivo: "x02-fecha-hora-separadas-1904.xlsx",
    formato: "xlsx",
    mapeo: { ticket: "No. Ticket", fecha: "Fecha", hora: "Hora", mesa: "Mesa", producto: "Descripción", cantidad: "Cant", total: "Total" },
    ventas: 2, total: 22350, noches: ["2026-11-20"], conError: 0, ignoradas: 0,
    lineas: {
      2: { ticket: "7001", fechaHora: "2026-11-20T23:40:00", producto: "Mezcal joven", cantidad: 2, totalCentavos: 17800 },
      3: { fechaHora: "2026-11-21T01:15:00", totalCentavos: 4550 },
    },
  },
  {
    archivo: "x03-celdas-de-texto.xlsx",
    formato: "xlsx",
    mapeo: { ticket: "NÚMERO DE CUENTA", fecha: "FECHA", hora: "HORA", total: "IMPORTE" },
    formatoMontos: "coma",
    ventas: 2, total: 125950, noches: ["2026-11-21"], conError: 0, ignoradas: 0,
    lineas: {
      2: { ticket: "C-1", fechaHora: "2026-11-21T23:15:00", producto: "Cubeta 6 cervezas", totalCentavos: 123450 },
      3: { fechaHora: "2026-11-21T23:50:00", totalCentavos: 2500 },
    },
  },
];

function utf8Valido(b) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

// Todos los archivos de la carpeta tienen caso (y al revés).
{
  const enDisco = readdirSync(DIR).filter((n) => n !== "LEEME.md").sort();
  const conCaso = CASOS.map((c) => c.archivo).sort();
  ok(json(enDisco) === json(conCaso), `cada archivo de fixtures/pos/ tiene su caso (${enDisco.length})`,
    `sin caso: ${enDisco.filter((n) => !conCaso.includes(n))}; sin archivo: ${conCaso.filter((n) => !enDisco.includes(n))}`);
  const leeme = readFileSync(path.join(DIR, "LEEME.md"), "utf8");
  const faltan = conCaso.filter((n) => !leeme.includes(`\`${n}\``));
  ok(!faltan.length, "LEEME.md describe cada archivo", faltan.join(", "));
}

/** El mismo mapeo que propone la pantalla al subir el archivo (sin mapeo guardado). */
function mapeoDePantalla(tabla) {
  const columnas = mp.sugerirMapeo(tabla.encabezados);
  const fechas = columnas.fecha ? mp.muestras(tabla, columnas.fecha, 50) : [];
  return { columnas, formato_fecha: fh.sugerirFormatoFecha(fechas) };
}

function revisarResultado(c, r, etiqueta) {
  if (c.ventas !== undefined) ok(r.ventas.length === c.ventas, `${etiqueta}: ${c.ventas} ventas`, String(r.ventas.length));
  if (c.total !== undefined) ok(r.totalCentavos === c.total, `${etiqueta}: total ${c.total} centavos`, String(r.totalCentavos));
  if (c.noches) ok(json(r.noches) === json(c.noches), `${etiqueta}: noches ${c.noches.join(", ")}`, json(r.noches));
  if (c.conError !== undefined) ok(r.conError === c.conError, `${etiqueta}: ${c.conError} líneas con error`, `${r.conError}: ${json(r.filas.filter((f) => f.errores.length).map((f) => [f.linea, f.errores]))}`);
  if (c.ignoradas !== undefined) ok(r.ignoradas === c.ignoradas, `${etiqueta}: ${c.ignoradas} filas ignoradas`, String(r.ignoradas));
  ok(r.errorGeneral === null, `${etiqueta}: sin error general`, String(r.errorGeneral));
  for (const [n, esperado] of Object.entries(c.lineas ?? {})) {
    const v = r.ventas.find((x) => x.linea === Number(n));
    if (!v) {
      ok(false, `${etiqueta}: línea ${n} entra`, "no está entre las ventas");
      continue;
    }
    const distintos = Object.entries(esperado).filter(([k, val]) => v[k] !== val);
    ok(!distintos.length, `${etiqueta}: línea ${n} ${json(esperado)}`, distintos.map(([k]) => `${k}=${json(v[k])}`).join("; "));
  }
  for (const [n, re] of Object.entries(c.errores ?? {})) {
    const f = r.filas.find((x) => x.linea === Number(n));
    ok(f && !f.venta && f.errores.length === 1 && re.test(f.errores[0]), `${etiqueta}: línea ${n} se rechaza con «${re.source.replace(/\\/g, "")}»`, json(f?.errores));
  }
  if (c.erroresTodas) {
    const malas = r.filas.filter((f) => !f.ignorada && !(f.errores.length === 1 && c.erroresTodas.test(f.errores[0])));
    ok(r.filas.length > 0 && !malas.length, `${etiqueta}: todas las líneas se rechazan con «${c.erroresTodas.source.replace(/\\/g, "")}»`, json(malas.map((f) => [f.linea, f.errores])));
  }
  for (const [n, re] of Object.entries(c.avisosLinea ?? {})) {
    const f = r.filas.find((x) => x.linea === Number(n));
    ok(f && f.avisos.some((a) => re.test(a)), `${etiqueta}: línea ${n} con aviso ${re}`, json(f?.avisos));
  }
}

// --------------------------------------------------------------- recorrido --
const paraBase = []; // { etiqueta, lineas (como las manda la pantalla), ventas, hash }

for (const c of CASOS) {
  const bytes = new Uint8Array(readFileSync(path.join(DIR, c.archivo)));
  const et = c.archivo;
  if (c.bytes) ok(c.bytes(bytes), `${et}: los bytes son los del exporte (codificación, BOM, finales de línea)`);
  const leido = await ad.leerArchivoPos(bytes, c.archivo);
  if (c.lectura) {
    ok(!leido.ok && c.lectura.test(leido.error), `${et}: se rechaza con «${leido.error ?? ""}»`, leido.ok ? "se leyó" : json(leido.error));
    continue;
  }
  if (!leido.ok) {
    ok(false, `${et}: se lee`, leido.error);
    continue;
  }
  ok(leido.formato === (c.formato ?? "csv"), `${et}: leído como ${c.formato ?? "csv"}`, leido.formato);
  for (const re of c.avisos ?? []) ok(leido.tabla.avisos.some((a) => re.test(a)), `${et}: aviso ${re}`, json(leido.tabla.avisos));

  const mapeo = mapeoDePantalla(leido.tabla);
  if (c.mapeo) {
    const distintos = Object.entries(c.mapeo).filter(([k, v]) => mapeo.columnas[k] !== v);
    ok(!distintos.length, `${et}: propone el mapeo correcto (${Object.keys(c.mapeo).length} datos)`, distintos.map(([k]) => `${k}→${json(mapeo.columnas[k])}`).join("; "));
  }
  for (const s of c.sinMapear ?? []) {
    const usado = Object.entries(mapeo.columnas).find(([k, v]) => v === s || k === s);
    ok(!usado, `${et}: «${s}» no se mapea`, json(usado));
  }
  ok(mapeo.formato_fecha === (c.formatoFecha ?? "dmy"), `${et}: fechas como ${c.formatoFecha ?? "dmy"}`, mapeo.formato_fecha);
  if (c.formatoMontos) {
    const f = mp.formatosNumeros(leido.tabla, mapeo);
    ok(f.detectado === c.formatoMontos, `${et}: montos detectados con ${c.formatoMontos} decimal`, String(f.detectado));
  }
  const faltan = mp.faltantesMapeo(mapeo, leido.tabla.encabezados);
  if (c.faltan) {
    ok(json(faltan) === json(c.faltan), `${et}: el mapeo pide «${c.faltan.join("», «")}»`, json(faltan));
  } else ok(!faltan.length, `${et}: el mapeo alcanza para importar`, json(faltan));

  const r = mp.normalizarVentas(leido.tabla, mapeo);
  revisarResultado(c, r, et);
  if (r.ventas.length) paraBase.push({ etiqueta: et, ventas: r.ventas, hash: await ad.huellaArchivo(bytes) });

  for (const v of c.variantes ?? []) {
    const m2 = { ...mapeo, ...v.mapeo };
    const r2 = mp.normalizarVentas(leido.tabla, m2);
    revisarResultado(v, r2, `${et} (${v.nombre})`);
    if (r2.ventas.length) paraBase.push({ etiqueta: `${et} (${v.nombre})`, ventas: r2.ventas, hash: null });
  }
}

// ---------------------------------------------------------------- la base --
if (SIN_BASE) {
  console.log("\n(sin base: --sin-base)");
} else {
  const { conectarDevEscritura } = await import("../db/conexion.mjs");
  const CLUB = "0de70000-0000-4000-8000-000000000001"; // Club Demo Dev (scripts/dev/sembrar-dev.mjs)
  const db = await conectarDevEscritura();
  const banderaAntes = json(await db.q("select activa from public.club_funciones where club_id = $1 and funcion = 'pos_ventas'", [CLUB]));
  try {
    await db.q("begin");
    const [admin] = await db.q(
      `select p.id from auth.users u join public.profiles p on p.id = u.id
        where u.email = 'dev_admin@example.com' and p.role = 'admin' and p.activo is not false`,
    );
    const [club] = await db.q("select id from public.clubs where id = $1", [CLUB]);
    ok(Boolean(admin && club), "dev: existen dev_admin y Club Demo Dev");
    if (admin && club) {
      // Bandera encendida SOLO dentro de esta transacción (se deshace al final).
      await db.q(
        `insert into public.club_funciones (club_id, funcion, activa) values ($1, 'pos_ventas', true)
         on conflict (club_id, funcion) do update set activa = true`,
        [CLUB],
      );
      await db.q("select set_config('request.jwt.claims', $1, true)", [json({ sub: admin.id, role: "authenticated" })]);
      for (const { etiqueta, ventas, hash } of paraBase) {
        const lineas = mp.lineasParaBase(ventas);
        await db.q("savepoint caso");
        try {
          // 1. La validación y normalización de la base (como la usan pos_preparar y pos_importar).
          const filas = await db.q(
            `select o_linea, o_ticket, to_char(o_local, 'YYYY-MM-DD"T"HH24:MI:SS') as local, o_fecha::text as noche,
                    o_mesa, o_producto, o_cantidad::text as cantidad, o_precio::text as precio, o_total::text as total
               from public.pos_leer_lineas($1, $2::jsonb)`,
            [CLUB, json(lineas)],
          );
          const distintas = ventas.filter((v) => {
            const f = filas.find((x) => x.o_linea === v.linea);
            return !f || f.o_ticket !== v.ticket || f.local !== v.fechaHora || f.noche !== fh.nocheDe(v.fechaHora)
              || f.o_mesa !== v.mesa || f.o_producto !== v.producto || Number(f.cantidad) !== v.cantidad
              || Number(f.total) !== v.totalCentavos || (f.precio === null ? null : Number(f.precio)) !== v.precioUnitarioCentavos;
          });
          ok(filas.length === ventas.length && !distintas.length, `base: pos_leer_lineas lee igual ${etiqueta} (${ventas.length} líneas, al centavo)`,
            json(distintas.map((v) => [v.linea, filas.find((x) => x.o_linea === v.linea)])));
          // 2. La vista previa de la pantalla, con la sesión de dev_admin.
          await db.q("set local role authenticated");
          const [{ r }] = await db.q("select public.pos_preparar($1, $2::jsonb, $3) as r", [CLUB, json(lineas), hash]);
          const malas = ventas.filter((v) => r.lineas.find((l) => l.linea === v.linea)?.fecha_operacion !== fh.nocheDe(v.fechaHora));
          ok(r.lineas.length === ventas.length && !malas.length, `base: pos_preparar responde ${etiqueta} con la noche de cada línea`,
            json(malas.map((v) => v.linea)));
        } catch (e) {
          ok(false, `base: ${etiqueta}`, e.message);
        } finally {
          await db.q("rollback to savepoint caso");
        }
      }
    }
  } finally {
    await db.q("rollback").catch(() => {});
    const banderaDespues = json(await db.q("select activa from public.club_funciones where club_id = $1 and funcion = 'pos_ventas'", [CLUB]));
    ok(banderaAntes === banderaDespues, "dev: todo se deshizo (la bandera pos_ventas de Club Demo Dev quedó como estaba)", `${banderaAntes} → ${banderaDespues}`);
    await db.fin();
  }
}

console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exit(fallan ? 1 : 0);
