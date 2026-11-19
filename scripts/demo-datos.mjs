// Regenera los datos demo de Club Demo alrededor de una noche objetivo.
//
// Uso:
//   node scripts/demo-datos.mjs                     (simulación, noche 2026-11-25)
//   node scripts/demo-datos.mjs --fecha=2026-11-25 --si   (escribe en la base)
//
// Qué hace:
//   1. Borra SOLO lo demo de Club Demo: reservas con teléfono 0000000… y sin
//      cliente_id (con sus consumos y comisiones), y turnos, asistencias,
//      comisiones individuales y pagos por día de las cuentas demo_*.
//      Nunca borra cuentas ni datos sin esa marca.
//   2. Carga la noche objetivo (40 reservas, 27 con entrada, mesa y consumo)
//      y las noches jue/vie/sáb de la semana anterior, para el rendimiento
//      semanal de los RPs.
//
// Noche operativa: corte a las 08:00 hora de la Ciudad de México. Una
// reserva vive en la fecha de su noche; los consumos de después de la
// medianoche (hasta las 03:30) siguen siendo de esa misma noche.
//
// Usa la service role key de .env.local; nunca imprime su valor.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createClient } = createRequire(join(RAIZ, "package.json"))("@supabase/supabase-js");
const env = Object.fromEntries(
  readFileSync(join(RAIZ, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CLUB_ID = "d2f531df-8116-442e-b967-4a1004fcd02e";
const CREDENCIALES = join(RAIZ, "backups", "2026-11-12-club-demo-credenciales.json");
const ZONA = "America/Mexico_City";
const MARCA_TEL = "0000000";

const args = process.argv.slice(2);
const ESCRIBIR = args.includes("--si");
const FECHA = (args.find((a) => a.startsWith("--fecha=")) ?? "--fecha=2026-11-25").slice(8);
if (!/^\d{4}-\d{2}-\d{2}$/.test(FECHA)) salir(`Fecha inválida: ${FECHA}`);

function salir(msg) {
  console.log(`ERROR: ${msg}`);
  process.exit(1);
}
const ok = (r, d) => {
  if (r.error) salir(`${d}: ${r.error.message}`);
  return r.data;
};

// ---------- Fechas (hora de la Ciudad de México) ----------
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const sumarDias = (iso, n) => {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const diaSemana = (iso) => {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
};
const etiqueta = (iso) => `${DIAS[diaSemana(iso)]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const partes = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
// Instante en que el reloj de la Ciudad de México marca esa fecha y hora.
// El desfase se toma de Intl (no se asume UTC-6 fijo).
function mx(fechaISO, hora, minuto = 0) {
  const [a, m, d] = fechaISO.split("-").map(Number);
  const deseado = Date.UTC(a, m - 1, d, hora, minuto);
  let t = deseado;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(partes.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
    t += deseado - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(t);
}
// Minutos desde las 22:30 de la noche -> instante (cruza la medianoche).
const enLaNoche = (noche, minDesde2230) => {
  const total = 22 * 60 + 30 + minDesde2230;
  return mx(total >= 1440 ? sumarDias(noche, 1) : noche, Math.floor((total % 1440) / 60), total % 60);
};
const AHORA = Date.now();
const nuncaFuturo = (d) => new Date(Math.min(d.getTime(), AHORA - 5 * 60 * 1000)).toISOString();

// Noche objetivo, su lunes y la semana anterior completa.
const lunesObjetivo = sumarDias(FECHA, diaSemana(FECHA) === 0 ? -6 : 1 - diaSemana(FECHA));
const lunesAnterior = sumarDias(lunesObjetivo, -7);
const nochesAnteriores = [3, 4, 5].map((n) => sumarDias(lunesAnterior, n)); // jue, vie, sáb

// ---------- Aleatorio reproducible ----------
let semilla = 20261125;
const azar = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;
const entre = (a, b) => Math.floor(a + azar() * (b - a + 1));
const elegir = (xs) => xs[Math.floor(azar() * xs.length)];

// ---------- Club ----------
const club = ok(await svc.from("clubs").select("id, nombre").eq("id", CLUB_ID).maybeSingle(), "club");
if (!club || club.nombre !== "Club Demo") salir("Club Demo no existe o cambió de nombre; no se toca nada.");
const mesas = ok(await svc.from("club_tables").select("id, numero").eq("club_id", CLUB_ID), "mesas")
  .sort((a, b) => Number(a.numero) - Number(b.numero));

// ---------- Cuentas demo_* ----------
const usuarios = [];
for (let pagina = 1; ; pagina++) {
  const { data, error } = await svc.auth.admin.listUsers({ page: pagina, perPage: 1000 });
  if (error) salir(`listUsers: ${error.message}`);
  usuarios.push(...data.users);
  if (data.users.length < 1000) break;
}
// Solo cuentas demo_* que además pertenezcan a Club Demo.
const candidatos = usuarios.filter((u) => u.email?.startsWith("demo_")).map((u) => u.id);
const demoIds = candidatos.length
  ? ok(await svc.from("profiles").select("id").eq("club_id", CLUB_ID).in("id", candidatos), "perfiles demo").map((p) => p.id)
  : [];

const REPARTO = [
  { clave: "mariana", nombre: "Mariana Ruiz", tel: "0000000101", tipo: "fijo", monto: 150 },
  { clave: "diego", nombre: "Diego Ramírez", tel: "0000000104", tipo: "porcentaje", monto: 10 },
  { clave: "valeria", nombre: "Valeria Cantú", tel: "0000000103", tipo: "fijo", monto: 200 },
  { clave: "luis", nombre: "Luis Herrera", tel: "0000000105", tipo: "porcentaje", monto: 8 },
  { clave: "fernanda", nombre: "Fernanda Ortiz", tel: "0000000106", tipo: "fijo", monto: 150 },
];
const faltan = REPARTO.filter((r) => !usuarios.some((u) => u.email === `demo_${r.clave}@example.com`));

// ---------- Inventario de lo demo a borrar ----------
const contarNoDemo = async () => {
  const { count, error } = await svc.from("reservations").select("id", { count: "exact", head: true })
    .eq("club_id", CLUB_ID).or(`cliente_telefono.is.null,cliente_telefono.not.like.${MARCA_TEL}*`);
  if (error) salir(`conteo no-demo: ${error.message}`);
  return count;
};
const noDemoAntes = await contarNoDemo();
const demoRes = ok(await svc.from("reservations").select("id, cliente_id")
  .eq("club_id", CLUB_ID).like("cliente_telefono", `${MARCA_TEL}%`), "reservas demo");
const conCliente = demoRes.filter((r) => r.cliente_id);
if (conCliente.length) console.log(`AVISO: ${conCliente.length} reserva(s) con teléfono demo tienen cliente_id; no se borran.`);
const borrarIds = demoRes.filter((r) => !r.cliente_id).map((r) => r.id);
const trozos = (xs, n = 100) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const TABLAS_RP = ["rp_schedule", "rp_attendance", "rp_comision_overrides", "rp_pagos_dia", "rp_dia_tarifa_overrides"];

console.log(`Noche objetivo: ${etiqueta(FECHA)} | semana anterior: ${etiqueta(lunesAnterior)} a ${etiqueta(sumarDias(lunesAnterior, 6))}`);
console.log(`Se borrarían: ${borrarIds.length} reservas demo (con sus consumos y comisiones) y los datos de ${demoIds.length} cuentas demo_* en ${TABLAS_RP.join(", ")}`);
if (faltan.length) console.log(`Cuentas por crear: ${faltan.map((f) => `demo_${f.clave}`).join(", ")}`);

// ---------- Generación (en memoria) ----------
const NOMBRES = ["Andrea", "Rodrigo", "Paulina", "Emilio", "Ximena", "Santiago", "Valentina", "Mauricio", "Regina", "Alejandro", "Camila", "Sebastián", "Daniela", "Héctor", "Sofía", "Iván", "Lucía", "Ricardo", "Natalia", "Óscar", "Renata", "Andrés", "Itzel", "Gerardo", "Paola", "Tomás", "Brenda", "Karla", "Fernando", "Montserrat", "Arturo", "Abril", "Melissa", "Hugo", "Alicia", "Rafael", "Diana", "César", "Julieta", "Joaquín", "Elena", "Marco"];
const APELLIDOS = ["Salazar", "Medina", "Garza", "Navarro", "Cortés", "Robles", "Ibarra", "Lara", "Fuentes", "Vega", "Rosales", "Ochoa", "Tapia", "Cárdenas", "Montes", "Delgado", "Luna", "Pineda", "Zúñiga", "Aguilar", "Ríos", "Guerrero", "Escobar", "Estrada", "Valdez", "Bravo", "Campos", "Solís", "Mendoza", "Carrillo", "Acosta", "Villarreal", "Meza", "Ruelas", "Peña", "Quintero"];
const combos = NOMBRES.flatMap((n) => APELLIDOS.map((a) => `${n} ${a}`));
for (let i = combos.length - 1; i > 0; i--) { const j = Math.floor(azar() * (i + 1)); [combos[i], combos[j]] = [combos[j], combos[i]]; }
let iNombre = 0, nTel = 200;
const MONTOS = [1200, 1650, 1800, 2200, 2400, 2900, 3200, 3600, 4200, 4800, 5500, 6400, 7800];

const reservas = [], consumos = [], comisiones = [], asistencias = [];
const resumen = {};
// rpIds se llena al escribir (o con ids ficticios en simulación).
const rpIds = {};

function cargarNoche(noche, reparto, entran) {
  const cuenta = {};
  let nMesa = 0;
  const trabajaron = new Set();
  resumen[noche] = { reservas: 0, entradas: 0, consumo: 0, comisiones: 0 };
  for (const origen of reparto) {
    cuenta[origen] = (cuenta[origen] ?? 0) + 1;
    const entro = cuenta[origen] <= entran[origen];
    const rp = REPARTO.find((r) => r.clave === origen);
    if (rp) trabajaron.add(origen);
    const creada = mx(sumarDias(noche, -entre(1, 5)), entre(10, 20), entre(0, 59));
    const r = {
      id: randomUUID(), cliente_nombre: combos[iNombre++ % combos.length],
      cliente_telefono: `${MARCA_TEL}${nTel++}`, personas: entre(2, 8),
      status: entro ? "usada" : azar() < 0.6 ? "confirmada" : "pendiente",
      source: rp ? "rp" : "organica", rp_id: rp ? rpIds[origen] : null, cliente_id: null,
      club_id: CLUB_ID, fecha: noche, qr_code: `antro-${randomUUID()}`,
      mesa_id: entro ? mesas[nMesa++ % mesas.length].id : null, created_at: nuncaFuturo(creada),
    };
    reservas.push(r);
    resumen[noche].reservas++;
    if (!entro) continue;
    resumen[noche].entradas++;
    // 1 a 3 cargos entre las 22:30 y las 03:30 (misma noche operativa).
    const cargos = entre(1, 3);
    let minuto = entre(0, 90), primero = 0, primerInstante = null;
    for (let k = 0; k < cargos; k++) {
      const monto = elegir(MONTOS);
      const instante = enLaNoche(noche, Math.min(minuto, 300));
      if (k === 0) { primero = monto; primerInstante = instante; }
      consumos.push({ reservation_id: r.id, monto, created_at: instante.toISOString() });
      resumen[noche].consumo += monto;
      minuto += entre(40, 100);
    }
    if (rp) {
      // Igual que la app hoy: la comisión se calcula con el primer cargo.
      const monto = rp.tipo === "fijo" ? rp.monto : Math.round((primero * rp.monto) / 100);
      comisiones.push({ reservation_id: r.id, rp_id: rpIds[origen], tipo: "rp", monto, status: "pendiente",
        created_at: new Date(primerInstante.getTime() + 60 * 1000).toISOString() });
      resumen[noche].comisiones += monto;
    }
  }
  let i = 0;
  for (const clave of trabajaron) {
    asistencias.push({ rp_id: rpIds[clave], club_id: CLUB_ID, fecha: noche, metodo: i % 2 ? "manual" : "qr",
      scanned_at: mx(noche, 21, entre(0, 59)).toISOString() });
    i++;
  }
}
const repartir = (n) => ({ mariana: n[0], diego: n[1], valeria: n[2], luis: n[3], fernanda: n[4], organica: n[5] });
const lista = (n) => ["mariana", "diego", "valeria", "luis", "fernanda", "organica"].flatMap((k, i) => Array(n[i]).fill(k));

function generar() {
  // Semana anterior: jue, vie y sáb.
  for (const noche of nochesAnteriores) {
    const tot = [entre(6, 9), entre(5, 7), entre(4, 6), entre(4, 6), entre(3, 5), entre(2, 4)];
    const ent = tot.map((t) => Math.round(t * (0.62 + azar() * 0.1)));
    cargarNoche(noche, lista(tot), repartir(ent));
  }
  // Noche objetivo: 40 reservas, 27 con entrada.
  cargarNoche(FECHA, lista([10, 8, 7, 6, 5, 4]), repartir([7, 6, 5, 4, 3, 2]));
}

if (!ESCRIBIR) {
  for (const r of REPARTO) rpIds[r.clave] = `simulado-${r.clave}`;
  generar();
  console.log(`Se crearían: ${reservas.length} reservas, ${consumos.length} consumos, ${comisiones.length} comisiones, ${asistencias.length} asistencias`);
  for (const n of Object.keys(resumen)) console.log(`  ${etiqueta(n)}: ${resumen[n].reservas} reservas, ${resumen[n].entradas} con entrada`);
  console.log("\nSimulación: no se escribió nada. Agrega --si para aplicar.");
  process.exit(0);
}

// ---------- Escritura ----------
// 1. Borrado de lo demo.
for (const ids of trozos(borrarIds)) {
  ok(await svc.from("consumption_entries").delete().in("reservation_id", ids), "borrar consumos");
  ok(await svc.from("commissions").delete().in("reservation_id", ids), "borrar comisiones");
  ok(await svc.from("reservations").delete().in("id", ids), "borrar reservas");
}
for (const t of TABLAS_RP) for (const ids of trozos(demoIds)) ok(await svc.from(t).delete().in("rp_id", ids), `borrar ${t}`);

// 2. Cuentas del reparto (se crean solo si faltan).
let creadas = 0;
for (const r of REPARTO) {
  const email = `demo_${r.clave}@example.com`;
  let u = usuarios.find((x) => x.email === email);
  if (!u) {
    let pass = env.DEMO_PASSWORD ?? process.env.DEMO_PASSWORD;
    if (!pass && existsSync(CREDENCIALES)) pass = JSON.parse(readFileSync(CREDENCIALES, "utf8")).password;
    if (!pass) salir(`Falta ${email} y no hay contraseña demo (DEMO_PASSWORD o backups).`);
    u = ok(await svc.auth.admin.createUser({ email, password: pass, email_confirm: true }), `crear ${email}`).user;
    creadas++;
    if (existsSync(CREDENCIALES)) {
      const cred = JSON.parse(readFileSync(CREDENCIALES, "utf8"));
      if (!cred.cuentas?.includes(email)) { cred.cuentas = [...(cred.cuentas ?? []), email]; writeFileSync(CREDENCIALES, JSON.stringify(cred, null, 2)); }
    }
  }
  ok(await svc.from("profiles").upsert({ id: u.id, nombre: r.nombre, telefono: r.tel, role: "rp", club_id: CLUB_ID, activo: true }), `perfil ${email}`);
  rpIds[r.clave] = u.id;
}

// 3. Comisión individual y turno fijo mié–sáb desde el lunes de la semana anterior.
ok(await svc.from("rp_comision_overrides").insert(REPARTO.map((r) => ({
  club_id: CLUB_ID, rp_id: rpIds[r.clave], comision_tipo: r.tipo, comision_monto: r.monto, comision_desbloqueo_reservas: 0,
}))), "comisiones individuales");
ok(await svc.from("rp_schedule").insert(REPARTO.map((r) => ({
  rp_id: rpIds[r.clave], club_id: CLUB_ID, fecha: lunesAnterior, es_fijo: true, dias_semana: [3, 4, 5, 6], fecha_inicio: lunesAnterior,
}))), "turnos");

// 4. Reservas, consumos, comisiones y asistencia.
generar();
for (const xs of trozos(reservas)) ok(await svc.from("reservations").insert(xs), "reservas");
for (const xs of trozos(consumos)) ok(await svc.from("consumption_entries").insert(xs), "consumos");
for (const xs of trozos(comisiones)) ok(await svc.from("commissions").insert(xs), "comisiones");
ok(await svc.from("rp_attendance").insert(asistencias), "asistencia");

// ---------- Resumen y verificación contra la base ----------
const pesos = (n) => `$${n.toLocaleString("es-MX")}`;
console.log(`\nBorradas: ${borrarIds.length} reservas demo anteriores. Cuentas creadas: ${creadas}.`);
let todoCuadra = true;
for (const noche of Object.keys(resumen)) {
  const r = resumen[noche];
  const enBase = ok(await svc.from("reservations").select("id, status").eq("club_id", CLUB_ID).eq("fecha", noche).like("cliente_telefono", `${MARCA_TEL}%`), "verificar");
  const ids = enBase.map((x) => x.id);
  let consumoBase = 0, comisionBase = 0;
  for (const t of trozos(ids)) {
    consumoBase += ok(await svc.from("consumption_entries").select("monto").in("reservation_id", t), "v consumos").reduce((s, c) => s + Number(c.monto), 0);
    comisionBase += ok(await svc.from("commissions").select("monto").in("reservation_id", t), "v comisiones").reduce((s, c) => s + Number(c.monto), 0);
  }
  const cuadra = enBase.length === r.reservas && enBase.filter((x) => x.status === "usada").length === r.entradas && consumoBase === r.consumo && comisionBase === r.comisiones;
  todoCuadra &&= cuadra;
  console.log(`${etiqueta(noche)}: ${r.reservas} reservas, ${r.entradas} con entrada, consumo ${pesos(r.consumo)}, comisiones ${pesos(r.comisiones)} ${cuadra ? "✓ coincide con la base" : "✗ NO coincide con la base"}`);
}
const noDemoDespues = await contarNoDemo();
console.log(`Reservas no-demo de Club Demo: antes ${noDemoAntes}, después ${noDemoDespues}${noDemoAntes === noDemoDespues ? " ✓" : " ✗"}`);
if (!todoCuadra || noDemoAntes !== noDemoDespues) process.exit(1);
