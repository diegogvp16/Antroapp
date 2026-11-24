// FASE 2 (rama fase2): inventario y propinas, con sesiones REALES contra
// antroapp-dev. Necesita sql/fase2/2026-11-21-inventario-propinas.sql
// aplicado en dev. Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-fase2.mjs
//
// Catálogo (solo gerente/dueño, por antro), venta que descuenta existencias
// (también con reintentos y 3 staff a la vez), anulación que las regresa,
// propina aparte del saldo y de la comisión. Crea su propio escenario y lo
// borra al final.

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

const TAG = "fase2" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
let clubId = null;
let clubOtro = null;
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
      await db.q("delete from public.producto_movimientos where club_id = any($1::uuid[])", [[clubId, clubOtro].filter(Boolean)]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = $1`, [clubId]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = $1)", [clubId]);
      await db.q("delete from public.reservations where club_id = $1", [clubId]);
      await db.q("delete from public.rp_comision_overrides where club_id = $1", [clubId]);
      await db.q("delete from public.club_tables where club_id = $1", [clubId]);
      await db.q("delete from public.productos where club_id = any($1::uuid[])", [[clubId, clubOtro].filter(Boolean)]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = any($1::uuid[])", [[clubId, clubOtro].filter(Boolean)]);
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


try {
  // ======================= Escenario =======================
  const dueno = await usuario("dueno", "dueno");
  const duenoOtro = await usuario("duenoOtro", "dueno");
  clubId = randomUUID();
  clubOtro = randomUUID();
  for (const [id, d] of [[clubId, dueno], [clubOtro, duenoOtro]]) {
    ok(await svc.from("clubs").insert({ id, nombre: `Prueba ${TAG} ${id.slice(0, 4)}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", dueno_id: d, suscripcion_activa: false }), "club");
    ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0 }).eq("id", id), "publicar");
  }
  await usuario("staffA", "staff", clubId);
  await usuario("staffB", "staff", clubId);
  await usuario("staffC", "staff", clubId);
  await usuario("gerente", "gerente", clubId);
  await usuario("staffOtro", "staff", clubOtro);
  const rp = await usuario("rp", "rp", clubId);
  const mesas = ok(await svc.from("club_tables").insert([1, 2].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const M1 = mesas.find((m) => m.numero === "1").id;
  const R = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000777", personas: 4, status: "confirmada",
    source: "rp", rp_id: rp, club_id: clubId, fecha: noche, qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(R), "reserva");
  const S = { anon: nuevoAnon(), A: await sesion("staffA"), B: await sesion("staffB"), C: await sesion("staffC"), G: await sesion("gerente"),
    D: await sesion("dueno"), DO: await sesion("duenoOtro"), SO: await sesion("staffOtro"), RP: await sesion("rp") };
  const existencias = async (id) => ok(await svc.from("productos").select("existencias").eq("id", id).single(), "existencias").existencias;

  // ======================= Catálogo =======================
  console.log("\n== Catálogo (solo gerente o dueño)");
  const guardar = (s, extra) => s.rpc("producto_guardar", { p_club_id: clubId, p_id: null, p_nombre: "Cerveza", p_categoria: "Cervezas", p_precio_centavos: 9000, p_existencias_minimas: 3, p_activo: true, p_existencias_iniciales: 10, ...extra });
  await debeFallar("staff no da de alta productos", guardar(S.A), "gerente o el dueño");
  await debeFallar("dueño de otro antro no da de alta aquí", guardar(S.DO), "gerente o el dueño");
  await debeFallar("anónimo no da de alta", guardar(S.anon));
  const cerveza = await debePasar("gerente da de alta Cerveza (10 en existencia, mínimo 3)", guardar(S.G));
  await debeFallar("nombre repetido (sin importar mayúsculas)", guardar(S.D, { p_nombre: " cerveza " }), "ya hay un producto");
  const botella = await debePasar("dueño da de alta Botella de tequila", guardar(S.D, { p_nombre: "Botella de tequila", p_categoria: "Botellas", p_precio_centavos: 280000, p_existencias_iniciales: 4, p_existencias_minimas: 1 }));
  const agua = await debePasar("gerente da de alta Agua (inactiva)", guardar(S.G, { p_nombre: "Agua", p_categoria: "Sin alcohol", p_precio_centavos: 4000, p_activo: false }));
  await debePasar("gerente edita el precio de la botella", guardar(S.G, { p_id: botella, p_nombre: "Botella de tequila", p_categoria: "Botellas", p_precio_centavos: 300000, p_existencias_minimas: 1 }));
  revisar("editar no cambia las existencias", (await existencias(botella)) === 4);
  const leeStaff = ok(await S.A.from("productos").select("id"), "staff lee");
  revisar("el staff del antro lee el catálogo", leeStaff.length === 3, `${leeStaff.length}`);
  revisar("staff de otro antro no lo lee", ok(await S.SO.from("productos").select("id"), "otro").length === 0);
  const anonLee = await S.anon.from("productos").select("id");
  revisar("anónimo no lo lee", !!anonLee.error || anonLee.data.length === 0);
  const rpLee = await S.RP.from("productos").select("id");
  revisar("el RP no lee el catálogo", !!rpLee.error || rpLee.data.length === 0);
  await debeFallar("staff no escribe directo en productos", S.A.from("productos").update({ precio_centavos: 1 }).eq("id", cerveza).select());
  revisar("…y el precio sigue igual", ok(await svc.from("productos").select("precio_centavos").eq("id", cerveza).single(), "precio").precio_centavos === 9000);
  await debeFallar("staff no ajusta existencias", S.A.rpc("producto_ajustar_existencias", { p_producto_id: cerveza, p_cantidad: 5, p_motivo: "Llegó pedido" }));
  await debeFallar("ajuste sin motivo", S.G.rpc("producto_ajustar_existencias", { p_producto_id: cerveza, p_cantidad: 5, p_motivo: "" }), "motivo");
  revisar("gerente ajusta +5 (llegó pedido) = 15", (await debePasar("ajuste +5", S.G.rpc("producto_ajustar_existencias", { p_producto_id: cerveza, p_cantidad: 5, p_motivo: "Llegó pedido" }))) === 15);

  // ======================= Ventas =======================
  console.log("\n== Venta de catálogo: descuenta existencias");
  ok(await S.A.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
  ok(await S.A.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
  const S1 = ok(await S.A.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "abrir");
  const C1 = ok(await S.A.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R.id }), "sentar");
  const vender = (s, producto, cantidad, clave = randomUUID()) => s.rpc("caja_registrar_consumo_producto", { p_cuenta_id: C1, p_producto_id: producto, p_cantidad: cantidad, p_clave: clave });
  const k1 = randomUUID();
  const v1 = await debePasar("staff vende 3 cervezas", vender(S.A, cerveza, 3, k1));
  const fila = ok(await svc.from("caja_consumos").select("monto_centavos, concepto, producto_id, cantidad").eq("id", v1).single(), "consumo");
  revisar("monto y concepto los pone la base (3 × $90)", fila.monto_centavos === 27000 && fila.concepto === "3 × Cerveza" && fila.cantidad === 3, JSON.stringify(fila));
  revisar("existencias 15 → 12", (await existencias(cerveza)) === 12);
  revisar("reintento con la misma clave: mismo consumo", (await debePasar("reintento", vender(S.A, cerveza, 3, k1))) === v1);
  revisar("…y no descuenta otra vez (12)", (await existencias(cerveza)) === 12);
  await debeFallar("la misma clave con otra cantidad se rechaza", vender(S.A, cerveza, 4, k1), "otros datos");
  const k2 = randomUUID();
  const rafaga = await Promise.all(Array.from({ length: 5 }, () => vender(S.B, cerveza, 1, k2)));
  revisar("5 envíos simultáneos con la misma clave: un consumo", new Set(rafaga.map((r) => r.data)).size === 1 && rafaga.every((r) => !r.error));
  revisar("…y descuenta solo 1 (11)", (await existencias(cerveza)) === 11);
  const tres = await Promise.all([S.A, S.B, S.C].flatMap((s) => Array.from({ length: 6 }, () => vender(s, cerveza, 1))));
  revisar("3 staff venden 18 cervezas a la vez: todas entran", tres.every((r) => !r.error), tres.find((r) => r.error)?.error.message ?? "");
  revisar("existencias exactas: 11 − 18 = −7 (se vende aunque el conteo esté mal)", (await existencias(cerveza)) === -7, `${await existencias(cerveza)}`);
  await debeFallar("producto inactivo no se vende", vender(S.A, agua, 1), "ya no se vende");
  const ajeno = ok(await svc.from("productos").insert({ club_id: clubOtro, nombre: "Ajena", categoria: "X", precio_centavos: 100 }).select("id").single(), "ajeno").id;
  await debeFallar("producto de otro antro no se vende aquí", vender(S.A, ajeno, 1), "no encontrado");
  await debeFallar("cantidad 0 no", vender(S.A, cerveza, 0), "cantidad");
  await debeFallar("el RP no vende", vender(S.RP, cerveza, 1), "permiso");
  await debePasar("vende una botella", vender(S.A, botella, 1));
  revisar("botella: 4 → 3", (await existencias(botella)) === 3);

  console.log("\n== Anular regresa existencias");
  await debePasar("gerente anula las 3 cervezas", S.G.rpc("caja_anular_consumo", { p_consumo_id: v1, p_motivo: "Capturado de más" }));
  revisar("existencias −7 → −4", (await existencias(cerveza)) === -4);
  const movs = ok(await svc.from("producto_movimientos").select("tipo, cantidad").eq("producto_id", cerveza), "movimientos");
  const suma = movs.reduce((a, m) => a + m.cantidad, 0);
  revisar("bitácora: alta + ajuste + ventas + anulación = existencias", suma === -4 && movs.some((m) => m.tipo === "anulacion"), `${movs.length} movimientos, suma ${suma}`);
  await debeFallar("anular otra vez no regresa dos veces", S.G.rpc("caja_anular_consumo", { p_consumo_id: v1, p_motivo: "Otra vez" }), "ya estaba anulado");
  revisar("…sigue en −4", (await existencias(cerveza)) === -4);

  // ======================= Propinas =======================
  console.log("\n== Propina aparte del saldo y de la comisión");
  const consumo = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", S1).eq("anulado", false), "consumo").reduce((a, c) => a + Number(c.monto_centavos), 0);
  const kp = randomUUID();
  const pagar = (propina, clave = kp) => S.A.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: consumo, p_clave: clave, p_saldo_esperado: consumo, p_propina_centavos: propina });
  await debeFallar("propina negativa no", pagar(-1, randomUUID()), "propina");
  await debePasar(`cobra el consumo con $50 de propina`, pagar(5000));
  const pago = ok(await svc.from("caja_pagos").select("monto_centavos, propina_centavos").eq("clave_cliente", kp).single(), "pago");
  revisar("el cobro guarda el monto y la propina por separado", Number(pago.monto_centavos) === consumo && Number(pago.propina_centavos) === 5000);
  await debeFallar("reintento con otra propina se rechaza", pagar(9000), "otros datos");
  const s2 = ok(await S.A.rpc("caja_abrir_mesa", { p_mesa_id: mesas.find((m) => m.numero === "2").id }), "mesa 2");
  const c2 = ok(await S.A.rpc("caja_sentar_cliente", { p_sesion_id: s2, p_cliente_nombre: "Walk-in", p_personas: 2 }), "walk");
  ok(await S.A.rpc("caja_registrar_consumo", { p_cuenta_id: c2, p_monto_centavos: 1000 }), "consumo 2");
  await debePasar("cobro sin propina (código anterior) sigue funcionando", S.A.rpc("caja_registrar_pago", { p_sesion_id: s2, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 1000 }));
  await debePasar("la mesa cierra: la propina no cuenta como saldo a favor", S.G.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }));
  await debePasar("gerente cuadra la mesa", S.G.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: null }));
  const cuadre = ok(await svc.from("caja_cuadres").select("registrado_centavos, cobrado_tarjeta_centavos").eq("sesion_id", S1).single(), "cuadre");
  revisar("el cuadre cobra el consumo, sin la propina", Number(cuadre.registrado_centavos) === consumo && Number(cuadre.cobrado_tarjeta_centavos) === consumo);
  const com = ok(await svc.from("commissions").select("monto").eq("reservation_id", R.id).eq("tipo", "rp"), "comisión");
  revisar("comisión del RP = su regla ($100 fijo), sin la propina", com.length === 1 && Number(com[0].monto) === 100, JSON.stringify(com));
  const { spawnSync } = await import("node:child_process");
  const verif = spawnSync(process.execPath, [path.join(RAIZ, "scripts/verificar-cuadre.mjs"), `--club=${clubId}`], { encoding: "utf8" });
  revisar("verificar-cuadre del antro: sin diferencias", verif.status === 0, verif.stdout.trim().split(/\r?\n/).pop());
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await limpiar();
  const pasan = resultados.filter(Boolean).length;
  console.log(`\nResultado: ${pasan}/${resultados.length} pasan`);
  if (pasan !== resultados.length) process.exitCode = 1;
}
