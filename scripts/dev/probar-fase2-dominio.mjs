// Pruebas de las reglas puras de la fase 2, bloque 8 (lib/domain/inventario.ts
// y lib/domain/propinas.ts). No toca ninguna base: Node 24 carga el .ts
// directo (quita los tipos).
//
//   node scripts/dev/probar-fase2-dominio.mjs

import {
  bajoStock,
  conMovimiento,
  errorMovimiento,
  esTipoMovimiento,
  leerEntero,
  textoDiferencia,
  textoExistencias,
  totalesReporteInventario,
  TIPO_MOVIMIENTO_LABEL,
} from "../../lib/domain/inventario.ts";
import {
  CONFIG_POR_DEFECTO,
  describirRegla,
  errorConfig,
  leerPorcentaje,
  ordenarLineas,
  sugerirParticipantes,
  sumaLineas,
  totalPropinas,
} from "../../lib/domain/propinas.ts";

let pasan = 0;
let fallan = 0;
function revisar(cond, nombre, detalle = "") {
  if (cond) pasan++;
  else fallan++;
  console.log(`${cond ? "PASA " : "FALLA"}  ${nombre}${!cond && detalle ? "  — " + detalle : ""}`);
}

console.log("== Inventario");
revisar(leerEntero(" 12 ") === 12 && leerEntero("0") === 0, "leerEntero acepta enteros con espacios");
revisar(leerEntero("1.5") === null && leerEntero("-3") === null && leerEntero("") === null && leerEntero("doce") === null, "leerEntero rechaza decimales, negativos, vacío y texto");
revisar(errorMovimiento({ tipo: "entrada", cantidad: "5" }) === null, "entrada de 5: lista");
revisar(errorMovimiento({ tipo: "entrada", cantidad: "0" }) !== null, "entrada de 0: falta");
revisar(errorMovimiento({ tipo: "entrada", cantidad: "100001" }) !== null, "entrada de más de 100,000: falta (igual que la base)");
revisar(errorMovimiento({ tipo: "merma", cantidad: "2", motivo: "" }) !== null, "merma sin motivo: falta");
revisar(errorMovimiento({ tipo: "merma", cantidad: "2", motivo: "Se rompió" }) === null, "merma con motivo: lista");
revisar(errorMovimiento({ tipo: "conteo", contado: "10", motivo: "", existencias: 10 }) === null, "conteo que cuadra no pide motivo");
revisar(errorMovimiento({ tipo: "conteo", contado: "8", motivo: "", existencias: 10 }) !== null, "conteo con diferencia sin motivo: falta");
revisar(errorMovimiento({ tipo: "conteo", contado: "0", motivo: "Se acabó", existencias: -3 }) === null, "conteo 0 con existencias negativas y motivo: listo");
revisar(textoDiferencia(0) === "Cuadra con el sistema" && textoDiferencia(2) === "Sobran 2" && textoDiferencia(-3) === "Faltan 3", "textoDiferencia");
revisar(bajoStock({ existencias: 3, existencias_minimas: 3 }) && !bajoStock({ existencias: 4, existencias_minimas: 3 }) && bajoStock({ existencias: -1, existencias_minimas: 0 }), "bajoStock en el mínimo, arriba y negativo");
revisar(textoExistencias({ existencias: -2 }).startsWith("Faltan 2") && textoExistencias({ existencias: 0 }) === "Agotado", "textoExistencias");
revisar(["alta", "ajuste", "venta", "anulacion", "entrada", "merma", "conteo"].every(esTipoMovimiento) && !esTipoMovimiento("robo"), "los 7 tipos de la bitácora tienen etiqueta (y nada más)");
revisar(Object.keys(TIPO_MOVIMIENTO_LABEL).length === 7, "7 etiquetas");
const filas = [
  { producto_id: "a", nombre: "A", categoria: "X", activo: true, vendidos: 3, vendido_centavos: "27000", anulados: 1, entradas: 0, mermas: 2, diferencias: 0, existencias: 2, existencias_minimas: 3 },
  { producto_id: "b", nombre: "B", categoria: "X", activo: true, vendidos: 0, vendido_centavos: 0, anulados: 0, entradas: 0, mermas: 0, diferencias: 0, existencias: 9, existencias_minimas: 1 },
  { producto_id: "c", nombre: "C", categoria: "X", activo: false, vendidos: 0, vendido_centavos: 0, anulados: 0, entradas: 5, mermas: 0, diferencias: -1, existencias: 0, existencias_minimas: 1 },
];
const t = totalesReporteInventario(filas);
revisar(t.vendidos === 3 && t.vendido_centavos === 27000 && t.anulados === 1 && t.entradas === 5 && t.mermas === 2, "totales del reporte (el bigint como texto se suma bien)", JSON.stringify(t));
revisar(t.bajos === 1, "bajos: solo productos activos", String(t.bajos));
revisar(conMovimiento(filas[0]) && !conMovimiento(filas[1]) && conMovimiento(filas[2]), "conMovimiento: ventas, nada, entradas/diferencias");

