// Genera los archivos de ejemplo del importador de ventas del POS en
// fixtures/pos/ (CSV en varias codificaciones y Excel .xlsx). Reproducible:
// sin fechas del sistema ni azar; los .xlsx se arman con
// scripts/dev/pos-archivos-prueba.mjs (zip propio, sin dependencias).
//
//   node scripts/dev/generar-pos-fixtures.mjs
//
// Todos los datos son ficticios (antro, meseros y productos inventados).
// Qué trae cada archivo y qué se espera: fixtures/pos/LEEME.md. La prueba
// que los lee del disco: scripts/dev/probar-pos-fixtures.mjs.
// No toca la base ni la red.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aWindows1252, crearXlsx, crearZip } from "./pos-archivos-prueba.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(RAIZ, "fixtures/pos");
mkdirSync(DIR, { recursive: true });

const BOM = [0xef, 0xbb, 0xbf];
const utf8 = (t, { bom = false } = {}) => {
  const b = new TextEncoder().encode(t);
  return bom ? new Uint8Array([...BOM, ...b]) : b;
};
const utf16le = (t) => new Uint8Array([0xff, 0xfe, ...Buffer.from(t, "utf16le")]);
const crlf = (lineas) => lineas.join("\r\n") + "\r\n";
const lf = (lineas) => lineas.join("\n") + "\n";

const archivos = {};

// ------------------------------------------------------------ CSV: se leen --

// Exporte típico de un POS mexicano: UTF-8 con BOM, coma, CRLF, montos con
// «$» y coma de miles entre comillas, títulos arriba, renglones vacíos y
// la fila de totales al final (sin folio).
archivos["01-utf8-bom-titulos-totales.csv"] = utf8(
  crlf([
    '"Reporte de ventas por producto"',
    '"Sucursal: Club Ficticio Centro"',
    '"Del 20/11/2026 al 21/11/2026"',
    "",
    "Folio,Fecha,Hora,Mesa,Producto,Cant.,Precio Unitario,Importe,Forma de Pago,Mesero",
    'A-1001,20/11/2026,22:45,Mesa 5,Piña colada,2,"$145.00","$290.00",Efectivo,Begoña',
    'A-1001,20/11/2026,22:47,Mesa 5,Jalapeño poppers,1,"$185.50","$185.50",Efectivo,Begoña',
    'A-1002,20/11/2026,23:10,VIP 1,Botella tequila añejo 750 ml,1,"$2,850.00","$2,850.00",Tarjeta,Andrés',
    'A-1002,20/11/2026,23:12,VIP 1,Agua mineral,6,"$45.00","$270.00",Tarjeta,Andrés',
    "",
    'A-1003,21/11/2026,00:35,12,Café americano,3,"$38.00","$114.00",Tarjeta,Sofía',
    'A-1004,21/11/2026,01:20,Barra,Cerveza clara,4,"$65.00","$260.00",Efectivo,Íñigo',
    ",,,,,,,,,",
    ',,,,TOTAL,,,"$3,969.50",,',
  ]),
  { bom: true },
);

// Configuración regional con coma decimal: punto y coma, «1.850,00»,
// fecha dd/mm/aa con la hora en la misma celda, encabezados en mayúsculas
// con acento, LF.
archivos["02-punto-y-coma-coma-decimal.csv"] = utf8(
  lf([
    "FOLIO;FECHA Y HORA;MESA;DESCRIPCIÓN;CANTIDAD;PRECIO;TOTAL;MESERO",
    "5501;20/11/26 22:05;3;Mojito de maracuyá;2;95,50;191,00;Raúl",
    "5501;20/11/26 22:05;3;Nachos con queso;1;120,00;120,00;Raúl",
    "5502;20/11/26 23:40:15;8;Botella ron añejo;1;1.850,00;1.850,00;Begoña",
    "5503;21/11/26 01:02;8;Refresco;4;35,00;140,00;Begoña",
    "5504;21/11/26 02:30;10;Shot mezcal espadín;3;89,90;269,70;Raúl",
  ]),
);

