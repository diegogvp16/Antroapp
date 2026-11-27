// Pruebas de dominio de la revisión de RPs (lib/domain/fraude.ts): las
// estadísticas y validaciones que la base aplica en fraude_detectar. No
// toca la base.
//
//   node scripts/dev/probar-fraude-dominio.mjs
import { importarTs } from "./cargar-ts.mjs";

const f = await importarTs("../../lib/domain/fraude.ts", import.meta.url);
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${!ok && d ? "  — " + d : ""}`); };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Teléfonos (igual que telefono_mx_10)
nota("tel: 10 dígitos tal cual", f.normalizarTelefonoMx("5512345678") === "5512345678");
nota("tel: +52 1 con espacios y guiones", f.normalizarTelefonoMx("+52 1 55-1234-5678") === "5512345678");
nota("tel: 52 sin 1", f.normalizarTelefonoMx("52 (55) 1234.5678") === "5512345678");
nota("tel: con / al final", f.normalizarTelefonoMx("55 1234 5678/") === "5512345678");
nota("tel: con texto después", f.normalizarTelefonoMx("5512345678 x") === "5512345678");
nota("tel: con guiones bajos", f.normalizarTelefonoMx("55_1234_5678") === "5512345678");
nota("tel: 044", f.normalizarTelefonoMx("044 55 1234 5678") === "5512345678");
nota("tel: 045", f.normalizarTelefonoMx("045-55-1234-5678") === "5512345678");
nota("tel: 01", f.normalizarTelefonoMx("01 55 1234 5678") === "5512345678");
nota("tel: 1 + 10", f.normalizarTelefonoMx("1 55 1234 5678") === "5512345678");
nota("tel: 11 dígitos sin prefijo conocido → null", f.normalizarTelefonoMx("95512345678") === null);
nota("tel: 9 dígitos → null", f.normalizarTelefonoMx("551234567") === null);
nota("texto: enmascara teléfonos en notas", f.enmascararTexto("Le marqué al 55 1234-5678 y al +52 1 (33) 9876 5432") === "Le marqué al ******5678 y al ******5432");
nota("texto: no toca números cortos", f.enmascararTexto("Mesa 12, 3 personas, $1,500") === "Mesa 12, 3 personas, $1,500");
nota("tel: corto → null", f.normalizarTelefonoMx("12345") === null);
nota("tel: con letras → solo dígitos (8) → null", f.normalizarTelefonoMx("55-1234-ABCD") === null);
nota("tel: vacío → null", f.normalizarTelefonoMx(null) === null && f.normalizarTelefonoMx("") === null);
nota("máscara: solo 4 últimos", f.enmascararTelefono("5512345678") === "******5678");
nota("máscara: nulo", f.enmascararTelefono(null) === null);

// Mediana
nota("mediana impar", f.mediana([5, 1, 3]) === 3);
nota("mediana par: promedio de los de en medio", f.mediana([1, 2, 3, 10]) === 2.5);
nota("mediana vacía: null", f.mediana([]) === null);
nota("mediana no cambia el arreglo", (() => { const a = [3, 1, 2]; f.mediana(a); return igual(a, [3, 1, 2]); })());
// Caso de la prueba de base: 20 × $1,000, 5 × $50 y 1 × $6,000 → $1,000
const muestra = [...Array(20).fill(100000), ...Array(5).fill(5000), 600000];
nota("mediana de la muestra de la prueba de base = 100000", f.mediana(muestra) === 100000);

// Umbrales y clasificación
nota("redondeo mitad lejos del cero (como numeric)", f.redondear(2.5) === 3 && f.redondear(3.5) === 4 && f.redondear(-2.5) === -3);
nota("umbral bajo 20 % de 100000 = 20000", f.umbralBajo(100000, 20) === 20000);
nota("umbral bajo redondea (33 % de 1001 = 330.33 → 330)", f.umbralBajo(1001, 33) === 330);
nota("umbral bajo redondea .5 hacia arriba (50 % de 101 = 50.5 → 51)", f.umbralBajo(101, 50) === 51);
const u = { pct_bajo: 20, factor_alto: 5 };
nota("consumo 0: sin consumo (no cuenta como bajo)", f.clasificarConsumo(0, 100000, u) === "sin_consumo");
nota("consumo 5000: bajo", f.clasificarConsumo(5000, 100000, u) === "bajo");
nota("consumo justo en el umbral bajo: normal (es «menor a»)", f.clasificarConsumo(20000, 100000, u) === "normal");
nota("consumo 500000 (= 5×): normal (es «más de»)", f.clasificarConsumo(500000, 100000, u) === "normal");
nota("consumo 500001: alto", f.clasificarConsumo(500001, 100000, u) === "alto");

// Ventanas de tiempo (ráfaga)
const t0 = Date.UTC(2026, 9, 10, 5, 0, 0);
const cada30s = Array.from({ length: 8 }, (_, i) => t0 + i * 30_000);
nota("ráfaga: 8 reservas en 3.5 min caben en 10 min", f.maximoEnVentana(cada30s, 10) === 8);
nota("ráfaga: en 1 min caben 3", f.maximoEnVentana(cada30s, 1) === 3);
nota("ventana incluye el borde exacto", f.maximoEnVentana([t0, t0 + 10 * 60_000], 10) === 2);
nota("ventana: fuera por 1 ms", f.maximoEnVentana([t0, t0 + 10 * 60_000 + 1], 10) === 1);
nota("ventana: desordenados", f.maximoEnVentana([t0 + 120_000, t0, t0 + 60_000, t0 + 3_600_000], 5) === 3);
nota("ventana vacía: 0", f.maximoEnVentana([], 5) === 0);

// Semanas
nota("lunes de un miércoles", f.lunesDe("2026-10-07") === "2026-10-05");
nota("lunes de un domingo (semana lunes–domingo)", f.lunesDe("2026-10-11") === "2026-10-05");
nota("lunes de un lunes", f.lunesDe("2026-10-05") === "2026-10-05");

// Cliente repetido (mismos casos que la prueba de base)
const R = (id, fecha, rpId, telefono, creada = "2026-01-01T00:00:00Z") => ({ id, fecha, rpId, telefono, creada });
const reservas = [
  R("a1", "2026-10-01", "A", "+52 1 55 1234 0001"),
  R("a2", "2026-10-07", "B", "55-1234-0001"),
  R("b1", "2026-10-06", "A", "5512340002"),
  R("b2", "2026-10-08", "A", "5512340002"),
  R("c1", "2026-08-20", "A", "5512340003"),
  R("c2", "2026-10-08", "B", "5512340003"),
  R("d1", "2026-10-08", "B", "123"),
];
const a30 = f.alertasClienteRepetido(reservas, 30, 2);
nota("repetido: B llega 6 días después de A → 1 alerta (tel:B, 7/10)", a30.size === 1 && a30.get("5512340001:B") === "2026-10-07", JSON.stringify([...a30]));
nota("repetido: mismo RP dos veces → nada", ![...a30.keys()].some((k) => k.startsWith("5512340002")));
nota("repetido: 49 días entre RPs con ventana de 30 → nada", ![...a30.keys()].some((k) => k.startsWith("5512340003")));
nota("repetido: con ventana de 60 → sí", f.alertasClienteRepetido(reservas, 60, 2).get("5512340003:B") === "2026-10-08");
nota("repetido: con 3 RPs mínimos → nada", f.alertasClienteRepetido(reservas, 30, 3).size === 0);
nota("repetido: teléfono inválido se ignora", ![...a30.keys()].some((k) => k.startsWith("123")));
// Caso de la revisión: A 5/10, B 6/10 y B sigue cada semana → UNA alerta, no una por semana.
const semanal = [R("s1", "2026-10-05", "A", "5512349999"), R("s2", "2026-10-06", "B", "5512349999"),
  R("s3", "2026-10-14", "B", "5512349999"), R("s4", "2026-10-21", "B", "5512349999"), R("s5", "2026-10-28", "B", "5512349999")];
const sem = f.alertasClienteRepetido(semanal, 30, 2);
nota("repetido: el cliente que cambia de RP una vez da 1 alerta, no 4", sem.size === 1 && sem.get("5512349999:B") === "2026-10-06", JSON.stringify([...sem]));
const conC = f.alertasClienteRepetido([...semanal, R("s6", "2026-10-29", "C", "5512349999")], 30, 2);
nota("repetido: un RP nuevo (C) sí hace otra alerta", conC.size === 2 && conC.get("5512349999:C") === "2026-10-29");
const mismaNoche = f.alertasClienteRepetido([R("m1", "2026-10-05", "A", "5512348888", "2026-10-05T01:00:00Z"), R("m2", "2026-10-05", "B", "5512348888", "2026-10-05T02:00:00Z")], 30, 2);
nota("repetido: misma noche, solo el que llega después", mismaNoche.size === 1 && mismaNoche.has("5512348888:B"));
const vuelve = f.alertasClienteRepetido([R("v1", "2026-08-01", "A", "5512347777"), R("v2", "2026-08-02", "B", "5512347777"), R("v3", "2026-10-01", "B", "5512347777"), R("v4", "2026-10-02", "A", "5512347777")], 30, 2);
nota("repetido: tras más de «dias» sin verse, la vuelta cuenta como llegada (A y B, una vez cada uno)", vuelve.get("5512347777:B") === "2026-08-02" && vuelve.get("5512347777:A") === "2026-10-02", JSON.stringify([...vuelve]));

// Validación
nota("validar: valores correctos", f.validarParametros("rafaga", { min_reservas: 8, minutos: 10 }) === null);
nota("validar: fuera de rango", /entre 3 y 100/.test(f.validarParametros("rafaga", { min_reservas: 2 }) ?? ""));
nota("validar: decimal", /entero/.test(f.validarParametros("rafaga", { minutos: 2.5 }) ?? ""));
nota("validar: texto", /entero/.test(f.validarParametros("rafaga", { minutos: "10" }) ?? ""));
nota("validar: umbral de otra regla", /no existe/.test(f.validarParametros("rafaga", { dias: 3 }) ?? ""));
nota("defectos de consumo", igual(f.parametrosPorDefecto("consumo_atipico"), { pct_bajo: 20, min_cuentas_bajas: 3, factor_alto: 5, muestra_minima: 20, dias_referencia: 60 }));
nota("defectos dentro de sus límites", Object.values(f.CATALOGO_FRAUDE).every((r) => Object.values(r).every((p) => p.defecto >= p.min && p.defecto <= p.max)));
nota("nota corta rechazada", f.validarNota("  ok  ") !== null);
nota("nota de 5 aceptada", f.validarNota("12345") === null);
nota("nota de 1001 rechazada", f.validarNota("x".repeat(1001)) !== null);
nota("transiciones desde revisar", igual(f.transicionesDe("revisar"), ["descartada", "confirmada"]));
nota("transiciones desde descartada: reabrir", igual(f.transicionesDe("descartada"), ["revisar"]));
nota("explicación usa los umbrales del antro", f.explicarRegla("rafaga", { min_reservas: 12, minutos: 7 }).includes("12 o más reservas en 7 minutos"));
nota("explicación de cada regla", f.REGLAS_FRAUDE.every((r) => f.explicarRegla(r, f.parametrosPorDefecto(r)).length > 50));

const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length}`);
process.exit(ok === res.length ? 0 : 1);
