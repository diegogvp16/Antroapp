// Pruebas puras (sin base) de lib/pos: CSV, Excel, montos, fechas, mapeo,
// normalización y conciliación.
//
//   node scripts/dev/probar-pos-dominio.mjs
import { importarTs } from "./cargar-ts.mjs";
import { crearXlsx, crearZip, aWindows1252, serialExcel } from "./pos-archivos-prueba.mjs";

const csv = await importarTs("../../lib/pos/csv.ts", import.meta.url);
const xlsx = await importarTs("../../lib/pos/xlsx.ts", import.meta.url);
const num = await importarTs("../../lib/pos/numeros.ts", import.meta.url);
const fh = await importarTs("../../lib/pos/fecha-hora.ts", import.meta.url);
const mapeo = await importarTs("../../lib/pos/mapeo.ts", import.meta.url);
const ad = await importarTs("../../lib/pos/adaptadores.ts", import.meta.url);
const conc = await importarTs("../../lib/pos/conciliacion.ts", import.meta.url);

let pasan = 0, fallan = 0;
function ok(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK   " : "FALLA"}  ${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = (t) => new TextEncoder().encode(t);
const monto = (t) => { const r = num.leerMonto(t); return r.ok ? r.valor : "ERR"; };
const cant = (t) => { const r = num.leerCantidad(t); return r.ok ? r.valor : "ERR"; };

// ============================== Montos ==============================
{
  const casos = [
    ["1,234.50", 123450], ["$1,234.50", 123450], ["$ 1,234.50", 123450], ["1234.5", 123450], ["1234", 123400],
    ["MXN 99.90", 9990], ["99.90 MXN", 9990], ["$99.90 M.N.", 9990], ["-120.00", -12000], ["(120.00)", -12000],
    ["120.00-", -12000], ["-$1,000.00", -100000], ["$-1,000.00", -100000], ["1.234,50", 123450], ["12,5", 1250],
    ["12,50", 1250], ["123,456.78", 12345678], ["999,999.99", 99999999], ["1,234,567", "ERR"],
    ["1.2345", 123], ["1,2345", 123], ["0", 0], ["  45  ", 4500], ["1 234.00", 123400],
    [".50", 50], ["+15", 1500], ["1000000", 100000000],
  ];
  for (const [t, esperado] of casos) ok(monto(t) === esperado, `monto «${t}» = ${esperado}`, String(monto(t)));
  for (const malo of ["", "abc", "1,23,4", "12.34.5", "$", "1.234,5,6", "--5", "10000000.01", "1e5", "12 34x"]) {
    ok(monto(malo) === "ERR", `monto «${malo}» se rechaza`, String(monto(malo)));
  }
  // Un solo separador con exactamente 3 dígitos: ambiguo sin formato.
  for (const amb of ["1.500", "1,234", "1.234", "2.675", "0.005", "-1.500", "$1,500"]) {
    const r = num.leerMonto(amb);
    ok(!r.ok && /ambiguo/.test(r.error), `«${amb}» sin formato conocido: ambiguo (no se adivina)`, JSON.stringify(r));
  }
  const conFormato = (t, f) => { const r = num.leerMonto(t, 100_000_000, f); return r.ok ? r.valor : "ERR"; };
  ok(conFormato("1.500", "coma") === 150000 && conFormato("1.500", "punto") === 150 && conFormato("1,500", "punto") === 150000 && conFormato("1,5", "coma") === 150,
    "con el formato de la columna: «1.500» = $1,500 (coma) o $1.50 (punto)");
  ok(conFormato("2.675", "punto") === 268 && conFormato("0.005", "punto") === 1 && conFormato("-0.005", "punto") === -1 && conFormato("0.004", "punto") === 0, "punto decimal con 3 decimales: redondea a centavos");
  ok(conFormato("1.234,50", "punto") === "ERR" && conFormato("1,234.50", "coma") === "ERR" && conFormato("12,34,5", "punto") === "ERR", "valor que no cuadra con el formato de su columna: error");
  ok(conFormato("1234", "coma") === 123400 && conFormato("1.234.567,89", "coma") === "ERR", "coma: entero solo, y tope");
  ok(num.clasificarNumero("1,234.50") === "punto" && num.clasificarNumero("1.234,50") === "coma" && num.clasificarNumero("12,5") === "coma" && num.clasificarNumero("12.5") === "punto"
    && num.clasificarNumero("1.500") === "ambiguo" && num.clasificarNumero("1,500") === "ambiguo" && num.clasificarNumero("1234") === null && num.clasificarNumero("1,234,567") === "punto" && num.clasificarNumero("1.234.567") === "coma",
    "clasificar un valor: punto, coma, ambiguo o nada");
  ok(num.detectarFormatoNumeros(["$1,500.00", "1,234", "300"]) === "punto" && num.detectarFormatoNumeros(["1.234,50", "1.500"]) === "coma"
    && num.detectarFormatoNumeros(["1.500", "2.000"]) === null && num.detectarFormatoNumeros(["1,5", "2.5"]) === "mixto", "formato de una columna por todos sus valores");
  ok(num.leerMonto("1.234.567,89", 1e12).ok && num.leerMonto("1.234.567,89", 1e12).valor === 123456789 && num.leerMonto("1.234.567", 1e12).valor === 123456700, "punto de miles (con tope mayor)");
  ok(monto("1,234,567.89") === "ERR", "más de $1,000,000: rechazado");
  ok(num.leerMonto("12.345", 1e8, "punto").ok && num.leerMonto("12.345", 1e8, "punto").redondeado, "monto con 3 decimales (punto conocido): avisa que se redondeó");
  ok(!num.leerMonto("12.30").redondeado, "monto «12.30» no se redondea");
  ok(cant("1") === 1 && cant("2.5") === 2.5 && cant("0.3333") === 0.333 && cant("-1") === -1 && cant("1,5") === 1.5, "cantidades: entero, decimal, 3 decimales, negativa, coma decimal");
  ok(cant("10001") === "ERR" && cant("x") === "ERR", "cantidad de más o no numérica: rechazada");
  ok(num.multiplicarCentavos(3, 4550) === 13650 && num.multiplicarCentavos(0.333, 1000) === 333 && num.multiplicarCentavos(-2, 999) === -1998 && num.multiplicarCentavos(1.5, 333) === 500,
    "cantidad × precio redondeado a centavos");
}

// ============================== Fechas ==============================
{
  const f = (t, h = null, formato = "dmy") => { const r = fh.leerFechaHora(t, h, formato); return r.ok ? r.valor : "ERR:" + r.error; };
  ok(f("25/11/2026 23:15") === "2026-11-25T23:15:00", "dd/mm/aaaa HH:MM", f("25/11/2026 23:15"));
  ok(f("2026-11-25 23:15:30") === "2026-11-25T23:15:30", "aaaa-mm-dd HH:MM:SS");
  ok(f("2026-11-25T01:05") === "2026-11-25T01:05:00", "ISO con T");
  ok(f("2026-11-25T01:05:00.000") === "2026-11-25T01:05:00", "ISO con milisegundos");
  ok(f("25-11-26 9:05") === "2026-11-25T09:05:00", "dd-mm-aa con hora de un dígito");
  ok(f("25.11.2026 23:15") === "2026-11-25T23:15:00", "dd.mm.aaaa");
  ok(f("2026/11/25 23:15") === "2026-11-25T23:15:00", "aaaa/mm/dd");
  ok(f("25/11/2026 11:15 p. m.") === "2026-11-25T23:15:00", "hora con «p. m.»");
  ok(f("25/11/2026 12:30 a. m.") === "2026-11-25T00:30:00", "12:30 a. m. = 00:30");
  ok(f("25/11/2026 12:30 PM") === "2026-11-25T12:30:00", "12:30 PM = 12:30");
  ok(f("25-nov-2026 23:15") === "2026-11-25T23:15:00", "mes abreviado «nov»");
  ok(f("25 de noviembre de 2026", "23:15") === "2026-11-25T23:15:00", "«25 de noviembre de 2026» + hora aparte");
  ok(f("3 dic 2026 01:00") === "2026-12-03T01:00:00", "«3 dic 2026»");
  ok(f("25/11/2026", "23:15") === "2026-11-25T23:15:00", "fecha y hora en columnas distintas");
  ok(f("25/11/2026 20:00", "23:15") === "2026-11-25T23:15:00", "la columna de hora manda sobre la hora de la fecha");
  ok(f("2026-11-25", "1899-12-30 23:15:00") === "2026-11-25T23:15:00", "hora de Excel con fecha 1899");
  ok(f("11/25/2026 23:15", null, "mdy") === "2026-11-25T23:15:00", "mm/dd/aaaa con formato mdy");
  ok(f("05/11/2026 23:15", null, "mdy") === "2026-05-11T23:15:00", "05/11 con mdy = 11 de mayo");
  ok(f("05/11/2026 23:15") === "2026-11-05T23:15:00", "05/11 con dmy = 5 de noviembre");
  ok(f("25/11/2026").startsWith("ERR:falta la hora"), "sin hora: error claro", f("25/11/2026"));
  ok(f("30/02/2026 23:00").startsWith("ERR:"), "30 de febrero no existe");
  ok(f("29/02/2028 23:00") === "2028-02-29T23:00:00", "29 de febrero en bisiesto");
  ok(f("25/13/2026 23:00").startsWith("ERR:"), "mes 13: error");
  ok(f("25/11/2026 24:00").startsWith("ERR:"), "hora 24: error");
  ok(f("25/11/2026 23:60").startsWith("ERR:"), "minuto 60: error");
  ok(f("2026-11-25T23:15:00Z").includes("zona horaria"), "con Z: se rechaza (zona horaria)");
  ok(f("2026-11-25T23:15:00-06:00").includes("zona horaria"), "con -06:00: se rechaza");
  ok(f("ayer").startsWith("ERR:") && f("").startsWith("ERR:"), "texto que no es fecha / vacío: error");
  ok(fh.nocheDe("2026-11-26T03:00:00") === "2026-11-25" && fh.nocheDe("2026-11-26T08:00:00") === "2026-11-26" && fh.nocheDe("2026-11-26T07:59:59") === "2026-11-25",
    "noche operativa: corte a las 08:00");
  ok(fh.nocheDe("2026-01-01T02:00:00") === "2025-12-31" && fh.nocheDe("2026-03-01T01:00:00") === "2026-02-28", "noche operativa: cambio de año y de mes");
  ok(fh.sugerirFormatoFecha(["11/25/2026", "11/26/2026"]) === "mdy" && fh.sugerirFormatoFecha(["25/11/2026"]) === "dmy" && fh.sugerirFormatoFecha(["05/11/2026"]) === "dmy",
    "sugiere mdy solo si el segundo número pasa de 12");
}

// ============================== CSV ==============================
{
  const t1 = csv.partirCsv("Folio,Mesa,Producto,Total\n1,5,\"Whisky, 750 ml\",\"$1,234.50\"\n");
  ok(t1.separador === "," && igual(t1.filas[1].celdas, ["1", "5", "Whisky, 750 ml", "$1,234.50"]), "coma con campo entre comillas que trae coma", JSON.stringify(t1.filas));
  const t2 = csv.partirCsv("Folio;Mesa;Total\r\n1;5;1.234,50\r\n2;6;99,90\r\n");
  ok(t2.separador === ";" && t2.filas.length === 3 && t2.filas[2].celdas[2] === "99,90", "punto y coma con CRLF");
  const t3 = csv.partirCsv("Folio\tMesa\tTotal\n1\t5\t100\n");
  ok(t3.separador === "\t", "tabulador");
  const t4 = csv.partirCsv("Folio|Mesa|Total\n1|5|100\n2|6|200\n");
  ok(t4.separador === "|", "barra vertical");
  const t5 = csv.partirCsv("sep=;\nFolio;Producto,extra;Total\n1;a,b;5\n");
  ok(t5.separador === ";" && t5.filas[0].n === 2 && t5.filas[0].celdas.length === 3, "«sep=;» fija el separador y la línea 1 no cuenta");
  const t6 = csv.partirCsv('Folio,Producto,Total\n1,"Botella\nespecial",100\n2,"Dice ""hola""",50\n');
  ok(t6.filas.length === 3 && t6.filas[1].celdas[1] === "Botella especial" && t6.filas[2].n === 4 && t6.filas[2].celdas[1] === 'Dice "hola"',
    "salto de línea dentro de comillas (la fila sigue con su número) y comillas dobles", JSON.stringify(t6.filas));
  const t7 = csv.partirCsv("A,B\n\n1,2\n   \n3,4");
  ok(t7.filas.length === 3 && t7.filas[1].n === 3 && t7.filas[2].n === 5 && t7.filas[2].celdas[1] === "4", "líneas vacías: no cuentan pero conservan el número; sin salto final");
  const t8 = csv.partirCsv('A,B\n"sin cerrar,2\n');
  ok(t8.avisos.length === 1, "comillas sin cerrar: aviso");
  ok(csv.detectarSeparador("Producto;Total\nWhisky, Etiqueta Negra;1,234.50\nRon, añejo;99.90") === ";", "separador por consistencia aunque haya comas sueltas");
  ok(csv.detectarSeparador("a,b,c\n1,2,3") === ",", "coma por defecto");

  const u = csv.decodificarTexto(enc("﻿Café,Año"));
  ok(u.texto === "Café,Año" && u.codificacion === "UTF-8", "UTF-8 con BOM");
  const w = csv.decodificarTexto(aWindows1252("Café,Año,Piña"));
  ok(w.texto === "Café,Año,Piña" && w.codificacion === "Windows-1252", "Windows-1252 / Latin-1 con acentos", JSON.stringify(w));
  const sinBom = csv.decodificarTexto(enc("Café"));
  ok(sinBom.texto === "Café" && sinBom.codificacion === "UTF-8", "UTF-8 sin BOM");
  const u16 = new Uint8Array([0xff, 0xfe, ...[..."Mesa\tTotal"].flatMap((c) => [c.charCodeAt(0), 0])]);
  ok(csv.decodificarTexto(u16).texto === "Mesa\tTotal", "UTF-16 con BOM (Texto Unicode de Excel)");
  ok(csv.adaptadorCsv.reconoce(enc("a,b"), "ventas.csv") && !csv.adaptadorCsv.reconoce(new Uint8Array([0x50, 0x4b, 3, 4]), "ventas.csv"), "un zip con nombre .csv no se lee como CSV");
}

// ============================== Excel ==============================
{
  const filas = [
    ["Folio", "Fecha", "Mesa", "Producto", "Cantidad", "Precio", "Importe", "Forma de pago", "Mesero"],
    ["A-1", { fecha: "2026-11-25 23:15" }, "5", "Whisky & Coca", 2, { num: 450.5 }, { num: 901 }, "Tarjeta", "Ana"],
    ["A-2", { fecha: "2026-11-26 01:30:45" }, 12, "Cerveza <clara>", 3, { num: 65 }, { num: 195 }, "Efectivo", "Beto"],
    [null, null, null, "TOTAL", null, null, { num: 1096 }],
  ];
  const libro = await crearXlsx(filas);
  const t = await xlsx.leerXlsx(libro);
  ok(t.filas.length === 4 && t.filas[1].celdas[1] === "2026-11-25 23:15:00", "xlsx: fecha con formato propio → texto", JSON.stringify(t.filas[1]));
  ok(t.filas[2].celdas[1] === "2026-11-26 01:30:45", "xlsx: segundos del serial");
  ok(t.filas[1].celdas[3] === "Whisky & Coca" && t.filas[2].celdas[3] === "Cerveza <clara>", "xlsx: textos compartidos con & y <>");
  ok(t.filas[1].celdas[5] === "450.5" && t.filas[2].celdas[2] === "12", "xlsx: moneda y enteros como número (no fecha)");
  ok(t.filas[3].n === 4 && t.filas[3].celdas[0] === "" && t.filas[3].celdas[3] === "TOTAL", "xlsx: celdas vacías al inicio respetan la columna");

  const enLinea = await xlsx.leerXlsx(await crearXlsx([["Folio", "Mesa"], ["X", "VIP 1"]], { enLinea: true, comprimir: false }));
  ok(enLinea.filas[1].celdas[1] === "VIP 1", "xlsx: textos en línea (inlineStr) y zip sin comprimir");
  const conPrefijo = await xlsx.leerXlsx(await crearXlsx([["Folio", "Fecha"], ["X", { fecha: "2026-11-25 22:00" }]], { prefijo: "x:" }));
  ok(conPrefijo.filas[1].celdas[1] === "2026-11-25 22:00:00", "xlsx: XML con prefijo «x:»", JSON.stringify(conPrefijo.filas));
  const s1904 = await xlsx.leerXlsx(await crearXlsx([["Fecha"], [{ fecha: "2026-11-25 22:00" }]], { date1904: true }));
  ok(s1904.filas[1].celdas[0] === "2026-11-25 22:00:00", "xlsx: sistema de fechas 1904", JSON.stringify(s1904.filas));
  const varias = await xlsx.leerXlsx(await crearXlsx([["Folio"], ["1"]], { hojasExtra: ["Resumen"] }));
  ok(varias.avisos.length === 1 && varias.filas[0].celdas[0] === "Folio", "xlsx: varias hojas → la primera, con aviso");
  const abajo = await xlsx.leerXlsx(await crearXlsx([["Reporte de ventas"], [], ["Folio", "Total"], ["1", 5]], { filaInicial: 3 }));
  ok(abajo.filas[0].n === 3 && abajo.filas[1].n === 5, "xlsx: números de fila reales (r)", JSON.stringify(abajo.filas.map((f) => f.n)));
  const hora = await xlsx.leerXlsx(await crearXlsx([["Hora"], [{ hora: "23:15" }]]));
  ok(hora.filas[1].celdas[0] === "23:15:00", "xlsx: celda de solo hora", JSON.stringify(hora.filas));
  ok(xlsx.serialAFecha(serialExcel("2026-11-25 00:00")) === "2026-11-25" && xlsx.serialAFecha(46000.5) === "2025-12-09 12:00:00", "serial → fecha, y mediodía");
  ok(xlsx.serialAFecha(serialExcel("2026-11-25 23:59:59.6")) === "2026-11-26", "serial que redondea a medianoche pasa al día siguiente");
  ok(xlsx.columnaDe("A1") === 0 && xlsx.columnaDe("Z9") === 25 && xlsx.columnaDe("AA3") === 26 && xlsx.columnaDe("AB12") === 27, "columnas A, Z, AA, AB");
  ok(xlsx.esFormatoFecha("dd/mm/yyyy") && xlsx.esFormatoFecha("[h]:mm") && xlsx.esFormatoFecha("yyyy-mm-dd\\ hh:mm") && !xlsx.esFormatoFecha('"$"#,##0.00') && !xlsx.esFormatoFecha("[Red]#,##0") && !xlsx.esFormatoFecha("General") && !xlsx.esFormatoFecha("0.00 \"días\""),
    "formatos de fecha vs moneda, color y texto entre comillas");
  ok(xlsx.decodificarXml("a&amp;b&#233;&#x00F1;_x000D_") === "a&béñ\r", "entidades XML y escapes _xHHHH_");
  const rico = xlsx.textosCompartidos('<sst><si><r><t>Whi</t></r><r><rPr/><t xml:space="preserve">sky </t></r><rPh><t>X</t></rPh></si><si><t/></si></sst>');
  ok(igual(rico, ["Whisky ", ""]), "texto con formato (varias corridas), sin fonética, y vacío", JSON.stringify(rico));
  let error = "";
  try { await xlsx.leerXlsx(enc("no soy zip")); } catch (e) { error = e.message; }
  ok(/\.xlsx/.test(error), "no es zip: error claro", error);
  error = "";
  try { await xlsx.leerXlsx(await crearZip({ "hola.txt": "x" })); } catch (e) { error = e.message; }
  ok(/workbook/.test(error), "zip que no es libro: error claro", error);
}

// ============================== Adaptadores ==============================
{
  const r1 = await ad.leerArchivoPos(enc("Folio,Fecha,Mesa,Total\n1,25/11/2026 23:00,5,100\n"), "ventas.csv");
  ok(r1.ok && r1.formato === "csv" && r1.tabla.encabezados.length === 4, "leerArchivoPos: CSV");
  const r2 = await ad.leerArchivoPos(await crearXlsx([["Folio", "Total"], ["1", 5]]), "ventas.csv");
  ok(r2.ok && r2.formato === "xlsx", "leerArchivoPos: Excel aunque se llame .csv (por contenido)");
  const r3 = await ad.leerArchivoPos(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), "viejo.xls");
  ok(!r3.ok && /xls/.test(r3.error), "un .xls viejo: error con la salida", r3.error);
  const r4 = await ad.leerArchivoPos(new Uint8Array(), "vacio.csv");
  ok(!r4.ok, "archivo vacío: error");
  const r5 = await ad.leerArchivoPos(enc("Folio,Total\n"), "x.csv");
  ok(!r5.ok && /solo trae encabezados/.test(r5.error), "solo encabezados: error");
  const h1 = await ad.huellaArchivo(enc("abc"));
  ok(h1 === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "huella SHA-256");
}