// Excel en Windows («CSV (delimitado por comas)»): Windows-1252, folios con
// ceros a la izquierda, comillas con comas y comillas dobles adentro y una
// columna extra (Observaciones).
archivos["03-windows-1252.csv"] = aWindows1252(
  crlf([
    "Núm. Ticket,Fecha,Hora,No. Mesa,Descripción,Cantidad,Precio,Total,Mesero,Observaciones",
    '00871,21/11/2026,21:55,04,Café de olla,2,"$42.00","$84.00",Ángeles,',
    '00871,21/11/2026,21:58,04,Limonada con chía,2,"$55.00","$110.00",Ángeles,"Sin hielo, con limón"',
    '00872,21/11/2026,23:30,07,Botella whisky 12 años,1,"$3,200.00","$3,200.00",Martín,"Pidió ""hielo aparte"""',
    '00873,22/11/2026,03:15,07,Agua de piña,5,"$40.00","$200.00",Martín,',
  ]),
);

// Excel «Texto Unicode»: UTF-16 LE con BOM, separado por tabuladores.
archivos["04-utf16-tabuladores.txt"] = utf16le(
  crlf([
    "Orden\tFecha\tHora\tMesa\tArtículo\tCant\tImporte\tMesera",
    "9001\t20/11/2026\t22:00\t1\tCubeta de cervezas (10)\t1\t650.00\tBegoña",
    "9001\t20/11/2026\t22:00\t1\tPapas a la francesa\t2\t180.00\tBegoña",
    "9002\t20/11/2026\t23:59:59\t2\tChampaña brut\t1\t1,250.00\tSofía",
  ]),
);

// Encabezados con espacios, acentos y otros nombres; hora de apertura y de
// cierre; columnas extra (Descuento, IVA, Propina, Estatus); fechas con
// nombre del mes; horas de 12 h («10:45 p. m.», «1:05 AM»); montos con
// «$ », «MXN» y «M.N.».
archivos["05-encabezados-raros-12h.csv"] = utf8(
  crlf([
    "  No. de Orden , FECHA ,Hora de Apertura,Hora de Cierre,Área,Núm. de Mesa,Artículo / Descripción,Cant.,P. Unit.,Descuento,IVA,Importe Total ($),Propina,Método de Pago,Atendió,Estatus",
    ' C-77 ,20-nov-2026,10:45 p. m.,11:58 p. m.,Terraza,T-3,Margarita de tamarindo,2,"$ 95.00",0.00,30.40,"$ 190.00 ",20.00,Efectivo,Iñaki,Cerrada',
    'C-78,20-nov-2026,11:20 p.m.,1:05 AM,Salón,Mesa 9,Botella vodka 1 L,1,"MXN 1,180.00",0.00,188.80,"MXN 1,180.00",0.00,Tarjeta de crédito,Ximena,Cerrada',
    "C-79,21 de noviembre de 2026,12:15 a. m.,2:40 a. m.,Salón,Mesa 9,Alitas búfalo,1,250.00,25.00,36.00,250.00 M.N.,0,Tarjeta de débito,Ximena,Cerrada",
  ]),
);

// Un renglón por ticket (sin producto ni cantidad), fechas AAAA-MM-DD y
// AAAA/MM/DD, devolución entre paréntesis, cancelación con «-» al final,
// cortesía en cero, ticket sin mesa y «Gran total» al final.
archivos["06-por-ticket-devoluciones.csv"] = utf8(
  crlf([
    "Cheque,Fecha Apertura,Hora Apertura,Mesa,Total,Tipo de Pago",
    '3301,2026-11-21,22:10:00,15,"1,540.00",Tarjeta',
    "3302,2026-11-21,23:45:00,16,860.5,Efectivo",
    "3303,2026-11-22,01:30:00,15,(250.00),Devolución",
    "3304,2026-11-22,02:00:00,17,0.00,Cortesía",
    "3305,2026/11/22,03:10:00,,320.00-,Cancelación",
    ',,,,"1,830.50",Gran total',
  ]),
);

