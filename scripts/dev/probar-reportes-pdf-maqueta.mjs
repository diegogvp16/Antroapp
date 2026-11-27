// Maquetación de los reportes PDF con datos FICTICIOS en memoria (no toca
// la base): nombres de antro y de RP muy largos y con acentos, 40 RPs (varias
// hojas), noche vacía y semana en curso. Lee el PDF con pdftotext.
//
//   node scripts/dev/probar-reportes-pdf-maqueta.mjs
//
// Carga lib/domain/reporte-pdf.ts directo (Node quita los tipos) con un
// gancho que resuelve el alias "@/" del proyecto.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gancho = `
export async function resolve(especificador, contexto, siguiente) {
  if (especificador.startsWith("@/")) {
    return siguiente(${JSON.stringify(pathToFileURL(RAIZ).href + "/")} + especificador.slice(2) + ".ts", contexto);
  }
  return siguiente(especificador, contexto);
}`;
register("data:text/javascript," + encodeURIComponent(gancho));
const R = await import(pathToFileURL(path.join(RAIZ, "lib/domain/reporte-pdf.ts")).href);
const E = await import(pathToFileURL(path.join(RAIZ, "lib/pdf/escritor.ts")).href);

// Todo texto escrito en el PDF cae dentro de la hoja (márgenes de 40 pt) y
// arriba del pie. Lee los flujos sin comprimir del escritor.
function dentroDeLaHoja(bytes) {
  const s = Buffer.from(bytes).toString("latin1");
  const re = /BT \/(F[12]) ([\d.]+) Tf .*? (-?[\d.]+) (-?[\d.]+) Td <([0-9A-F]*)> Tj ET/g;
  const fuera = [];
  let n = 0;
  for (const m of s.matchAll(re)) {
    n++;
    const tam = Number(m[2]);
    const x = Number(m[3]);
    const y = Number(m[4]);
    const b = (m[5].match(/../g) ?? []).map((h) => parseInt(h, 16));
    const ancho = E.anchoBytes(b, m[1] === "F2" ? "negrita" : "normal", tam);
    if (x < 39.5 || x + ancho > 572.5 || y < 20 || y > 792) fuera.push({ x, y, ancho: Math.round(ancho), texto: String.fromCharCode(...b).slice(0, 40) });
  }
  return { n, fuera };
}

let pasan = 0;
let fallan = 0;
function revisar(nombre, paso, detalle = "") {
  if (paso) pasan++; else fallan++;
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${!paso && detalle ? "  — " + String(detalle).slice(0, 300) : ""}`);
}
const dir = mkdtempSync(path.join(tmpdir(), "pdf-maqueta-"));
function leer(bytes, nombre, modo = "-layout") {
  const archivo = path.join(dir, nombre);
  writeFileSync(archivo, bytes);
  execFileSync("pdftotext", ["-enc", "UTF-8", modo, archivo, archivo + ".txt"]);
  return readFileSync(archivo + ".txt", "utf8");
}
// Renglón de -raw que empieza con `inicio` y trae los valores en orden.
function renglonCrudo(bytes, inicio, valores) {
  const t = leer(bytes, "crudo-" + Math.random().toString(36).slice(2) + ".pdf", "-raw");
  return t.split(/\r?\n/).some((l) => {
    if (!l.trimStart().startsWith(inicio)) return false;
    let desde = l.indexOf(inicio) + inicio.length;
    for (const v of valores) {
      const i = l.indexOf(v, desde);
      if (i < 0) return false;
      desde = i + v.length;
    }
    return true;
  });
}
const paginas = (bytes) => Number(/\/Count (\d+)/.exec(Buffer.from(bytes).toString("latin1"))?.[1]);