console.log("\n== Propinas");
const pagos = [
  { anulado: false, metodo: "tarjeta", propina_centavos: 200 },
  { anulado: true, metodo: "efectivo", propina_centavos: 999 },
  { anulado: false, metodo: "efectivo" },
];
const sueltas = [
  { anulado: false, metodo: "efectivo", monto_centavos: 300 },
  { anulado: true, metodo: "otro", monto_centavos: 5000 },
  { anulado: false, metodo: "efectivo", monto_centavos: "101" },
];
const tp = totalPropinas(pagos, sueltas);
revisar(tp.total === 601 && tp.porMetodo.efectivo === 401 && tp.porMetodo.tarjeta === 200 && tp.porMetodo.otro === 0, "totalPropinas: cobros + sueltas, sin anuladas (igual que el reporte de la base)", JSON.stringify(tp));
revisar(totalPropinas([], []).total === 0, "sin propinas: 0");
const pagosConId = [{ id: "p1", anulado: false, metodo: "tarjeta", propina_centavos: 5000 }, { id: "p2", anulado: false, metodo: "efectivo", propina_centavos: 200 }];
revisar(totalPropinas(pagosConId, [], new Set(["p1"])).total === 200 && totalPropinas(pagosConId, [], new Set(["p1"])).porMetodo.tarjeta === 0, "la propina de un cobro anulada sola no cuenta (el cobro sigue)");
revisar(totalPropinas(pagosConId, []).total === 5200, "sin anulaciones cuentan las dos");
revisar(errorConfig({ pct_personal: 70, pct_rp: 20, pct_casa: 10 }) === null, "70/20/10 vale");
revisar(errorConfig({ pct_personal: 70, pct_rp: 20, pct_casa: 20 })?.includes("suman 110"), "110 no vale (dice cuánto suma)");
revisar(errorConfig({ pct_personal: 100.5, pct_rp: -0.5, pct_casa: 0 }) !== null, "decimales o negativos no valen");
revisar(errorConfig(CONFIG_POR_DEFECTO) === null && CONFIG_POR_DEFECTO.pct_personal === 100, "la regla por defecto (100 % personal) es válida");
revisar(leerPorcentaje("70") === 70 && leerPorcentaje(" 0 ") === 0 && leerPorcentaje("101") === null && leerPorcentaje("7.5") === null, "leerPorcentaje");
revisar(describirRegla({ pct_personal: 70, pct_rp: 20, pct_casa: 10, incluye_gerente: true }) === "70 % al personal (con gerente) · 20 % al RP de la cuenta · 10 % a la casa", "describirRegla completa");
revisar(describirRegla(CONFIG_POR_DEFECTO) === "100 % al personal", "describirRegla por defecto");
revisar(JSON.stringify(sugerirParticipantes([{ id: "1", nombre: "A", rol: "staff", trabajo: true }, { id: "2", nombre: "B", rol: "staff", trabajo: false }])) === '["1"]', "sugerirParticipantes: solo quien trabajó");
const lineas = [
  { tipo: "casa", profile_id: null, nombre: "La casa", monto_centavos: 60 },
  { tipo: "personal", profile_id: "b", nombre: "Beto", monto_centavos: "220" },
  { tipo: "rp", profile_id: "r", nombre: "Rosa", monto_centavos: 100 },
  { tipo: "personal", profile_id: "a", nombre: "Ana", monto_centavos: 221 },
];
revisar(sumaLineas(lineas) === 601, "sumaLineas (montos como texto incluidos)");
revisar(ordenarLineas(lineas).map((l) => l.nombre).join() === "Ana,Beto,Rosa,La casa", "ordenarLineas: personal, RP y casa al final");

console.log(`\n${pasan} pasan, ${fallan} fallan`);
if (fallan) process.exitCode = 1;
