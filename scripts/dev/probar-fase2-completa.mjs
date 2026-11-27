// FASE 2, bloque 8: inventario completo y propinas, con sesiones REALES
// contra antroapp-dev. Necesita sql/post-junta-3/80-inventario.sql y
// 81-propinas.sql aplicados en dev. Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-fase2-completa.mjs
//
// Crea su propio escenario (dos antros, 12 cuentas: admin, dueño, gerente,
// 2 staff, RP, cliente, staff/gerente/dueño del otro antro, cuenta sin
// perfil y anónimo), enciende las banderas «inventario» y «propinas» SOLO en
// su antro (por el admin, como en /admin/funciones) y lo borra todo al final.
//
//  1. Banderas apagadas: las funciones nuevas no hacen nada y la caja trabaja
//     exactamente como antes (sin filas nuevas de propinas).
//  2. Permisos por rol y aislamiento entre antros (inventario y propinas).
//  3. Existencias: entradas, mermas y conteos con reintentos; ventas y
//     anulaciones; dos staff venden la última pieza a la vez; existencias =
//     suma de la bitácora; historial y reporte de la noche.
//  4. Propinas: registro idempotente, aparte del saldo, del cuadre y de la
//     comisión; cierre de noche sin propinas en el conteo; reparto con la
//     regla del antro, al centavo; reintentos y reparto doble a la vez.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const TAG = "f2c" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
const clubs = [];
const resultados = [];
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
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
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const noche = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));