const CLUB_LARGO = "Antro Ñandú de la Señora Peñaloza — Terraza, Mezcalería y Pista Principal «El Último Brindis» Guadalajara";
const RP_LARGO = "María José de los Ángeles Ibáñez-Gutiérrez Santibáñez Échevarría";
const rps = Array.from({ length: 40 }, (_, i) => ({
  rp_id: `rp-${i}`,
  rp_nombre: i === 0 ? RP_LARGO : `RP ${i + 1} Núñez`,
  rp_activo: i !== 3,
  reservas: 10 + i, entraron: 8, consumieron: 7, consumo_centavos: 1234567 + i, ticket_centavos: 176367, comisiones_centavos: 15050,
}));
const cierre = {
  club: { id: "c", nombre: CLUB_LARGO, zona_horaria: "America/Tijuana" },
  fecha: "2026-11-25", noche_en_curso: "2026-11-27", momento: "pasada", termino: true,
  noche: { estado: "cerrada" },
  reservas: { reservas: 120, personas: 480, entraron: 90, en_puerta: 0, consumieron: 85, entraron_sin_consumo: 5, no_llegaron: 30, por_llegar: 0, consumo_centavos: 0 },
  por_origen: [],
  consumo: { total_centavos: 123456789, con_reserva_centavos: 120000000, sin_reserva_centavos: 3456789, cuentas_con_consumo: 99, renglones: 300, ticket_promedio_centavos: 1247038 },
  walk_ins: { cuentas_total: 104, cuentas_reserva: 90, cuentas: 14, personas: 40, con_consumo: 14, consumo_centavos: 3456789 },
  cobros: { efectivo_centavos: 50000000, tarjeta_centavos: 70000000, otro_centavos: 3456789, total_centavos: 123456789, cobros: 150, por_cobrar_centavos: 0 },
  cuadre: {
    registrado_centavos: 123456789, cobrado_efectivo_centavos: 50000000, cobrado_tarjeta_centavos: 70000000, cobrado_otro_centavos: 3456789,
    saldo_sin_cobrar_centavos: 0, contado_efectivo_centavos: 49950000, contado_tarjeta_centavos: 70000000, contado_otro_centavos: 3456789,
    diferencia_centavos: -50000, notas: "Faltó un billete de $500 en la caja 2; se revisó con el cajero.", hecho_en: "2026-11-26T10:12:00Z", hecho_por_nombre: "Lorena Olvera",
  },
  anulaciones: { consumos: 4, consumos_centavos: 98700, cobros: 2, cobros_centavos: 45000, mesas_reabiertas: 1 },
  mesas: { mesas_antro: 60, mesas_usadas: 55, grupos: 70 },
  comisiones: { comisiones: 85, comisiones_en_cero: 3, comision_centavos: 602000, pago_dia_centavos: 0, pagos_dia: 0, cuentas_rp_sin_cuadrar: 2, total_centavos: 602000 },
  rps,
  generado_en: "2026-11-27T20:00:00Z",
  generado_local: "2026-11-27 12:00",
};

// Noche con 40 RPs y nombres largos.
const bN = R.pdfReporteNoche(R.normalizarNochePdf(cierre));
const tN = leer(bN, "noche.pdf");
// Copia para verla (carpeta de capturas, ignorada por Git), si existe.
const capturas = path.join(RAIZ, "screenshots-n4-reportes");
try {
  writeFileSync(path.join(capturas, "maqueta-noche-nombres-largos.pdf"), bN);
} catch {
  /* sin carpeta de capturas */
}
const tNraw = leer(bN, "noche-raw.pdf", "-raw");
revisar(`noche: varias hojas (${paginas(bN)})`, paginas(bN) >= 2);
revisar("noche: el nombre largo del antro sale completo (partido en renglones)", tNraw.replace(/\s+/g, " ").includes(CLUB_LARGO));
// La 1.ª línea del nombre va antes de las cifras y el resto después (orden de lectura de la fila).
revisar("noche: el nombre largo de la RP sale completo y en orden", (() => {
  let i = 0;
  for (const p of RP_LARGO.split(" ")) {
    i = tNraw.indexOf(p, i);
    if (i < 0) return false;
  }
  return true;
})());
revisar("noche: los 40 RPs", rps.every((r) => tNraw.includes(r.rp_nombre.split(" ").slice(0, 2).join(" "))));
revisar("noche: RP dado de baja marcado", tNraw.includes("RP 4 Núñez (dado de baja)"));
revisar("noche: montos grandes con separador de miles", tN.includes("$1,234,567.89") && tN.includes("$12,345.67"));
revisar("noche: pie en cada hoja", (tN.match(/Página \d de \d/g) ?? []).length === paginas(bN));
revisar("noche: encabezado de la tabla se repite en la hoja siguiente", (tN.match(/Consumieron/g) ?? []).length >= 2);
revisar("noche: «continúa» en la hoja 2", tN.includes("(continúa)"));
revisar("noche: aviso de cuentas sin cuadrar", tN.replace(/\s+/g, " ").includes("2 cuentas de RP siguen sin cuadrar"));
revisar("noche: zona del antro", tN.includes("America/Tijuana"));