// ============================== Mapeo ==============================
{
  const cruda = { filas: [
    { n: 1, celdas: ["Reporte de ventas del 25/11/2026"] },
    { n: 2, celdas: ["Sucursal Centro"] },
    { n: 4, celdas: ["No. Ticket", "Fecha", "Hora", "Mesa", "Comensal", "Descripción", "Cant.", "P. Unitario", "Importe", "Forma de pago", "Mesero", ""] },
    { n: 5, celdas: ["1001", "25/11/2026", "23:15", "5", "Juan", "Whisky", "2", "$450.00", "$900.00", "Tarjeta", "Ana", ""] },
  ], avisos: [] };
  const t = mapeo.elegirEncabezado(cruda);
  ok(t.filaEncabezado === 4 && t.filas.length === 1 && t.avisos.some((a) => /fila 4/.test(a)), "encabezado debajo de títulos del reporte", JSON.stringify(t));
  ok(t.encabezados[11] === "Columna L", "encabezado vacío → «Columna L»");
  const s = mapeo.sugerirMapeo(t.encabezados);
  ok(s.ticket === "No. Ticket" && s.fecha === "Fecha" && s.hora === "Hora" && s.mesa === "Mesa" && s.cuenta === "Comensal" && s.producto === "Descripción"
    && s.cantidad === "Cant." && s.precio_unitario === "P. Unitario" && s.total === "Importe" && s.metodo_pago === "Forma de pago" && s.mesero === "Mesero",
    "sugerencia de mapeo por encabezados en español", JSON.stringify(s));
  const s2 = mapeo.sugerirMapeo(["Folio", "Fecha y hora", "No. Mesa", "Artículo", "Total", "Precio", "Subtotal"]);
  ok(s2.ticket === "Folio" && s2.fecha === "Fecha y hora" && !s2.hora && s2.mesa === "No. Mesa" && s2.producto === "Artículo" && s2.total === "Total" && s2.precio_unitario === "Precio",
    "sugerencia: fecha y hora juntas, sin columnas repetidas", JSON.stringify(s2));
  const s3 = mapeo.sugerirMapeo(["Folio", "Cuenta", "Total"]);
  ok(s3.ticket === "Folio" && s3.cuenta === "Cuenta", "«Cuenta» con «Folio» → cuenta (comensal)");
  const rep = mapeo.elegirEncabezado({ filas: [{ n: 1, celdas: ["Total", "Total", "Mesa"] }, { n: 2, celdas: ["1", "2", "3"] }], avisos: [] });
  ok(igual(rep.encabezados, ["Total", "Total (2)", "Mesa"]), "encabezados repetidos se numeran");
  ok(igual(mapeo.faltantesMapeo({ columnas: { mesa: "Mesa" } }, ["Mesa"]), ["Ticket o folio", "Fecha", "Total (o precio unitario)"]), "faltantes: ticket, fecha y total");
  ok(mapeo.faltantesMapeo({ columnas: { ticket: "A", fecha: "B", precio_unitario: "C" } }, ["A", "B", "C"]).length === 0, "con precio y sin total alcanza");
  ok(mapeo.faltantesMapeo({ columnas: { ticket: "A", fecha: "A", total: "C" } }, ["A", "C"]).some((x) => /solo puede/.test(x)), "una columna para dos datos: falta");
  const aj = mapeo.ajustarMapeo({ columnas: { ticket: "Folio", mesa: "Mesa vieja" }, formato_fecha: "mdy" }, ["Folio", "Mesa"]);
  ok(igual(aj, { columnas: { ticket: "Folio" }, formato_fecha: "mdy" }), "mapeo guardado: se quitan columnas que no existen en este archivo");
  ok(igual(mapeo.muestras(t, "Mesa"), ["5"]), "muestras de una columna");
  ok(mapeo.letraColumna(0) === "A" && mapeo.letraColumna(25) === "Z" && mapeo.letraColumna(26) === "AA", "letra de columna");
}

