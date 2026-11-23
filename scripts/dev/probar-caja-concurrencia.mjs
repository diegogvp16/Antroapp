// Caja con mala señal y varios staff a la vez, con sesiones REALES contra
// antroapp-dev (PostgREST + RLS, como la app). Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-caja-concurrencia.mjs
//
// Necesita sql/2026-11-21-caja-idempotencia.sql aplicado en dev. Revisa:
//   * Reintentos con la misma clave: no duplican consumo ni cobro, ni
//     siquiera con 5 envíos simultáneos o con la mesa ya cerrada.
//   * Una clave reusada con otros datos se rechaza.
//   * Dos staff que agregan consumo a la vez: no se pierde ninguno.
//   * Dos staff que cobran el saldo completo a la vez: solo entra uno.
//   * Cuadrar dos veces no duplica el cuadre ni la comisión.
//   * Llamar sin clave (código anterior) sigue funcionando.
// Crea su propio escenario y al final lo borra todo.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const TAG = "conc" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
let clubId = null;
const resultados = [];
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };

function revisar(nombre, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}
async function debeFallar(nombre, promesa, contiene = null) {
  const r = await promesa;
  const msg = r.error?.message ?? "";
  revisar(nombre, !!r.error && (!contiene || msg.toLowerCase().includes(contiene.toLowerCase())), r.error ? msg : "NO falló");
  return r;
}
async function debePasar(nombre, promesa) {
  const r = await promesa;
  revisar(nombre, !r.error, r.error?.message ?? "");
  return r.data;
}
const noche = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));

