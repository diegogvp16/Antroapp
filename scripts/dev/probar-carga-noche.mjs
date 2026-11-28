// SOLO DEV. Prueba de carga de una noche realista de un club grande.
//
// Arma un antro propio ("Club Carga Dev <tag>", publicado, cuentas
// carga_<rol>_<tag>@example.com): 60 mesas, 15 RPs, 3 gerentes, 4 staff,
// dueño y admin; 4 semanas de historia (jueves a sábado, 500 reservas por
// noche, con caja cuadrada y comisiones) y la noche de hoy con 500 reservas,
// puerta, caja con varios grupos por mesa, cobros, anulaciones, reaperturas
// y cuadres, todo con las funciones reales de la base y las sesiones de cada
// rol. Mide 10 pantallas a 390×844 con CPU 4× mientras 3 gerentes y 4 staff
// operan a la vez, ensaya los cierres dentro de una transacción que se
// deshace (para comparar antes/después de un cambio), hace el cierre real
// por la API y revisa el cuadre al centavo (scripts/verificar-cuadre.mjs).
//
//   node scripts/dev/probar-carga-noche.mjs armar
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-carga-noche.mjs medir [--etiqueta=antes] [--repeticiones=8] [--base=http://localhost:3002]
//   node scripts/dev/probar-carga-noche.mjs ensayo [--etiqueta=antes]   (cierres en transacción deshecha)
//   node scripts/dev/probar-carga-noche.mjs estadisticas [--etiqueta=antes] (pg_stat_statements de la carga)
//   node scripts/dev/probar-carga-noche.mjs explicar [--etiqueta=antes] [--volumen-anio] [--con=<archivo.sql>]
//        (EXPLAIN ANALYZE como cada rol; --volumen-anio y --con solo viven dentro de la transacción)
//   node scripts/dev/probar-carga-noche.mjs equivalencia --con=<archivo.sql>  (mismas filas visibles por sesión)
//   node scripts/dev/probar-carga-noche.mjs cierre                       (cierre real por la API + cuadre)
//   node scripts/dev/probar-carga-noche.mjs limpiar
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-carga-noche.mjs todo   (armar, medir, ensayo, cierre y limpiar)
//
// La app tiene que ser el build de producción contra dev
// (node scripts/dev/servidor-prod-dev.mjs, puerto 3002): con `next dev` los
// tiempos salen 2–5× peores. Solo acepta una app en localhost.
// El estado (ids, correos y la contraseña temporal de las cuentas de prueba)
// queda en screenshots-carga-noche/estado.json (ignorado por Git) y se borra
// con `limpiar`. Las medidas quedan en screenshots-carga-noche/*.json.
// Se niega a correr contra producción: verificarEnvDev y conectarDevEscritura
// revisan que URL, llaves y conexión sean de antroapp-dev.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura, REF_PROD } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = req("@supabase/supabase-js");

const MODO = process.argv[2] ?? "todo";
const arg = (n, def = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? def;
const BASE = arg("base", "http://localhost:3002");
const ETIQUETA = arg("etiqueta", "antes");
const REPETICIONES = Number(arg("repeticiones", "8"));
const SEMANAS_HISTORIA = Number(arg("historia", "4"));
const SIN_CARGA = process.argv.includes("--sin-carga");
const VOLUMEN_ANIO = process.argv.includes("--volumen-anio");
const CON_SQL = arg("con");
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) || BASE.includes(REF_PROD)) {
  console.log("ABORTO: la app a medir debe ser local (build de producción contra dev).");
  process.exit(1);
}

const DIR = path.join(RAIZ, "screenshots-carga-noche");
mkdirSync(DIR, { recursive: true });
const ARCHIVO_ESTADO = path.join(DIR, "estado.json");
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};
const resumen = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: pct(xs, 100) });
const azar = (xs) => xs[Math.floor(Math.random() * xs.length)];

// Carta (precio en centavos).
const PRODUCTOS = [["Cerveza", 9000], ["Botella de tequila", 280000], ["Agua", 4000], ["Ronda de shots", 45000], ["Refresco", 5000], ["Botella de whisky", 320000], ["Cubeta", 60000], ["Mezcal", 18000], ["Botella de vodka", 240000], ["Bebida preparada", 14000]];
const MESAS = 60;
const RESERVAS_NOCHE = 500;
const N_RP = 15;

// ---------------------------------------------------------------- estado
function leerEstado() {
  if (!existsSync(ARCHIVO_ESTADO)) throw new Error("No hay escenario armado: corre primero `armar`.");
  return JSON.parse(readFileSync(ARCHIVO_ESTADO, "utf8"));
}
const guardarEstado = (e) => writeFileSync(ARCHIVO_ESTADO, JSON.stringify(e, null, 2));
const claves = () => ["dueno", "admin", "gerente1", "gerente2", "gerente3", "staff1", "staff2", "staff3", "staff4", ...Array.from({ length: N_RP }, (_, i) => `rp${String(i + 1).padStart(2, "0")}`)];
const rolDe = (k) => (k.startsWith("rp") ? "rp" : k.replace(/\d+$/, ""));

async function sesion(e, clave) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  ok(await c.auth.signInWithPassword({ email: e.usuarios[clave].email, password: e.pass }), "login " + clave);
  return c;
}

// Noche operativa del antro (zona del antro, corte 08:00) y su lunes.
async function nocheDe(clubId) {
  const db = await conectarDevEscritura();
  const [{ fecha }] = await db.q("select public.club_fecha_operacion($1)::text as fecha", [clubId]);
  await db.fin();
  const d = new Date(fecha + "T12:00:00Z");
  const lunes = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  return { fecha, lunes };
}