// ============================== Normalizar ==============================
{
  const tabla = mapeo.elegirEncabezado({ filas: [
    { n: 1, celdas: ["Folio", "Fecha", "Mesa", "Producto", "Cant", "Precio", "Total", "Comensal", "Pago", "Mesero"] },
    { n: 2, celdas: ["T1", "25/11/2026 23:15", "5", "Whisky", "2", "$450.00", "$900.00", "", "Tarjeta", "Ana"] },
    { n: 3, celdas: ["T1", "25/11/2026 23:15", "5", "Whisky", "2", "$450.00", "$900.00", "", "Tarjeta", "Ana"] },
    { n: 4, celdas: ["T2", "26/11/2026 01:30", "", "Agua", "1", "$30.00", "", "", "", ""] },
    { n: 5, celdas: ["T3", "26/11/2026 02:00", "6", "Botella", "1", "$2,000.00", "$1,800.00", "Juan", "", ""] },
    { n: 6, celdas: ["T4", "26/11/2026 02:10", "6", "Devolución", "-1", "$100", "-$100", "", "", ""] },
    { n: 7, celdas: ["", "", "", "TOTAL", "", "", "$3,500.00", "", "", ""] },
    { n: 8, celdas: ["", "26/11/2026 03:00", "7", "Algo", "1", "", "$10", "", "", ""] },
    { n: 9, celdas: ["T5", "26/11/2026", "7", "Algo", "1", "", "$10", "", "", ""] },
    { n: 10, celdas: ["T6", "26/11/2026 03:00", "7", "Algo", "0", "", "$10", "", "", ""] },
    { n: 11, celdas: ["T7", "26/11/2026 03:00", "7", "Algo", "1", "", "diez", "", "", ""] },
    { n: 12, celdas: ["T8", "26/11/2026 03:00", "7", "", "1", "", "$0.00", "", "", ""] },
    { n: 13, celdas: ["", "", "", "", "", "", "", "", "", ""] },
    { n: 14, celdas: ["T9", "01/01/2099 03:00", "7", "Futuro", "1", "", "$10", "", "", ""] },
    { n: 15, celdas: ["T".repeat(61), "26/11/2026 03:00", "7", "x", "1", "", "$10", "", "", ""] },
  ], avisos: [] });
  const m = { columnas: mapeo.sugerirMapeo(tabla.encabezados), formato_fecha: "dmy" };
  const r = mapeo.normalizarVentas(tabla, m);
  const fila = (n) => r.filas.find((f) => f.linea === n);
  ok(r.ventas.length === 6, "6 ventas válidas (2 idénticas cuentan como 2)", `${r.ventas.length}: ${JSON.stringify(r.filas.filter((f) => f.errores.length).map((f) => [f.linea, f.errores]))}`);
  ok(igual(fila(2).venta, { linea: 2, ticket: "T1", fechaHora: "2026-11-25T23:15:00", mesa: "5", cuenta: null, producto: "Whisky", cantidad: 2, precioUnitarioCentavos: 45000, totalCentavos: 90000, metodoPago: "Tarjeta", mesero: "Ana" }),
    "forma normalizada completa", JSON.stringify(fila(2).venta));
  ok(fila(4).venta?.totalCentavos === 3000 && fila(4).avisos.some((a) => /Sin mesa/.test(a)), "sin total: cantidad × precio; sin mesa: aviso");
  ok(fila(5).avisos.some((a) => /descuento/.test(a)) && fila(5).venta.cuenta === "Juan", "total ≠ cantidad × precio: aviso (descuento); comensal");
  ok(fila(6).venta?.totalCentavos === -10000 && fila(6).avisos.some((a) => /negativo/.test(a)), "devolución: total negativo con aviso");
  ok(fila(7).ignorada && !fila(7).errores.length, "fila «TOTAL» del reporte: se ignora");
  ok(fila(8).errores.some((e) => /ticket/.test(e)), "sin ticket: error");
  ok(fila(9).errores.some((e) => /falta la hora/.test(e)), "sin hora: error");
  ok(fila(10).errores.some((e) => /cantidad es 0/.test(e)), "cantidad 0: error");
  ok(fila(11).errores.some((e) => /total/.test(e)), "total que no es número: error");
  ok(fila(12).venta?.producto === "(sin detalle)" && fila(12).avisos.some((a) => /cortesía/.test(a)), "sin producto → «(sin detalle)»; total 0: aviso");
  ok(!fila(13), "fila vacía: ni cuenta");
  ok(fila(14).errores.some((e) => /futura/.test(e)), "fecha futura: error");
  ok(fila(15).errores.some((e) => /más de 60/.test(e)), "ticket de más de 60: error");
  ok(r.conError === 6 && r.ignoradas === 1, "conteos de error e ignoradas", `${r.conError}/${r.ignoradas}`);
  ok(r.totalCentavos === 90000 * 2 + 3000 + 180000 - 10000 + 1000 * 0 + 0, "total de las válidas", String(r.totalCentavos));
  ok(igual(r.noches, ["2026-11-25"]), "noches: 01:30 del 26 es la noche del 25", JSON.stringify(r.noches));
  const base = mapeo.lineasParaBase(r.ventas, new Map([[2, "c-1"]]));
  ok(base[0].cuenta_id === "c-1" && base[1].cuenta_id === null && base[0].fecha_hora === "2026-11-25T23:15:00" && base[0].total_centavos === 90000, "lo que va a la base, con la cuenta elegida a mano");
  const muchas = mapeo.elegirEncabezado({ filas: [{ n: 1, celdas: ["Folio", "Fecha", "Total"] }, ...Array.from({ length: 5001 }, (_, k) => ({ n: k + 2, celdas: [`F${k}`, "25/11/2026 23:00", "1"] }))], avisos: [] });
  const rm = mapeo.normalizarVentas(muchas, { columnas: { ticket: "Folio", fecha: "Fecha", total: "Total" } });
  ok(rm.errorGeneral && /5,000/.test(rm.errorGeneral), "más de 5,000 líneas: error de archivo", rm.errorGeneral);
  const largo = mapeo.normalizarVentas(mapeo.elegirEncabezado({ filas: [{ n: 1, celdas: ["Folio", "Fecha", "Total", "Producto", "Mesero"] }, { n: 2, celdas: ["1", "25/11/2026 23:00", "1", "p".repeat(130), "m".repeat(90)] }], avisos: [] }),
    { columnas: { ticket: "Folio", fecha: "Fecha", total: "Total", producto: "Producto", mesero: "Mesero" } });
  ok(largo.ventas[0].producto.length === 120 && largo.ventas[0].mesero.length === 80 && largo.filas[0].avisos.length === 2, "producto y mesero largos: se recortan con aviso");
  const mdy = mapeo.normalizarVentas(mapeo.elegirEncabezado({ filas: [{ n: 1, celdas: ["Folio", "Fecha", "Total"] }, { n: 2, celdas: ["1", "11/25/2026 23:00", "1"] }], avisos: [] }),
    { columnas: { ticket: "Folio", fecha: "Fecha", total: "Total" }, formato_fecha: "mdy" });
  ok(mdy.ventas[0]?.fechaHora === "2026-11-25T23:00:00", "formato_fecha mdy del mapeo");
}