// Noche vacía y noche en curso.
const vacia = { ...cierre, club: { ...cierre.club, nombre: "Vacío" }, reservas: { ...cierre.reservas, reservas: 0 }, consumo: { ...cierre.consumo, total_centavos: 0 }, walk_ins: { ...cierre.walk_ins, cuentas_total: 0 }, cobros: { ...cierre.cobros, total_centavos: 0 }, comisiones: { ...cierre.comisiones, total_centavos: 0 }, rps: [] };
const tV = leer(R.pdfReporteNoche(R.normalizarNochePdf(vacia)), "vacia.pdf");
revisar("noche vacía: «Sin movimientos», sin tablas", tV.includes("Sin movimientos") && !tV.includes("Total cobrado"));
const enCurso = { ...cierre, momento: "en_curso", termino: false, noche: { estado: "abierta" } };
const tC = leer(R.pdfReporteNoche(R.normalizarNochePdf(enCurso)), "encurso.pdf");
revisar("noche en curso: aviso de parciales y «Por llegar»", tC.includes("Noche en curso") && tC.includes("Por llegar"));

// Semana en curso, con noches futuras.
const nocheSem = (i) => ({
  fecha: `2026-11-${23 + i}`, momento: i < 4 ? "pasada" : i === 4 ? "en_curso" : "futura", termino: i < 4, estado_caja: i === 2 ? "cerrada" : "sin_caja",
  reservas: i, personas: i * 3, entraron: i, consumieron: i, no_llegaron: 0, por_llegar: 0, cuentas: i, cuentas_walk_in: 0, personas_walk_in: 0,
  mesas_usadas: i, grupos: i, consumo_centavos: i * 1000, cuentas_con_consumo: i, ticket_promedio_centavos: i ? 1000 : 0,
  efectivo_centavos: i * 1000, tarjeta_centavos: 0, otro_centavos: 0, cobrado_centavos: i * 1000, por_cobrar_centavos: 0,
  comision_reserva_centavos: 0, pago_dia_centavos: 0, comisiones_centavos: 0, cuentas_rp_sin_cuadrar: 0,
  consumos_anulados: 1, consumos_anulados_centavos: 1000, cobros_anulados: 0, cobros_anulados_centavos: 0, mesas_reabiertas: 0,
  con_cuadre: i === 2, diferencia_centavos: i === 2 ? 2500 : null,
});
const semana = {
  club: cierre.club, lunes: "2026-11-23", domingo: "2026-11-29", semana_iso: { anio: 2026, semana: 48 }, noche_en_curso: "2026-11-27",
  parcial: true, mesas_antro: 60, noches: Array.from({ length: 7 }, (_, i) => nocheSem(i)),
  totales: { reservas: 21, personas: 63, entraron: 21, consumieron: 21, no_llegaron: 0, por_llegar: 0, cuentas: 21, cuentas_walk_in: 0, personas_walk_in: 0, grupos: 21,
    consumo_centavos: 21000, cuentas_con_consumo: 21, ticket_promedio_centavos: 1000, efectivo_centavos: 21000, tarjeta_centavos: 0, otro_centavos: 0,
    cobrado_centavos: 21000, por_cobrar_centavos: 0, comision_reserva_centavos: 0, pago_dia_centavos: 0, comisiones_centavos: 0, cuentas_rp_sin_cuadrar: 0,
    consumos_anulados: 7, consumos_anulados_centavos: 7000, cobros_anulados: 0, cobros_anulados_centavos: 0, mesas_reabiertas: 0,
    noches_con_cuadre: 1, diferencia_centavos: 2500,
    noches_con_consumo: 6, noches_sin_terminar: 3 },
  rps: rps.slice(0, 3), generado_en: "", generado_local: "2026-11-27 12:00",
};
const bS = R.pdfReporteSemana(R.normalizarSemanaPdf(semana));
const tS = leer(bS, "semana.pdf");
revisar("semana en curso: aviso con 3 noches sin terminar", tS.replace(/\s+/g, " ").includes("Semana en curso: 3 noches no han terminado"));
revisar("semana: noches marcadas (en curso / todavía no empieza)", tS.includes("en curso (parcial)") && tS.includes("todavía no empieza"));
revisar("semana: periodo «del 23 al 29 de noviembre de 2026»", tS.includes("del 23 de noviembre al 29 de noviembre de 2026"));
revisar("semana: definición del ticket semanal", tS.replace(/\s+/g, " ").includes("no es el promedio de los tickets de cada noche"));

revisar("semana: anulaciones y cuadres", tS.includes("Anulaciones y cuadres") && renglonCrudo(bS, "Consumos anulados", ["7", "$70.00"]) && renglonCrudo(bS, "Noches cerradas con cuadre", ["1 de 7"]) && tS.includes("Sobran $25.00"));
revisar("semana: todo el texto dentro de la hoja", dentroDeLaHoja(bS).fuera.length === 0, JSON.stringify(dentroDeLaHoja(bS).fuera.slice(0, 3)));