// ================================================================ ARMAR
async function armar() {
  if (existsSync(ARCHIVO_ESTADO)) throw new Error("Ya hay un escenario armado (screenshots-carga-noche/estado.json): corre `limpiar` primero.");
  const tag = "carga" + randomUUID().slice(0, 6);
  const e = { tag, pass: "Carga-" + randomUUID(), clubId: randomUUID(), usuarios: {}, creado: new Date().toISOString() };
  guardarEstado(e); // desde ya, para poder limpiar si algo falla a la mitad
  const t0 = Date.now();
  ok(await svc.from("clubs").insert({ id: e.clubId, nombre: `Club Carga Dev ${tag}`, direccion: "Av. Carga 500, Guadalajara", ciudad: "Guadalajara", horario: "22:00-05:00", suscripcion_activa: false }), "club");
  for (const k of claves()) {
    const email = `carga_${k}_${tag}@example.com`;
    const u = ok(await svc.auth.admin.createUser({ email, password: e.pass, email_confirm: true }), "crear " + k);
    const rol = rolDe(k);
    const nombre = rol === "rp" ? `RP Carga ${k.slice(2)}` : `${rol[0].toUpperCase()}${rol.slice(1)} Carga ${k.replace(/\D/g, "") || ""}`.trim();
    e.usuarios[k] = { id: u.user.id, email };
    guardarEstado(e);
    ok(await svc.from("profiles").upsert({ id: u.user.id, nombre, role: rol, club_id: rol === "admin" ? null : e.clubId, telefono: "0000000555", activo: true }), "perfil " + k);
  }
  ok(await svc.from("clubs").update({
    dueno_id: e.usuarios.dueno.id, estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true,
    pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 150, comision_desbloqueo_reservas: 3, deposito_monto: 300,
  }).eq("id", e.clubId), "publicar");
  const rps = claves().filter((k) => k.startsWith("rp")).map((k) => e.usuarios[k].id);
  // Tres RPs con tarifa propia (8 % del consumo, sin cuota).
  ok(await svc.from("rp_comision_overrides").insert(rps.slice(0, 3).map((rp) => ({ club_id: e.clubId, rp_id: rp, comision_tipo: "porcentaje", comision_monto: 8, comision_desbloqueo_reservas: 0 }))), "overrides");
  const mesas = ok(await svc.from("club_tables").insert(Array.from({ length: MESAS }, (_, i) => ({ club_id: e.clubId, numero: String(i + 1), capacidad: 6 + (i % 5) }))).select("id, numero"), "mesas");
  mesas.sort((a, b) => Number(a.numero) - Number(b.numero));
  const { fecha, lunes } = await nocheDe(e.clubId);
  Object.assign(e, { fecha, lunes, mesas: mesas.map((m) => m.id) });
  guardarEstado(e);
  // Turno fijo miércoles a sábado para todos los RPs.
  const inicio = new Date(new Date(lunes + "T12:00:00Z").getTime() - 7 * SEMANAS_HISTORIA * 864e5).toISOString().slice(0, 10);
  ok(await svc.from("rp_schedule").insert(rps.map((rp) => ({ rp_id: rp, club_id: e.clubId, fecha: inicio, es_fijo: true, dias_semana: [3, 4, 5, 6], fecha_inicio: inicio }))), "turnos");
  console.log(`Cuentas, mesas y reglas: ${Math.round((Date.now() - t0) / 1000)} s. Noche ${fecha} (semana del ${lunes}).`);

  // ---------- Historia: jueves a sábado de las semanas anteriores ----------
  const fechasHist = [];
  for (let w = 1; w <= SEMANAS_HISTORIA; w++) for (const d of [3, 4, 5]) fechasHist.push(new Date(new Date(lunes + "T12:00:00Z").getTime() + (d - 7 * w) * 864e5).toISOString().slice(0, 10));
  let t = Date.now();
  await historia(e, fechasHist, rps);
  console.log(`Historia: ${fechasHist.length} noches × ${RESERVAS_NOCHE} reservas con caja cuadrada, ${Math.round((Date.now() - t) / 1000)} s.`);

  // ---------- La noche de hoy ----------
  t = Date.now();
  const reservas = Array.from({ length: RESERVAS_NOCHE }, (_, i) => {
    const deRp = i % 7 !== 0; // ~86 % traídas por RP
    return {
      id: randomUUID(), cliente_nombre: `Cliente Carga ${String(i + 1).padStart(3, "0")}`, cliente_telefono: "5597" + String(100000 + i * 13).slice(-6),
      personas: 2 + (i % 5), status: "confirmada", source: deRp ? "rp" : "organica", rp_id: deRp ? rps[i % N_RP] : null, club_id: e.clubId, fecha,
      qr_code: `antro-${randomUUID()}`, created_at: new Date(Date.now() - (2 + (i % 40)) * 3600e3).toISOString(),
    };
  });
  for (let i = 0; i < reservas.length; i += 250) ok(await svc.from("reservations").insert(reservas.slice(i, i + 250)), "reservas de hoy");
  const S = await Promise.all([1, 2, 3, 4].map((n) => sesion(e, `staff${n}`)));
  const G = await Promise.all([1, 2, 3].map((n) => sesion(e, `gerente${n}`)));
  const lat = {};
  const llamar = async (c, fn, a) => {
    const t1 = performance.now();
    const r = await c.rpc(fn, a);
    (lat[fn] ??= []).push(performance.now() - t1);
    return ok(r, fn);
  };
  const enParalelo = async (tareas, n) => {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < tareas.length) await tareas[i++](); }));
  };
  // Asistencia de los 15 RPs (staff, como en el panel).
  for (const [i, rp] of rps.entries()) ok(await S[i % 4].from("rp_attendance").insert({ rp_id: rp, club_id: e.clubId, fecha, scanned_at: new Date().toISOString(), metodo: i % 3 ? "qr" : "manual", marcado_por: e.usuarios[`staff${(i % 4) + 1}`].id }), "asistencia");
  // Puerta: entran 300 de 500 ahora; de las otras 200, dos de cada tres llegan durante la medición.
  const entran = reservas.filter((_, i) => i % 5 !== 4 && i % 25 !== 3).slice(0, 300);
  await enParalelo(entran.map((r, i) => async () => {
    await llamar(S[i % 4], "puerta_escanear", { p_qr: r.qr_code });
    await llamar(S[i % 4], "puerta_confirmar_entrada", { p_reservation_id: r.id });
  }), 4);
  console.log(`Puerta: ${entran.length} entradas con 4 staff, ${Math.round((Date.now() - t) / 1000)} s.`);

  // Caja. Cada mesa: grupo 1 (2 reservas, ~5 consumos c/u, 2 cobros, cerrar y
  // cuadrar) y grupo 2 (2 reservas + walk-in cada tercera mesa, ~5 consumos
  // c/u, cobro parcial; queda abierto). Anulaciones, cobro anulado y
  // reaperturas en algunas mesas, como una noche real.
  t = Date.now();
  let k = 0;
  const siguiente = () => entran[k++];
  const conteo = { consumos: 0, pagos: 0, anulados: 0, pagos_anulados: 0, reaperturas: 0, cuadres: 0 };
  const consumir = async (s, cuenta, n, base) => {
    let total = 0;
    for (let j = 0; j < n; j++) {
      const [prod, precio] = PRODUCTOS[(base + j * 3) % PRODUCTOS.length];
      await llamar(s, "caja_registrar_consumo", { p_cuenta_id: cuenta, p_monto_centavos: precio, p_concepto: `1 × ${prod}`, p_clave: randomUUID() });
      total += precio;
      conteo.consumos++;
    }
    return total;
  };
  const tareas = mesas.map((m, i) => async () => {
    const s = S[i % 4];
    const g = G[i % 3];
    // Grupo 1.
    const ses1 = await llamar(s, "caja_abrir_mesa", { p_mesa_id: m.id });
    let total = 0;
    for (let c = 0; c < 2; c++) {
      const r = siguiente();
      const cuenta = await llamar(s, "caja_sentar_cliente", { p_sesion_id: ses1, p_reservation_id: r.id });
      total += await consumir(s, cuenta, 4 + ((i + c) % 3), i + c);
      if (i % 10 === 0 && c === 0) {
        // Se capturó doble: el gerente lo anula.
        const id = await llamar(s, "caja_registrar_consumo", { p_cuenta_id: cuenta, p_monto_centavos: 9000, p_concepto: "1 × Cerveza", p_clave: randomUUID() });
        conteo.consumos++;
        await llamar(g, "caja_anular_consumo", { p_consumo_id: id, p_motivo: "Se capturó doble" });
        conteo.anulados++;
      }
    }
    const mitad = Math.floor(total / 2);
    if (i % 15 === 0) {
      const malo = await llamar(s, "caja_registrar_pago", { p_sesion_id: ses1, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: mitad, p_clave: randomUUID(), p_saldo_esperado: total });
      await llamar(g, "caja_anular_pago", { p_pago_id: malo, p_motivo: "Terminal rechazó la tarjeta" });
      conteo.pagos++;
      conteo.pagos_anulados++;
    }
    await llamar(s, "caja_registrar_pago", { p_sesion_id: ses1, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: mitad, p_clave: randomUUID(), p_saldo_esperado: total });
    await llamar(s, "caja_registrar_pago", { p_sesion_id: ses1, p_cuenta_id: null, p_metodo: i % 4 ? "efectivo" : "otro", p_monto_centavos: total - mitad, p_clave: randomUUID(), p_saldo_esperado: total - mitad });
    conteo.pagos += 2;
    await llamar(g, "caja_cerrar_mesa", { p_sesion_id: ses1 });
    if (i % 20 === 7) {
      // Reabrir: pidieron otra ronda antes de irse.
      await llamar(g, "caja_reabrir_mesa", { p_sesion_id: ses1, p_motivo: "Pidieron otra ronda" });
      conteo.reaperturas++;
      const cuentas = ok(await svc.from("mesa_cuentas").select("id").eq("sesion_id", ses1).limit(1), "cuenta a reabrir");
      const extra = await consumir(s, cuentas[0].id, 1, i);
      await llamar(s, "caja_registrar_pago", { p_sesion_id: ses1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: extra, p_clave: randomUUID(), p_saldo_esperado: extra });
      conteo.pagos++;
      await llamar(g, "caja_cerrar_mesa", { p_sesion_id: ses1 });
    }
    await llamar(g, "caja_cuadrar_mesa", { p_sesion_id: ses1, p_notas: null });
    conteo.cuadres++;
    // Grupo 2: queda abierto.
    const ses2 = await llamar(s, "caja_abrir_mesa", { p_mesa_id: m.id });
    let total2 = 0;
    const nCuentas = i % 3 === 0 ? 3 : 2;
    for (let c = 0; c < nCuentas; c++) {
      const r = c < 2 ? siguiente() : null;
      const cuenta = r
        ? await llamar(s, "caja_sentar_cliente", { p_sesion_id: ses2, p_reservation_id: r.id })
        : await llamar(s, "caja_sentar_cliente", { p_sesion_id: ses2, p_cliente_nombre: `Grupo sin reserva ${i + 1}`, p_personas: 4 });
      total2 += await consumir(s, cuenta, 3 + ((i + c) % 3), i + c + 5);
    }
    await llamar(s, "caja_registrar_pago", { p_sesion_id: ses2, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: Math.floor(total2 * 0.4), p_clave: randomUUID(), p_saldo_esperado: total2 });
    conteo.pagos++;
  });
  await enParalelo(tareas, 7);
  const segundos = Math.round((Date.now() - t) / 1000);
  const latencias = Object.fromEntries(Object.entries(lat).map(([f, xs]) => [f, resumen(xs)]));
  e.armado = { segundos_caja: segundos, ...conteo, latencias };
  guardarEstado(e);
  console.log(`Caja: ${conteo.consumos} consumos (${conteo.anulados} anulados), ${conteo.pagos} cobros (${conteo.pagos_anulados} anulados), ${conteo.cuadres} cuadres, ${conteo.reaperturas} reaperturas; ${segundos} s con 4 staff y 3 gerentes.`);
  for (const [f, r] of Object.entries(latencias)) console.log(`  ${f.padEnd(26)} n=${String(r.n).padStart(4)}  p50 ${r.p50} ms  p95 ${r.p95} ms`);
  const db = await conectarDevEscritura();
  await db.q("analyze public.reservations; analyze public.caja_consumos; analyze public.caja_pagos; analyze public.mesa_cuentas; analyze public.mesa_sesiones; analyze public.commissions; analyze public.caja_eventos");
  await db.fin();
}

