// Pruebas de la configuración por antro de los RPs (sql/post-junta/07-config-rp.sql)
// contra antroapp-dev, con DOS antros de prueba:
//   A: hoy paga $100 fijo; el gerente programa "cuota 2, desde la 3.ª $200".
//   B: regla de porcentaje (10 %) y el dueño cambia lo que ven sus RPs.
// La comisión se genera por el camino real: mesa → cuenta → consumo → pago
// → cierre → cuadre (caja_liquidar_cuenta).
//
//   node scripts/dev/probar-config-rp.mjs
//
// Como una regla nueva vale desde el LUNES SIGUIENTE, para probar el cálculo
// esta misma semana la prueba inserta (con service_role) una regla vigente
// desde el lunes actual: "simula que ya llegó el lunes". Al final borra todo.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";
import { describirRegla, porcentajeABp, validarRegla } from "../../lib/domain/config-rp.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const TAG = "cfgrp" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const ids = [];
const clubs = {};
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
async function cuenta(clave, role, club_id = null) {
  const email = `${TAG}_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "usuario " + clave);
  ids.push(u.user.id);
  ok(await svc.from("profiles").insert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id }), "perfil " + clave);
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  ok(await c.auth.signInWithPassword({ email, password: PASS }), "login " + clave);
  return { id: u.user.id, c };
}
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const lunesDe = (f) => {
  const d = new Date(f + "T12:00:00Z");
  const dia = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dia * 86400e3).toISOString().slice(0, 10);
};
const sumar = (f, n) => new Date(Date.parse(f + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);

// Una reserva del RP que entra, se sienta, consume, paga y se cuadra.
async function noche(club, ger, rp, centavos, concepto = "Botella prueba") {
  const r = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000555", personas: 4, status: "usada", puerta_estado: "entro", entrada_en: new Date().toISOString(), source: "rp", rp_id: rp, club_id: club.id, fecha: club.noche, qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(r), "reserva");
  const mesa = club.mesas.shift();
  const sesion = ok(await ger.rpc("caja_abrir_mesa", { p_mesa_id: mesa }), "abrir mesa");
  const cta = ok(await ger.rpc("caja_sentar_cliente", { p_sesion_id: sesion, p_reservation_id: r.id }), "sentar");
  ok(await ger.rpc("caja_registrar_consumo", { p_cuenta_id: cta, p_monto_centavos: centavos, p_concepto: concepto }), "consumo");
  ok(await ger.rpc("caja_registrar_pago", { p_sesion_id: sesion, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: centavos }), "pago");
  ok(await ger.rpc("caja_cerrar_mesa", { p_sesion_id: sesion }), "cerrar");
  ok(await ger.rpc("caja_cuadrar_mesa", { p_sesion_id: sesion }), "cuadrar");
  const com = ok(await svc.from("commissions").select("monto, regla_id").eq("reservation_id", r.id).maybeSingle(), "comisión");
  return { centavos: com ? Math.round(Number(com.monto) * 100) : null, regla: com?.regla_id ?? null, reserva: r.id };
}

try {
  // ---------- Reglas puras ----------
  revisar(porcentajeABp("12.5") === 1250 && porcentajeABp("10 %") === 1000 && porcentajeABp("0") === null && porcentajeABp("101") === null, "porcentaje a puntos base");
  revisar(describirRegla({ tipo: "cuota", cuota: 4, porcentaje_bp: null, monto_centavos: 20000 }) === "Las primeras 4 reservas de la semana no pagan; desde la 5.ª, $200 cada una", "texto de la regla con cuota");
  revisar(validarRegla({ tipo: "cuota", cuota: 0, porcentaje_bp: null, monto_centavos: 100 }) !== null && validarRegla({ tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 15000 }) === null, "validación de la regla");

  // ---------- Escenario ----------
  const hoy = hoyMx();
  for (const k of ["A", "B"]) {
    const dueno = await cuenta(`dueno${k}`, "dueno");
    const club = ok(await svc.from("clubs").insert({ nombre: `Antro ${k} ${TAG}`, direccion: "Calle 1", horario: "Vie", dueno_id: dueno.id, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0 }).select("id").single(), "club " + k);
    const mesas = ok(await svc.from("club_tables").insert(Array.from({ length: 8 }, (_, i) => ({ club_id: club.id, numero: String(i + 1), capacidad: 6 }))).select("id"), "mesas");
    clubs[k] = { id: club.id, noche: hoy, mesas: mesas.map((m) => m.id), dueno };
    clubs[k].gerente = await cuenta(`gerente${k}`, "gerente", club.id);
    clubs[k].staff = await cuenta(`staff${k}`, "staff", club.id);
    clubs[k].rp = await cuenta(`rp${k}`, "rp", club.id);
  }
  const { A, B } = clubs;
  const lunes = lunesDe(hoy);
  const sigLunes = sumar(lunes, 7);

  // ---------- Permisos ----------
  const programar = (s, club, extra) => s.rpc("config_rp_cambiar_regla", { p_club: club.id, p_tipo: "cuota", p_cuota: 2, p_porcentaje_bp: null, p_monto_centavos: 20000, ...extra });
  revisar(/Solo el dueño o el gerente/.test((await programar(A.staff.c, A)).error?.message ?? ""), "el staff no cambia la regla de pago");
  revisar(!!(await programar(A.rp.c, A)).error, "el RP no la cambia");
  revisar(!!(await programar(B.gerente.c, A)).error, "el gerente de otro antro no la cambia");
  revisar(((await A.staff.c.from("reglas_comision").select("id")).data ?? []).length === 0 && !!(await A.staff.c.rpc("config_rp_actual", { p_club: A.id })).error, "el staff no ve la regla ni la configuración");
  revisar(!!(await A.staff.c.rpc("config_rp_cambiar_visibilidad", { p_club: A.id, p_nivel: "estado" })).error, "el staff no cambia lo que ven los RPs");
  revisar(!!(await A.gerente.c.from("reglas_comision").insert({ club_id: A.id, tipo: "fijo", monto_centavos: 1, vigente_desde: lunes, creada_por: A.gerente.id })).error, "nadie inserta reglas directo (solo por la función)");

  // ---------- A: programar no es retroactivo ----------
  const p1 = await programar(A.gerente.c, A, { p_cuota: 3 });
  revisar(!p1.error && p1.data.vigente_desde === sigLunes, `el gerente programa la regla: vale desde el lunes ${sigLunes}`, JSON.stringify(p1.error ?? p1.data));
  const p2 = await programar(A.dueno.c, A, { p_cuota: 2 });
  const { data: reglasA } = await svc.from("reglas_comision").select("cuota, vigente_desde").eq("club_id", A.id);
  revisar(!p2.error && reglasA.length === 1 && reglasA[0].cuota === 2, "reprogramar antes del lunes reemplaza la programada (una sola)");
  const cfg = (await A.gerente.c.rpc("config_rp_actual", { p_club: A.id })).data;
  revisar(cfg?.vigente?.origen === "anterior" && cfg.vigente.tipo === "fijo" && cfg.programada?.cuota === 2, "esta semana sigue la regla de hoy; la nueva aparece como programada");
  const n1 = await noche(A, A.gerente.c, A.rp.id, 50000);
  revisar(n1.centavos === 10000 && n1.regla === null, "cuadre de esta semana: $100 como siempre (no retroactivo)", JSON.stringify(n1));
  const prog = (await A.rp.c.rpc("rp_progreso_cuota")).data;
  revisar(prog?.tiene_cuota === false, "el RP no ve cuota esta semana (todavía no aplica)");

  // ---------- A: "ya llegó el lunes" ----------
  // Se simula moviendo la regla programada al lunes actual y borrando la comisión de prueba anterior.
  await svc.from("commissions").delete().eq("reservation_id", n1.reserva);
  ok(await svc.from("reglas_comision").update({ vigente_desde: lunes }).eq("club_id", A.id), "simular lunes A");
  const a1 = await noche(A, A.gerente.c, A.rp.id, 80000);
  const a2 = await noche(A, A.gerente.c, A.rp.id, 30000);
  const progA = (await A.rp.c.rpc("rp_progreso_cuota")).data;
  revisar(progA?.tiene_cuota && progA.cuota === 3 && progA.llevas === 2 && progA.siguiente_paga === true, "panel del RP: llevas 2, la siguiente paga (la 3.ª)", JSON.stringify(progA));
  const a3 = await noche(A, A.gerente.c, A.rp.id, 10000);
  revisar(a1.centavos === 0 && a2.centavos === 0 && a3.centavos === 20000, "cuota 2: la 1.ª y 2.ª en $0, la 3.ª paga $200", JSON.stringify([a1.centavos, a2.centavos, a3.centavos]));
  revisar(!!a3.regla && a1.regla === a3.regla, "cada comisión guarda con qué regla se calculó");
  // Regla propia del RP: sigue ganando.
  const rp2 = await cuenta("rp2A", "rp", A.id);
  ok(await svc.from("rp_comision_overrides").insert({ club_id: A.id, rp_id: rp2.id, comision_tipo: "fijo", comision_monto: 75, comision_desbloqueo_reservas: 0 }), "override");
  const o1 = await noche(A, A.gerente.c, rp2.id, 40000);
  revisar(o1.centavos === 7500 && o1.regla === null, "un RP con regla propia sigue con la suya ($75)", JSON.stringify(o1));

  // ---------- B: porcentaje y visibilidad ----------
  ok(await svc.from("reglas_comision").insert({ club_id: B.id, tipo: "porcentaje", porcentaje_bp: 1000, vigente_desde: lunes, creada_por: B.dueno.id }), "regla B");
  const b1 = await noche(B, B.gerente.c, B.rp.id, 123400, "Botella Tequila");
  revisar(b1.centavos === 12340, "10 % de $1,234: $123.40", String(b1.centavos));
  revisar(((await B.rp.c.rpc("rp_progreso_cuota")).data)?.tiene_cuota === false, "con porcentaje no hay cuota");
  const ver = async () => (await B.rp.c.rpc("rp_mis_reservas", { p_desde: hoy, p_hasta: hoy })).data?.find((x) => x.reservation_id === b1.reserva);
  let v = await ver();
  revisar(v?.nivel === "estado_monto" && Number(v.consumo_centavos) === 123400 && v.renglones === null, "por defecto el RP ve estado y monto (como hoy)");
  ok(await B.dueno.c.rpc("config_rp_cambiar_visibilidad", { p_club: B.id, p_nivel: "estado" }), "solo estado");
  v = await ver();
  revisar(v?.estado === "consumio" && v.consumo_centavos === null && v.renglones === null, "solo estado: el RP ve que consumió, sin monto");
  ok(await B.gerente.c.rpc("config_rp_cambiar_visibilidad", { p_club: B.id, p_nivel: "estado_monto_botellas" }), "botellas");
  v = await ver();
  revisar(Number(v?.consumo_centavos) === 123400 && v.renglones?.[0]?.concepto === "Botella Tequila", "estado, monto y botellas: ve el renglón «Botella Tequila»");
  revisar(((await A.rp.c.rpc("rp_mis_reservas", { p_desde: hoy, p_hasta: hoy })).data ?? []).every((x) => x.nivel === "estado_monto"), "el cambio de B no afecta a los RPs de A");

  // ---------- Bitácora ----------
  const histA = (await A.dueno.c.rpc("config_rp_historial", { p_club: A.id })).data ?? [];
  revisar(histA.length === 2 && histA.every((h) => h.que === "regla_comision" && h.vigente_desde === sigLunes) && histA.some((h) => h.quien === `gerenteA ${TAG}`), "bitácora de A: 2 cambios de regla con quién y desde cuándo");
  const histB = (await B.gerente.c.rpc("config_rp_historial", { p_club: B.id })).data ?? [];
  revisar(histB.filter((h) => h.que === "visibilidad").length === 2 && histB[0].antes === "estado" && histB[0].despues === "estado_monto_botellas", "bitácora de B: los 2 cambios de visibilidad con antes y después");
  revisar(!!(await A.staff.c.rpc("config_rp_historial", { p_club: A.id })).error && ((await A.staff.c.from("config_rp_cambios").select("id")).data ?? []).length === 0, "el staff no ve la bitácora");

  // ---------- Nómina ----------
  // Semana ISO del lunes actual (la nómina va de lunes a domingo).
  const d = new Date(lunes + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 3); // jueves de esa semana
  const anio = d.getUTCFullYear();
  const semana = Math.ceil(((d.getTime() - Date.UTC(anio, 0, 1)) / 86400e3 + 1) / 7);
  const nom = await A.gerente.c.rpc("nomina_semana", { p_club_id: A.id, p_anio: anio, p_semana: semana });
  const filaRp = (nom.data ?? []).find((f) => f.rp_id === A.rp.id);
  revisar(!nom.error && filaRp && filaRp.comisiones === 3 && Number(filaRp.comision_centavos) === 20000, "la nómina de la semana suma lo que calculó la regla nueva (3 reservas, $200)", JSON.stringify(nom.error ?? filaRp));
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  const clubIds = Object.values(clubs).map((c) => c.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const t of ["config_rp_cambios", "reglas_comision", "club_config_rp", "rp_comision_overrides", "reservations", "club_tables"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza falló: " + e.message);
  } finally {
    await db.fin();
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  console.log(`\nLimpieza: ${clubIds.length} antros y ${ids.length} cuentas de prueba borrados.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