// Cuadre y anulaciones de la noche.
revisar("noche: cobrado y contado por método", renglonCrudo(bN, "Efectivo", ["$500,000.00", "$499,500.00"]) && renglonCrudo(bN, "Tarjeta", ["$700,000.00", "$700,000.00"]));
revisar("noche: diferencia del cuadre «Faltan $500.00»", renglonCrudo(bN, "Diferencia del cuadre", ["Faltan $500.00"]));
revisar("noche: quién cuadró, saldo y notas", tNraw.replace(/\s+/g, " ").includes("Cuadre de Lorena Olvera") && tNraw.includes("Notas del cuadre: Faltó un billete de $500"));
revisar("noche: anulaciones (consumos, cobros, mesas reabiertas)", renglonCrudo(bN, "Consumos anulados", ["4", "$987.00"]) && renglonCrudo(bN, "Cobros anulados", ["2", "$450.00"]) && renglonCrudo(bN, "Mesas reabiertas", ["1"]));
revisar("noche: todo el texto dentro de la hoja", dentroDeLaHoja(bN).fuera.length === 0, JSON.stringify(dentroDeLaHoja(bN).fuera.slice(0, 3)));
const sinCuadre = leer(R.pdfReporteNoche(R.normalizarNochePdf({ ...cierre, cuadre: null })), "sincuadre.pdf");
revisar("noche sin cierre en caja: «Sin cuadre general» y contado «—»", sinCuadre.includes("Sin cuadre general") && /Efectivo\s+\$500,000\.00\s+—/.test(sinCuadre));

// Nombres de 20,000 letras (profiles.nombre no tiene límite en la base y
// el RP puede cambiar el suyo): rápido y sin salirse de la hoja.
const ENORME = "A".repeat(20000);
let t0 = performance.now();
const bE = R.pdfReporteNoche(R.normalizarNochePdf({
  ...cierre,
  club: { ...cierre.club, nombre: ENORME },
  cuadre: { ...cierre.cuadre, notas: "N".repeat(20000), hecho_por_nombre: "H".repeat(20000) },
  rps: [{ ...rps[0], rp_nombre: ENORME }, { ...rps[1], rp_nombre: "Ñ".repeat(20000) }, ...rps.slice(2, 5)],
}));
const msE = performance.now() - t0;
revisar(`20,000 letras: el PDF de la noche se arma en ${msE.toFixed(0)} ms (< 1000 ms)`, msE < 1000);
const dE = dentroDeLaHoja(bE);
revisar(`20,000 letras: los ${dE.n} textos dentro de la hoja`, dE.fuera.length === 0, JSON.stringify(dE.fuera.slice(0, 3)));
revisar(`20,000 letras: pocas hojas (${paginas(bE)})`, paginas(bE) <= 3);
revisar(`20,000 letras: archivo chico (${(bE.length / 1024).toFixed(0)} KB < 100 KB)`, bE.length < 100 * 1024);
const tE = leer(bE, "enorme.pdf", "-raw");
revisar("20,000 letras: los nombres salen recortados con «…»", tE.includes("…") && !tE.includes("A".repeat(200)));
// Sin el tope de normalizar (por si una pantalla futura lo salta): el maquetador recorta igual.
t0 = performance.now();
const crudo = R.normalizarNochePdf(cierre);
crudo.club.nombre = ENORME;
crudo.rps = [{ ...crudo.rps[0], rp_nombre: ENORME }];
const bE2 = R.pdfReporteNoche(crudo);
const msE2 = performance.now() - t0;
revisar(`20,000 letras sin tope previo: ${msE2.toFixed(0)} ms (< 1000 ms) y dentro de la hoja`, msE2 < 1000 && dentroDeLaHoja(bE2).fuera.length === 0 && paginas(bE2) <= 3);

// Nombres de archivo.
revisar("nombre de archivo sin acentos ni símbolos", R.nombreArchivoPdf("noche", "Ñandú «Bar»", "2026-11-25") === "reporte-noche-nandu-bar-2026-11-25.pdf");
revisar("nombre de archivo de un antro sin nombre", R.nombreArchivoPdf("semana", "¿¡!?", "2026-11-23") === "reporte-semana-antro-2026-11-23.pdf");
revisar("pesos: negativo y centavos", R.pesos(-5050) === "-$50.50" && R.pesos(0) === "$0.00");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pasan} pasan, ${fallan} fallan`);
process.exit(fallan ? 1 : 0);