// Historia en SQL (como postgres, con el permiso de pruebas para la caja):
// noches cerradas y cuadradas, coherentes entre sí (caja = cuadres = comisiones).
async function historia(e, fechas, rps) {
  const db = await conectarDevEscritura();
  const g = e.usuarios.gerente1.id;
  const s = e.usuarios.staff1.id;
  const precios = PRODUCTOS.map((p) => p[1]);
  try {
    await db.q("begin");
    await db.q("set local statement_timeout = 0");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    await db.q(
      `insert into public.reservations (cliente_nombre, cliente_telefono, personas, status, source, rp_id, club_id, fecha, qr_code, created_at, puerta_estado, entrada_en)
       select 'Historia Carga ' || i, '5596' || lpad(((i * 37 + extract(doy from f)::int * 11) % 3000)::text, 6, '0'), 2 + i % 5,
              case when i % 25 < 18 then 'usada' else 'confirmada' end, case when i % 7 = 0 then 'organica' else 'rp' end,
              case when i % 7 = 0 then null else ($2::uuid[])[1 + i % ${N_RP}] end, $1, f, 'antro-' || gen_random_uuid(),
              (f + time '12:00') at time zone 'America/Mexico_City' - (i % 40) * interval '1 hour',
              case when i % 25 < 18 then 'entro' end,
              case when i % 25 < 18 then (f + time '23:00') at time zone 'America/Mexico_City' + (i % 180) * interval '1 minute' end
         from unnest($3::date[]) f cross join generate_series(1, ${RESERVAS_NOCHE}) i`,
      [e.clubId, rps, fechas],
    );
    await db.q(
      `insert into public.caja_noches (club_id, fecha_operacion, estado, abierta_por, abierta_en, cerrada_por, cerrada_en)
       select $1, f, 'cerrada', $2, (f + time '21:00') at time zone 'America/Mexico_City', $3, (f + 1 + time '05:30') at time zone 'America/Mexico_City'
         from unnest($4::date[]) f`,
      [e.clubId, s, g, fechas],
    );
    await db.q(
      `insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado, abierta_por, abierta_en, cerrada_por, cerrada_en, cuadrada_por, cuadrada_en)
       select $1, n.id, m.id, 'cuadrada', $2, (n.fecha_operacion + time '22:00') at time zone 'America/Mexico_City' + (k - 1) * interval '3 hours', $3,
              (n.fecha_operacion + time '22:00') at time zone 'America/Mexico_City' + (k - 1) * interval '3 hours' + interval '150 minutes', $3,
              (n.fecha_operacion + time '22:00') at time zone 'America/Mexico_City' + (k - 1) * interval '3 hours' + interval '160 minutes'
         from public.caja_noches n cross join unnest($4::uuid[]) m(id) cross join generate_series(1, 2) k
        where n.club_id = $1`,
      [e.clubId, s, g, e.mesas],
    );
    // 300 reservas con entrada se sientan (120 sesiones por noche) y 40 walk-ins.
    await db.q(
      `with ses as (select s.id, s.noche_id, s.abierta_en, row_number() over (partition by s.noche_id order by s.mesa_id, s.abierta_en) - 1 as k
                      from public.mesa_sesiones s where s.club_id = $1),
            res as (select r.*, n.id as noche_id, row_number() over (partition by r.fecha order by r.cliente_nombre) - 1 as k
                      from public.reservations r join public.caja_noches n on n.club_id = r.club_id and n.fecha_operacion = r.fecha
                     where r.club_id = $1 and r.puerta_estado = 'entro')
       insert into public.mesa_cuentas (club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_por, creada_en, liquidada_en)
       select $1, ses.id, res.id, case when res.source = 'rp' then res.rp_id end, 'reserva', res.cliente_nombre, res.personas, $2, ses.abierta_en + interval '5 minutes', ses.abierta_en + interval '160 minutes'
         from res join ses on ses.noche_id = res.noche_id and ses.k = res.k % 120
        where res.k < 300`,
      [e.clubId, s],
    );
    await db.q(
      `insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, personas, creada_por, creada_en, liquidada_en)
       select $1, s.id, 'walk_in', 'Walk-in historia', 4, $2, s.abierta_en + interval '10 minutes', s.abierta_en + interval '160 minutes'
         from (select s.*, row_number() over (partition by s.noche_id order by s.mesa_id, s.abierta_en) as k from public.mesa_sesiones s where s.club_id = $1) s
        where s.k % 3 = 0`,
      [e.clubId, s],
    );
    await db.q(
      `insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, monto_centavos, concepto, registrado_por, registrado_en)
       select $1, s.noche_id, s.id, s.mesa_id, c.id, c.reservation_id, ($3::bigint[])[1 + (abs(hashtext(c.id::text)) + j * 3) % ${precios.length}],
              'Consumo historia', $2, c.creada_en + j * interval '12 minutes'
         from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id
        cross join generate_series(1, 5) j
        where c.club_id = $1 and (j <= 4 or abs(hashtext(c.id::text)) % 2 = 0)`,
      [e.clubId, s, precios],
    );
    await db.q(
      `insert into public.caja_pagos (club_id, noche_id, sesion_id, metodo, monto_centavos, registrado_por, registrado_en)
       select $1, t.noche_id, t.sesion_id, x.metodo, x.monto, $2, t.cerrada_en - interval '5 minutes'
         from (select s.id as sesion_id, s.noche_id, s.cerrada_en, sum(k.monto_centavos) as total
                 from public.mesa_sesiones s join public.caja_consumos k on k.sesion_id = s.id
                where s.club_id = $1 group by s.id) t
        cross join lateral (values ('tarjeta', t.total / 2), ('efectivo', t.total - t.total / 2)) x(metodo, monto)
        where x.monto > 0`,
      [e.clubId, s],
    );
    await db.q(
      `insert into public.caja_cuadres (club_id, noche_id, sesion_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos, hecho_por, hecho_en)
       select $1, s.noche_id, s.id, 'mesa', coalesce(k.total, 0), coalesce(p.ef, 0), coalesce(p.ta, 0), 0, coalesce(k.total, 0) - coalesce(p.ef, 0) - coalesce(p.ta, 0), $2, s.cuadrada_en
         from public.mesa_sesiones s
         left join (select sesion_id, sum(monto_centavos) total from public.caja_consumos where club_id = $1 group by 1) k on k.sesion_id = s.id
         left join (select sesion_id, sum(monto_centavos) filter (where metodo = 'efectivo') ef, sum(monto_centavos) filter (where metodo = 'tarjeta') ta
                      from public.caja_pagos where club_id = $1 group by 1) p on p.sesion_id = s.id
        where s.club_id = $1`,
      [e.clubId, g],
    );
    await db.q(
      `insert into public.caja_cuadres (club_id, noche_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos,
                                        contado_efectivo_centavos, contado_tarjeta_centavos, contado_otro_centavos, diferencia_centavos, hecho_por, hecho_en)
       select $1, q.noche_id, 'noche', sum(q.registrado_centavos), sum(q.cobrado_efectivo_centavos), sum(q.cobrado_tarjeta_centavos), 0, 0,
              sum(q.cobrado_efectivo_centavos), sum(q.cobrado_tarjeta_centavos), 0, 0, $2, max(n.cerrada_en)
         from public.caja_cuadres q join public.caja_noches n on n.id = q.noche_id
        where q.club_id = $1 and q.tipo = 'mesa' group by q.noche_id`,
      [e.clubId, g],
    );
    await db.q(
      `with c as (select c.reservation_id, c.rp_id, c.liquidada_en, sum(k.monto_centavos) as base
                    from public.mesa_cuentas c join public.caja_consumos k on k.cuenta_id = c.id
                   where c.club_id = $1 and c.reservation_id is not null group by 1, 2, 3)
       insert into public.commissions (reservation_id, rp_id, tipo, monto, status, created_at, updated_at)
       select c.reservation_id, c.rp_id, 'rp', case when c.rp_id = any($2::uuid[]) then round(c.base * 8 / 100.0 / 100.0, 2) else 150 end, 'pendiente', c.liquidada_en, c.liquidada_en
         from c where c.rp_id is not null`,
      [e.clubId, rps.slice(0, 3)],
    );
    await db.q(
      `update public.reservations r set consumo_monto = round(x.base / 100.0, 2)
         from (select c.reservation_id, sum(k.monto_centavos) base from public.mesa_cuentas c join public.caja_consumos k on k.cuenta_id = c.id
                where c.club_id = $1 and c.reservation_id is not null group by 1) x
        where r.id = x.reservation_id`,
      [e.clubId],
    );
    // Bitácora de caja: un evento por consumo, como deja la caja real.
    await db.q(
      `insert into public.caja_eventos (club_id, noche_id, sesion_id, tipo, detalle, hecho_por, hecho_en)
       select club_id, noche_id, sesion_id, 'registrar_consumo', jsonb_build_object('consumo_id', id, 'monto', monto_centavos), registrado_por, registrado_en
         from public.caja_consumos where club_id = $1`,
      [e.clubId],
    );
    await db.q("commit");
  } catch (x) {
    await db.q("rollback").catch(() => {});
    throw x;
  } finally {
    await db.fin();
  }
}

// ================================================================ CARGA CONCURRENTE
// 4 staff y 3 gerentes operando a la vez sobre la noche abierta. El estado
// de cada mesa se lleva aquí (este proceso es el único que escribe en el
// antro), así que el cobro manda el saldo exacto, como la app.
// Se lee en SQL directo (no por PostgREST, que corta en 1,000 filas).
async function leerCaja(e) {
  const db = await conectarDevEscritura();
  const [noche] = await db.q("select id, estado from public.caja_noches where club_id = $1 and fecha_operacion = $2", [e.clubId, e.fecha]);
  const sesiones = await db.q("select id, mesa_id, estado from public.mesa_sesiones where noche_id = $1 and estado = 'abierta'", [noche.id]);
  const ids = sesiones.map((s) => s.id);
  const cuentas = await db.q("select id, sesion_id from public.mesa_cuentas where sesion_id = any($1::uuid[])", [ids]);
  const consumos = await db.q("select id, sesion_id, monto_centavos from public.caja_consumos where sesion_id = any($1::uuid[]) and not anulado", [ids]);
  const pagos = await db.q("select id, sesion_id, monto_centavos from public.caja_pagos where sesion_id = any($1::uuid[]) and not anulado", [ids]);
  const pendientes = await db.q("select id, qr_code from public.reservations where club_id = $1 and fecha = $2 and puerta_estado is null order by cliente_nombre", [e.clubId, e.fecha]);
  await db.fin();
  const porId = new Map(sesiones.map((s) => [s.id, { id: s.id, mesa: s.mesa_id, owner: e.mesas.indexOf(s.mesa_id) % 4, cuentas: [], consumos: [], pagos: [], registrado: 0, pagado: 0, ocupada: false }]));
  for (const c of cuentas) porId.get(c.sesion_id).cuentas.push(c.id);
  for (const k of consumos) { const s = porId.get(k.sesion_id); s.consumos.push({ id: k.id, monto: Number(k.monto_centavos) }); s.registrado += Number(k.monto_centavos); }
  for (const p of pagos) { const s = porId.get(p.sesion_id); s.pagos.push({ id: p.id, monto: Number(p.monto_centavos) }); s.pagado += Number(p.monto_centavos); }
  // De las que no han llegado, dos de cada tres llegan durante la medición; el resto no llega.
  return { nocheId: noche.id, estadoNoche: noche.estado, sesiones: porId, pendientes: pendientes.filter((_, i) => i % 3 !== 2) };
}

