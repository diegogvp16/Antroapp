// Pruebas de lib/domain/cierre-noche.ts (normalizar y CSV del cierre de la
// noche). No toca ninguna base.
//
//   node scripts/dev/probar-cierre-noche-dominio.mjs

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createJiti } = createRequire(path.join(RAIZ, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": RAIZ } });
const d = await jiti.import(path.join(RAIZ, "lib/domain/cierre-noche.ts"));

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (!cond && detalle ? "  — " + detalle : ""));
}

// Lo que devuelve la base (con bigint como texto, como llega por PostgREST a veces).
const crudo = {
  club: { id: "c1", nombre: "Club Ñandú", zona_horaria: "America/Tijuana" },
  fecha: "2026-11-25", noche_en_curso: "2026-11-24", momento: "futura", termino: false,
  noche: { estado: "abierta", abierta_en: "2026-11-26T03:30:00+00:00", abierta_por_nombre: "Staff", cerrada_en: null, cerrada_por_nombre: null },
  reservas: { reservas: 40, personas: 205, entraron: 27, en_puerta: 0, consumieron: 24, entraron_sin_consumo: 3, no_llegaron: 0, por_llegar: 13, consumo_centavos: "16070000" },
  por_origen: [{ origen: "organica", reservas: 4 }, { origen: "rp", reservas: 36 }],
  consumo: { total_centavos: "16155000", con_reserva_centavos: 16070000, sin_reserva_centavos: 85000, cuentas_con_consumo: 25, renglones: 49, ticket_promedio_centavos: 646200 },
  walk_ins: { cuentas: 1, personas: 2 },
  cobros: { efectivo_centavos: 4777000, tarjeta_centavos: 7165500, otro_centavos: 0, total_centavos: 11942500, cobros: 16, por_cobrar_centavos: 4212500 },
  cuadre: null,
  anulaciones: { consumos: 1, consumos_centavos: 95000 },
  mesas: { mesas_antro: 12, mesas_usadas: 8, grupos: 11 },
  comisiones: { comisiones: 13, comisiones_en_cero: 4, comision_centavos: 155000, total_centavos: 155000 },
  rps: [{ rp_id: "r1", rp_nombre: "=HYPERLINK(\"x\")", rp_activo: true, reservas: 10, consumo_centavos: 5325000, comisiones_centavos: 75000 }],
  generado_en: "2026-11-25T03:38:32Z",
};
const rep = d.normalizarReporte(crudo);
revisar(rep.consumo.total_centavos === 16155000, "normalizar: montos en texto se vuelven número");
revisar(rep.walk_ins.consumo_centavos === 0 && rep.mesas.grupos_cuadrados === 0, "normalizar: lo que falta queda en 0");
revisar(rep.cuadre === null && rep.noche.estado === "abierta" && rep.momento === "futura", "normalizar: cuadre nulo y estados");
revisar(d.normalizarReporte(null).rps.length === 0 && d.normalizarReporte(null).noche.estado === "sin_caja", "normalizar: respuesta vacía no truena");
revisar(d.esParcial(rep) === true, "noche abierta sin terminar = parcial");
revisar(d.etiquetaEstado(rep) === "Abierta (noche en curso)", "etiqueta de noche abierta", d.etiquetaEstado(rep));
revisar(d.etiquetaEstado({ ...rep, noche: { ...rep.noche, estado: "cerrada" } }) === "Cerrada en caja", "etiqueta de noche cerrada");
revisar(d.etiquetaEstado({ ...rep, termino: true }) === "Abierta en caja (ya pasó su corte)", "etiqueta de noche que nadie cerró");
revisar(d.textoDiferencia(0, String) === "Cuadra" && d.textoDiferencia(-5000, String) === "Faltan 5000" && d.textoDiferencia(100, String) === "Sobran 100", "texto de la diferencia");

const csv = d.generarCsvCierre(rep);
revisar(csv.startsWith("﻿"), "CSV con BOM para Excel");
revisar(csv.includes("\r\n") && csv.endsWith("\r\n"), "CSV con fin de línea CRLF");
revisar(csv.includes("Consumo,Total en caja,161550.00"), "CSV: consumo en pesos con dos decimales");
revisar(csv.includes("Cobros,Por cobrar,42125.00"), "CSV: por cobrar");
revisar(csv.includes("Cuadre,Diferencia (contado − cobrado),Sin cuadre: la noche no se ha cerrado"), "CSV: sin cuadre lo dice");
revisar(csv.includes("Reservas,De RPs,36") && csv.includes("Reservas,Orgánicas,4"), "CSV: reservas por origen");
revisar(csv.includes(`"'=HYPERLINK(""x"")"`), "CSV: un nombre que empieza con = no se ejecuta como fórmula", csv.split("\r\n").at(-2));
revisar(csv.includes("Antro,Nombre,Club Ñandú"), "CSV: acentos y ñ tal cual");
const conCuadre = d.generarCsvCierre({ ...rep, cuadre: { registrado_centavos: 1, cobrado_efectivo_centavos: 0, cobrado_tarjeta_centavos: 0, cobrado_otro_centavos: 0, saldo_sin_cobrar_centavos: 0,
  contado_efectivo_centavos: 95000, contado_tarjeta_centavos: null, contado_otro_centavos: 0, diferencia_centavos: -5000, notas: "faltó, revisar", hecho_en: null, hecho_por_nombre: "Gerente" } });
revisar(conCuadre.includes("Cuadre,Diferencia (contado − cobrado),-50.00") && conCuadre.includes('Cuadre,Notas,"faltó, revisar"') && conCuadre.includes("Cuadre,Contado tarjeta,\r\n"), "CSV: cuadre con diferencia negativa, notas con coma y contado vacío");
revisar(!/telefono|cliente/i.test(csv), "CSV: sin columnas de clientes");

revisar(d.nombreArchivoCierre("Club Ñandú & Bar", "2026-11-25") === "cierre-club-nandu-bar-2026-11-25.csv", "nombre del archivo", d.nombreArchivoCierre("Club Ñandú & Bar", "2026-11-25"));
revisar(d.nombreArchivoCierre("", "x") === "cierre-antro-noche.csv", "nombre del archivo sin datos");
revisar(d.esFechaISO("2026-11-25") && !d.esFechaISO("2026-02-30") && !d.esFechaISO("25/11/2026") && !d.esFechaISO(null), "fecha de la URL");
revisar(d.esUuid("0de70000-0000-4000-8000-000000000001") && !d.esUuid("1; drop") && !d.esUuid(null), "antro de la URL");
revisar(d.horaEnZona("2026-11-26T03:30:00Z", "America/Mexico_City") === "21:30" && d.horaEnZona("2026-11-26T03:30:00Z", "America/Tijuana") === "19:30", "hora en la zona del antro");

console.log(`\n${pasan} pasan, ${fallan} fallan`);
if (fallan) process.exitCode = 1;