// Pista «sep=;» de Excel, todo entre comillas, un producto con «;», otro
// con comillas dobles y salto de línea adentro, cantidad con coma decimal.
archivos["07-sep-comillas-saltos.csv"] = utf8(
  crlf([
    "sep=;",
    "Ticket;Fecha;Hora;Mesa;Producto;Cantidad;Total;Comensal",
    '"T-10";"21/11/2026";"22:30";"Mesa 2";"Tabla de quesos; carnes frías";"1";"345,00";"Mariana"',
    '"T-10";"21/11/2026";"22:31";"Mesa 2";"Coctel ""de la casa""\r\n(edición otoño)";"2";"300,00";"Mariana"',
    '"T-11";"21/11/2026";"23:05";"VIP 2";"Vino tinto copa";"1,5";"217,50";""',
  ]),
);

// Montos sin ningún valor que diga el formato: «1.500» ¿mil quinientos o
// uno cincuenta? Sin elegir en el mapeo, esas líneas no entran.
archivos["08-montos-ambiguos.csv"] = utf8(
  crlf([
    "Folio,Fecha,Hora,Mesa,Total",
    "801,20/11/2026,23:00,1,1.500",
    "802,20/11/2026,23:10,2,2.300",
    "803,20/11/2026,23:20,3,350",
  ]),
);

// Exporte de un POS en inglés: mes/día/año, 12 h, encabezados en inglés.
archivos["09-ingles-mes-dia.csv"] = utf8(
  crlf([
    "Ticket #,Date,Time,Table,Item,Qty,Price,Amount,Server",
    "4410,11/20/2026,10:15 PM,6,Margarita,2,$95.00,$190.00,Kevin",
    "4410,11/20/2026,10:16 PM,6,Nachos,1,$122.50,$122.50,Kevin",
    "4411,11/21/2026,12:40 AM,8,Beer,3,$60.00,$180.00,Laura",
  ]),
);

// Sin columna de total: se calcula cantidad × precio, redondeado a centavos.
archivos["10-sin-total-con-precio.csv"] = utf8(
  crlf([
    "Folio,Fecha,Hora,Mesa,Producto,Cantidad,Precio unitario",
    "1201,22/11/2026,22:00,5,Shot de tequila,3,33.33",
    "1201,22/11/2026,22:00,5,Cerveza de barril (litro),2.5,40",
    "1202,22/11/2026,23:00,6,Botana,1,99.995",
  ]),
);

// Excel en Windows con configuración de coma decimal: Windows-1252 y
// punto y coma, «1.234,50» con «$».
archivos["11-windows-1252-punto-y-coma.csv"] = aWindows1252(
  crlf([
    "Folio;Fecha;Hora;Mesa;Producto;Cantidad;Importe;Mesero",
    "77-1;22/11/2026;22:40;3;Jarra de sangría;1;$1.234,50;Begoña",
    "77-1;22/11/2026;22:41;3;Champiñones al ajillo;2;$190,00;Begoña",
    "77-2;22/11/2026;23:59;4;Té chai;1;$58,00;Ñeco",
  ]),
);

// Título largo arriba que nombra varios datos («ticket, fecha y hora, mesa
// y producto») encima de un encabezado corto.
archivos["12-titulo-largo-arriba.csv"] = utf8(
  crlf([
    '"Detalle de ventas por ticket, fecha y hora, mesa y producto"',
    '"Generado el 22/11/2026 08:05"',
    "Folio,Fecha,Hora,Importe",
    "6001,21/11/2026,22:10,350.00",
    "6002,21/11/2026,23:45,1200.00",
  ]),
);

// Fila de totales con «TOTAL» en la columna del folio (como lo ponen muchos
// reportes): esa fila sale con error y las demás entran.
archivos["13-total-en-columna-folio.csv"] = utf8(
  crlf([
    "Folio,Fecha,Hora,Mesa,Producto,Importe",
    "8101,22/11/2026,22:15,2,Cerveza,65.00",
    "8102,22/11/2026,22:30,3,Mezcal,95.00",
    "TOTAL,,,,,160.00",
  ]),
);

// ----------------------------------------------------------- CSV: rechazo --