// ============================== Excel completo → ventas ==============================
{
  const libro = await crearXlsx([
    ["Ventas del día"],
    ["Folio", "Fecha", "Mesa", "Producto", "Cantidad", "Importe"],
    ["X-1", { fecha: "2026-11-25 23:15" }, "VIP 1", "Champaña", 1, { num: 3500 }],
    ["X-2", { fecha: "2026-11-26 00:45" }, 5, "Shots", 4, 320.5],
  ]);
  const leido = await ad.leerArchivoPos(libro, "ventas.xlsx");
  ok(leido.ok && leido.tabla.filaEncabezado === 2, "Excel con título arriba: encabezado en la fila 2");
  const r = mapeo.normalizarVentas(leido.tabla, { columnas: mapeo.sugerirMapeo(leido.tabla.encabezados) });
  ok(r.ventas.length === 2 && r.ventas[0].fechaHora === "2026-11-25T23:15:00" && r.ventas[0].totalCentavos === 350000 && r.ventas[1].totalCentavos === 32050 && r.ventas[1].mesa === "5" && r.ventas[1].cantidad === 4,
    "Excel → ventas normalizadas (fecha serial, moneda, mesa numérica)", JSON.stringify(r.ventas));
}

// ============================== Arreglos de la revisión ==============================
{
  // Excel: fecha y hora exactamente a las 00:00 (antes salía solo la fecha → «falta la hora»).
  const media = await xlsx.leerXlsx(await crearXlsx([["Folio", "Fecha", "Total"], ["M1", { fecha: "2026-11-26 00:00" }, 100]]));
  ok(media.filas[1].celdas[1] === "2026-11-26 00:00:00", "Excel: fecha y hora a las 00:00 conserva la hora", JSON.stringify(media.filas[1]));
  const rm = mapeo.normalizarVentas(mapeo.elegirEncabezado(media), { columnas: { ticket: "Folio", fecha: "Fecha", total: "Total" } });
  ok(rm.ventas[0]?.fechaHora === "2026-11-26T00:00:00" && fh.nocheDe(rm.ventas[0].fechaHora) === "2026-11-25", "…y la venta de medianoche entra (noche anterior)");
  const h1904 = await xlsx.leerXlsx(await crearXlsx([["Hora"], [{ hora: "00:00" }], [{ hora: "23:15" }]], { date1904: true }));
  ok(h1904.filas[1].celdas[0] === "00:00:00" && h1904.filas[2].celdas[0] === "23:15:00", "Excel 1904: hora sola (también 00:00) sale como hora", JSON.stringify(h1904.filas));
  ok(xlsx.serialAFecha(serialExcel("2026-11-26 00:00"), false, "fechahora") === "2026-11-26 00:00:00" && xlsx.serialAFecha(serialExcel("2026-11-26 00:00"), false, "fecha") === "2026-11-26"
    && xlsx.serialAFecha(0, true, "hora") === "00:00:00" && xlsx.serialAFecha(0.5, true) === "12:00:00" && xlsx.serialAFecha(46000.75, false, "hora") === "18:00:00",
    "serial según el tipo de formato (fecha, hora, fecha y hora)");
  ok(xlsx.tipoFormato("dd/mm/yyyy hh:mm") === "fechahora" && xlsx.tipoFormato("dd/mm/yyyy") === "fecha" && xlsx.tipoFormato("hh:mm") === "hora" && xlsx.tipoFormato("mm:ss") === "hora"
    && xlsx.tipoFormato("mmm yyyy") === "fecha" && xlsx.tipoFormato('"$"#,##0.00') === null, "tipo de un formato propio");
  // Bomba zip: una parte que se infla de más se corta con un mensaje claro.
  const ceros = "0".repeat(60_000_000);
  const zipBomba = await crearZip({ "xl/workbook.xml": '<workbook><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>', "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${ceros}</sheetData></worksheet>` });
  ok(zipBomba.length < 1_000_000, `la bomba de prueba pesa poco comprimida (${Math.round(zipBomba.length / 1000)} KB)`);
  let errBomba = "";
  try { await xlsx.leerXlsx(zipBomba); } catch (e) { errBomba = e.message; }
  ok(/descomprimido pasa de 50 MB/.test(errBomba), "bomba zip: se corta en 50 MB con mensaje en español", errBomba);
  let errCp = "";
  try { xlsx.decodificarXml("a&#99999999;b"); } catch (e) { errCp = e.message; }
  ok(/carácter inválido/.test(errCp), "entidad &#99999999; (fuera de Unicode): error en español, no excepción cruda", errCp);
  let errCp2 = "";
  try { await xlsx.leerXlsx(await crearZip({ "xl/workbook.xml": "<workbook><sheets/></workbook>", "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#x110000;</t></is></c></row></sheetData></worksheet>' })); } catch (e) { errCp2 = e.message; }
  const r2 = await ad.leerArchivoPos(await crearZip({ "xl/workbook.xml": "<workbook><sheets/></workbook>", "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#x110000;</t></is></c></row></sheetData></worksheet>' }), "x.xlsx");
  ok(/carácter inválido/.test(errCp2) && !r2.ok && /carácter inválido/.test(r2.error), "…y leerArchivoPos lo devuelve como error, sin romper la pantalla");

  // Montos por columna.
  const tablaDe = (filas) => mapeo.elegirEncabezado({ filas: [{ n: 1, celdas: ["Folio", "Fecha", "Total"] }, ...filas.map((t, k) => ({ n: k + 2, celdas: [`F${k}`, "25/11/2026 23:00", t] }))], avisos: [] });
  const base = { columnas: { ticket: "Folio", fecha: "Fecha", total: "Total" } };
  const mx = mapeo.normalizarVentas(tablaDe(["$1,500.00", "1,234", "300"]), base);
  ok(mx.ventas.map((v) => v.totalCentavos).join() === "150000,123400,30000" && mx.conError === 0, "columna con «$1,500.00»: «1,234» se lee como mil doscientos treinta y cuatro");
  const es = mapeo.normalizarVentas(tablaDe(["1.234,50", "1.500"]), base);
  ok(es.ventas.map((v) => v.totalCentavos).join() === "123450,150000", "columna con «1.234,50» (configuración de España): «1.500» = $1,500, no $1.50", JSON.stringify(es.ventas.map((v) => v.totalCentavos)));
  const amb = mapeo.normalizarVentas(tablaDe(["1.500", "2.000"]), base);
  ok(amb.ventas.length === 0 && amb.conError === 2 && amb.filas.every((f) => f.errores.some((e) => /ambiguo/.test(e))), "columna solo con «1.500» y «2.000»: error «ambiguo» (no $1.50 en silencio)");
  const fijoComa = mapeo.normalizarVentas(tablaDe(["1.500", "2.000"]), { ...base, formato_montos: "coma" });
  const fijoPunto = mapeo.normalizarVentas(tablaDe(["1.500", "2.000"]), { ...base, formato_montos: "punto" });
  ok(fijoComa.ventas.map((v) => v.totalCentavos).join() === "150000,200000" && fijoPunto.ventas.map((v) => v.totalCentavos).join() === "150,200", "con el formato elegido en el mapeo se lee sin duda");
  const mixta = mapeo.normalizarVentas(tablaDe(["1,5", "2.50", "1.500"]), base);
  ok(mixta.conError === 1 && mixta.ventas.length === 2, "columna mixta: los valores claros entran, el ambiguo no", JSON.stringify(mixta.filas.map((f) => f.errores)));
  const f1 = mapeo.formatosNumeros(tablaDe(["1.234,50"]), base);
  ok(f1.detectado === "coma" && f1.porColumna.total === "coma", "formatosNumeros: detecta coma");
  ok(mapeo.ajustarMapeo({ columnas: { total: "Total" }, formato_montos: "coma" }, ["Total"]).formato_montos === "coma", "el mapeo guardado conserva el formato de montos");

  // Hora de cierre.
  ok(mapeo.esColumnaCierre("Hora de cierre") && mapeo.esColumnaCierre("Fecha cierre") && mapeo.esColumnaCierre("Hora pago") && !mapeo.esColumnaCierre("Hora") && !mapeo.esColumnaCierre("Fecha apertura"),
    "reconoce columnas de cierre o cobro");
  const sa = mapeo.sugerirMapeo(["Folio", "Fecha apertura", "Fecha cierre", "Total"]);
  ok(sa.fecha === "Fecha apertura", "con apertura y cierre, propone apertura", JSON.stringify(sa));
  const sc = mapeo.sugerirMapeo(["Folio", "Fecha", "Hora de cierre", "Total"]);
  ok(sc.fecha === "Fecha" && sc.hora === "Hora de cierre", "si solo hay hora de cierre, la propone…", JSON.stringify(sc));
  ok(mapeo.avisosMapeo({ columnas: sc }).some((a) => /CIERRE/.test(a)) && mapeo.avisosMapeo({ columnas: sa }).length === 0, "…con aviso; con apertura, sin aviso");
}

// ============================== Conciliación ==============================
{
  const f = (o) => conc.normalizarFila({ nivel: "cuenta", caja_centavos: 0, pos_centavos: 0, pos_lineas: 0, pos_tickets: 0, estado: "coincide", ...o });
  ok(conc.estadoDe(100, 100, true) === "coincide" && conc.estadoDe(100, 90, true) === "diferencia" && conc.estadoDe(0, 90, true) === "solo_pos" && conc.estadoDe(100, 0, false) === "solo_caja" && conc.estadoDe(100, 0, true) === "diferencia",
    "estados: coincide, diferencia, solo POS, solo caja (POS que suma 0 con caja: diferencia)");
  const filas = [
    f({ mesa_id: "m10", mesa_numero: "10", cuenta_id: "a", caja_centavos: 500, pos_centavos: 500, pos_lineas: 1, estado: "coincide" }),
    f({ mesa_id: "m2", mesa_numero: "2", cuenta_id: "b", caja_centavos: 300, pos_centavos: 0, pos_lineas: 0, estado: "solo_caja" }),
    f({ mesa_id: "m2", mesa_numero: "2", nivel: "mesa_sin_cuenta", caja_centavos: 0, pos_centavos: 300, pos_lineas: 2, estado: "solo_pos" }),
    f({ mesa_id: null, mesa_numero: "99", nivel: "sin_mesa", pos_centavos: 50, pos_lineas: 1, estado: "solo_pos" }),
    f({ mesa_id: "m1", mesa_numero: "1", cuenta_id: "c", caja_centavos: 200, pos_centavos: 150, pos_lineas: 1, estado: "diferencia" }),
    f({ mesa_id: null, mesa_numero: null, nivel: "sin_mesa", pos_centavos: 20, pos_lineas: 1, estado: "solo_pos" }),
  ];
  const g = conc.agruparPorMesa(filas);
  ok(igual(g.map((m) => m.mesa), ["1", "2", "10", "99", "Sin mesa"]), "mesas en orden natural; las de fuera de caja al final", JSON.stringify(g.map((m) => m.mesa)));
  ok(g[1].estado === "coincide" && g[1].caja === 300 && g[1].pos === 300, "mesa 2: la cuenta sin POS y el POS sin cuenta coinciden a nivel mesa");
  ok(g[0].estado === "diferencia" && g[3].estado === "solo_pos", "mesa con diferencia y mesa desconocida = solo POS");
  const rn = conc.resumirNoche(g);
  ok(rn.caja === 1000 && rn.pos === 1020 && rn.diferencia === 20 && rn.porEstado.coincide === 2 && rn.porEstado.diferencia === 1 && rn.porEstado.solo_pos === 2, "resumen de la noche", JSON.stringify(rn));
  ok(conc.normalizarFila({ nivel: "raro", estado: "raro", caja_centavos: "120" }).caja_centavos === 120, "normalizarFila tolera números como texto y valores raros");
}

console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exit(fallan ? 1 : 0);