async function cargaConcurrente(e) {
  const S = await Promise.all([1, 2, 3, 4].map((n) => sesion(e, `staff${n}`)));
  const G = await Promise.all([1, 2, 3].map((n) => sesion(e, `gerente${n}`)));
  const caja = await leerCaja(e);
  const stats = { lat: {}, errores: {}, inicio: Date.now() };
  let parar = false;
  let grupos = 0;
  const reg = async (c, fn, a) => {
    const t = performance.now();
    const r = await c.rpc(fn, a);
    (stats.lat[fn] ??= []).push(performance.now() - t);
    if (r.error) {
      const clave = `${fn}: ${r.error.message.slice(0, 70)}`;
      stats.errores[clave] = (stats.errores[clave] ?? 0) + 1;
      return null;
    }
    return r.data ?? true;
  };
  const sesionesDe = (owner) => [...caja.sesiones.values()].filter((s) => (owner === null || s.owner === owner) && !s.ocupada);
  const producto = () => azar(PRODUCTOS);

  async function opStaff(i, c) {
    const mias = sesionesDe(i);
    const r = Math.random();
    if (r < 0.2 && caja.pendientes.length) {
      const res = caja.pendientes.shift();
      if (!(await reg(c, "puerta_escanear", { p_qr: res.qr_code }))) return;
      if (!(await reg(c, "puerta_confirmar_entrada", { p_reservation_id: res.id }))) return;
      const s = azar(mias);
      if (s && Math.random() < 0.7) {
        s.ocupada = true;
        const cuenta = await reg(c, "caja_sentar_cliente", { p_sesion_id: s.id, p_reservation_id: res.id });
        if (cuenta) s.cuentas.push(cuenta);
        s.ocupada = false;
      }
      return;
    }
    const s = azar(mias.filter((x) => x.cuentas.length));
    if (!s) return;
    s.ocupada = true;
    try {
      if (r < 0.85) {
        const [nombre, precio] = producto();
        const id = await reg(c, "caja_registrar_consumo", { p_cuenta_id: azar(s.cuentas), p_monto_centavos: precio, p_concepto: `1 × ${nombre}`, p_clave: randomUUID() });
        if (id) { s.consumos.push({ id, monto: precio }); s.registrado += precio; }
      } else {
        const saldo = s.registrado - s.pagado;
        if (saldo < 20000) return;
        const monto = Math.floor(saldo * 0.3);
        const id = await reg(c, "caja_registrar_pago", { p_sesion_id: s.id, p_cuenta_id: null, p_metodo: azar(["efectivo", "tarjeta", "tarjeta"]), p_monto_centavos: monto, p_clave: randomUUID(), p_saldo_esperado: saldo });
        if (id) { s.pagos.push({ id, monto }); s.pagado += monto; }
      }
    } finally {
      s.ocupada = false;
    }
  }

  async function opGerente(i, c) {
    const r = Math.random();
    if (r < 0.25) {
      const s = azar(sesionesDe(null).filter((x) => x.consumos.length && x.registrado - x.pagado > 10000));
      if (!s) return;
      const k = s.consumos.find((x) => x.monto <= s.registrado - s.pagado);
      if (!k) return;
      s.ocupada = true;
      if (await reg(c, "caja_anular_consumo", { p_consumo_id: k.id, p_motivo: "Se capturó doble" })) { s.consumos.splice(s.consumos.indexOf(k), 1); s.registrado -= k.monto; }
      s.ocupada = false;
    } else if (r < 0.35) {
      const s = azar(sesionesDe(null).filter((x) => x.pagos.length));
      if (!s) return;
      s.ocupada = true;
      const p = s.pagos[s.pagos.length - 1];
      if (await reg(c, "caja_anular_pago", { p_pago_id: p.id, p_motivo: "Cobro en la mesa equivocada" })) { s.pagos.pop(); s.pagado -= p.monto; }
      s.ocupada = false;
    } else if (r < 0.65) {
      // El gerente revisa cómo va la noche.
      await reg(c, "reporte_cierre_noche", { p_club_id: e.clubId, p_fecha: e.fecha });
    } else if (r < 0.8) {
      const [anio, semana] = semanaIso(e.fecha);
      await reg(c, "nomina_semana", { p_club_id: e.clubId, p_anio: anio, p_semana: semana });
    } else {
      // Rotar una mesa: cobra lo que falta, cierra, cuadra y el staff sienta al siguiente grupo.
      const s = azar(sesionesDe(null).filter((x) => x.cuentas.length && x.registrado > 0));
      if (!s) return;
      s.ocupada = true;
      await dormir(800); // que terminen las operaciones en vuelo de esa mesa
      const saldo = s.registrado - s.pagado;
      if (saldo > 0 && !(await reg(c, "caja_registrar_pago", { p_sesion_id: s.id, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: saldo, p_clave: randomUUID(), p_saldo_esperado: saldo }))) { s.ocupada = false; return; }
      s.pagado += Math.max(0, saldo);
      if (!(await reg(c, "caja_cerrar_mesa", { p_sesion_id: s.id }))) { s.ocupada = false; return; }
      if (!(await reg(c, "caja_cuadrar_mesa", { p_sesion_id: s.id, p_notas: null }))) { s.ocupada = false; return; }
      caja.sesiones.delete(s.id);
      const staff = S[s.owner];
      const nueva = await reg(staff, "caja_abrir_mesa", { p_mesa_id: s.mesa });
      if (!nueva) return;
      grupos++;
      const cuenta = await reg(staff, "caja_sentar_cliente", { p_sesion_id: nueva, p_cliente_nombre: `Grupo nuevo ${grupos}`, p_personas: 3 });
      caja.sesiones.set(nueva, { id: nueva, mesa: s.mesa, owner: s.owner, cuentas: cuenta ? [cuenta] : [], consumos: [], pagos: [], registrado: 0, pagado: 0, ocupada: false });
    }
  }

  // La caja abierta en cada teléfono revisa la firma de la noche cada 5 s.
  const firmar = async (c) => { while (!parar) { await reg(c, "caja_firma_noche", { p_club_id: e.clubId }); await dormir(5000); } };
  const actor = async (op, i, c) => { await dormir(Math.random() * 1000); while (!parar) { try { await op(i, c); } catch (x) { stats.errores[`excepción: ${x.message.slice(0, 60)}`] = (stats.errores[`excepción: ${x.message.slice(0, 60)}`] ?? 0) + 1; } await dormir(300 + Math.random() * 700); } };
  const vivos = [...S.map((c, i) => actor(opStaff, i, c)), ...G.map((c, i) => actor(opGerente, i, c)), ...[...S, ...G].map(firmar)];
  return {
    async detener() {
      parar = true;
      await Promise.all(vivos);
      const seg = (Date.now() - stats.inicio) / 1000;
      const escrituras = Object.entries(stats.lat).filter(([f]) => !/firma|reporte|nomina/.test(f)).reduce((a, [, xs]) => a + xs.length, 0);
      return {
        segundos: Math.round(seg), llamadas_por_segundo: +(Object.values(stats.lat).reduce((a, xs) => a + xs.length, 0) / seg).toFixed(1),
        escrituras_por_segundo: +(escrituras / seg).toFixed(1), grupos_nuevos: grupos,
        latencias: Object.fromEntries(Object.entries(stats.lat).map(([f, xs]) => [f, resumen(xs)])), errores: stats.errores,
      };
    },
  };
}

function semanaIso(fecha) {
  const d = new Date(fecha + "T12:00:00Z");
  const jueves = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * 864e5);
  const anio = jueves.getUTCFullYear();
  const primero = new Date(Date.UTC(anio, 0, 4));
  const semana = 1 + Math.round((jueves - primero) / 864e5 / 7 - (3 - ((primero.getUTCDay() + 6) % 7)) / 7);
  return [anio, semana];
}

// ================================================================ PANTALLAS
// Las 10 pantallas clave (ver docs/prueba-carga.md, «Por qué estas 10»).
// `listo`: lo que el usuario necesita ver para empezar a trabajar.
function pantallas(e, mesaLlena, nombreEnMesa) {
  return [
    { clave: "puerta", nombre: "Puerta / panel de staff (/staff/panel)", rol: "staff1", url: "/staff/panel", listo: (p) => p.getByText("Cliente Carga 500", { exact: false }).first() },
    { clave: "caja", nombre: "Caja: mapa de 60 mesas (/staff/caja)", rol: "staff1", url: "/staff/caja", listo: (p) => p.getByRole("button", { name: /^Mesa 60,/ }) },
    { clave: "mesa", nombre: "Caja: abrir una mesa con su cuenta", rol: "staff1", previa: "/staff/caja", previaListo: (p) => p.getByRole("button", { name: /^Mesa 60,/ }), accion: (p) => p.getByRole("button", { name: new RegExp(`^Mesa ${mesaLlena},`) }).click(), listo: (p) => p.getByText(nombreEnMesa).first(), volver: (p) => p.getByRole("button", { name: "Volver a las mesas" }).click() },
    { clave: "cuadre", nombre: "Caja: cuadre de la noche (gerente)", rol: "gerente1", previa: "/staff/caja", previaListo: (p) => p.getByRole("button", { name: /^Mesa 60,/ }), accion: (p) => p.getByRole("button", { name: "Cuadre de la noche" }).click(), listo: (p) => p.getByText(/Faltan \d+ mesas? por cuadrar|Cerrar la noche/).first() },
    { clave: "rp", nombre: "Panel del RP: reservas (/rp/panel)", rol: "rp04", url: "/rp/panel", listo: (p) => p.getByText(/^Cliente Carga \d+$/).first() },
    { clave: "nomina", nombre: "Nómina de la semana (/staff/nomina, gerente)", rol: "gerente1", url: "/staff/nomina", listo: (p) => p.getByText(/\d+ reservas entraron/).first() },
    { clave: "grupo", nombre: "Números del antro (/grupo, dueño)", rol: "dueno", url: "/grupo", listo: (p) => p.getByText("Consumo en caja").first() },
    { clave: "cierre", nombre: "Cierre de la noche (/grupo/noche, dueño)", rol: "dueno", url: `/grupo/noche?club=${e.clubId}&fecha=${e.fecha}`, listo: (p) => p.getByText("Estado de la noche").first() },
    { clave: "dueno", nombre: "Panel del dueño (/dueno/panel)", rol: "dueno", url: "/dueno/panel", listo: (p) => p.getByText("Antro verificado").first() },
    { clave: "admin", nombre: "Panel del admin (/admin)", rol: "admin", url: "/admin", listo: (p) => p.getByText(`Club Carga Dev ${e.tag}`).first() },
  ];
}
const DESTINO = { staff: /staff\/panel/, gerente: /staff\/panel/, rp: /rp\/panel/, dueno: /dueno\/panel/, admin: /admin/ };

async function cargarPlaywright() {
  try {
    return req("playwright");
  } catch {
    if (!process.env.PLAYWRIGHT_DESDE) {
      console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
      process.exit(1);
    }
    return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
  }
}

// Uso de CPU de la máquina que corre la prueba (para saber si hubo ruido).
function muestreoCpu() {
  const tomar = () => os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return { total: a.total + t, ocio: a.ocio + c.times.idle }; }, { total: 0, ocio: 0 });
  const muestras = [];
  let previo = tomar();
  const h = setInterval(() => { const a = tomar(); muestras.push(1 - (a.ocio - previo.ocio) / Math.max(1, a.total - previo.total)); previo = a; }, 2000);
  return () => { clearInterval(h); return { promedio_pct: Math.round((muestras.reduce((a, b) => a + b, 0) / Math.max(1, muestras.length)) * 100), max_pct: Math.round(Math.max(0, ...muestras) * 100), nucleos: os.cpus().length }; };
}