archivos["r01-vacio.csv"] = new Uint8Array(0);
archivos["r02-solo-bom-y-renglones-vacios.csv"] = utf8("\r\n\r\n   \r\n,,,\r\n", { bom: true });
archivos["r03-solo-encabezados.csv"] = utf8(crlf(["Folio,Fecha,Hora,Mesa,Producto,Total"]));
archivos["r04-sin-columna-total.csv"] = utf8(
  crlf([
    "Folio,Fecha,Hora,Mesa,Producto,Cantidad,Mesero",
    "1,20/11/2026,23:00,1,Cerveza,2,Begoña",
    "2,20/11/2026,23:30,2,Mezcal,1,Andrés",
  ]),
);
archivos["r05-encabezados-desconocidos.csv"] = utf8(
  crlf(["Col1,Col2,Col3", "A,20/11/2026,100", "B,20/11/2026,200"]),
);
archivos["r06-fechas-imposibles.csv"] = utf8(
  crlf([
    "Folio,Fecha,Hora,Mesa,Total",
    "F1,31/11/2026,23:00,1,100.00",
    "F2,29/02/2026,23:00,1,100.00",
    "F3,15/13/2026,23:00,1,100.00",
    "F4,00/11/2026,23:00,1,100.00",
    "F5,20/11/2026,25:10,1,100.00",
    "F6,20/11/2026,23:61,1,100.00",
    "F7,20/11/2019,23:00,1,100.00",
    "F8,20/11/2030,23:00,1,100.00",
    "F9,ayer,23:00,1,100.00",
    "F10,20/11/2026,23:00,1,100.00",
  ]),
);
archivos["r07-sin-hora.csv"] = utf8(
  crlf(["Folio,Fecha,Mesa,Total", "1,20/11/2026,1,100.00", "2,21/11/2026,2,200.00"]),
);
archivos["r08-zona-horaria.csv"] = utf8(
  crlf(["Folio,Fecha,Mesa,Total", "1,2026-11-20T23:15:00Z,1,100.00", "2,2026-11-20T23:15:00-06:00,2,200.00"]),
);
archivos["r09-montos-invalidos.csv"] = utf8(
  crlf([
    "Folio,Fecha,Hora,Mesa,Cantidad,Total",
    "M1,20/11/2026,23:00,1,1,N/A",
    "M2,20/11/2026,23:00,1,1,12.34.5",
    "M3,20/11/2026,23:00,1,1,$",
    'M4,20/11/2026,23:00,1,1,"$2,000,000.00"',
    "M5,20/11/2026,23:00,1,0,100.00",
    "M6,20/11/2026,23:00,1,dos,100.00",
    "M7,20/11/2026,23:00,1,1,",
    "M8,20/11/2026,23:00,1,1,100.00",
  ]),
);
archivos["r10-sin-folio.csv"] = utf8(
  crlf(["Folio,Fecha,Hora,Mesa,Producto,Total", ",20/11/2026,23:00,1,Cerveza,65.00", ",20/11/2026,23:10,2,Agua,30.00"]),
);
// Un .xls viejo (formato binario de Office, firma D0 CF 11 E0).
archivos["r11-excel-viejo.xls"] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(504).fill(0)]);
// Un CSV con la extensión cambiada a .xlsx.
archivos["r12-csv-renombrado.xlsx"] = utf8(crlf(["Folio,Fecha,Hora,Total", "1,20/11/2026,23:00,100.00"]));

// ------------------------------------------------------------ Excel .xlsx --

// Libro de Excel normal: título arriba, renglón vacío, fechas con formato de
// fecha y hora (una a las 00:00 en punto), montos con formato de moneda,
// mesa numérica, columna extra (Propina), fila de totales y una 2.ª hoja.
archivos["x01-excel-normal.xlsx"] = await crearXlsx(
  [
    ["Reporte de ventas — Club Ficticio"],
    [],
    ["Folio", "Fecha y hora", "Mesa", "Producto", "Cantidad", "Precio", "Importe", "Mesero", "Propina"],
    ["B-200", { fecha: "2026-11-21 22:15" }, "Mesa 3", "Piña colada", 2, { num: 145 }, { num: 290 }, "Begoña", { num: 30 }],
    ["B-200", { fecha: "2026-11-21 22:20" }, "Mesa 3", "Jalapeños rellenos", 1, { num: 185.5 }, { num: 185.5 }, "Begoña", null],
    ["B-201", { fecha: "2026-11-22 00:00" }, "VIP 1", "Botella tequila añejo", 1, { num: 2850 }, { num: 2850 }, "Iñaki", { num: 285 }],
    ["B-202", { fecha: "2026-11-22 01:45" }, 5, "Café", 3, { num: 38.3 }, { num: 114.9 }, "Sofía", null],
    [null, null, null, "Total", null, null, { num: 3440.4 }, null, null],
  ],
  { hojasExtra: ["Resumen"] },
);