async function usuario(clave, role, club_id = null) {
  const email = `prueba-${clave}-${TAG}@example.com`.toLowerCase();
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  if (role) ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `Prueba ${clave} ${TAG}`, role, club_id, activo: true }), "perfil " + clave);
  U[clave] = { id: u.user.id, email };
  return u.user.id;
}
// Otros carriles inician sesión en dev al mismo tiempo: reintento con espera
// si Auth limita.
async function sesion(clave) {
  for (let intento = 1; ; intento++) {
    const c = nuevoAnon();
    const r = await c.auth.signInWithPassword({ email: U[clave].email, password: PASS });
    if (!r.error) return c;
    if (intento >= 5) throw new Error(`login ${clave}: ${r.error.message}`);
    await espera(1500 * intento);
  }
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubs.length) {
      const c = clubs;
      await db.q("delete from public.propinas_reparto_lineas where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.propinas_repartos where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.caja_propinas where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.propinas_cobro_anuladas where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.propinas_config where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.producto_movimientos where club_id = any($1::uuid[])", [c]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [c]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [c]);
      await db.q("delete from public.reservations where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.club_tables where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.productos where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.funciones_cambios where club_id = any($1::uuid[])", [c]);
      await db.q("delete from public.club_funciones where club_id = any($1::uuid[])", [c]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubs.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubs]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from public.profiles where nombre like $1)::int perfiles,
            (select count(*) from auth.users where email like $2)::int usuarios,
            (select count(*) from public.club_funciones where club_id = any($3::uuid[]))::int banderas`,
    [`%${TAG}%`, `%${TAG.toLowerCase()}%`, clubs],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

try {
  // ======================= Escenario =======================
  const dueno = await usuario("dueno", "dueno");
  const duenoOtro = await usuario("duenoOtro", "dueno");
  const A = randomUUID();
  const B = randomUUID();
  for (const [id, d] of [[A, dueno], [B, duenoOtro]]) {
    ok(await svc.from("clubs").insert({ id, nombre: `Prueba ${TAG} ${id.slice(0, 4)}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", dueno_id: d, suscripcion_activa: false }), "club");
    clubs.push(id);
    ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0 }).eq("id", id), "publicar");
  }
  await usuario("admin", "admin");
  await usuario("gerente", "gerente", A);
  await usuario("staffA", "staff", A);
  await usuario("staffB", "staff", A);
  const rp = await usuario("rp", "rp", A);
  await usuario("cliente", "cliente");
  await usuario("gerenteOtro", "gerente", B);
  await usuario("staffOtro", "staff", B);
  await usuario("sinPerfil", null);
  const mesas = ok(await svc.from("club_tables").insert([1, 2, 3].map((n) => ({ club_id: A, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const M = Object.fromEntries(mesas.map((m) => [m.numero, m.id]));
  const R = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000777", personas: 4, status: "confirmada", source: "rp", rp_id: rp, club_id: A, fecha: noche, qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(R), "reserva");

  const S = { anon: nuevoAnon() };
  for (const k of ["admin", "dueno", "gerente", "staffA", "staffB", "rp", "cliente", "gerenteOtro", "staffOtro", "duenoOtro", "sinPerfil"]) S[k] = await sesion(k);
  const existencias = async (id) => ok(await svc.from("productos").select("existencias").eq("id", id).single(), "existencias").existencias;
  const sumaBitacora = async (id) => ok(await svc.from("producto_movimientos").select("cantidad").eq("producto_id", id), "bitácora").reduce((a, m) => a + m.cantidad, 0);
  const cuadraBitacora = async (id) => (await existencias(id)) === (await sumaBitacora(id));

  // Catálogo (fase 2 de antes, sin bandera).
  const guardar = (nombre, precio, iniciales, minimo) => S.gerente.rpc("producto_guardar", { p_club_id: A, p_id: null, p_nombre: nombre, p_categoria: "Barra", p_precio_centavos: precio, p_existencias_minimas: minimo, p_activo: true, p_existencias_iniciales: iniciales });
  const cerveza = ok(await guardar("Cerveza", 9000, 10, 3), "cerveza");
  const botella = ok(await guardar("Botella", 250000, 1, 1), "botella");
  const ajeno = ok(await svc.from("productos").insert({ club_id: B, nombre: "Ajena", categoria: "X", precio_centavos: 100, existencias: 5 }).select("id").single(), "ajeno").id;

  // ======================= 1. Banderas apagadas =======================
  console.log("\n== 1. Banderas apagadas: nada nuevo, la caja como antes");
  const ver = ok(await S.gerente.rpc("mis_funciones", { p_club_id: A }), "mis_funciones");
  revisar("el antro arranca con inventario y propinas apagadas", !ver.includes("inventario") && !ver.includes("propinas"), JSON.stringify(ver));
  await debeFallar("inventario_entrada con la bandera apagada", S.gerente.rpc("inventario_entrada", { p_producto_id: cerveza, p_cantidad: 5 }), "no está activo");
  await debeFallar("inventario_merma apagada", S.gerente.rpc("inventario_merma", { p_producto_id: cerveza, p_cantidad: 1, p_motivo: "Se rompió" }), "no está activo");
  await debeFallar("inventario_conteo apagada", S.gerente.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: 10 }), "no está activo");
  await debeFallar("inventario_historial apagada", S.gerente.rpc("inventario_historial", { p_producto_id: cerveza }), "no está activo");
  await debeFallar("inventario_reporte_noche apagada", S.gerente.rpc("inventario_reporte_noche", { p_club_id: A, p_fecha: noche }), "no está activo");
  await debeFallar("propinas_config_guardar apagada", S.gerente.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 100, p_pct_rp: 0, p_pct_casa: 0 }), "no están activas");
  await debeFallar("propinas_reporte_noche apagada", S.gerente.rpc("propinas_reporte_noche", { p_club_id: A, p_fecha: noche }), "no están activas");
  revisar("con la bandera apagada no cambió ninguna existencia", (await existencias(cerveza)) === 10 && (await cuadraBitacora(cerveza)));

  ok(await S.staffA.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
  ok(await S.staffA.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
  const S1 = await debePasar("caja como antes: abrir mesa 1", S.staffA.rpc("caja_abrir_mesa", { p_mesa_id: M["1"] }));
  const C1 = await debePasar("caja como antes: sentar la reserva del RP", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R.id }));
  const nocheId = ok(await svc.from("mesa_sesiones").select("noche_id").eq("id", S1).single(), "noche").noche_id;
  await debeFallar("caja_registrar_propina apagada", S.staffA.rpc("caja_registrar_propina", { p_noche_id: nocheId, p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 100 }), "no están activas");
  await debePasar("caja como antes: consumo libre $100", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 10000, p_concepto: "Mezcal", p_clave: randomUUID() }));
  await debePasar("caja como antes: cobro sin propina (firma vieja)", S.staffA.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 10000, p_clave: randomUUID(), p_saldo_esperado: 10000 }));
  revisar("apagada: ninguna fila en caja_propinas", ok(await svc.from("caja_propinas").select("id").eq("club_id", A), "propinas").length === 0);

  // Encender SOLO en el antro A, como el admin en /admin/funciones.
  await debeFallar("el gerente no enciende banderas", S.gerente.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "inventario", p_activa: true }), "admin");
  await debePasar("admin enciende «inventario» en A", S.admin.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "inventario", p_activa: true }));
  await debePasar("admin enciende «propinas» en A", S.admin.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "propinas", p_activa: true }));
  const ver2 = ok(await S.staffA.rpc("mis_funciones", { p_club_id: A }), "mis_funciones");
  revisar("el staff de A ve las dos banderas encendidas", ver2.includes("inventario") && ver2.includes("propinas"));
  revisar("el antro B sigue apagado", ok(await S.gerenteOtro.rpc("mis_funciones", { p_club_id: B }), "B").length === 0);
  await debeFallar("anónimo no ejecuta funcion_activa", S.anon.rpc("funcion_activa", { p_club_id: A, p_funcion: "inventario" }));
  await debeFallar("autenticado no ejecuta funcion_activa", S.staffA.rpc("funcion_activa", { p_club_id: A, p_funcion: "inventario" }));

  // ======================= 2. Permisos e aislamiento =======================
  console.log("\n== 2. Inventario: permisos por rol y por antro");
  const entrada = (s, prod = cerveza, n = 1, clave = randomUUID()) => s.rpc("inventario_entrada", { p_producto_id: prod, p_cantidad: n, p_clave: clave });
  for (const k of ["anon", "sinPerfil", "cliente", "rp", "staffA", "staffOtro", "gerenteOtro", "duenoOtro"])
    await debeFallar(`${k} no registra entradas en A`, entrada(S[k]));
  await debeFallar("gerente de A no mueve un producto de B", entrada(S.gerente, ajeno), "no encontrado");
  await debeFallar("gerente de B (bandera apagada) tampoco en su antro", entrada(S.gerenteOtro, ajeno), "no está activo");
  revisar("gerente registra entrada +1", (await debePasar("entrada gerente", entrada(S.gerente))) === 11);
  revisar("dueño registra entrada +1", (await debePasar("entrada dueño", entrada(S.dueno))) === 12);
  revisar("admin registra entrada +1", (await debePasar("entrada admin", entrada(S.admin))) === 13);
  for (const k of ["staffA", "rp", "gerenteOtro"]) await debeFallar(`${k} no ve el historial`, S[k].rpc("inventario_historial", { p_producto_id: cerveza }));
  for (const k of ["staffA", "gerenteOtro", "anon"]) await debeFallar(`${k} no ve el reporte de inventario de A`, S[k].rpc("inventario_reporte_noche", { p_club_id: A, p_fecha: noche }));
  await debeFallar("merma: staff no", S.staffA.rpc("inventario_merma", { p_producto_id: cerveza, p_cantidad: 1, p_motivo: "Se rompió" }));
  await debeFallar("conteo: staff no", S.staffA.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: 1, p_motivo: "x conteo" }));
  revisar("bitácora: el staff no la lee", ok(await S.staffA.from("producto_movimientos").select("id"), "staff").length === 0);
  revisar("bitácora: el gerente de B no lee la de A", ok(await S.gerenteOtro.from("producto_movimientos").select("id").eq("club_id", A), "B").length === 0);
  await debeFallar("nadie escribe la bitácora directo", S.gerente.from("producto_movimientos").insert({ club_id: A, producto_id: cerveza, tipo: "entrada", cantidad: 99 }));

  console.log("\n== 2b. Propinas: permisos por rol y por antro");
  const propina = (s, extra = {}) => s.rpc("caja_registrar_propina", { p_noche_id: nocheId, p_sesion_id: S1, p_cuenta_id: C1, p_metodo: "efectivo", p_monto_centavos: 100, p_clave: randomUUID(), ...extra });
  for (const k of ["anon", "sinPerfil", "cliente", "rp", "staffOtro", "gerenteOtro", "duenoOtro"]) await debeFallar(`${k} no registra propinas en A`, propina(S[k]));
  for (const k of ["anon", "sinPerfil", "cliente", "rp", "staffA", "gerenteOtro"]) await debeFallar(`${k} no ve el reporte de propinas de A`, S[k].rpc("propinas_reporte_noche", { p_club_id: A, p_fecha: noche }));
  for (const k of ["staffA", "rp", "gerenteOtro", "sinPerfil"]) await debeFallar(`${k} no configura el reparto`, S[k].rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 50, p_pct_rp: 50, p_pct_casa: 0 }));
  await debeFallar("la regla debe sumar 100", S.gerente.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 70, p_pct_rp: 20, p_pct_casa: 20 }), "sumar 100");
  await debePasar("gerente guarda la regla 70/20/10", S.gerente.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 70, p_pct_rp: 20, p_pct_casa: 10, p_incluye_gerente: false }));
  const regla = ok(await S.staffA.rpc("propinas_config_leer", { p_club_id: A }), "leer")[0];
  revisar("el staff de A lee la regla (70/20/10)", regla.pct_personal === 70 && regla.pct_rp === 20 && regla.pct_casa === 10 && !regla.por_defecto);
  await debeFallar("el RP no lee la regla", S.rp.rpc("propinas_config_leer", { p_club_id: A }));
  for (const k of ["staffA", "gerenteOtro"]) await debeFallar(`${k} no calcula el reparto`, S[k].rpc("propinas_calcular", { p_noche_id: nocheId, p_participantes: [] }));
  await debeFallar("nadie escribe caja_propinas directo", S.staffA.from("caja_propinas").insert({ club_id: A, noche_id: nocheId, metodo: "efectivo", monto_centavos: 5, registrado_por: U.staffA.id }));

  // ======================= 3. Existencias =======================
  console.log("\n== 3. Existencias: entradas, mermas y conteos con reintento");
  const k1 = randomUUID();
  revisar("entrada +12 con clave = 25", (await debePasar("entrada +12", S.gerente.rpc("inventario_entrada", { p_producto_id: cerveza, p_cantidad: 12, p_costo_centavos: 120000, p_referencia: "Factura 77", p_clave: k1 }))) === 25);
  await debePasar("reintento con la misma clave", S.gerente.rpc("inventario_entrada", { p_producto_id: cerveza, p_cantidad: 12, p_costo_centavos: 120000, p_referencia: "Factura 77", p_clave: k1 }));
  revisar("…no suma dos veces (25)", (await existencias(cerveza)) === 25);
  await debeFallar("misma clave con otra cantidad se rechaza", S.gerente.rpc("inventario_entrada", { p_producto_id: cerveza, p_cantidad: 13, p_clave: k1 }), "otros datos");
  const k2 = randomUUID();
  const rafaga = await Promise.all(Array.from({ length: 5 }, () => S.gerente.rpc("inventario_entrada", { p_producto_id: cerveza, p_cantidad: 2, p_clave: k2 })));
  revisar("5 envíos simultáneos de la misma entrada: sin error", rafaga.every((r) => !r.error), rafaga.find((r) => r.error)?.error.message ?? "");
  revisar("…y suma una sola vez (27)", (await existencias(cerveza)) === 27);
  await debeFallar("cantidad 0 no", S.gerente.rpc("inventario_entrada", { p_producto_id: cerveza, p_cantidad: 0 }), "cantidad");
  await debeFallar("merma sin motivo no", S.gerente.rpc("inventario_merma", { p_producto_id: cerveza, p_cantidad: 1, p_motivo: "" }), "motivo");
  revisar("merma −2 (se rompieron) = 25", (await debePasar("merma", S.gerente.rpc("inventario_merma", { p_producto_id: cerveza, p_cantidad: 2, p_motivo: "Se rompieron en la barra", p_clave: randomUUID() }))) === 25);
  await debeFallar("conteo con diferencia y sin motivo no", S.gerente.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: 24 }), "motivo");
  revisar("conteo 24 con motivo deja 24", (await debePasar("conteo 24", S.gerente.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: 24, p_motivo: "Faltó una en el conteo", p_clave: randomUUID() }))) === 24);
  await debePasar("conteo que cuadra no pide motivo", S.gerente.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: 24 }));
  const ultimoConteo = ok(await svc.from("producto_movimientos").select("tipo, cantidad, contado").eq("producto_id", cerveza).eq("tipo", "conteo"), "conteos");
  revisar("los conteos guardan lo contado y la diferencia (−1 y 0)", ultimoConteo.length === 2 && ultimoConteo.some((m) => m.cantidad === -1 && m.contado === 24) && ultimoConteo.some((m) => m.cantidad === 0));
  revisar("existencias = suma de la bitácora", await cuadraBitacora(cerveza));

  console.log("\n== 3b. Ventas y anulaciones");
  const vender = (s, prod, n, cuenta = C1) => s.rpc("caja_registrar_consumo_producto", { p_cuenta_id: cuenta, p_producto_id: prod, p_cantidad: n, p_clave: randomUUID() });
  const v1 = await debePasar("staff vende 3 cervezas", vender(S.staffA, cerveza, 3));
  revisar("24 → 21", (await existencias(cerveza)) === 21);
  await debePasar("gerente anula la venta", S.gerente.rpc("caja_anular_consumo", { p_consumo_id: v1, p_motivo: "Capturado de más" }));
  revisar("anular regresa: 21 → 24", (await existencias(cerveza)) === 24);
  await debeFallar("anular otra vez no regresa dos veces", S.gerente.rpc("caja_anular_consumo", { p_consumo_id: v1, p_motivo: "Otra vez" }), "ya estaba anulado");
  revisar("…sigue en 24", (await existencias(cerveza)) === 24);
  // Venta, merma y anulación a la vez sobre el mismo producto.
  const v2 = ok(await vender(S.staffA, cerveza, 2), "venta 2");
  const mezcla = await Promise.all([
    vender(S.staffA, cerveza, 1), vender(S.staffB, cerveza, 1),
    S.gerente.rpc("inventario_merma", { p_producto_id: cerveza, p_cantidad: 1, p_motivo: "Se derramó", p_clave: randomUUID() }),
    S.gerente.rpc("caja_anular_consumo", { p_consumo_id: v2, p_motivo: "Cliente la regresó" }),
  ]);
  revisar("venta, merma y anulación a la vez: sin error", mezcla.every((r) => !r.error), mezcla.find((r) => r.error)?.error.message ?? "");
  revisar("existencias exactas: 24 − 2 − 1 − 1 − 1 + 2 = 21", (await existencias(cerveza)) === 21, String(await existencias(cerveza)));
  revisar("…y = suma de la bitácora", await cuadraBitacora(cerveza));

  console.log("\n== 3c. Dos staff venden la última pieza a la vez");
  revisar("botella: queda 1", (await existencias(botella)) === 1);
  const ultima = await Promise.all([vender(S.staffA, botella, 1), vender(S.staffB, botella, 1)]);
  revisar("las dos ventas entran (la caja no se detiene por existencias)", ultima.every((r) => !r.error), ultima.find((r) => r.error)?.error.message ?? "");
  revisar("existencias −1 exactas (ni 0 ni −2 por carrera)", (await existencias(botella)) === -1, String(await existencias(botella)));
  const ventasBotella = ok(await svc.from("producto_movimientos").select("id").eq("producto_id", botella).eq("tipo", "venta"), "ventas");
  revisar("dos movimientos de venta, y existencias = bitácora", ventasBotella.length === 2 && (await cuadraBitacora(botella)));
  revisar("conteo deja la botella en 0 con motivo", (await debePasar("conteo botella", S.gerente.rpc("inventario_conteo", { p_producto_id: botella, p_contado: 0, p_motivo: "Se vendió de más" }))) === 0);

  console.log("\n== 3d. Historial y reporte de la noche");
  const hist = ok(await S.gerente.rpc("inventario_historial", { p_producto_id: cerveza, p_limite: 500 }), "historial");
  const cerv = await existencias(cerveza);
  let saldoBien = hist.length > 0 && hist[0].existencias_despues === cerv;
  for (let i = 0; i < hist.length - 1; i++) if (hist[i + 1].existencias_despues + hist[i].cantidad !== hist[i].existencias_despues) saldoBien = false;
  revisar("historial: el saldo de cada movimiento encadena con el anterior", saldoBien, `${hist.length} movimientos, último saldo ${hist[0]?.existencias_despues}`);
  revisar("historial: el más viejo es «alta» con saldo 10", hist.at(-1)?.tipo === "alta" && hist.at(-1)?.existencias_despues === 10);
  revisar("historial: la entrada guarda costo y referencia", hist.some((h) => h.tipo === "entrada" && Number(h.costo_centavos) === 120000 && h.referencia === "Factura 77"));
  const rep = ok(await S.dueno.rpc("inventario_reporte_noche", { p_club_id: A, p_fecha: noche }), "reporte");
  const rc = rep.find((f) => f.producto_id === cerveza);
  revisar("reporte (dueño): cervezas vendidas 2 ($180), anuladas 5", rc && rc.vendidos === 2 && Number(rc.vendido_centavos) === 18000 && rc.anulados === 5, JSON.stringify(rc));
  revisar("reporte: entradas 27 (alta 10 + 3 + 12 + 2), mermas 3, diferencias −1", rc && rc.entradas === 27 && rc.mermas === 3 && rc.diferencias === -1, JSON.stringify(rc));
  revisar("reporte: no trae productos de otro antro", !rep.some((f) => f.producto_id === ajeno));

  console.log("\n== 3e. Conteo con ventas mientras se cuenta (no se absorben en la diferencia)");
  const vistas = await existencias(cerveza);
  await debePasar("mientras el gerente cuenta, el staff vende 2", vender(S.staffA, cerveza, 2));
  // Contó vistas − 1 (falta una de verdad). Las 2 vendidas no son diferencia.
  const tras = await debePasar("conteo con las existencias vistas al empezar", S.gerente.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: vistas - 1, p_motivo: "Falta una botella", p_clave: randomUUID(), p_existencias_vistas: vistas }));
  revisar(`existencias = contado menos lo vendido mientras: ${vistas - 1} − 2 = ${vistas - 3}`, tras === vistas - 3 && (await existencias(cerveza)) === vistas - 3, String(tras));
  const mc = ok(await svc.from("producto_movimientos").select("cantidad, contado, motivo").eq("producto_id", cerveza).eq("tipo", "conteo").order("orden", { ascending: false }).limit(1), "conteo")[0];
  revisar("la diferencia guardada es −1 (no −3) y el motivo lo explica", mc.cantidad === -1 && mc.contado === vistas - 1 && mc.motivo.includes("se respetaron"), JSON.stringify(mc));
  revisar("…y existencias = suma de la bitácora", await cuadraBitacora(cerveza));
  await debeFallar("conteo con diferencia contra lo visto y sin motivo no", S.gerente.rpc("inventario_conteo", { p_producto_id: cerveza, p_contado: vistas, p_existencias_vistas: vistas - 2 }), "motivo");

  // ======================= 4. Propinas =======================
  console.log("\n== 4. Propinas: aparte del saldo, del cuadre y de la comisión");
  // Mesa 1: la cuenta del RP. Consumo y cobro con propina del cobro.
  const saldo1 = async (s) => {
    // Igual que caja_totales_sesion: consumos vigentes menos pagos vigentes.
    const suma = (filas) => filas.reduce((a, f) => a + Number(f.monto_centavos), 0);
    const k = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", s).eq("anulado", false), "consumos");
    const p = ok(await svc.from("caja_pagos").select("monto_centavos").eq("sesion_id", s).eq("anulado", false), "pagos");
    return suma(k) - suma(p);
  };
  const deuda1 = await saldo1(S1);
  revisar("mesa 1: saldo antes de cobrar = lo vendido del catálogo", deuda1 > 0, String(deuda1));
  await debePasar("cobro de la mesa 1 con $2 de propina (tarjeta)", S.staffA.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: deuda1, p_clave: randomUUID(), p_saldo_esperado: deuda1, p_propina_centavos: 200 }));
  const kp = randomUUID();
  const p1 = await debePasar("propina suelta $3 a la cuenta del RP", propina(S.staffA, { p_monto_centavos: 300, p_clave: kp, p_nota: "La dejaron en la mesa" }));
  revisar("reintento con la misma clave: la misma propina", (await debePasar("reintento", propina(S.staffA, { p_monto_centavos: 300, p_clave: kp, p_nota: "La dejaron en la mesa" }))) === p1);
  await debeFallar("misma clave con otro monto se rechaza", propina(S.staffA, { p_monto_centavos: 301, p_clave: kp }), "otros datos");
  const kr = randomUUID();
  const rafagaP = await Promise.all(Array.from({ length: 5 }, () => propina(S.staffB, { p_monto_centavos: 5000, p_metodo: "otro", p_cuenta_id: null, p_sesion_id: null, p_clave: kr })));
  revisar("5 envíos simultáneos de una propina sin mesa: una sola", rafagaP.every((r) => !r.error) && new Set(rafagaP.map((r) => r.data)).size === 1, rafagaP.find((r) => r.error)?.error.message ?? "");
  await debeFallar("propina 0 no", propina(S.staffA, { p_monto_centavos: 0 }), "inválida");
  await debeFallar("cuenta de otra mesa no", propina(S.staffA, { p_sesion_id: null }), "cuenta");
  await debeFallar("el staff no anula propinas (permiso «anular»)", S.staffA.rpc("caja_anular_propina", { p_propina_id: rafagaP[0].data, p_motivo: "Error de captura" }), "permiso");
  await debePasar("el gerente anula la propina sin mesa", S.gerente.rpc("caja_anular_propina", { p_propina_id: rafagaP[0].data, p_motivo: "Se capturó en otro antro" }));
  await debeFallar("anular dos veces no", S.gerente.rpc("caja_anular_propina", { p_propina_id: rafagaP[0].data, p_motivo: "Otra vez" }), "ya estaba anulada");
  const r1 = await svc.from("caja_propinas").delete().eq("id", p1).select();
  revisar("ni service_role borra una propina", !!r1.error || (await svc.from("caja_propinas").select("id").eq("id", p1)).data.length === 1, r1.error?.message ?? "");
  const r2 = await svc.from("caja_propinas").update({ monto_centavos: 1 }).eq("id", p1).select();
  revisar("ni service_role cambia el monto", !!r2.error, r2.error?.message ?? "NO falló");
  revisar("staff de A lee las propinas de su mesa", ok(await S.staffA.from("caja_propinas").select("id").eq("sesion_id", S1), "lee").length === 1);
  for (const k of ["staffOtro", "rp", "cliente"]) revisar(`${k} no lee propinas de A`, ok(await S[k].from("caja_propinas").select("id"), k).length === 0);
  const anonLee = await S.anon.from("caja_propinas").select("id");
  revisar("anónimo no lee propinas", !!anonLee.error || anonLee.data.length === 0);
  revisar("las propinas NO cambian el saldo de la mesa 1 (0)", (await saldo1(S1)) === 0);

  // Mesa 2: walk-in sin RP con propina suelta sin cuenta.
  const S2 = ok(await S.staffA.rpc("caja_abrir_mesa", { p_mesa_id: M["2"] }), "mesa 2");
  const C2 = ok(await S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S2, p_cliente_nombre: "Walk-in", p_personas: 2 }), "walk-in");
  ok(await S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C2, p_monto_centavos: 50000, p_concepto: "Botella", p_clave: randomUUID() }), "consumo 2");
  ok(await S.staffB.rpc("caja_registrar_pago", { p_sesion_id: S2, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 50000, p_clave: randomUUID(), p_saldo_esperado: 50000 }), "cobro 2");
  await debePasar("propina suelta $1.01 de la mesa 2 (sin RP)", propina(S.staffB, { p_sesion_id: S2, p_cuenta_id: null, p_monto_centavos: 101 }));
  const REGLA = { p_pct_personal: 70, p_pct_rp: 20, p_pct_casa: 10, p_incluye_gerente: false };
  const calc = (s, part, r = REGLA) => s.rpc("propinas_calcular", { p_noche_id: nocheId, p_participantes: part, ...r });
  const repartir = (s, part, total, r = REGLA) => s.rpc("propinas_repartir", { p_noche_id: nocheId, p_participantes: part, p_total_visto: total, ...r });
  await debeFallar("repartir con la noche abierta no", repartir(S.gerente, [U.staffA.id], 601), "cierra la noche");

  for (const s of [S1, S2]) {
    ok(await S.gerente.rpc("caja_cerrar_mesa", { p_sesion_id: s }), "cerrar");
    ok(await S.gerente.rpc("caja_cuadrar_mesa", { p_sesion_id: s, p_notas: null }), "cuadrar");
  }
  await debeFallar("propina en una mesa cuadrada no (se registra sin mesa)", propina(S.staffA), "cuadrada");
  const cuadres = ok(await svc.from("caja_cuadres").select("sesion_id, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos").eq("club_id", A).eq("tipo", "mesa"), "cuadres");
  const cq1 = cuadres.find((c) => c.sesion_id === S1);
  revisar("cuadre de la mesa 1: registrado = cobrado, sin propinas", cq1 && Number(cq1.registrado_centavos) === Number(cq1.cobrado_efectivo_centavos) + Number(cq1.cobrado_tarjeta_centavos) + Number(cq1.cobrado_otro_centavos), JSON.stringify(cq1));
  const com = ok(await svc.from("commissions").select("monto").eq("reservation_id", R.id).eq("tipo", "rp"), "comisión");
  revisar("comisión del RP = su regla ($100), sin propinas", com.length === 1 && Number(com[0].monto) === 100, JSON.stringify(com));

  // Cierre de la noche: el conteo NO espera propinas.
  const pagos = ok(await svc.from("caja_pagos").select("metodo, monto_centavos").eq("noche_id", nocheId).eq("anulado", false), "pagos");
  const cobrado = (m) => pagos.filter((p) => p.metodo === m).reduce((a, p) => a + Number(p.monto_centavos), 0);
  await debePasar("cierre de la noche con el conteo de lo cobrado (sin propinas)", S.gerente.rpc("caja_cerrar_noche", { p_noche_id: nocheId, p_contado_efectivo_centavos: cobrado("efectivo"), p_contado_tarjeta_centavos: cobrado("tarjeta"), p_contado_otro_centavos: cobrado("otro"), p_notas: null }));
  const cn = ok(await svc.from("caja_cuadres").select("registrado_centavos, diferencia_centavos, saldo_sin_cobrar_centavos").eq("noche_id", nocheId).eq("tipo", "noche").single(), "cuadre noche");
  revisar("cuadre de la noche: diferencia 0 y nada sin cobrar", Number(cn.diferencia_centavos) === 0 && Number(cn.saldo_sin_cobrar_centavos) === 0, JSON.stringify(cn));
  await debeFallar("con la noche cerrada ya no entran propinas", propina(S.staffA, { p_sesion_id: null, p_cuenta_id: null }), "cerrada");

  console.log("\n== 4b. Reparto (70 % personal · 20 % RP · 10 % casa)");
  await debeFallar("el RP no entra al reparto del personal", calc(S.gerente, [U.staffA.id, U.rp.id]), "personal activo");
  await debeFallar("el gerente no entra si la regla no lo incluye", calc(S.gerente, [U.staffA.id, U.gerente.id]), "personal activo");
  await debeFallar("staff de otro antro no", calc(S.gerente, [U.staffOtro.id]), "personal activo");
  await debeFallar("personas repetidas no", calc(S.gerente, [U.staffA.id, U.staffA.id]), "repetidas");
  await debeFallar("sin nadie del personal (habiendo personal) no", calc(S.gerente, []), "al menos");
  const lineas = await debePasar("gerente calcula con staffA y staffB", calc(S.gerente, [U.staffA.id, U.staffB.id]));
  const de = (ls, tipo, id) => Number(ls.find((l) => l.tipo === tipo && (id === undefined || l.profile_id === id))?.monto_centavos ?? -1);
  // 200 (cobro, mesa de una cuenta con RP): RP 40, casa 20, personal 140.
  // 300 (suelta, cuenta del RP): RP 60, casa 30, personal 210.
  // 101 (mesa 2, sin RP): casa 10, personal 91. La de 50 está anulada.
  revisar("RP: 40 + 60 = $1.00", de(lineas, "rp", rp) === 100, JSON.stringify(lineas));
  revisar("casa: 20 + 30 + 10 = $0.60", de(lineas, "casa") === 60);
  revisar("personal: 441 en partes iguales (221 y 220, el centavo al primero por nombre)", de(lineas, "personal", U.staffA.id) === 221 && de(lineas, "personal", U.staffB.id) === 220);
  revisar("las líneas suman exacto el total ($6.01)", lineas.reduce((a, l) => a + Number(l.monto_centavos), 0) === 601);

  console.log("\n== 4c. La regla cambia entre «Ver cómo queda» y «Repartir»");
  await debePasar("el dueño cambia la regla a 10/0/90", S.dueno.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 10, p_pct_rp: 0, p_pct_casa: 90, p_incluye_gerente: false }));
  await debeFallar("repartir con la regla vista (70/20/10) se rechaza", repartir(S.gerente, [U.staffA.id, U.staffB.id], 601), "regla del reparto cambió");
  await debeFallar("calcular con la regla vista también se rechaza", calc(S.gerente, [U.staffA.id, U.staffB.id]), "regla del reparto cambió");
  revisar("no se guardó ningún reparto", ok(await svc.from("propinas_repartos").select("id").eq("noche_id", nocheId), "repartos").length === 0);
  const sinRegla = await S.gerente.rpc("propinas_repartir", { p_noche_id: nocheId, p_participantes: [U.staffA.id], p_total_visto: 601 });
  revisar("repartir sin mandar la regla no se puede", !!sinRegla.error, sinRegla.error?.message ?? "NO falló");
  await debePasar("el dueño regresa la regla a 70/20/10", S.dueno.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 70, p_pct_rp: 20, p_pct_casa: 10, p_incluye_gerente: false }));

  console.log("\n== 4d. RP dado de baja: su parte va al personal");
  const nombreRp = `Prueba rp ${TAG}`;
  ok(await svc.from("profiles").update({ activo: false }).eq("id", rp), "baja RP");
  const lineasBaja = await debePasar("calcular con el RP dado de baja", calc(S.gerente, [U.staffA.id, U.staffB.id]));
  revisar("sin línea de RP; personal 441 + 100 = 541 (271 y 270); casa 60", de(lineasBaja, "rp", rp) === -1 && de(lineasBaja, "personal", U.staffA.id) === 271 && de(lineasBaja, "personal", U.staffB.id) === 270 && de(lineasBaja, "casa") === 60, JSON.stringify(lineasBaja));
  const repBaja = ok(await S.gerente.rpc("propinas_reporte_noche", { p_club_id: A, p_fecha: noche }), "reporte baja");
  revisar("el reporte avisa que el RP está dado de baja", repBaja.rp_de_baja.includes(nombreRp) && repBaja.propinas.some((p) => p.rp_de_baja === nombreRp && p.rp === null), JSON.stringify(repBaja.rp_de_baja));
  ok(await svc.from("profiles").update({ activo: true }).eq("id", rp), "alta RP");
  const repAlta = ok(await S.gerente.rpc("propinas_reporte_noche", { p_club_id: A, p_fecha: noche }), "reporte alta");
  const deMesa = repAlta.propinas.find((p) => p.origen === "cobro");
  revisar("reporte: la propina «de la mesa» (cobro, mesa de una cuenta) muestra al RP que cobra su parte", deMesa?.rp === nombreRp && deMesa?.cuenta === null, JSON.stringify(deMesa));
  revisar("reporte por origen: cobro $2.00 (1), aparte $4.01 (2)", Number(repAlta.por_origen.cobro) === 200 && repAlta.por_origen.cobro_n === 1 && Number(repAlta.por_origen.suelta) === 401 && repAlta.por_origen.suelta_n === 2, JSON.stringify(repAlta.por_origen));

  console.log("\n== 4e. Repartir");
  await debeFallar("repartir con un total visto distinto no", repartir(S.gerente, [U.staffA.id, U.staffB.id], 600), "cambiaron");
  await debeFallar("el staff no reparte", repartir(S.staffA, [U.staffA.id], 601));
  const tres = await Promise.all(Array.from({ length: 3 }, () => repartir(S.gerente, [U.staffA.id, U.staffB.id], 601)));
  revisar("3 repartos a la vez: uno solo (los reintentos devuelven el mismo)", tres.every((r) => !r.error) && new Set(tres.map((r) => r.data)).size === 1, tres.find((r) => r.error)?.error.message ?? "");
  const rid = tres[0].data;
  revisar("un solo reparto vigente en la base", ok(await svc.from("propinas_repartos").select("id").eq("noche_id", nocheId).eq("anulado", false), "repartos").length === 1);
  await debeFallar("repartir otra vez con otra gente no", repartir(S.gerente, [U.staffA.id], 601), "ya se repartió");
  const lin = ok(await svc.from("propinas_reparto_lineas").select("monto_centavos").eq("reparto_id", rid), "líneas");
  revisar("líneas guardadas = $6.01", lin.reduce((a, l) => a + Number(l.monto_centavos), 0) === 601);
  revisar("el staff no lee los repartos", ok(await S.staffA.from("propinas_repartos").select("id"), "staff").length === 0);
  const r3 = await svc.from("propinas_reparto_lineas").update({ monto_centavos: 999 }).eq("reparto_id", rid).select();
  revisar("las líneas no se modifican (ni service_role)", !!r3.error, r3.error?.message ?? "NO falló");

  console.log("\n== 4f. Anular solo la propina de un cobro (error de dedo)");
  const pagoTip = ok(await svc.from("caja_pagos").select("id, monto_centavos, anulado").eq("noche_id", nocheId).gt("propina_centavos", 0).single(), "pago con propina");
  const pagoSin = ok(await svc.from("caja_pagos").select("id").eq("sesion_id", S2).single(), "pago sin propina");
  await debeFallar("con el reparto hecho no se anula la propina", S.gerente.rpc("propinas_anular_de_cobro", { p_pago_id: pagoTip.id, p_motivo: "Eran $0.20" }), "ya se repartió");
  await debeFallar("anular el reparto sin motivo no", S.gerente.rpc("propinas_anular_reparto", { p_reparto_id: rid, p_motivo: "" }), "motivo");
  await debeFallar("el staff no anula el reparto", S.staffA.rpc("propinas_anular_reparto", { p_reparto_id: rid, p_motivo: "Faltó alguien" }));
  await debePasar("gerente anula el reparto con motivo", S.gerente.rpc("propinas_anular_reparto", { p_reparto_id: rid, p_motivo: "La propina del cobro estaba mal" }));
  const cuadresAntes = JSON.stringify(ok(await svc.from("caja_cuadres").select("*").eq("noche_id", nocheId).order("id"), "cuadres antes"));
  await debeFallar("el staff no anula la propina de un cobro (permiso «anular»)", S.staffA.rpc("propinas_anular_de_cobro", { p_pago_id: pagoTip.id, p_motivo: "Eran $0.20" }), "permiso");
  await debeFallar("staff de otro antro tampoco", S.staffOtro.rpc("propinas_anular_de_cobro", { p_pago_id: pagoTip.id, p_motivo: "Eran $0.20" }), "permiso");
  await debeFallar("un cobro sin propina no", S.gerente.rpc("propinas_anular_de_cobro", { p_pago_id: pagoSin.id, p_motivo: "No aplica" }), "no tiene propina");
  await debePasar("el gerente anula solo la propina del cobro (noche cerrada)", S.gerente.rpc("propinas_anular_de_cobro", { p_pago_id: pagoTip.id, p_motivo: "Eran $0.20" }));
  await debeFallar("anularla dos veces no", S.gerente.rpc("propinas_anular_de_cobro", { p_pago_id: pagoTip.id, p_motivo: "Otra vez" }), "ya estaba anulada");
  const pagoDespues = ok(await svc.from("caja_pagos").select("id, monto_centavos, anulado").eq("id", pagoTip.id).single(), "pago después");
  revisar("el cobro no cambia (monto y vigente)", JSON.stringify(pagoDespues) === JSON.stringify(pagoTip));
  revisar("los cuadres de mesa y de noche no cambian", JSON.stringify(ok(await svc.from("caja_cuadres").select("*").eq("noche_id", nocheId).order("id"), "cuadres después")) === cuadresAntes);
  const rb = await svc.from("propinas_cobro_anuladas").delete().eq("pago_id", pagoTip.id).select();
  revisar("la anulación no se borra (ni service_role)", !!rb.error, rb.error?.message ?? "NO falló");
  revisar("el staff de A ve qué propina de cobro se anuló (para la caja)", ok(await S.staffA.from("propinas_cobro_anuladas").select("pago_id"), "staff").length === 1);
  revisar("el staff de otro antro no", ok(await S.staffOtro.from("propinas_cobro_anuladas").select("pago_id"), "otro").length === 0);
  const rid2 = await debePasar("reparte de nuevo solo con staffA (ya sin la propina del cobro: $4.01)", repartir(S.gerente, [U.staffA.id], 401));
  const lin2 = ok(await svc.from("propinas_reparto_lineas").select("tipo, profile_id, monto_centavos").eq("reparto_id", rid2), "líneas 2");
  // 300: RP 60, casa 30, personal 210. 101: casa 10, personal 91.
  revisar("staffA $3.01, RP $0.60, casa $0.40", de(lin2, "personal", U.staffA.id) === 301 && de(lin2, "rp", rp) === 60 && de(lin2, "casa") === 40, JSON.stringify(lin2));

  const rp2 = ok(await S.gerente.rpc("propinas_reporte_noche", { p_club_id: A, p_fecha: noche }), "reporte propinas");
  revisar("reporte: total $4.01; efectivo $4.01, tarjeta $0, otro $0", Number(rp2.total_centavos) === 401 && Number(rp2.por_metodo.efectivo) === 401 && Number(rp2.por_metodo.tarjeta) === 0 && Number(rp2.por_metodo.otro) === 0, JSON.stringify(rp2.por_metodo));
  revisar("reporte: 4 propinas (2 anuladas, la del cobro con su motivo), por mesa 1 = $3.00 y 2 = $1.01", rp2.propinas.length === 4 && rp2.propinas.filter((p) => p.anulado).length === 2 && rp2.propinas.some((p) => p.origen === "cobro" && p.anulado && p.motivo_anulacion === "Eran $0.20") && rp2.por_mesa.some((m) => m.mesa === "1" && Number(m.total_centavos) === 300) && rp2.por_mesa.some((m) => m.mesa === "2" && Number(m.total_centavos) === 101), JSON.stringify(rp2.por_mesa));
  revisar("reporte: marca quién trabajó (staffA y staffB) y trae el reparto vigente", rp2.personal.filter((p) => p.trabajo).length === 2 && rp2.reparto?.id === rid2);

  console.log("\n== 4g. 0 % al personal, o sin personal: el resto va a la casa");
  await debePasar("gerente anula el reparto", S.gerente.rpc("propinas_anular_reparto", { p_reparto_id: rid2, p_motivo: "Probar otra regla" }));
  await debePasar("regla 0/50/50", S.gerente.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 0, p_pct_rp: 50, p_pct_casa: 50, p_incluye_gerente: false }));
  const R050 = { p_pct_personal: 0, p_pct_rp: 50, p_pct_casa: 50, p_incluye_gerente: false };
  const l0 = await debePasar("con 0 % al personal no pide elegir a nadie", calc(S.gerente, [], R050));
  // 300 con RP: RP 150, casa 150. 101 sin RP: casa 50 + lo del personal 51 = 101.
  revisar("RP $1.50 y casa $2.51 (sin líneas de personal)", de(l0, "rp", rp) === 150 && de(l0, "casa") === 251 && !l0.some((l) => l.tipo === "personal"), JSON.stringify(l0));
  const rid3 = await debePasar("se reparte sin personal", repartir(S.gerente, [U.staffA.id], 401, R050));
  revisar("con 0 % al personal se guarda sin participantes", ok(await svc.from("propinas_repartos").select("participantes").eq("id", rid3).single(), "rid3").participantes.length === 0);
  await debePasar("gerente anula ese reparto", S.gerente.rpc("propinas_anular_reparto", { p_reparto_id: rid3, p_motivo: "Probar sin personal" }));
  await debePasar("regla 70/20/10 otra vez", S.gerente.rpc("propinas_config_guardar", { p_club_id: A, p_pct_personal: 70, p_pct_rp: 20, p_pct_casa: 10, p_incluye_gerente: false }));
  ok(await svc.from("profiles").update({ activo: false }).in("id", [U.staffA.id, U.staffB.id]), "baja staff");
  const lSin = await debePasar("sin personal activo, calcular sin elegir a nadie", calc(S.gerente, []));
  // 300: RP 60, casa 30, personal 210. 101: casa 10, personal 91. Personal 301 → casa.
  revisar("lo del personal va a la casa: RP $0.60, casa $3.41", de(lSin, "rp", rp) === 60 && de(lSin, "casa") === 341, JSON.stringify(lSin));
  ok(await svc.from("profiles").update({ activo: true }).in("id", [U.staffA.id, U.staffB.id]), "alta staff");

  const verif = spawnSync(process.execPath, [path.join(RAIZ, "scripts/verificar-cuadre.mjs"), `--club=${A}`], { encoding: "utf8" });
  revisar("verificar-cuadre del antro: sin diferencias (las propinas no se cuelan)", verif.status === 0, verif.stdout.trim().split(/\r?\n/).pop());

  // Apagar de nuevo: las funciones nuevas vuelven a negarse.
  await debePasar("admin apaga «propinas» en A", S.admin.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "propinas", p_activa: null }));
  await debeFallar("apagada otra vez: el reporte de propinas se niega", S.gerente.rpc("propinas_reporte_noche", { p_club_id: A, p_fecha: noche }), "no están activas");
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.stack ?? e.message);
} finally {
  await limpiar();
  const pasan = resultados.filter(Boolean).length;
  console.log(`\nResultado: ${pasan}/${resultados.length} pasan`);
  if (pasan !== resultados.length) process.exitCode = 1;
}