async function medir() {
  const e = leerEstado();
  const { chromium } = await cargarPlaywright();
  // La mesa con más consumos de la noche y un cliente sentado en ella.
  const db = await conectarDevEscritura();
  const [llena] = await db.q(
    `select t.numero, (select c.cliente_nombre from public.mesa_cuentas c where c.sesion_id = s.id order by c.creada_en limit 1) as nombre, count(k.*)::int as n
       from public.mesa_sesiones s join public.club_tables t on t.id = s.mesa_id join public.caja_noches n on n.id = s.noche_id
       left join public.caja_consumos k on k.sesion_id = s.id
      where n.club_id = $1 and n.fecha_operacion = $2 and s.estado = 'abierta' group by t.numero, s.id order by 3 desc limit 1`,
    [e.clubId, e.fecha],
  );
  const [vol] = await db.q(
    `select (select count(*) from public.reservations where club_id = $1 and fecha = $2)::int reservas,
            (select count(*) from public.caja_consumos k join public.caja_noches n on n.id = k.noche_id where n.club_id = $1 and n.fecha_operacion = $2)::int consumos,
            (select count(*) from public.caja_pagos k join public.caja_noches n on n.id = k.noche_id where n.club_id = $1 and n.fecha_operacion = $2)::int pagos,
            (select count(*) from public.mesa_sesiones k join public.caja_noches n on n.id = k.noche_id where n.club_id = $1 and n.fecha_operacion = $2)::int sesiones,
            (select count(*) from public.reservations where club_id = $1)::int reservas_total,
            (select count(*) from public.caja_consumos where club_id = $1)::int consumos_total`,
    [e.clubId, e.fecha],
  );
  await db.fin();
  console.log(`Volumen al empezar: ${JSON.stringify(vol)}; mesa más llena: ${llena.numero} (${llena.n} consumos)`);
  const defs = pantallas(e, llena.numero, llena.nombre);

  const navegador = await chromium.launch();
  const contextos = {};
  const resultado = { etiqueta: ETIQUETA, base: BASE, fecha: new Date().toISOString(), repeticiones: REPETICIONES, con_carga: !SIN_CARGA, volumen_inicio: vol, pantallas: {} };
  let carga = null;
  const cpu = muestreoCpu();
  try {
    // Una sesión de navegador por rol (login por la pantalla, como un usuario).
    for (const rol of [...new Set(defs.map((d) => d.rol))]) {
      const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const p = await ctx.newPage();
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", e.usuarios[rol].email);
      await p.fill("#password", e.pass);
      await p.click("button[type=submit]");
      await p.waitForURL(DESTINO[rolDe(rol)], { timeout: 90000 });
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      // Peticiones a Supabase (datos) en vuelo y terminadas.
      const red = { vuelo: 0, ultimo: 0, n: 0, bytes: 0 };
      const esDatos = (u) => u.startsWith(env.NEXT_PUBLIC_SUPABASE_URL);
      p.on("request", (r) => { if (esDatos(r.url())) red.vuelo++; });
      const fin = async (r, bien) => {
        if (!esDatos(r.url())) return;
        red.vuelo = Math.max(0, red.vuelo - 1);
        red.ultimo = Date.now();
        red.n++;
        if (bien) { const s = await r.sizes().catch(() => null); if (s) red.bytes += s.responseBodySize + s.responseHeadersSize; }
      };
      p.on("requestfinished", (r) => fin(r, true));
      p.on("requestfailed", (r) => fin(r, false));
      contextos[rol] = { ctx, p, red };
    }
    if (!SIN_CARGA) carga = await cargaConcurrente(e);
    await dormir(SIN_CARGA ? 0 : 3000);

    for (const d of defs) {
      const { p, red } = contextos[d.rol];
      const tiempos = [], datos = [], consultas = [], kb = [];
      let fallas = 0;
      for (let rep = 0; rep <= REPETICIONES; rep++) {
        try {
          if (d.previa) {
            await p.goto(BASE + d.previa);
            await d.previaListo(p).waitFor({ timeout: 90000 });
            await esperarRedQuieta(red, Date.now());
          }
          red.n = 0; red.bytes = 0;
          const t0 = Date.now();
          if (d.accion) await d.accion(p);
          else await p.goto(BASE + d.url);
          await d.listo(p).waitFor({ timeout: 90000 });
          const listo = Date.now() - t0;
          await esperarRedQuieta(red, t0);
          const conDatos = Math.max(listo, red.ultimo - t0);
          if (rep === 0) {
            await p.screenshot({ path: path.join(DIR, `${ETIQUETA}-${d.clave}.png`) });
            continue; // la primera calienta (caché del navegador y del servidor)
          }
          tiempos.push(listo); datos.push(conDatos); consultas.push(red.n); kb.push(red.bytes / 1024);
          if (d.volver) await d.volver(p).catch(() => {});
        } catch (x) {
          fallas++;
          console.log(`  ${d.clave} rep ${rep}: ${x.message.split("\n")[0].slice(0, 120)}`);
          await p.screenshot({ path: path.join(DIR, `${ETIQUETA}-${d.clave}-falla.png`) }).catch(() => {});
        }
      }
      resultado.pantallas[d.clave] = { nombre: d.nombre, listo_ms: resumen(tiempos), con_datos_ms: resumen(datos), consultas: pct(consultas, 50), kb: pct(kb, 50), fallas };
      const r = resultado.pantallas[d.clave];
      console.log(`${d.nombre.padEnd(48)} listo p50 ${r.listo_ms.p50} / p95 ${r.listo_ms.p95} ms · datos p50 ${r.con_datos_ms.p50} / p95 ${r.con_datos_ms.p95} ms · ${r.consultas} consultas, ${r.kb} KB${fallas ? ` · ${fallas} fallas` : ""}`);
    }
    // Lo que cuesta tener la caja abierta: la revisión periódica (cada 10 s)
    // vuelve a leer toda la noche si la firma cambió, y con 7 personas
    // operando cambia siempre. 60 s con la caja abierta en el teléfono del staff.
    {
      const { p, red } = contextos.staff1;
      await p.goto(BASE + "/staff/caja");
      await p.getByRole("button", { name: /^Mesa 60,/ }).waitFor({ timeout: 90000 });
      await esperarRedQuieta(red, Date.now());
      await p.evaluate(() => {
        window.__largas = [];
        new PerformanceObserver((l) => l.getEntries().forEach((x) => window.__largas.push(x.duration))).observe({ type: "longtask", buffered: false });
      });
      red.n = 0; red.bytes = 0;
      await dormir(60000);
      const largas = await p.evaluate(() => window.__largas.splice(0));
      resultado.caja_abierta_60s = {
        consultas: red.n, kb: Math.round(red.bytes / 1024), tareas_largas: largas.length,
        tarea_larga_max_ms: Math.round(Math.max(0, ...largas)), tareas_largas_total_ms: Math.round(largas.reduce((a, b) => a + b, 0)),
      };
      console.log(`Caja abierta 60 s (staff, CPU 4×): ${JSON.stringify(resultado.caja_abierta_60s)}`);
    }
  } finally {
    if (carga) resultado.carga = await carga.detener();
    resultado.cpu_maquina = cpu();
    await navegador.close();
  }
  if (resultado.carga) {
    console.log(`\nCarga concurrente: ${resultado.carga.segundos} s, ${resultado.carga.llamadas_por_segundo} llamadas/s (${resultado.carga.escrituras_por_segundo} escrituras/s), ${resultado.carga.grupos_nuevos} mesas rotadas.`);
    for (const [f, r] of Object.entries(resultado.carga.latencias)) console.log(`  ${f.padEnd(26)} n=${String(r.n).padStart(4)}  p50 ${r.p50} ms  p95 ${r.p95} ms  max ${r.max} ms`);
    if (Object.keys(resultado.carga.errores).length) console.log("  errores:", JSON.stringify(resultado.carga.errores));
  }
  console.log(`CPU de la máquina durante la medición: ${JSON.stringify(resultado.cpu_maquina)}`);
  writeFileSync(path.join(DIR, `medidas-${ETIQUETA}.json`), JSON.stringify(resultado, null, 2));
}

async function esperarRedQuieta(red, t0) {
  let quieta = Date.now();
  while (Date.now() - t0 < 60000) {
    if (red.vuelo > 0) quieta = Date.now();
    else if (Date.now() - quieta > 800) return;
    await dormir(50);
  }
}

// ================================================================ ENSAYO DE CIERRES
// Los cierres como los hace el gerente, directo en la base con su sesión
// (rol authenticated + sus claims, statement_timeout de 8 s como en
// Supabase), dentro de UNA transacción que al final se deshace: se puede
// repetir antes y después de un cambio de índices sobre los mismos datos.
async function comoRol(db, uid, sql, args = []) {
  await db.q("savepoint r");
  try {
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.q("set local role authenticated");
    await db.q("set local statement_timeout = '8s'");
    const t = performance.now();
    const filas = await db.q(sql, args);
    const ms = performance.now() - t;
    await db.q("reset role");
    await db.q("release savepoint r");
    return { filas, ms };
  } catch (x) {
    await db.q("rollback to savepoint r");
    await db.q("reset role");
    return { error: x.message, ms: null };
  }
}