async function usuario(clave, role, club_id = null) {
  const email = `prueba-${clave}-${TAG}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `Prueba ${clave} ${TAG}`, role, club_id, activo: true }), "perfil " + clave);
  U[clave] = { id: u.user.id, email };
  return u.user.id;
}
async function sesion(clave) {
  const c = nuevoAnon();
  ok(await c.auth.signInWithPassword({ email: U[clave].email, password: PASS }), "login " + clave);
  return c;
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubId) {
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = $1`, [clubId]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = $1)", [clubId]);
      await db.q("delete from public.reservations where club_id = $1", [clubId]);
      await db.q("delete from public.rp_comision_overrides where club_id = $1", [clubId]);
      await db.q("delete from public.club_tables where club_id = $1", [clubId]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = $1", [clubId]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from public.profiles where nombre like $1)::int perfiles,
            (select count(*) from auth.users where email like $1)::int usuarios`,
    [`%${TAG}%`],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

const contar = async (tabla, filtro) => {
  let q = svc.from(tabla).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filtro)) q = q.eq(k, v);
  return (await q).count;
};

try {
  // ======================= Escenario =======================
  const dueno = await usuario("dueno", "dueno");
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `Prueba ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", dueno_id: dueno, suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0 }).eq("id", clubId), "publicar");
  await usuario("staffA", "staff", clubId);
  await usuario("staffB", "staff", clubId);
  await usuario("staffC", "staff", clubId);
  await usuario("gerente", "gerente", clubId);
  const rp = await usuario("rp", "rp", clubId);
  const mesas = ok(await svc.from("club_tables").insert([1, 2, 3].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const M = Object.fromEntries(mesas.map((m) => [m.numero, m.id]));
  const R = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000777", personas: 4, status: "confirmada",
    source: "rp", rp_id: rp, club_id: clubId, fecha: noche, qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(R), "reserva");

  const S = { anon: nuevoAnon(), A: await sesion("staffA"), B: await sesion("staffB"), C: await sesion("staffC"), G: await sesion("gerente") };
  ok(await S.A.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
  ok(await S.A.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
  const S1 = ok(await S.A.rpc("caja_abrir_mesa", { p_mesa_id: M["1"] }), "abrir mesa 1");
  const C1 = ok(await S.A.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R.id }), "sentar");
  console.log(`Escenario: antro de prueba, noche ${noche}, mesa 1 con la reserva del RP`);

  // ======================= Reintentos de consumo =======================
  console.log("\n== Agregar consumo: reintentos con la misma clave");
  const k1 = randomUUID();
  const consumo = (s, clave, monto = 25000, cuenta = C1) =>
    s.rpc("caja_registrar_consumo", { p_cuenta_id: cuenta, p_monto_centavos: monto, p_concepto: "2 × Cerveza", p_clave: clave });
  const id1 = await debePasar("primer envío guarda el consumo", consumo(S.A, k1));
  const id1b = await debePasar("reintento con la misma clave responde bien", consumo(S.A, k1));
  revisar("el reintento devuelve el mismo consumo", id1 && id1 === id1b);
  revisar("solo hay 1 consumo con esa clave", (await contar("caja_consumos", { clave_cliente: k1 })) === 1);
  await debeFallar("la misma clave con otro monto se rechaza", consumo(S.A, k1, 99900), "otros datos");

  const k2 = randomUUID();
  const rafaga = await Promise.all(Array.from({ length: 5 }, () => consumo(S.A, k2, 12000)));
  const idsRafaga = new Set(rafaga.map((r) => r.data));
  revisar("5 envíos simultáneos con la misma clave: todos responden bien", rafaga.every((r) => !r.error), rafaga.map((r) => r.error?.message).filter(Boolean).join(" | "));
  revisar("5 envíos simultáneos: un solo consumo", idsRafaga.size === 1 && (await contar("caja_consumos", { clave_cliente: k2 })) === 1);

  const kOtro = randomUUID();
  await debePasar("otro staff usa una clave propia", consumo(S.B, kOtro, 5000));
  await debePasar("sin clave (código anterior) sigue funcionando", S.A.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 1000 }));
  await debeFallar("anónimo no registra consumo con clave", consumo(S.anon, randomUUID()));

  // ======================= Varios staff a la vez =======================
  console.log("\n== Tres staff agregando consumo al mismo tiempo");
  const antes = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", S1).eq("anulado", false), "consumos antes");
  const sumaAntes = antes.reduce((s, c) => s + Number(c.monto_centavos), 0);
  const envios = [];
  for (const s of [S.A, S.B, S.C]) for (let i = 0; i < 10; i++) envios.push(consumo(s, randomUUID(), 1000 + i));
  const res = await Promise.all(envios);
  revisar("30 consumos simultáneos de 3 staff: todos entran", res.every((r) => !r.error), res.map((r) => r.error?.message).filter(Boolean)[0] ?? "");
  const despues = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", S1).eq("anulado", false), "consumos después");
  const esperado = sumaAntes + 3 * Array.from({ length: 10 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
  const suma = despues.reduce((s, c) => s + Number(c.monto_centavos), 0);
  revisar("el total de la mesa es exacto (ni uno perdido ni duplicado)", suma === esperado && despues.length === antes.length + 30, `${suma} vs ${esperado}`);

  // ======================= Cobros =======================
  console.log("\n== Cobrar: saldo esperado y reintentos");
  const saldo = suma;
  await debeFallar("cobro con un saldo esperado viejo se rechaza", S.A.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 1000, p_clave: randomUUID(), p_saldo_esperado: saldo - 1 }), "saldo de la mesa cambió");
  const parcial = 10000;
  const kp = randomUUID();
  const cobro = (s, clave, monto, esperado) =>
    s.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: monto, p_clave: clave, p_saldo_esperado: esperado });
  const p1 = await debePasar("cobro parcial con el saldo correcto", cobro(S.A, kp, parcial, saldo));
  const p1b = await debePasar("reintento del cobro (el saldo ya cambió, pero es el mismo cobro)", cobro(S.A, kp, parcial, saldo));
  revisar("el reintento devuelve el mismo cobro y no cobra dos veces", p1 === p1b && (await contar("caja_pagos", { clave_cliente: kp })) === 1);
  await debeFallar("la misma clave con otro monto se rechaza", cobro(S.A, kp, parcial + 1, saldo), "otros datos");

  const resto = saldo - parcial;
  const [cA, cB, cC] = await Promise.all([cobro(S.A, randomUUID(), resto, resto), cobro(S.B, randomUUID(), resto, resto), cobro(S.C, randomUUID(), resto, resto)]);
  const entraron = [cA, cB, cC].filter((r) => !r.error).length;
  const rechazados = [cA, cB, cC].filter((r) => r.error?.message.includes("saldo de la mesa cambió")).length;
  revisar("3 staff cobran el saldo completo a la vez: entra exactamente uno", entraron === 1 && rechazados === 2, `entraron ${entraron}, rechazados ${rechazados}`);
  const pagos = ok(await svc.from("caja_pagos").select("monto_centavos").eq("sesion_id", S1).eq("anulado", false), "pagos");
  const cobrado = pagos.reduce((s, p) => s + Number(p.monto_centavos), 0);
  revisar("la mesa queda pagada exacta (saldo 0, no sobrepagada)", cobrado === saldo, `${cobrado} vs ${saldo}`);

  // ======================= Cerrar y cuadrar =======================
  console.log("\n== Cerrar y cuadrar: repetir no duplica");
  await debePasar("gerente cierra la mesa", S.G.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }));
  const p1c = await debePasar("reintento tardío del cobro con la mesa ya cerrada: devuelve el mismo", cobro(S.A, kp, parcial, saldo));
  revisar("…y no inserta nada", p1c === p1 && (await contar("caja_pagos", { clave_cliente: kp })) === 1);
  const id1c = await debePasar("reintento tardío del consumo con la mesa cerrada: devuelve el mismo", consumo(S.A, k1));
  revisar("…y no inserta nada", id1c === id1);
  await debeFallar("un consumo NUEVO con la mesa cerrada sí se rechaza", consumo(S.A, randomUUID()), "requiere");
  const [q1, q2] = await Promise.all([
    S.G.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: null }),
    S.G.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: null }),
  ]);
  revisar("dos cuadres simultáneos: solo uno pasa", [q1, q2].filter((r) => !r.error).length === 1, [q1, q2].map((r) => r.error?.message ?? "ok").join(" | "));
  revisar("un solo cuadre de la mesa", (await contar("caja_cuadres", { sesion_id: S1 })) === 1);
  const comisiones = ok(await svc.from("commissions").select("id, monto").eq("reservation_id", R.id).eq("tipo", "rp"), "comisiones");
  revisar("una sola comisión del RP por la cuenta", comisiones.length === 1, `${comisiones.length} comisiones`);
  await debeFallar("cuadrar otra vez después se rechaza (no se duplica)", S.G.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: null }), "cuadrada");
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await limpiar();
  const pasan = resultados.filter(Boolean).length;
  console.log(`\nResultado: ${pasan}/${resultados.length} pasan`);
  if (pasan !== resultados.length) process.exitCode = 1;
}