// Fecha y hora en columnas separadas, sistema de fechas 1904 (Excel de Mac
// viejo), XML con prefijo «x:» y textos en línea (como LibreOffice y otros).
archivos["x02-fecha-hora-separadas-1904.xlsx"] = await crearXlsx(
  [
    ["No. Ticket", "Fecha", "Hora", "Mesa", "Descripción", "Cant", "Total"],
    ["7001", { fecha: "2026-11-20 00:00" }, { hora: "23:40" }, "12", "Mezcal joven", 2, { num: 178 }],
    ["7002", { fecha: "2026-11-21 00:00" }, { hora: "01:15" }, "12", "Agua mineral", 1, { num: 45.5 }],
  ],
  { date1904: true, prefijo: "x:", enLinea: true },
);

// Todo escrito como texto en las celdas (sin formato de número ni fecha):
// encabezados en mayúsculas con acento y espacios, coma decimal, 12 h.
archivos["x03-celdas-de-texto.xlsx"] = await crearXlsx([
  ["  NÚMERO DE CUENTA ", "FECHA", "HORA", "MESA", "PRODUCTO", "IMPORTE"],
  ["C-1", "21/11/2026", "11:15 p. m.", "4", "Cubeta 6 cervezas", "$1.234,50"],
  ["C-2", "21/11/2026", "11:50 p. m.", "4", "Hielo", "$25,00"],
]);

// --------------------------------------------------------- Excel: rechazo --

const base = await crearXlsx([
  ["Folio", "Fecha", "Hora", "Total"],
  ["1", "20/11/2026", "23:00", { num: 100 }],
]);
// Hoja con los datos comprimidos dañados (como un archivo que se cortó al
// bajarlo o se corrompió en una USB): el índice del zip está bien.
archivos["r13-xlsx-danado.xlsx"] = danarParte(base, "xl/worksheets/sheet1.xml");
// Archivo cortado a la mitad: falta el índice del zip.
archivos["r14-xlsx-truncado.xlsx"] = base.slice(0, Math.floor(base.length * 0.6));
// Un zip que no es libro de Excel.
archivos["r15-zip-no-excel.xlsx"] = await crearZip({ "LEEME.txt": "Esto no es un libro de Excel." });
// Libro con solo encabezados.
archivos["r16-xlsx-solo-encabezados.xlsx"] = await crearXlsx([["Folio", "Fecha", "Hora", "Mesa", "Total"]]);

/** Copia del zip con los bytes comprimidos de `nombre` sobrescritos con 0xFF
 *  (un bloque deflate de tipo reservado: no se puede descomprimir). */
function danarParte(zip, nombre) {
  const b = new Uint8Array(zip);
  const u16 = (i) => b[i] | (b[i + 1] << 8);
  const u32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  let fin = b.length - 22;
  while (fin >= 0 && u32(fin) !== 0x06054b50) fin--;
  let p = u32(fin + 16);
  for (let k = 0; k < u16(fin + 10); k++) {
    const largo = u16(p + 28);
    const n = new TextDecoder().decode(b.subarray(p + 46, p + 46 + largo));
    const comprimido = u32(p + 20);
    const local = u32(p + 42);
    if (n === nombre) {
      const inicio = local + 30 + u16(local + 26) + u16(local + 28);
      b.fill(0xff, inicio, inicio + comprimido);
      return b;
    }
    p += 46 + largo + u16(p + 30) + u16(p + 32);
  }
  throw new Error(`No está ${nombre} en el zip`);
}

for (const [nombre, bytes] of Object.entries(archivos)) writeFileSync(path.join(DIR, nombre), bytes);
console.log(`${Object.keys(archivos).length} archivos en fixtures/pos/`);