async function ensayo({ rastrear = false, etiqueta = ETIQUETA } = {}) {
  const e = leerEstado();
  const db = await conectarDevEscritura();
  // Para `estadisticas`: que pg_stat_statements vea también lo de dentro de las funciones.
  if (rastrear) await db.q("set pg_stat_statements.track = 'all'");
  const G = e.usuarios.gerente1.id;
  const res = { etiqueta, fecha: new Date().toISOString() };
  const tiempos = {};
  const anotar = (k, r) => { if (r.ms !== null) (tiempos[k] ??= []).push(r.ms); else (res.errores ??= []).push(`${k}: ${r.error}`); return r; };
  try {
    await db.q("begin");
    const [n] = await db.q("select id, estado from public.caja_noches where club_id = $1 and fecha_operacion = $2", [e.clubId, e.fecha]);
    if (n.estado !== "abierta") throw new Error("La noche ya está cerrada: el ensayo necesita la noche abierta.");
    const abiertas = await db.q(
      `select s.id, coalesce((select sum(monto_centavos) from public.caja_consumos k where k.sesion_id = s.id and not anulado), 0)::bigint
                  - coalesce((select sum(monto_centavos) from public.caja_pagos p where p.sesion_id = s.id and not anulado), 0)::bigint as saldo
         from public.mesa_sesiones s where s.noche_id = $1 and s.estado = 'abierta'`, [n.id]);
    for (const s of abiertas) {
      const saldo = Number(s.saldo);
      if (saldo > 0) anotar("cobrar el saldo", await comoRol(db, G, "select public.caja_registrar_pago($1, null, 'tarjeta', $2, null, gen_random_uuid(), $2)", [s.id, saldo]));
      anotar("cerrar mesa", await comoRol(db, G, "select public.caja_cerrar_mesa($1)", [s.id]));
      anotar("cuadrar mesa", await comoRol(db, G, "select public.caja_cuadrar_mesa($1, null)", [s.id]));
    }
    const [tot] = await db.q("select coalesce(sum(monto_centavos) filter (where metodo='efectivo'),0)::bigint ef, coalesce(sum(monto_centavos) filter (where metodo='tarjeta'),0)::bigint ta, coalesce(sum(monto_centavos) filter (where metodo='otro'),0)::bigint ot from public.caja_pagos where noche_id = $1 and not anulado", [n.id]);
    anotar("cerrar la noche", await comoRol(db, G, "select public.caja_cerrar_noche($1, $2, $3, $4, 'Ensayo de carga')", [n.id, tot.ef, tot.ta, tot.ot]));
    const [anio, semana] = semanaIso(e.fecha);
    for (let i = 0; i < 5; i++) {
      anotar("reporte de cierre de la noche", await comoRol(db, G, "select public.reporte_cierre_noche($1, $2::date)", [e.clubId, e.fecha]));
      anotar("nómina de la semana", await comoRol(db, G, "select * from public.nomina_semana($1, $2, $3)", [e.clubId, anio, semana]));
      anotar("/grupo de la semana (dueño)", await comoRol(db, e.usuarios.dueno.id, "select * from public.grupo_resumen($1::date, $1::date + 6)", [e.lunes]));
      anotar("/grupo del mes (dueño)", await comoRol(db, e.usuarios.dueno.id, "select * from public.grupo_resumen($1::date - 27, $1::date + 6)", [e.lunes]));
      anotar("rendimiento por RP (semana)", await comoRol(db, G, "select * from public.grupo_rendimiento_rp($1, $2::date, $2::date + 6)", [e.clubId, e.lunes]));
      anotar("panel RP: mis reservas del mes", await comoRol(db, e.usuarios.rp04.id, "select * from public.rp_mis_reservas($1::date - 27, $1::date + 6)", [e.lunes]));
      anotar("panel RP: progreso de cuota", await comoRol(db, e.usuarios.rp04.id, "select public.rp_progreso_cuota()"));
      anotar("exportar consumos de la noche (1,000 filas)", await comoRol(db, G, "select * from public.reporte_consumos($1, $2::date, $2::date, null, 1000)", [e.clubId, e.fecha]));
      anotar("exportar reservas de la noche", await comoRol(db, G, "select * from public.reporte_reservas($1, $2::date, $2::date, null, 1000)", [e.clubId, e.fecha]));
      anotar("exportar comisiones del mes", await comoRol(db, G, "select * from public.reporte_comisiones($1, $2::date - 27, $2::date + 6, null, 1000)", [e.clubId, e.lunes]));
    }
    res.mesas_cuadradas = abiertas.length;
  } finally {
    await db.q("rollback").catch(() => {});
    const [n] = await db.q("select estado from public.caja_noches where club_id = $1 and fecha_operacion = $2", [e.clubId, e.fecha]);
    res.noche_sigue_abierta = n?.estado === "abierta";
    await db.fin();
  }
  res.tiempos = Object.fromEntries(Object.entries(tiempos).map(([k, xs]) => [k, resumen(xs)]));
  for (const [k, r] of Object.entries(res.tiempos)) console.log(`${k.padEnd(46)} n=${String(r.n).padStart(3)}  p50 ${r.p50} ms  p95 ${r.p95} ms  max ${r.max} ms`);
  if (res.errores) console.log("Errores:", res.errores.slice(0, 10));
  console.log(`Todo se deshizo (la noche sigue abierta): ${res.noche_sigue_abierta}`);
  writeFileSync(path.join(DIR, `ensayo-${etiqueta}.json`), JSON.stringify(res, null, 2));
}

// ================================================================ ESTADÍSTICAS
// Qué sentencias pesan de verdad, incluidas las de dentro de las funciones:
// pg_stat_statements con track = 'all' solo en esta sesión. Corre el ensayo
// de cierres y las lecturas de las pantallas como cada rol (en transacción
// que se deshace) y compara las estadísticas antes y después.
async function estadisticas() {
  const e = leerEstado();
  const db = await conectarDevEscritura();
  const foto = async () => new Map((await db.q(`select queryid::text id, calls::bigint, total_exec_time, shared_blks_hit + shared_blks_read as bloques, rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 400) q
                                                 from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())`)).map((r) => [r.id, r]));
  await db.q("set pg_stat_statements.track = 'all'");
  const antes = await foto();
  const S = e.usuarios.staff1.id;
  try {
    await db.q("begin");
    const [n] = await db.q("select id from public.caja_noches where club_id = $1 and fecha_operacion = $2", [e.clubId, e.fecha]);
    for (let i = 0; i < 5; i++) {
      // Lo que leen las pantallas (mismas consultas que manda la app).
      await comoRol(db, S, "select * from public.reservations where fecha = $2 and club_id = $1 order by created_at desc", [e.clubId, e.fecha]);
      await comoRol(db, S, "select id, cliente_nombre, personas, source, rp_id from public.reservations where club_id = $1 and fecha = $2 and (status = 'usada' or puerta_estado = 'entro') order by cliente_nombre", [e.clubId, e.fecha]);
      await comoRol(db, S, "select * from public.caja_consumos where noche_id = $1 order by registrado_en, id", [n.id]);
      await comoRol(db, S, "select * from public.caja_pagos where noche_id = $1 order by registrado_en, id", [n.id]);
      await comoRol(db, S, "select * from public.mesa_sesiones where noche_id = $1 order by abierta_en, id", [n.id]);
      await comoRol(db, S, "select c.* from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id where s.noche_id = $1 order by c.creada_en, c.id", [n.id]);
      await comoRol(db, S, "select public.caja_firma_noche($1)", [e.clubId]);
      await comoRol(db, S, "select public.caja_mis_permisos($1)", [e.clubId]);
      await comoRol(db, e.usuarios.admin.id, "select id, club_id, fecha, status, source, consumo_monto, created_at from public.reservations where created_at >= now() - interval '30 days'");
      await comoRol(db, e.usuarios.admin.id, "select * from public.commissions where created_at >= now() - interval '30 days'");
    }
  } finally {
    await db.q("rollback").catch(() => {});
  }
  await db.q("reset pg_stat_statements.track");
  await db.fin();
  // El ensayo de cierres (en su propia sesión) también con track = 'all'.
  await ensayo({ rastrear: true, etiqueta: `${ETIQUETA}-estadisticas` });
  const db3 = await conectarDevEscritura();
  const despues = new Map((await db3.q(`select queryid::text id, calls::bigint, total_exec_time, shared_blks_hit + shared_blks_read as bloques, rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 400) q
                                          from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())`)).map((r) => [r.id, r]));
  await db3.fin();
  const dif = [];
  for (const [id, r] of despues) {
    const a = antes.get(id);
    const calls = Number(r.calls) - Number(a?.calls ?? 0);
    if (calls <= 0) continue;
    const ms = r.total_exec_time - (a?.total_exec_time ?? 0);
    dif.push({ ms: +ms.toFixed(1), calls, ms_por_llamada: +(ms / calls).toFixed(2), bloques_por_llamada: Math.round((Number(r.bloques) - Number(a?.bloques ?? 0)) / calls), filas_por_llamada: Math.round((Number(r.rows) - Number(a?.rows ?? 0)) / calls), q: r.q });
  }
  dif.sort((a, b) => b.ms - a.ms);
  console.log("Sentencias que más tiempo sumaron (incluye las de dentro de funciones):");
  for (const d of dif.slice(0, 25)) console.log(`${String(d.ms).padStart(9)} ms  ${String(d.calls).padStart(5)}×  ${String(d.ms_por_llamada).padStart(8)} ms/llamada  ${String(d.bloques_por_llamada).padStart(7)} bloques/llamada  ${d.q.slice(0, 160)}`);
  writeFileSync(path.join(DIR, `estadisticas-${ETIQUETA}.json`), JSON.stringify(dif.slice(0, 80), null, 2));
}

// ================================================================ EXPLICAR
// EXPLAIN (ANALYZE, BUFFERS) de las consultas que mandan las pantallas,
// como el rol que las manda (RLS incluida), en transacción que se deshace.
// Las de dentro de funciones SECURITY DEFINER corren sin RLS (como su dueño).
async function explicar() {
  const e = leerEstado();
  const db = await conectarDevEscritura();
  const salida = [];
  const hace30 = new Date(Date.now() - 30 * 864e5);
  const fecha30 = hace30.toISOString().slice(0, 10);
  const U = (k) => e.usuarios[k].id;
  try {
    await db.q("begin");
    await db.q("set local statement_timeout = 0");
    if (VOLUMEN_ANIO) {
      // Un año de historia más (300 noches × 500 reservas antes de la historia
      // armada, con comisión en 6 de cada 10), solo dentro de esta transacción.
      const t = Date.now();
      const rps = claves().filter((k) => k.startsWith("rp")).map((k) => e.usuarios[k].id);
      await db.q(
        `insert into public.reservations (cliente_nombre, cliente_telefono, personas, status, source, rp_id, club_id, fecha, qr_code, created_at, puerta_estado, entrada_en, consumo_monto)
         select 'Año Carga ' || i, '5595' || lpad((i % 9000)::text, 6, '0'), 2, case when i % 10 < 7 then 'usada' else 'confirmada' end,
                case when i % 7 = 0 then 'organica' else 'rp' end, case when i % 7 = 0 then null else ($2::uuid[])[1 + i % ${N_RP}] end, $1, f,
                'antro-' || gen_random_uuid(), (f + time '12:00') at time zone 'America/Mexico_City',
                case when i % 10 < 7 then 'entro' end, case when i % 10 < 7 then (f + time '23:30') at time zone 'America/Mexico_City' end,
                case when i % 10 < 6 then 1500 end
           from generate_series($3::date - 300 - 7 * ${SEMANAS_HISTORIA}, $3::date - 1 - 7 * ${SEMANAS_HISTORIA}, interval '1 day') f cross join generate_series(1, ${RESERVAS_NOCHE}) i`,
        [e.clubId, rps, e.lunes],
      );
      await db.q(
        `insert into public.commissions (reservation_id, rp_id, tipo, monto, status, created_at, updated_at)
         select r.id, r.rp_id, 'rp', 150, 'pagada', r.entrada_en + interval '3 hours', r.entrada_en + interval '3 hours'
           from public.reservations r where r.club_id = $1 and r.cliente_nombre like 'Año Carga %' and r.rp_id is not null and r.consumo_monto is not null`,
        [e.clubId],
      );
      await db.q("analyze public.reservations; analyze public.commissions");
      const [c] = await db.q("select (select count(*) from public.reservations)::int reservas, (select count(*) from public.commissions)::int comisiones");
      console.log(`Volumen de un año (solo en esta transacción): ${JSON.stringify(c)} en toda la base, ${Math.round((Date.now() - t) / 1000)} s.`);
      salida.push(`Volumen de un año (solo en la transacción): ${JSON.stringify(c)}\n`);
    }
    if (CON_SQL) {
      // La propuesta, aplicada solo dentro de esta transacción.
      const texto = readFileSync(path.resolve(RAIZ, CON_SQL), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
      await db.q(texto);
      await db.q("analyze public.reservations; analyze public.commissions");
      console.log(`Con ${CON_SQL} (solo en esta transacción).`);
      salida.push(`Con ${CON_SQL} aplicado (solo en la transacción).\n`);
    }
    const [n] = await db.q("select id from public.caja_noches where club_id = $1 and fecha_operacion = $2", [e.clubId, e.fecha]);
    const consultas = [
      ["Puerta (/staff/panel): reservas de la noche, como staff", U("staff1"), "select * from public.reservations where fecha = $2 and club_id = $1 order by created_at desc", [e.clubId, e.fecha]],
      ["Caja: reservas con entrada, como staff", U("staff1"), "select id, cliente_nombre, personas, source, rp_id from public.reservations where club_id = $1 and fecha = $2 and (status = 'usada' or puerta_estado = 'entro') order by cliente_nombre", [e.clubId, e.fecha]],
      ["Caja: consumos de la noche, como staff", U("staff1"), "select * from public.caja_consumos where noche_id = $1 order by registrado_en, id", [n.id]],
      ["Admin: reservas de 30 días (dashboard)", U("admin"), "select id, club_id, source from public.reservations where fecha >= $1", [fecha30]],
      ["Admin: reservas usadas de 30 días con sus consumos (alertas)", U("admin"), "select r.club_id, r.source, (select coalesce(json_agg(json_build_object('id', ce.id)), '[]') from public.consumption_entries ce where ce.reservation_id = r.id) as ce from public.reservations r where r.status = 'usada' and r.fecha >= $1", [fecha30]],
      ["Admin: comisiones de 30 días", U("admin"), "select tipo, monto, status from public.commissions where created_at >= $1", [hace30.toISOString()]],
      ["Gerente: comisiones del antro (lectura directa)", U("gerente1"), "select c.* from public.commissions c join public.reservations r on r.id = c.reservation_id where r.club_id = $1 and r.fecha between $2::date and $2::date + 6", [e.clubId, e.lunes]],
      ["Cuadrar: conteo semanal de comisiones del RP (dentro de caja_liquidar_cuenta)", null, "select count(*) from public.commissions c join public.reservations r on r.id = c.reservation_id where c.tipo = 'rp' and c.rp_id = $1 and r.club_id = $2 and c.status <> 'anulada' and r.fecha between $3::date and $3::date + 6", [U("rp05"), e.clubId, e.lunes]],
      ["Funciones: /grupo del mes (dueño)", U("dueno"), "select * from public.grupo_resumen($1::date - 27, $1::date + 6)", [e.lunes]],
      ["Funciones: reporte de cierre de la noche (gerente)", U("gerente1"), "select public.reporte_cierre_noche($1, $2::date)", [e.clubId, e.fecha]],
      ["Funciones: panel RP, mis reservas del mes", U("rp04"), "select * from public.rp_mis_reservas($1::date - 27, $1::date + 6)", [e.lunes]],
      ["Funciones: nómina de la semana (gerente)", U("gerente1"), "select * from public.nomina_semana($1, $2, $3)", [e.clubId, ...semanaIso(e.fecha)]],
      ["Funciones: firma de la noche (staff)", U("staff1"), "select public.caja_firma_noche($1)", [e.clubId]],
    ];
    for (const [titulo, uid, sql, args] of consultas) {
      await db.q("savepoint x");
      if (uid) {
        await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
        await db.q("set local role authenticated");
      }
      try {
        await db.q(sql, args); // calentar caché
        const plan = (await db.q(`explain (analyze, buffers) ${sql}`, args)).map((r) => r["QUERY PLAN"]).join("\n");
        salida.push(`### ${titulo}\n${sql}\n\n${plan}\n`);
        const tiempo = plan.match(/Execution Time: ([\d.]+) ms/)?.[1];
        const bloques = [...plan.matchAll(/Buffers: shared hit=(\d+)/g)][0]?.[1];
        console.log(`${titulo.padEnd(78)} ${String(tiempo).padStart(9)} ms  ${String(bloques ?? "?").padStart(7)} bloques`);
      } catch (x) {
        salida.push(`### ${titulo}\nERROR: ${x.message}\n`);
        console.log(`${titulo}: ERROR ${x.message}`);
      }
      await db.q("rollback to savepoint x");
      await db.q("reset role");
    }
  } finally {
    await db.q("rollback").catch(() => {});
    await db.fin();
  }
  writeFileSync(path.join(DIR, `explicar-${ETIQUETA}.txt`), salida.join("\n"));
}

// ================================================================ EQUIVALENCIA
// Que un cambio de políticas (--con=<archivo>) no cambie quién ve qué: por
// cada sesión (los roles del antro de prueba, los usuarios ficticios de dev,
// una cuenta sin perfil, una con contraseña temporal y anon) compara la
// huella de las filas visibles de reservas, comisiones y consumos antes y
// después, todo en una transacción que se deshace.
async function equivalencia() {
  const e = leerEstado();
  if (!CON_SQL) throw new Error("Falta --con=<archivo.sql> con el cambio a comparar.");
  const db = await conectarDevEscritura();
  const sesiones = Object.entries(e.usuarios).filter(([k]) => ["dueno", "admin", "gerente1", "staff1", "rp01", "rp04"].includes(k)).map(([k, u]) => [k, { sub: u.id, role: "authenticated" }]);
  for (const u of await db.q(`select u.id, u.email from auth.users u join public.profiles p on p.id = u.id where u.email like 'dev\\_%@example.com' order by 1 limit 12`))
    sesiones.push([u.email.split("@")[0], { sub: u.id, role: "authenticated" }]);
  sesiones.push(["sin perfil", { sub: randomUUID(), role: "authenticated" }]);
  sesiones.push(["contraseña temporal (gerente1)", { sub: e.usuarios.gerente1.id, role: "authenticated", app_metadata: { debe_cambiar: true } }]);
  sesiones.push(["anon", { role: "anon" }]);
  const tablas = ["reservations", "commissions", "consumption_entries"];
  const huellas = async () => {
    const r = {};
    for (const [nombre, claims] of sesiones) {
      await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await db.q(`set local role ${claims.role}`);
      for (const t of tablas) {
        const [h] = await db.q(`select count(*)::int n, coalesce(md5(string_agg(id::text, ',' order by id)), '-') h from public.${t}`);
        r[`${nombre} · ${t}`] = `${h.n}:${h.h}`;
      }
      await db.q("reset role");
    }
    return r;
  };
  let iguales = 0;
  const distintas = [];
  try {
    await db.q("begin");
    await db.q("set local statement_timeout = 0");
    // Para que las políticas del cliente y de consumption_entries (tabla vieja,
    // vacía en dev) también se pongan a prueba: reservas propias de un
    // cliente y consumos viejos en dos antros, solo dentro de la transacción.
    const [cli] = await db.q(`select u.id from auth.users u join public.profiles p on p.id = u.id where u.email = 'dev_cliente@example.com'`);
    if (cli) {
      sesiones.push(["dev_cliente (con reservas propias)", { sub: cli.id, role: "authenticated" }]);
      await db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, personas, status, source, club_id, fecha, qr_code, cliente_id)
                  select 'Cliente equivalencia', '5594000001', 2, 'confirmada', 'organica', $1, $2::date + g, 'antro-' || gen_random_uuid(), $3 from generate_series(1, 3) g`, [e.clubId, e.fecha, cli.id]);
    }
    await db.q(`insert into public.consumption_entries (reservation_id, monto)
                select id, 100 from (select id from public.reservations where club_id = $1 order by id limit 40) a
                union all select id, 50 from (select id from public.reservations where club_id <> $1 order by id limit 40) b`, [e.clubId]);
    const antes = await huellas();
    await db.q(readFileSync(path.resolve(RAIZ, CON_SQL), "utf8").replace(/^\s*(begin|commit);\s*$/gim, ""));
    const despues = await huellas();
    for (const [k, v] of Object.entries(antes)) {
      if (despues[k] === v) iguales++;
      else distintas.push(`${k}: ${v.split(":")[0]} → ${despues[k].split(":")[0]} filas`);
      console.log(`${despues[k] === v ? "igual " : "DISTINTA"}  ${k.padEnd(56)} ${v.split(":")[0]} filas`);
    }
  } finally {
    await db.q("rollback").catch(() => {});
    await db.fin();
  }
  console.log(`\n${iguales}/${iguales + distintas.length} combinaciones (sesión × tabla) ven exactamente las mismas filas.`);
  if (distintas.length) { console.log("DISTINTAS:", distintas); process.exitCode = 1; }
}

// ================================================================ CIERRE REAL
// Por la API (PostgREST) como los 3 gerentes: cobrar lo que falta, cerrar
// y cuadrar todas las mesas abiertas, cerrar la noche y abrir los reportes.
// Luego scripts/verificar-cuadre.mjs sobre el antro y la noche.
async function cierre() {
  const e = leerEstado();
  const G = await Promise.all([1, 2, 3].map((n) => sesion(e, `gerente${n}`)));
  const D = await sesion(e, "dueno");
  const caja = await leerCaja(e);
  const lat = {};
  const llamar = async (c, k, fn, a) => {
    const t = performance.now();
    const r = await c.rpc(fn, a);
    (lat[k] ??= []).push(performance.now() - t);
    return ok(r, fn);
  };
  const lista = [...caja.sesiones.values()];
  let i = 0;
  await Promise.all(G.map(async (g) => {
    while (i < lista.length) {
      const s = lista[i++];
      const saldo = s.registrado - s.pagado;
      if (saldo > 0) await llamar(g, "cobrar el saldo", "caja_registrar_pago", { p_sesion_id: s.id, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: saldo, p_clave: randomUUID(), p_saldo_esperado: saldo });
      await llamar(g, "cerrar mesa", "caja_cerrar_mesa", { p_sesion_id: s.id });
      await llamar(g, "cuadrar mesa", "caja_cuadrar_mesa", { p_sesion_id: s.id, p_notas: null });
    }
  }));
  // Totales en SQL (PostgREST corta en 1,000 filas y una noche grande tiene más cobros).
  const db0 = await conectarDevEscritura();
  const tot = await db0.q("select metodo, sum(monto_centavos)::bigint as cent from public.caja_pagos where noche_id = $1 and not anulado group by metodo", [caja.nocheId]);
  await db0.fin();
  const suma = (m) => Number(tot.find((x) => x.metodo === m)?.cent ?? 0);
  // Se cuenta $500 menos de efectivo: el cuadre debe registrar la diferencia.
  await llamar(G[0], "cerrar la noche", "caja_cerrar_noche", { p_noche_id: caja.nocheId, p_contado_efectivo_centavos: suma("efectivo") - 50000, p_contado_tarjeta_centavos: suma("tarjeta"), p_contado_otro_centavos: suma("otro"), p_notas: "Faltaron $500 en efectivo" });
  const [anio, semana] = semanaIso(e.fecha);
  for (let k = 0; k < 5; k++) {
    await llamar(G[k % 3], "reporte de cierre de la noche", "reporte_cierre_noche", { p_club_id: e.clubId, p_fecha: e.fecha });
    await llamar(G[k % 3], "nómina de la semana", "nomina_semana", { p_club_id: e.clubId, p_anio: anio, p_semana: semana });
    await llamar(D, "/grupo de la semana (dueño)", "grupo_resumen", { p_desde: e.lunes, p_hasta: e.fecha });
    await llamar(G[k % 3], "exportar consumos de la noche", "reporte_consumos", { p_club_id: e.clubId, p_desde: e.fecha, p_hasta: e.fecha, p_despues: null, p_limite: 1000 });
  }
  const res = { mesas_cuadradas: lista.length, latencias: Object.fromEntries(Object.entries(lat).map(([k, xs]) => [k, resumen(xs)])) };
  for (const [k, r] of Object.entries(res.latencias)) console.log(`${k.padEnd(40)} n=${String(r.n).padStart(3)}  p50 ${r.p50} ms  p95 ${r.p95} ms  max ${r.max} ms`);
  const db = await conectarDevEscritura();
  const [vol] = await db.q(
    `select count(*) filter (where k.anulado)::int anulados, count(*)::int consumos, (select count(*) from public.caja_pagos p where p.noche_id = $1)::int cobros,
            (select count(*) from public.caja_pagos p where p.noche_id = $1 and p.anulado)::int cobros_anulados,
            (select count(*) from public.mesa_sesiones s where s.noche_id = $1)::int grupos,
            (select count(*) from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id where s.noche_id = $1)::int cuentas,
            (select count(*) from public.reservations r where r.club_id = $2 and r.fecha = $3 and r.puerta_estado = 'entro')::int entraron,
            (select count(*) from public.commissions x join public.reservations r on r.id = x.reservation_id where r.club_id = $2 and r.fecha = $3)::int comisiones,
            (select coalesce(sum(x.monto), 0)::text from public.commissions x join public.reservations r on r.id = x.reservation_id where r.club_id = $2 and r.fecha = $3) comisiones_pesos,
            (select diferencia_centavos from public.caja_cuadres q where q.noche_id = $1 and q.tipo = 'noche')::int diferencia_centavos
       from public.caja_consumos k where k.noche_id = $1`,
    [caja.nocheId, e.clubId, e.fecha],
  );
  await db.fin();
  res.volumen_final = vol;
  console.log("Noche cerrada:", JSON.stringify(vol));
  const v = spawnSync(process.execPath, [path.join(RAIZ, "scripts/verificar-cuadre.mjs"), `--club=${e.clubId}`, `--desde=${e.fecha}`, `--hasta=${e.fecha}`], { encoding: "utf8" });
  res.verificar_cuadre = { codigo: v.status, salida: v.stdout.trim().split(/\r?\n/).slice(-4) };
  console.log("verificar-cuadre:", res.verificar_cuadre.salida.join(" | "));
  if (v.status !== 0) process.exitCode = 1;
  writeFileSync(path.join(DIR, "cierre.json"), JSON.stringify(res, null, 2));
}

// ================================================================ LIMPIAR
// Borra todo lo del antro de prueba. La caja no deja borrar (caja_sin_borrar):
// se hace como postgres con antroapp.borrado_pruebas = 'on', como las demás
// pruebas. Recorre las tablas con club_id o con llave a las cuentas de
// prueba, en varias pasadas para respetar las llaves foráneas.
async function limpiar() {
  if (!existsSync(ARCHIVO_ESTADO)) { console.log("No hay escenario que limpiar."); return; }
  const e = leerEstado();
  const ids = Object.values(e.usuarios).map((u) => u.id);
  const db = await conectarDevEscritura();
  const errores = [];
  try {
    await db.q("begin");
    await db.q("set local statement_timeout = 0");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    const conClub = (await db.q(`select table_name t from information_schema.columns c join information_schema.tables x using (table_schema, table_name)
                                  where c.table_schema = 'public' and c.column_name = 'club_id' and x.table_type = 'BASE TABLE' and table_name <> 'clubs'`)).map((r) => r.t);
    const aPerfiles = await db.q(`select cl.relname t, a.attname col from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_namespace n on n.oid = cl.relnamespace
                                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                                   where k.contype = 'f' and n.nspname = 'public' and k.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass) and cl.relname <> 'profiles'`);
    const aReservas = await db.q(`select cl.relname t, a.attname col from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_namespace n on n.oid = cl.relnamespace
                                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                                   where k.contype = 'f' and n.nspname = 'public' and k.confrelid = 'public.reservations'::regclass`);
    const pasos = [
      ...aReservas.map((r) => [`delete from public.${r.t} where ${r.col} in (select id from public.reservations where club_id = $1)`, [e.clubId]]),
      ...conClub.map((t) => [`delete from public.${t} where club_id = $1`, [e.clubId]]),
      ...aPerfiles.map((r) => [`delete from public.${r.t} where ${r.col} = any($1::uuid[])`, [ids]]),
      ["delete from public.profiles where id = any($1::uuid[])", [ids]],
      ["delete from public.clubs where id = $1", [e.clubId]],
    ];
    let pendientes = pasos;
    for (let pasada = 0; pasada < 6 && pendientes.length; pasada++) {
      const siguen = [];
      for (const [sql, a] of pendientes) {
        await db.q("savepoint b");
        try { await db.q(sql, a); await db.q("release savepoint b"); } catch (x) { await db.q("rollback to savepoint b"); siguen.push([sql, a, x.message]); }
      }
      pendientes = siguen;
    }
    for (const [sql, , m] of pendientes) errores.push(`${sql.slice(0, 80)}: ${m}`);
    await db.q("commit");
  } catch (x) {
    await db.q("rollback").catch(() => {});
    errores.push(x.message);
  }
  for (const id of ids) { const r = await svc.auth.admin.deleteUser(id); if (r.error && !/not found/i.test(r.error.message)) errores.push(`auth ${id}: ${r.error.message}`); }
  await svc.from("login_intentos").delete().in("email_hash", Object.values(e.usuarios).map((u) => createHash("sha256").update(u.email.toLowerCase()).digest("hex")));
  const [quedan] = await db.q(
    `select (select count(*) from public.clubs where id = $1)::int clubs, (select count(*) from auth.users where email like $2)::int usuarios,
            (select count(*) from public.profiles where id = any($3::uuid[]))::int perfiles, (select count(*) from public.reservations where club_id = $1)::int reservas,
            (select count(*) from public.caja_consumos where club_id = $1)::int consumos, (select count(*) from public.caja_eventos where club_id = $1)::int eventos`,
    [e.clubId, `carga\\_%\\_${e.tag}@example.com`, ids],
  );
  await db.fin();
  if (errores.length) console.log("Errores en la limpieza:", errores);
  console.log(`Limpieza (restos): ${JSON.stringify(quedan)}`);
  if (!errores.length && Object.values(quedan).every((x) => x === 0)) rmSync(ARCHIVO_ESTADO);
  else process.exitCode = 1;
}

// ================================================================ MAIN
const MODOS = { armar, medir, ensayo, estadisticas, explicar, equivalencia, cierre, limpiar };
try {
  if (MODO === "todo") {
    await armar();
    try {
      await medir();
      await ensayo();
      await cierre();
    } finally {
      await limpiar();
    }
  } else if (MODOS[MODO]) {
    await MODOS[MODO]();
  } else {
    console.log(`Modo desconocido: ${MODO}. Usa armar | medir | ensayo | estadisticas | explicar | equivalencia | cierre | limpiar | todo.`);
    process.exitCode = 1;
  }
} catch (x) {
  console.log("FALLA:", x.message);
  process.exitCode = 1;
}
