// C5 (noche 3): pruebas de concurrencia con sesiones REALES contra
// antroapp-dev (PostgREST + RLS, como la app). Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-concurrencia-noche3.mjs
//
// Casos (cada uno manda las peticiones a la vez con Promise.all):
//   1. Dos staff escanean el mismo QR y confirman la entrada a la vez: la
//      entrada se registra una sola vez y el segundo recibe "ya entró".
//   2. Dos reservas del mismo cliente, mismo antro y misma noche: el índice
//      único deja pasar una (23505 en la otra, que /cliente/reservar traduce).
//      Además, ráfaga de reservas sin cuenta con el mismo teléfono: el tope
//      de 3 por teléfono, antro y noche (72) se respeta también en paralelo.
//   3. Doble cobro: la misma clave enviada dos y cinco veces a la vez (con y
//      sin saldo esperado) y claves distintas con el mismo saldo: un solo cobro.
//   4. Cuadrar la misma mesa a la vez (gerente, otro gerente y dueño): un
//      cuadre y una comisión por cuenta; y dos mesas del mismo RP cuadradas a
//      la vez con cuota semanal: la cuota se cuenta bien (una paga, otra no).
//   5. Dos gerentes (y el dueño) cierran la misma noche a la vez: un cierre.
//      Y cerrar la noche mientras otro staff abre una mesa: nunca queda una
//      noche cerrada con una mesa abierta.
//   6. Un dueño sin antro da de alta dos antros a la vez (carrera forzada y
//      Promise.all): queda uno solo y el otro recibe un aviso (68).
//
// Post-junta-3 (bloque 9, parte 2; antro C propio con sus banderas, que
// enciende un admin de prueba y se van con el antro):
//   7. Dos admins cambian la misma bandera a la vez (00): sin cambios perdidos.
//   8. Dos gerentes importan el mismo archivo del POS (10), dos archivos que
//      se enciman y dos «deshacer» a la vez.
//   9. Dos staff mandan la misma entrada diferida (20) desde dos teléfonos, el
//      mismo envío tres veces y diferida contra cámara.
//  10. Lista negra (40): dos bloqueos del mismo teléfono, bloqueo y desbloqueo
//      contra reservas de ese teléfono, dos desbloqueos.
//  11. Inventario (80): dos staff venden la última pieza, entrada + merma +
//      venta a la vez, conteo mientras se vende, reintentos con la misma clave.
//  12. Propinas (81): dos gerentes reparten la misma noche (mismo y distinto
//      reparto) y anular una propina contra el reparto.
//  13. Formulario de /para-clubes (50): ráfagas contra los topes por IP y por
//      correo y la casilla trampa, por el camino de la ruta con CAPTCHA
//      (service role con IP de prueba: no gasta el tope de la IP real de la
//      máquina, que comparten los demás carriles). Enciende para_clubes solo
//      durante la ráfaga y la deja como estaba.
// Antifraude (30) no se incluye: su rama se está corrigiendo.
//
//   node scripts/dev/probar-concurrencia-noche3.mjs --solo-pj3   (solo 7–13)
//
// Crea sus propios antros "T rls conc …" y cuentas t_rls_…@example.com, y al
// final lo borra todo aunque falle (try/finally). No toca Club Demo Dev.

import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
// Cada petición con tope de 90 s: una petición colgada (red o gateway) sale como error en vez de dejar
// el proceso esperando para siempre sin llegar a la limpieza (pasó en dev el 27/11/2026).
const conTope = (url, o = {}) => fetch(url, { ...o, signal: o.signal ?? AbortSignal.timeout(90000) });
const opciones = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: conTope } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const TAG = "t_rls_" + randomUUID().slice(0, 6);
const SOLO_PJ3 = process.argv.includes("--solo-pj3");
const PASS = "Prueba-" + randomUUID();
const U = {};
const clubs = {};
const huellasContacto = []; // contacto_huella() de las IP y correos de prueba del caso 13
let paraClubesAntes = null; // valor de la bandera de plataforma antes del caso 13 (se restaura siempre)
const resultados = [];
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };

function revisar(nombre, paso, detalle = "") {
  resultados.push({ nombre, paso, detalle });
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}
const errores = (rs) => rs.map((r) => r.error?.message ?? "ok").join(" | ");
const contar = async (tabla, filtro) => {
  let q = svc.from(tabla).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filtro)) q = q.eq(k, v);
  const r = await q;
  if (r.error) throw new Error(`contar ${tabla}: ${r.error.message}`);
  return r.count;
};

// Carrera forzada y repetible (no depende de la suerte de la red): dos
// conexiones directas a dev con el rol y el JWT de quien llama, como
// PostgREST. La primera hace su paso y se queda con la transacción abierta;
// la segunda hace el suyo. Si a los 1.5 s no terminó es que esperó un
// candado. Luego se confirma la primera y se ve qué respondió la segunda.
async function carreraForzada(quien, paso1, paso2, { confirmarSegunda }) {
  const c1 = await conectarDevEscritura();
  const c2 = await conectarDevEscritura();
  const como = async (c) => {
    await c.q("begin");
    await c.q(`set local role ${quien.rol === "anon" ? "anon" : "authenticated"}`);
    await c.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: quien.rol, ...(quien.uid ? { sub: quien.uid } : {}) })]);
    if (quien.uid) await c.q("select set_config('request.jwt.claim.sub', $1, true)", [quien.uid]);
  };
  try {
    await como(c1);
    const primera = await paso1(c1);
    await como(c2);
    let termino = false;
    const p2 = paso2(c2).then((r) => ({ r }), (e) => ({ e })).finally(() => { termino = true; });
    await new Promise((r) => setTimeout(r, 1500));
    const esperó = !termino;
    await c1.q("commit");
    const res = await p2;
    await c2.q(res.e || !confirmarSegunda ? "rollback" : "commit");
    return { esperó, primera, segunda: res.r, error: res.e?.message };
  } finally {
    await c1.q("rollback").catch(() => {});
    await c2.q("rollback").catch(() => {});
    await c1.fin();
    await c2.fin();
  }
}

async function usuario(clave, role, club = null) {
  const email = `${TAG}_${clave.toLowerCase()}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  U[clave] = { id: u.user.id, email };
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `T rls ${clave} ${TAG}`, role, club_id: club ? clubs[club] : null, activo: true }), "perfil " + clave);
  return u.user.id;
}
async function sesion(clave) {
  const c = nuevoAnon();
  ok(await c.auth.signInWithPassword({ email: U[clave].email, password: PASS }), "login " + clave);
  return c;
}
async function crearClub(k, extra = {}) {
  const r = ok(await svc.from("clubs").insert({
    nombre: `T rls conc ${k} ${TAG}`, direccion: "Calle prueba 1", horario: "22:00-03:00", pago_rp_modo: "reserva",
    comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0, ...extra,
  }).select("id").single(), "club " + k);
  clubs[k] = r.id;
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true }).eq("id", r.id), "publicar " + k);
  const dueno = await usuario("dueno" + k, "dueno");
  ok(await svc.from("clubs").update({ dueno_id: dueno }).eq("id", r.id), "dueño " + k);
  return r.id;
}

async function limpiar() {
  const clubIds = Object.values(clubs);
  const perfiles = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    const extra = await db.q("select id from auth.users where email like $1", [`${TAG}%`]);
    for (const x of extra) if (!perfiles.includes(x.id)) perfiles.push(x.id);
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    const borrar = async (sql, p) => {
      await db.q("savepoint s");
      try { await db.cliente.query(sql, p); await db.q("release savepoint s"); } catch (e) { await db.q("rollback to savepoint s"); console.log("  limpieza: " + e.message); }
    };
    if (clubIds.length) {
      // Post-junta-3 primero (POS, propinas e inventario apuntan a la caja y a productos sin cascada).
      for (const t of ["pos_ventas", "pos_importacion_lineas", "pos_importaciones", "pos_mapeos", "propinas_reparto_lineas", "propinas_repartos",
        "propinas_cobro_anuladas", "caja_propinas", "propinas_config", "producto_movimientos", "lista_negra_eventos", "club_bloqueos",
        "club_noshow_politica", "club_funciones", "funciones_cambios"])
        await borrar(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos", "productos"])
        await borrar(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await borrar("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      await borrar("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      await borrar("delete from public.reserva_intentos where club_id = any($1::uuid[])", [clubIds]);
      await borrar("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
      await borrar("update public.clubs set dueno_id = null where id = any($1::uuid[])", [clubIds]);
    }
    // Si el caso 13 se cortó con /para-clubes encendida por nosotros, se apaga aquí (así estaba).
    if (paraClubesAntes === false) await borrar("update public.plataforma_banderas set activa = false where clave = 'para_clubes'", []);
    // /para-clubes (50): contactos de prueba, sus intentos (huellas de las IP y correos de prueba) y la bitácora de los admins de prueba.
    await borrar("delete from public.contactos_clubes where correo like $1", [`${TAG}%`]);
    if (huellasContacto.length) await borrar("delete from public.contacto_intentos where ip_hash = any($1) or correo_hash = any($1)", [huellasContacto]);
    if (perfiles.length) await borrar("delete from public.para_clubes_bitacora where hecho_por = any($1::uuid[])", [perfiles]);
    // Primero los perfiles (el personal apunta al antro), luego los antros.
    if (perfiles.length) await borrar("delete from public.profiles where id = any($1::uuid[])", [perfiles]);
    if (clubIds.length) await borrar("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of perfiles) await svc.auth.admin.deleteUser(id);
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from public.profiles where nombre like $1)::int perfiles,
            (select count(*) from auth.users where email like $2)::int usuarios,
            ((select count(*) from public.contactos_clubes where correo like $2)
             + (select count(*) from public.contacto_intentos where ip_hash = any($3) or correo_hash = any($3)))::int contactos`,
    [`%${TAG}%`, `${TAG}%`, huellasContacto],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
  if (quedan[0].clubs || quedan[0].perfiles || quedan[0].usuarios || quedan[0].contactos) revisar("la limpieza no deja restos", false, JSON.stringify(quedan[0]));
}

// ======================= Post-junta-3 (antro C, casos 7–13) =======================
async function casosPostJunta3(db) {
  await crearClub("C");
  for (const [k, r] of [["staffC1", "staff"], ["staffC2", "staff"], ["staffC3", "staff"], ["gerenteC1", "gerente"], ["gerenteC2", "gerente"], ["rpC", "rp"]]) await usuario(k, r, "C");
  for (const k of ["admin1", "admin2"]) await usuario(k, "admin");
  const P = {};
  for (const k of ["staffC1", "staffC2", "staffC3", "gerenteC1", "gerenteC2", "rpC", "duenoC", "admin1", "admin2"]) P[k] = await sesion(k);
  const C = clubs.C;
  const nocheC = (await db.q("select public.club_fecha_operacion($1, now())::text as f", [C]))[0].f;
  const m = ok(await svc.from("club_tables").insert([1, 2, 3].map((n) => ({ club_id: C, numero: `C${n}`, capacidad: 8 }))).select("id, numero"), "mesas C");
  const mesaC = Object.fromEntries(m.map((x) => [x.numero, x.id]));
  // Banderas de C: solo este antro de prueba, por la función del admin; se van con el antro.
  for (const f of ["pos_ventas", "escaner_respaldo", "lista_negra", "inventario", "propinas"])
    ok(await P.admin1.rpc("funcion_cambiar", { p_club_id: C, p_funcion: f, p_activa: true }), "bandera " + f);
  console.log(`\nAntro C (post-junta-3): noche ${nocheC}`);

  // ======================= 7. Banderas =======================
  console.log("\n== 7. Dos admins cambian la misma bandera a la vez");
  const cambiar = (s, v) => s.rpc("funcion_cambiar", { p_club_id: C, p_funcion: "whatsapp", p_activa: v });
  const rondas = [];
  for (let i = 0; i < 6; i++) rondas.push(...(await Promise.all([cambiar(P.admin1, i % 2 === 0), cambiar(P.admin2, i % 2 === 1)])));
  rondas.push(...(await Promise.all([cambiar(P.admin1, true), cambiar(P.admin2, null)])));
  revisar("7a. 14 cambios a la vez (7 rondas de 2 admins): todos responden bien", rondas.every((r) => !r.error), errores(rondas.filter((r) => r.error)));
  const estadoWA = async () => {
    const v = (await db.q("select activa from public.club_funciones where club_id = $1 and funcion = 'whatsapp'", [C]))[0]?.activa ?? null;
    const u = (await db.q(`select activa, (select count(*)::int from public.funciones_cambios where club_id = $1 and funcion = 'whatsapp') n
      from public.funciones_cambios where club_id = $1 and funcion = 'whatsapp' order by id desc limit 1`, [C]))[0];
    return { guardado: v, ultimo: u?.activa ?? null, n: u?.n ?? 0 };
  };
  const e7 = await estadoWA();
  revisar("7b. lo guardado es lo último de la bitácora (ningún cambio perdido ni fuera de orden)", e7.guardado === e7.ultimo, JSON.stringify(e7));
  revisar("7c. la bitácora tiene los 14 cambios", e7.n === 14, String(e7.n));
  const veApp = ok(await P.gerenteC1.rpc("mis_funciones", { p_club_id: C }), "mis_funciones").includes("whatsapp");
  revisar("7d. lo que ve la app (mis_funciones) es lo guardado", veApp === (e7.guardado === true), `app ${veApp}, base ${e7.guardado}`);
  const sqlBandera = "select public.funcion_cambiar($1, 'whatsapp', $2)";
  const cb = await carreraForzada({ rol: "authenticated", uid: U.admin1.id }, (c) => c.q(sqlBandera, [C, true]), (c) => c.q(sqlBandera, [C, false]), { confirmarSegunda: true });
  const e7b = await estadoWA();
  revisar("7e. carrera forzada: el segundo cambio espera al primero y queda al final", cb.esperó && !cb.error && e7b.guardado === false && e7b.ultimo === false, `esperó ${cb.esperó}; ${cb.error ?? ""} ${JSON.stringify(e7b)}`);

  // ======================= 8. POS =======================
  console.log("\n== 8. Dos gerentes importan el mismo archivo del POS a la vez");
  const huellaArchivo = (s) => createHash("sha256").update(TAG + s).digest("hex");
  const linea = (n, ticket, total) => ({ linea: n, ticket, fecha_hora: `${nocheC}T23:${String(10 + n).padStart(2, "0")}`, producto: `Producto ${ticket}`, total_centavos: total });
  const importar = (s, h, lineas) => s.rpc("pos_importar", { p_club_id: C, p_archivo_nombre: `ventas-${TAG}.csv`, p_archivo_hash: h, p_formato: "csv", p_mapeo_id: null, p_lineas: lineas });
  const ventas = async () => (await db.q("select count(*)::int n, count(distinct clave)::int d from public.pos_ventas where club_id = $1", [C]))[0];
  const archivo1 = [linea(1, "A1", 1000), linea(2, "A2", 2000), linea(3, "A3", 3000)];
  const imp = await Promise.all([P.gerenteC1, P.gerenteC2, P.duenoC].map((s) => importar(s, huellaArchivo("f1"), archivo1)));
  revisar("8a. el mismo archivo 3 veces a la vez (2 gerentes y el dueño): entra exactamente una importación", imp.filter((r) => !r.error).length === 1, errores(imp));
  revisar("8b. las otras reciben un aviso claro (P0001: «ya se importó» o «se acaban de importar»)", imp.filter((r) => r.error).every((r) => r.error.code === "P0001" && /ya se importó|acaban de importar/.test(r.error.message)), errores(imp));
  const v8 = await ventas();
  revisar("8c. 3 ventas, cada línea una sola vez", v8.n === 3 && v8.d === 3, JSON.stringify(v8));
  revisar("8d. una sola importación vigente con esa huella", (await db.q("select count(*)::int n from public.pos_importaciones where club_id = $1 and archivo_hash = $2 and deshecha_en is null", [C, huellaArchivo("f1")]))[0].n === 1);
  // Dos archivos distintos que se enciman (B2 viene en los dos), a la vez.
  const x = [linea(4, "B1", 100), linea(5, "B2", 200)];
  const y = [{ ...linea(5, "B2", 200), linea: 1 }, { ...linea(6, "B3", 300), linea: 2 }];
  const xy = await Promise.all([importar(P.gerenteC1, huellaArchivo("x"), x), importar(P.gerenteC2, huellaArchivo("y"), y)]);
  revisar("8e. dos archivos que se enciman, a la vez: entran los dos", xy.every((r) => !r.error), errores(xy));
  const nuevas = xy.reduce((s, r) => s + (r.data?.nuevas ?? 0), 0);
  const repetidas = xy.reduce((s, r) => s + (r.data?.repetidas ?? 0), 0);
  const v8b = await ventas();
  revisar("8f. la línea que traen los dos entra una vez (3 nuevas, 1 repetida, 6 ventas)", nuevas === 3 && repetidas === 1 && v8b.n === 6 && v8b.d === 6, `nuevas ${nuevas}, repetidas ${repetidas}, ${JSON.stringify(v8b)}`);
  const desh = await Promise.all([P.gerenteC1, P.gerenteC2].map((s) => s.rpc("pos_importacion_deshacer", { p_importacion_id: xy[0].data?.importacion_id, p_motivo: "prueba t_rls" })));
  revisar("8g. deshacer el mismo archivo dos veces a la vez: pasa uno", desh.filter((r) => !r.error).length === 1, errores(desh));
  revisar("8h. el otro recibe «ya se deshizo» (P0001)", desh.some((r) => r.error?.code === "P0001" && /ya se deshizo/.test(r.error.message)), errores(desh));
  const porTicket = async (t) => (await db.q("select count(*)::int n from public.pos_ventas where club_id = $1 and ticket = $2", [C, t]))[0].n;
  const [b1, b2] = [await porTicket("B1"), await porTicket("B2")];
  revisar("8i. al deshacer, la línea que también trae el otro archivo se queda (B2 una vez) y la propia se va (B1)", b1 === 0 && b2 === 1, `B1 ${b1}, B2 ${b2}`);
  const sqlImp = "select public.pos_importar($1, 'forzada.csv', $2, 'csv', null, $3::jsonb)::text as r";
  const z = JSON.stringify([linea(7, "Z1", 700)]);
  const ci = await carreraForzada({ rol: "authenticated", uid: U.gerenteC1.id }, (c) => c.q(sqlImp, [C, huellaArchivo("z"), z]), (c) => c.q(sqlImp, [C, huellaArchivo("z"), z]), { confirmarSegunda: true });
  revisar("8j. carrera forzada: la segunda importación espera el candado del antro y recibe «ya se importó»", ci.esperó && /ya se importó/.test(ci.error ?? ""), `esperó ${ci.esperó}; ${ci.error ?? "PASÓ"}`);
  // Dos gerentes guardan a la vez un mapeo NUEVO con el mismo nombre («guarda o reemplaza por nombre»).
  const sqlMapeo = "select public.pos_mapeo_guardar($1, $2, '{\"columnas\": {\"ticket\": \"Folio\"}}'::jsonb)::text as id";
  const nombreMapeo = `Mapeo ${TAG}`;
  const cm = await carreraForzada({ rol: "authenticated", uid: U.gerenteC1.id }, (c) => c.q(sqlMapeo, [C, nombreMapeo]), (c) => c.q(sqlMapeo, [C, nombreMapeo]), { confirmarSegunda: true });
  const mapeos = (await db.q("select count(*)::int n from public.pos_mapeos where club_id = $1 and lower(btrim(nombre)) = lower($2)", [C, nombreMapeo]))[0].n;
  revisar("8k. carrera forzada: dos mapeos nuevos con el mismo nombre dejan uno solo", mapeos === 1, String(mapeos));
  revisar("8l. …y el segundo lo reemplaza o recibe un aviso claro (no el error crudo del índice)", !cm.error || !/duplicate key|23505/.test(cm.error), `esperó ${cm.esperó}; ${cm.error ?? "lo reemplazó"}`);

  // ======================= 9. Entrada diferida =======================
  console.log("\n== 9. Dos staff mandan la misma entrada diferida desde dos teléfonos");
  const reservaC = async () => {
    const R = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000777", personas: 2, status: "confirmada", source: "rp", rp_id: U.rpC.id, club_id: C, fecha: nocheC, qr_code: `antro-${randomUUID()}` };
    ok(await svc.from("reservations").insert(R), "reserva C");
    return R;
  };
  const diferida = (s, R, clave = randomUUID()) => s.rpc("puerta_entrada_diferida", { p_club_id: C, p_reservation_id: R.id, p_clave: clave, p_escaneado_en: new Date(Date.now() - 60000).toISOString() });
  const eventos = async (tipo, R) => (await db.q("select count(*)::int n from public.caja_eventos where club_id = $1 and tipo = $2 and detalle->>'reservation_id' = $3", [C, tipo, R.id]))[0].n;
  const R9 = await reservaC();
  const d9 = await Promise.all([diferida(P.staffC1, R9), diferida(P.staffC2, R9)]);
  revisar("9a. las dos responden bien (que ya haya entrado no es error)", d9.every((r) => !r.error), errores(d9));
  const res9 = d9.map((r) => r.data?.resultado).sort().join(",");
  revisar("9b. una «entro» y la otra «ya_entro»", res9 === "entro,ya_entro", res9);
  const perdio = d9.find((r) => r.data?.resultado === "ya_entro")?.data;
  revisar("9c. la otra dice que fue otra cuenta y a qué hora", perdio?.por_ti === false && /^\d{2}:\d{2}$/.test(perdio?.hora_local ?? ""), JSON.stringify(perdio));
  revisar("9d. un solo evento de entrada y uno de envío diferido", (await eventos("puerta_confirmar_entrada", R9)) === 1 && (await eventos("puerta_entrada_diferida", R9)) === 1);
  const R9b = await reservaC();
  const k9 = randomUUID();
  const t9 = await Promise.all([1, 2, 3].map(() => diferida(P.staffC1, R9b, k9)));
  const r9b = t9.map((r) => r.data?.resultado);
  revisar("9e. el mismo envío 3 veces a la vez (misma clave, mismo teléfono): todos bien y exactamente una «entro»", t9.every((r) => !r.error) && r9b.filter((v) => v === "entro").length === 1, `${r9b.join(",")} ${errores(t9)}`);
  revisar("9f. …los otros dicen «ya_enviada» o «ya_entro» por ti", t9.filter((r) => r.data?.resultado !== "entro").every((r) => r.data?.resultado === "ya_enviada" || (r.data?.resultado === "ya_entro" && r.data?.por_ti === true)), JSON.stringify(t9.map((r) => r.data?.resultado + "/" + r.data?.por_ti)));
  revisar("9g. …un solo evento de entrada", (await eventos("puerta_confirmar_entrada", R9b)) === 1);
  const despues9 = await diferida(P.staffC1, R9b, k9);
  revisar("9h. el reintento posterior responde «ya_enviada»", despues9.data?.resultado === "ya_enviada", JSON.stringify(despues9.data ?? despues9.error?.message));
  const R9c = await reservaC();
  const mal9 = await diferida(P.staffC1, R9c, k9);
  revisar("9i. la misma clave con otra reserva se rechaza (P0001)", mal9.error?.code === "P0001" && /otra reserva/.test(mal9.error.message), mal9.error?.message ?? "PASÓ");
  const R9d = await reservaC();
  const camara = (async () => {
    const e = await P.staffC3.rpc("puerta_escanear", { p_qr: R9d.qr_code });
    return e.error ? e : P.staffC3.rpc("puerta_confirmar_entrada", { p_reservation_id: R9d.id });
  })();
  const [dc, cc] = await Promise.all([diferida(P.staffC2, R9d), camara]);
  const entraron = [dc.data?.resultado === "entro", !cc.error].filter(Boolean).length;
  revisar("9j. diferida y cámara a la vez: entra exactamente una vez", entraron === 1 && (await eventos("puerta_confirmar_entrada", R9d)) === 1, `diferida ${JSON.stringify(dc.data?.resultado ?? dc.error?.message)}; cámara ${cc.error?.message ?? "ok"}`);
  revisar("9k. …y quien pierde recibe un aviso claro", dc.data?.resultado === "ya_entro" || /ya entró/.test(cc.error?.message ?? ""), `${dc.data?.resultado ?? dc.error?.message} / ${cc.error?.message ?? "ok"}`);

  // ======================= 10. Lista negra =======================
  console.log("\n== 10. Lista negra: bloqueos y reservas del mismo teléfono a la vez");
  const tel = () => "55" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const bloquear = (s, t) => s.rpc("lista_negra_bloquear", { p_club: C, p_telefono: t, p_reserva_id: null, p_motivo: "prueba t_rls", p_dias: null });
  const abiertos = async (t) => (await db.q("select count(*)::int n from public.club_bloqueos where club_id = $1 and telefono = $2 and desbloqueado_en is null", [C, t]))[0].n;
  const t1 = tel();
  const b10 = await Promise.all([P.gerenteC1, P.gerenteC2, P.duenoC].map((s) => bloquear(s, t1)));
  revisar("10a. tres bloqueos del mismo teléfono a la vez: un solo bloqueo abierto", (await abiertos(t1)) === 1 && b10.filter((r) => !r.error).length === 1, errores(b10));
  revisar("10b. los otros reciben «ya está bloqueado» (P0001), no un error crudo de la base", b10.filter((r) => r.error).every((r) => r.error.code === "P0001" && /ya está bloqueado/.test(r.error.message)), b10.map((r) => (r.error ? `${r.error.code} ${r.error.message}` : "ok")).join(" | "));
  const t1b = tel();
  const sqlBloq = "select public.lista_negra_bloquear($1, $2, null, 'prueba t_rls', null)::text as id";
  const cbq = await carreraForzada({ rol: "authenticated", uid: U.gerenteC1.id }, (c) => c.q(sqlBloq, [C, t1b]), (c) => c.q(sqlBloq, [C, t1b]), { confirmarSegunda: true });
  revisar("10c. carrera forzada: el segundo bloqueo espera al primero y recibe «ya está bloqueado»", cbq.esperó && /ya está bloqueado/.test(cbq.error ?? ""), `esperó ${cbq.esperó}; ${cbq.error ?? "PASÓ"}`);
  revisar("10d. …y queda un solo bloqueo abierto", (await abiertos(t1b)) === 1);
  const reservaRp = (t) => P.rpC.from("reservations").insert({ cliente_nombre: `Cliente ${TAG}`, cliente_telefono: t, personas: 2, fecha: nocheC, club_id: C, qr_code: `antro-${randomUUID()}`, status: "pendiente", source: "rp", rp_id: U.rpC.id });
  const avisoRp = /no puede reservar en este antro por ahora/;
  const bienOAviso = (r) => !r.error || (r.error.code === "P0001" && avisoRp.test(r.error.message));
  const t2 = tel();
  const [bq, ...rs] = await Promise.all([bloquear(P.gerenteC1, t2), ...[1, 2, 3, 4].map(() => reservaRp(t2))]);
  revisar("10e. bloqueo y 4 reservas del RP con ese teléfono a la vez: el bloqueo entra", !bq.error, bq.error?.message ?? "");
  revisar("10f. …cada reserva entra (llegó antes) o recibe el aviso para el RP (P0001), sin otros errores", rs.every(bienOAviso), errores(rs));
  const tras = await reservaRp(t2);
  revisar("10g. con el bloqueo ya guardado, la siguiente reserva se rechaza", tras.error?.code === "P0001" && avisoRp.test(tras.error.message), tras.error?.message ?? "PASÓ");
  const [dq, ...rs2] = await Promise.all([P.gerenteC2.rpc("lista_negra_desbloquear", { p_club: C, p_bloqueo_id: bq.data, p_reserva_id: null, p_motivo: "prueba t_rls" }), ...[1, 2, 3].map(() => reservaRp(t2))]);
  revisar("10h. desbloqueo y 3 reservas a la vez: el desbloqueo entra y cada reserva entra o recibe el aviso", !dq.error && rs2.every(bienOAviso), `${dq.error?.message ?? "ok"}; ${errores(rs2)}`);
  const libre = await reservaRp(t2);
  revisar("10i. ya desbloqueado, la siguiente reserva entra", !libre.error, libre.error?.message ?? "");
  const idB1 = b10.find((r) => !r.error)?.data;
  const d10 = await Promise.all([P.gerenteC1, P.duenoC].map((s) => s.rpc("lista_negra_desbloquear", { p_club: C, p_bloqueo_id: idB1, p_reserva_id: null, p_motivo: "prueba t_rls" })));
  revisar("10j. dos desbloqueos a la vez: pasa uno", d10.filter((r) => !r.error).length === 1, errores(d10));
  revisar("10k. el otro recibe «no está bloqueado» (P0001)", d10.some((r) => r.error?.code === "P0001" && /no está bloqueado/.test(r.error.message)), errores(d10));
  const ev10 = (await db.q("select count(*)::int n from public.lista_negra_eventos where club_id = $1 and tipo = 'desbloqueo' and telefono = $2", [C, t1]))[0].n;
  revisar("10l. un solo evento de desbloqueo y el bloqueo cerrado", ev10 === 1 && (await abiertos(t1)) === 0, `eventos ${ev10}`);

  // ======================= 11. Inventario =======================
  console.log("\n== 11. Inventario: dos staff venden la última pieza a la vez");
  const prod = ok(await P.gerenteC1.rpc("producto_guardar", { p_club_id: C, p_id: null, p_nombre: `Botella ${TAG}`, p_categoria: "Botellas", p_precio_centavos: 100000, p_existencias_minimas: 0, p_activo: true, p_existencias_iniciales: 1 }), "producto");
  const existencias = async () => (await db.q(`select p.existencias,
      (select coalesce(sum(m.cantidad), 0)::int from public.producto_movimientos m where m.producto_id = p.id) bitacora,
      (select count(*)::int from public.producto_movimientos m where m.producto_id = p.id and m.tipo = 'venta') ventas
    from public.productos p where p.id = $1`, [prod]))[0];
  const sC1 = ok(await P.staffC1.rpc("caja_abrir_mesa", { p_mesa_id: mesaC.C1 }), "abrir C1");
  const sC2 = ok(await P.staffC2.rpc("caja_abrir_mesa", { p_mesa_id: mesaC.C2 }), "abrir C2");
  const cu1 = ok(await P.staffC1.rpc("caja_sentar_cliente", { p_sesion_id: sC1, p_cliente_nombre: "Walk-in t_rls", p_personas: 2 }), "sentar 1");
  const cu2 = ok(await P.staffC2.rpc("caja_sentar_cliente", { p_sesion_id: sC2, p_cliente_nombre: "Walk-in t_rls", p_personas: 2 }), "sentar 2");
  const vender = (s, cuenta, clave = randomUUID()) => s.rpc("caja_registrar_consumo_producto", { p_cuenta_id: cuenta, p_producto_id: prod, p_cantidad: 1, p_clave: clave });
  const v11 = await Promise.all([vender(P.staffC1, cu1), vender(P.staffC2, cu2)]);
  const e11 = await existencias();
  revisar("11a. las dos ventas de la última pieza pasan (vender sin existencias es a propósito: decisión 2 de docs/post-junta-3/fase2.md)", v11.every((r) => !r.error), errores(v11));
  revisar("11b. ninguna venta se pierde: existencias 1 − 2 = −1 y dos movimientos de venta", e11.existencias === -1 && e11.ventas === 2, JSON.stringify(e11));
  revisar("11c. existencias = suma de la bitácora", e11.existencias === e11.bitacora, JSON.stringify(e11));
  const kv = randomUUID();
  const rv = await Promise.all([1, 2, 3].map(() => vender(P.staffC1, cu1, kv)));
  const e11b = await existencias();
  revisar("11d. la misma venta (misma clave) 3 veces a la vez: un consumo y un descuento", rv.every((r) => !r.error) && new Set(rv.map((r) => r.data)).size === 1 && e11b.existencias === -2 && e11b.ventas === 3 && e11b.bitacora === -2, `${errores(rv)} ${JSON.stringify(e11b)}`);
  const mov = await Promise.all([
    P.gerenteC1.rpc("inventario_entrada", { p_producto_id: prod, p_cantidad: 10, p_clave: randomUUID() }),
    P.gerenteC2.rpc("inventario_merma", { p_producto_id: prod, p_cantidad: 3, p_motivo: "se rompió (prueba)", p_clave: randomUUID() }),
    vender(P.staffC2, cu2),
  ]);
  const e11c = await existencias();
  revisar("11e. entrada (+10), merma (−3) y venta (−1) a la vez: quedan 4 y cuadran con la bitácora", mov.every((r) => !r.error) && e11c.existencias === 4 && e11c.bitacora === 4, `${errores(mov)} ${JSON.stringify(e11c)}`);
  const km = randomUUID();
  const mm = await Promise.all([1, 2].map(() => P.gerenteC1.rpc("inventario_merma", { p_producto_id: prod, p_cantidad: 1, p_motivo: "derrame (prueba)", p_clave: km })));
  const e11d = await existencias();
  revisar("11f. la misma merma (misma clave) 2 veces a la vez: se descuenta una vez", mm.every((r) => !r.error) && e11d.existencias === 3 && e11d.bitacora === 3, `${errores(mm)} ${JSON.stringify(e11d)}`);
  const cont = await Promise.all([
    P.gerenteC2.rpc("inventario_conteo", { p_producto_id: prod, p_contado: 3, p_motivo: null, p_clave: randomUUID(), p_existencias_vistas: 3 }),
    vender(P.staffC1, cu1),
  ]);
  const e11e = await existencias();
  const difConteo = (await db.q("select cantidad from public.producto_movimientos where producto_id = $1 and tipo = 'conteo' order by orden desc limit 1", [prod]))[0]?.cantidad;
  revisar("11g. conteo (vistas 3, contadas 3) y una venta a la vez: la venta no se absorbe (quedan 2, diferencia del conteo 0)", cont.every((r) => !r.error) && e11e.existencias === 2 && e11e.bitacora === 2 && difConteo === 0, `${errores(cont)} ${JSON.stringify(e11e)} diferencia ${difConteo}`);

  // ======================= 12. Propinas =======================
  console.log("\n== 12. Propinas: dos gerentes reparten la misma noche a la vez");
  ok(await P.gerenteC1.rpc("propinas_config_guardar", { p_club_id: C, p_pct_personal: 80, p_pct_rp: 10, p_pct_casa: 10, p_incluye_gerente: false }), "regla de propinas");
  const nocheId = (await db.q("select id::text from public.caja_noches where club_id = $1 and fecha_operacion = $2", [C, nocheC]))[0].id;
  const propina = (s, sesion, cuenta, monto) => s.rpc("caja_registrar_propina", { p_noche_id: nocheId, p_sesion_id: sesion, p_cuenta_id: cuenta, p_metodo: "efectivo", p_monto_centavos: monto, p_nota: "prueba t_rls", p_clave: randomUUID() });
  ok(await propina(P.staffC1, sC1, cu1, 2000), "propina en mesa");
  const suelta = ok(await propina(P.staffC2, null, null, 500), "propina suelta");
  const saldo = async (s) => Number((await db.q(`select (select coalesce(sum(monto_centavos), 0) from public.caja_consumos where sesion_id = $1 and not anulado)
      - (select coalesce(sum(monto_centavos), 0) from public.caja_pagos where sesion_id = $1 and not anulado) as s`, [s]))[0].s);
  for (const [s, propinaCobro] of [[sC1, 1000], [sC2, 0]]) {
    const x = await saldo(s);
    if (x > 0) ok(await P.staffC1.rpc("caja_registrar_pago", { p_sesion_id: s, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: x, p_clave: randomUUID(), p_saldo_esperado: x, p_propina_centavos: propinaCobro }), "cobro");
    ok(await P.gerenteC1.rpc("caja_cerrar_mesa", { p_sesion_id: s }), "cerrar mesa");
    ok(await P.gerenteC1.rpc("caja_cuadrar_mesa", { p_sesion_id: s, p_notas: null }), "cuadrar mesa");
  }
  const efectivo = Number((await db.q("select coalesce(sum(monto_centavos), 0) s from public.caja_pagos where noche_id = $1 and not anulado and metodo = 'efectivo'", [nocheId]))[0].s);
  ok(await P.gerenteC1.rpc("caja_cerrar_noche", { p_noche_id: nocheId, p_contado_efectivo_centavos: efectivo, p_contado_tarjeta_centavos: 0, p_contado_otro_centavos: 0, p_notas: null }), "cerrar noche");
  const totalPropinas = async () => Number(ok(await P.gerenteC1.rpc("propinas_reporte_noche", { p_club_id: C, p_fecha: nocheC }), "reporte de propinas").total_centavos);
  const regla = { p_pct_personal: 80, p_pct_rp: 10, p_pct_casa: 10, p_incluye_gerente: false };
  const repartir = (s, part, total) => s.rpc("propinas_repartir", { p_noche_id: nocheId, p_participantes: part, p_total_visto: total, ...regla });
  const vigentes = async () => db.q(`select r.id::text, r.total_centavos::bigint t,
      (select coalesce(sum(l.monto_centavos), 0)::bigint from public.propinas_reparto_lineas l where l.reparto_id = r.id) s
    from public.propinas_repartos r where r.noche_id = $1 and not r.anulado`, [nocheId]);
  const anularVigentes = async () => { for (const v of await vigentes()) ok(await P.gerenteC1.rpc("propinas_anular_reparto", { p_reparto_id: v.id, p_motivo: "prueba t_rls" }), "anular reparto"); };
  const tot1 = await totalPropinas();
  const [an, rp1] = await Promise.all([P.gerenteC2.rpc("caja_anular_propina", { p_propina_id: suelta, p_motivo: "prueba t_rls" }), repartir(P.gerenteC1, [U.staffC1.id], tot1)]);
  revisar("12a. anular una propina y repartir a la vez: pasa exactamente uno", [an, rp1].filter((r) => !r.error).length === 1, errores([an, rp1]));
  revisar("12b. …el que pierde recibe un aviso claro (P0001: «ya se repartió» o «las propinas cambiaron»)", [an, rp1].filter((r) => r.error).every((r) => r.error.code === "P0001" && /ya se repartió|propinas cambiaron/.test(r.error.message)), errores([an, rp1]));
  const tot1b = await totalPropinas();
  const v12 = await vigentes();
  revisar("12c. …y nunca queda un reparto con una propina anulada (reparto = propinas vigentes)", v12.every((v) => Number(v.t) === tot1b && Number(v.s) === tot1b), `${JSON.stringify(v12)}; vigentes ${tot1b}`);
  await anularVigentes();
  const tot2 = await totalPropinas();
  const mismo = await Promise.all([repartir(P.gerenteC1, [U.staffC1.id, U.staffC2.id], tot2), repartir(P.gerenteC2, [U.staffC2.id, U.staffC1.id], tot2)]);
  const v12b = await vigentes();
  revisar("12d. el mismo reparto dos veces a la vez (doble clic): los dos responden con el mismo reparto", mismo.every((r) => !r.error) && mismo[0].data === mismo[1].data, errores(mismo));
  revisar("12e. …un solo reparto vigente y sus líneas suman el total", v12b.length === 1 && Number(v12b[0].t) === tot2 && Number(v12b[0].s) === tot2, JSON.stringify(v12b));
  await anularVigentes();
  const dist = await Promise.all([repartir(P.gerenteC1, [U.staffC1.id], tot2), repartir(P.gerenteC2, [U.staffC2.id, U.staffC3.id], tot2), repartir(P.duenoC, [U.staffC3.id], tot2)]);
  const v12c = await vigentes();
  revisar("12f. tres repartos distintos a la vez: pasa exactamente uno", dist.filter((r) => !r.error).length === 1 && v12c.length === 1, errores(dist));
  revisar("12g. los otros reciben «ya se repartió» (P0001)", dist.filter((r) => r.error).every((r) => r.error.code === "P0001" && /ya se repartió/.test(r.error.message)), errores(dist));
  revisar("12h. el reparto vigente cuadra al centavo", v12c.length === 1 && Number(v12c[0].s) === tot2, JSON.stringify(v12c));
  await anularVigentes();
  const sqlRep = "select public.propinas_repartir($1, $2::uuid[], $3, 80, 10, 10, false)::text as id";
  const cr = await carreraForzada({ rol: "authenticated", uid: U.gerenteC1.id }, (c) => c.q(sqlRep, [nocheId, [U.staffC1.id], tot2]), (c) => c.q(sqlRep, [nocheId, [U.staffC2.id], tot2]), { confirmarSegunda: true });
  revisar("12i. carrera forzada: el segundo reparto espera el candado de la noche y recibe «ya se repartió»", cr.esperó && /ya se repartió/.test(cr.error ?? ""), `esperó ${cr.esperó}; ${cr.error ?? "PASÓ"}`);
  revisar("12j. un solo reparto vigente al final", (await vigentes()).length === 1);

  // ======================= 13. /para-clubes =======================
  console.log("\n== 13. Formulario de /para-clubes: ráfagas contra los topes");
  const enLaHora = (await db.q("select count(*)::int n from public.contacto_intentos where creado_en > now() - interval '1 hour'"))[0].n;
  const fila = (await db.q("select activa from public.plataforma_banderas where clave = 'para_clubes'"))[0];
  if (!fila || enLaHora > 40) {
    console.log(`  (se salta: ${!fila ? "no existe la bandera para_clubes en dev" : `${enLaHora} envíos en la última hora; el tope global de 60 la haría poco fiable`})`);
    return;
  }
  const huella = async (t) => (await db.q("select public.contacto_huella($1) as h", [t]))[0].h;
  const ip = () => `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const correo = (n) => `${TAG}_c${n}@example.com`;
  const enviar = async (c, i, extra = {}) => {
    huellasContacto.push(await huella("ip:" + i), await huella("correo:" + c));
    return svc.rpc("para_clubes_contacto_enviar", { p_nombre: "Prueba Concurrencia", p_club: "Antro de prueba", p_ciudad: "CDMX", p_correo: c, p_ip: i, ...extra });
  };
  const tope = /Ya recibimos varios mensajes/;
  paraClubesAntes = fila.activa;
  try {
    if (!paraClubesAntes) ok(await P.admin1.rpc("plataforma_bandera_cambiar", { p_clave: "para_clubes", p_activa: true }), "encender para_clubes");
    const ipA = ip();
    const r1 = await Promise.all(Array.from({ length: 8 }, (_, i) => enviar(correo(i), ipA)));
    const pasan1 = r1.filter((r) => !r.error && r.data === "recibido").length;
    revisar("13a. 8 envíos a la vez desde la misma conexión: pasan exactamente 3 (tope de 3 por hora)", pasan1 === 3, `pasaron ${pasan1}; ${errores(r1.filter((r) => r.error)).slice(0, 160)}`);
    revisar("13b. los demás reciben el aviso del tope (P0001)", r1.filter((r) => r.error).every((r) => r.error.code === "P0001" && tope.test(r.error.message)), errores(r1.filter((r) => r.error)).slice(0, 160));
    const guardados = (await db.q("select count(*)::int n from public.contacto_intentos where ip_hash = $1", [await huella("ip:" + ipA)]))[0].n;
    revisar("13c. 3 intentos guardados con la huella de esa IP", guardados === 3, String(guardados));
    const c5 = correo("x");
    const r2 = await Promise.all(Array.from({ length: 5 }, () => enviar(c5, ip())));
    const pasan2 = r2.filter((r) => !r.error).length;
    revisar("13d. el mismo correo desde 5 conexiones a la vez: pasan exactamente 3 (tope de 3 por día)", pasan2 === 3 && r2.filter((r) => r.error).every((r) => r.error.code === "P0001" && tope.test(r.error.message)), `pasaron ${pasan2}; ${errores(r2.filter((r) => r.error)).slice(0, 160)}`);
    const ipT = ip();
    const r3 = await Promise.all(Array.from({ length: 5 }, (_, i) => enviar(correo(`t${i}`), ipT, { p_sitio_web: "https://spam.example" })));
    const trampa = (await db.q("select count(*)::int n from public.contacto_intentos where ip_hash = $1", [await huella("ip:" + ipT)]))[0].n;
    revisar("13e. casilla trampa, 5 a la vez: todas responden «recibido» y no se guarda ni se cuenta nada", r3.every((r) => !r.error && r.data === "recibido") && trampa === 0, `${errores(r3)}; guardados ${trampa}`);
    const contactos = (await db.q("select count(*)::int n from public.contactos_clubes where correo like $1", [`${TAG}%`]))[0].n;
    revisar("13f. contactos guardados = envíos aceptados (3 + 3)", contactos === 6, String(contactos));
  } finally {
    if (paraClubesAntes === false) {
      const r = await P.admin1.rpc("plataforma_bandera_cambiar", { p_clave: "para_clubes", p_activa: false });
      if (!r.error) paraClubesAntes = null;
    } else paraClubesAntes = null;
  }
  const ahora = (await db.q("select activa from public.plataforma_banderas where clave = 'para_clubes'"))[0].activa;
  revisar("13g. la bandera para_clubes quedó como estaba", ahora === fila.activa, `antes ${fila.activa}, ahora ${ahora}`);
}

const db = await conectarDevEscritura();
try {
  // ======================= Escenario =======================
  // A: comisión fija de $100 con cuota 2 (la 2a reserva de la semana ya paga).
  await crearClub("A", { comision_desbloqueo_reservas: 2 });
  await crearClub("B");
  for (const [k, r, c] of [["staff1", "staff", "A"], ["staff2", "staff", "A"], ["gerente1", "gerente", "A"], ["gerente2", "gerente", "A"],
    ["rp1", "rp", "A"], ["rp2", "rp", "A"], ["cliente", "cliente", null], ["gerenteB", "gerente", "B"], ["staffB", "staff", "B"]])
    await usuario(k, r, c);
  const noche = (await db.q("select public.club_fecha_operacion($1, now())::text as f", [clubs.A]))[0].f;
  const manana = (await db.q("select ($1::date + 1)::text as f", [noche]))[0].f;
  const mesas = {};
  for (const k of ["A", "B"]) {
    const m = ok(await svc.from("club_tables").insert([1, 2, 3, 4].map((n) => ({ club_id: clubs[k], numero: `T${n}`, capacidad: 8 }))).select("id, numero"), "mesas " + k);
    mesas[k] = Object.fromEntries(m.map((x) => [x.numero, x.id]));
  }
  const reserva = async (rp) => {
    const R = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000777", personas: 4, status: "confirmada",
      source: "rp", rp_id: U[rp].id, club_id: clubs.A, fecha: noche, qr_code: `antro-${randomUUID()}` };
    ok(await svc.from("reservations").insert(R), "reserva");
    return R;
  };
  const S = {};
  for (const k of ["staff1", "staff2", "gerente1", "gerente2", "duenoA", "cliente", "gerenteB", "staffB", "duenoB"]) S[k] = await sesion(k);
  console.log(`Escenario: ${TAG}, antros A y B publicados, noche ${noche}`);
  if (!SOLO_PJ3) {

  // ======================= 1. Escaneo doble =======================
  console.log("\n== 1. Dos staff escanean el mismo QR a la vez");
  const R1 = await reserva("rp1");
  const esc = await Promise.all([S.staff1, S.staff2].map((s) => s.rpc("puerta_escanear", { p_qr: R1.qr_code })));
  revisar("1a. los dos escaneos responden bien (el segundo ve la reserva en puerta)", esc.every((r) => !r.error), errores(esc));
  revisar("1b. un solo evento de escaneo", (await db.q("select count(*)::int n from public.caja_eventos where tipo = 'puerta_escanear' and detalle->>'reservation_id' = $1", [R1.id]))[0].n === 1);
  const conf = await Promise.all([S.staff1, S.staff2].map((s) => s.rpc("puerta_confirmar_entrada", { p_reservation_id: R1.id })));
  const confOk = conf.filter((r) => !r.error).length;
  const perdedor = conf.find((r) => r.error);
  revisar("1c. dos confirmaciones a la vez: entra exactamente una", confOk === 1, errores(conf));
  revisar("1d. la segunda respuesta es clara (\"ya entró\")", /ya entró/i.test(perdedor?.error?.message ?? ""), perdedor?.error?.message ?? "sin error");
  revisar("1e. la segunda respuesta es un aviso de la base (P0001, se muestra tal cual)", perdedor?.error?.code === "P0001", perdedor?.error?.code ?? "");
  const r1 = (await db.q("select status, puerta_estado, entrada_por::text from public.reservations where id = $1", [R1.id]))[0];
  revisar("1f. la reserva queda usada / entró, una sola vez", r1.status === "usada" && r1.puerta_estado === "entro" && [U.staff1.id, U.staff2.id].includes(r1.entrada_por));
  revisar("1g. un solo evento de entrada", (await db.q("select count(*)::int n from public.caja_eventos where tipo = 'puerta_confirmar_entrada' and detalle->>'reservation_id' = $1", [R1.id]))[0].n === 1);

  // Entrada manual (sin cámara): cada staff escanea y confirma, los dos a la vez.
  const R2 = await reserva("rp1");
  const manual = (s) => (async () => {
    const e = await s.rpc("puerta_escanear", { p_qr: R2.qr_code });
    if (e.error) return e;
    return s.rpc("puerta_confirmar_entrada", { p_reservation_id: R2.id });
  })();
  const man = await Promise.all([manual(S.staff1), manual(S.staff2), manual(S.gerente1)]);
  revisar("1h. entrada manual de 3 a la vez: entra exactamente una", man.filter((r) => !r.error).length === 1, errores(man));
  revisar("1i. los otros dos reciben \"ya entró\"", man.filter((r) => /ya entró/i.test(r.error?.message ?? "")).length === 2, errores(man));
  revisar("1j. un solo evento de entrada (manual)", (await db.q("select count(*)::int n from public.caja_eventos where tipo = 'puerta_confirmar_entrada' and detalle->>'reservation_id' = $1", [R2.id]))[0].n === 1);

  // ======================= 2. Reservas duplicadas =======================
  console.log("\n== 2. Dos reservas del mismo cliente, mismo antro y noche, a la vez");
  const resCliente = () => S.cliente.from("reservations").insert({
    cliente_nombre: "Cliente Prueba", cliente_telefono: "5512345678", rp_id: null, club_id: clubs.A, cliente_id: U.cliente.id,
    source: "organica", fecha: manana, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}`,
  });
  const dos = await Promise.all([resCliente(), resCliente()]);
  revisar("2a. dos a la vez: pasa exactamente una", dos.filter((r) => !r.error).length === 1, errores(dos));
  revisar("2b. la otra falla con 23505 (índice único)", dos.some((r) => r.error?.code === "23505"), dos.map((r) => r.error?.code ?? "ok").join(","));
  const cinco = await Promise.all(Array.from({ length: 5 }, resCliente));
  revisar("2c. cinco más a la vez: ninguna pasa, todas 23505", cinco.every((r) => r.error?.code === "23505"), cinco.map((r) => r.error?.code ?? "ok").join(","));
  revisar("2d. el cliente tiene una sola reserva esa noche en ese antro", (await contar("reservations", { cliente_id: U.cliente.id, club_id: clubs.A, fecha: manana })) === 1);
  const pagina = readFileSync(path.join(RAIZ, "app/cliente/reservar/page.tsx"), "utf8");
  revisar("2e. /cliente/reservar traduce 23505 a un mensaje claro", /code\s*===\s*"23505"[\s\S]{0,200}Ya tienes una reserva en este antro/.test(pagina));
  // Los topes de reservas sin cuenta (72/66) avisan con P0001: la pantalla
  // tiene que mostrar ese aviso, no el genérico "Intenta de nuevo".
  revisar("2e'. /cliente/reservar muestra tal cual los avisos de la base (P0001)", /code\s*===\s*"P0001"[\s\S]{0,200}setError\(\s*insertError\.message\s*\)/.test(pagina));
  // Sin cuenta: tope de 3 por teléfono, antro y noche (sql/post-junta-2/72).
  const tieneAntiabuso = (await db.q("select count(*)::int n from pg_trigger where tgname = 'reservations_antiabuso_anon' and not tgisinternal"))[0].n === 1;
  if (tieneAntiabuso) {
    const tel = "55" + String(Date.now()).slice(-8);
    const anon = () => nuevoAnon().from("reservations").insert({
      cliente_nombre: "Anon Prueba", cliente_telefono: tel, rp_id: null, club_id: clubs.A, cliente_id: null,
      source: "organica", fecha: manana, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}`,
    });
    const rafaga = await Promise.all(Array.from({ length: 6 }, anon));
    const pasaron = rafaga.filter((r) => !r.error).length;
    revisar("2f. sin cuenta, 6 a la vez con el mismo teléfono: pasan como mucho 3", pasaron <= 3, `pasaron ${pasaron}; ${errores(rafaga)}`);
    revisar("2g. las rechazadas reciben el aviso del tope (P0001)", rafaga.filter((r) => r.error).every((r) => r.error.code === "P0001"), errores(rafaga));
    // Carrera forzada: con 2 ya guardadas, dos transacciones anónimas abiertas
    // a la vez meten la 3a y la "4a". Sin candado las dos ven 2 y pasan.
    const tel2 = "56" + String(Date.now()).slice(-8);
    for (let i = 0; i < 2; i++) ok(await nuevoAnon().from("reservations").insert({
      cliente_nombre: "Anon Prueba", cliente_telefono: tel2, rp_id: null, club_id: clubs.A, cliente_id: null,
      source: "organica", fecha: manana, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}`,
    }), "reserva anónima previa");
    const ins = `insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, fecha, personas, status, qr_code)
      values ('Anon Prueba', $1, $2, 'organica', $3, 2, 'pendiente', $4)`;
    const carrera = await carreraForzada({ rol: "anon" },
      (c) => c.q(ins, [tel2, clubs.A, manana, `antro-${randomUUID()}`]),
      (c) => c.q(ins, [tel2, clubs.A, manana, `antro-${randomUUID()}`]), { confirmarSegunda: false });
    revisar("2h. carrera forzada (2 transacciones abiertas): la 4a reserva sin cuenta del mismo teléfono se rechaza",
      carrera.esperó && /varias reservas con este teléfono/.test(carrera.error ?? ""), `esperó ${carrera.esperó}; ${carrera.error ?? "pasó"}`);
  } else {
    console.log("  (sin el trigger de 72 en dev: se salta la ráfaga sin cuenta)");
  }

  // ======================= 3. Doble cobro =======================
  console.log("\n== 3. Doble cobro");
  const S1 = ok(await S.staff1.rpc("caja_abrir_mesa", { p_mesa_id: mesas.A.T1 }), "abrir mesa 1");
  const C1 = ok(await S.staff1.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R1.id }), "sentar R1");
  const C2 = ok(await S.staff1.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R2.id }), "sentar R2");
  for (const c of [C1, C2]) ok(await S.staff1.rpc("caja_registrar_consumo", { p_cuenta_id: c, p_monto_centavos: 50000, p_concepto: "Botella", p_clave: randomUUID() }), "consumo");
  const cobro = (s, clave, monto, esperado) =>
    s.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: monto, p_clave: clave, p_saldo_esperado: esperado });
  const pagado = async () => (await db.q("select coalesce(sum(monto_centavos), 0)::bigint s from public.caja_pagos where sesion_id = $1 and not anulado", [S1]))[0].s;

  const kA = randomUUID();
  const dobles = await Promise.all([cobro(S.staff1, kA, 30000, 100000), cobro(S.staff1, kA, 30000, 100000)]);
  revisar("3a. misma clave dos veces a la vez (con saldo esperado): las dos responden bien", dobles.every((r) => !r.error), errores(dobles));
  revisar("3b. …y devuelven el mismo cobro", dobles[0].data && dobles[0].data === dobles[1].data);
  revisar("3c. …un solo cobro guardado", (await contar("caja_pagos", { clave_cliente: kA })) === 1);
  const kB = randomUUID();
  const cinco2 = await Promise.all(Array.from({ length: 5 }, () => cobro(S.staff1, kB, 10000, 70000)));
  revisar("3d. misma clave cinco veces a la vez: todas bien y un solo cobro", cinco2.every((r) => !r.error) && new Set(cinco2.map((r) => r.data)).size === 1 && (await contar("caja_pagos", { clave_cliente: kB })) === 1, errores(cinco2));
  const kC = randomUUID();
  const sinSaldo = await Promise.all(Array.from({ length: 3 }, () => cobro(S.staff1, kC, 5000, null)));
  revisar("3e. misma clave tres veces a la vez SIN saldo esperado (código anterior): un solo cobro", sinSaldo.every((r) => !r.error) && new Set(sinSaldo.map((r) => r.data)).size === 1 && (await contar("caja_pagos", { clave_cliente: kC })) === 1, errores(sinSaldo));
  revisar("3f. lo cobrado va en $450.00", Number(await pagado()) === 45000, String(await pagado()));
  // Carrera forzada: el primer envío tiene la mesa bloqueada (sin confirmar)
  // cuando llega el reintento con la misma clave y el mismo saldo esperado.
  const kD = randomUUID();
  const pagoSql = `select public.caja_registrar_pago(p_sesion_id => $1, p_cuenta_id => null, p_metodo => 'efectivo',
    p_monto_centavos => 5000, p_clave => $2, p_saldo_esperado => 55000)::text as id`;
  const carreraPago = await carreraForzada({ rol: "authenticated", uid: U.staff1.id },
    (c) => c.q(pagoSql, [S1, kD]), (c) => c.q(pagoSql, [S1, kD]), { confirmarSegunda: true });
  revisar("3j. carrera forzada: el reintento espera el candado y devuelve el mismo cobro (sin \"el saldo cambió\")",
    carreraPago.esperó && !carreraPago.error && carreraPago.primera?.[0]?.id === carreraPago.segunda?.[0]?.id,
    `esperó ${carreraPago.esperó}; ${carreraPago.error ?? "mismo id: " + (carreraPago.primera?.[0]?.id === carreraPago.segunda?.[0]?.id)}`);
  revisar("3k. …y hay un solo cobro con esa clave", (await contar("caja_pagos", { clave_cliente: kD })) === 1);
  revisar("3l. lo cobrado va en $500.00", Number(await pagado()) === 50000, String(await pagado()));
  const resto = 100000 - 50000;
  const distintas = await Promise.all([cobro(S.staff1, randomUUID(), resto, resto), cobro(S.staff2, randomUUID(), resto, resto), cobro(S.gerente1, randomUUID(), resto, resto)]);
  revisar("3g. claves distintas con el mismo saldo esperado, 3 a la vez: entra exactamente uno", distintas.filter((r) => !r.error).length === 1, errores(distintas));
  revisar("3h. los otros reciben \"el saldo cambió\"", distintas.filter((r) => /saldo de la mesa cambió/.test(r.error?.message ?? "")).length === 2);
  revisar("3i. la mesa queda pagada exacta (ni de más ni de menos)", Number(await pagado()) === 100000, String(await pagado()));

  // ======================= 4. Cuadrar dos veces =======================
  console.log("\n== 4. Cuadrar la misma mesa a la vez");
  ok(await S.gerente1.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }), "cerrar mesa 1");
  const cuad = await Promise.all([S.gerente1, S.gerente2, S.duenoA].map((s) => s.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: null })));
  revisar("4a. tres cuadres a la vez: pasa exactamente uno", cuad.filter((r) => !r.error).length === 1, errores(cuad));
  revisar("4b. los otros reciben un aviso claro (mesa ya cuadrada)", cuad.filter((r) => r.error).every((r) => /cuadrada/i.test(r.error.message) && r.error.code === "P0001"), errores(cuad));
  revisar("4c. un solo cuadre de la mesa", (await contar("caja_cuadres", { sesion_id: S1 })) === 1);
  const com1 = (await db.q("select r.id::text, c.monto::numeric m from public.commissions c join public.reservations r on r.id = c.reservation_id where c.tipo = 'rp' and r.id = any($1::uuid[])", [[R1.id, R2.id]]));
  revisar("4d. una comisión por cuenta (2 cuentas → 2 comisiones)", com1.length === 2, `${com1.length}`);
  revisar("4e. con cuota 2: una paga $0 y la otra $100", com1.map((c) => Number(c.m)).sort((a, b) => a - b).join(",") === "0,100", com1.map((c) => c.m).join(","));
  const liq = (await db.q("select count(*) filter (where liquidada_en is not null)::int l, count(*)::int t from public.mesa_cuentas where sesion_id = $1", [S1]))[0];
  revisar("4f. las dos cuentas quedan liquidadas", liq.l === 2 && liq.t === 2);

  // Cuota semanal con dos mesas del mismo RP cuadradas a la vez.
  const R3 = await reserva("rp2");
  const R4 = await reserva("rp2");
  const sesiones = [];
  for (const [R, mesa] of [[R3, "T2"], [R4, "T3"]]) {
    ok(await S.staff1.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
    ok(await S.staff1.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
    const s = ok(await S.staff1.rpc("caja_abrir_mesa", { p_mesa_id: mesas.A[mesa] }), "abrir " + mesa);
    const c = ok(await S.staff1.rpc("caja_sentar_cliente", { p_sesion_id: s, p_reservation_id: R.id }), "sentar");
    ok(await S.staff1.rpc("caja_registrar_consumo", { p_cuenta_id: c, p_monto_centavos: 20000, p_concepto: "Cubeta", p_clave: randomUUID() }), "consumo");
    ok(await S.staff1.rpc("caja_registrar_pago", { p_sesion_id: s, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: 20000, p_clave: randomUUID(), p_saldo_esperado: 20000 }), "cobro");
    ok(await S.gerente1.rpc("caja_cerrar_mesa", { p_sesion_id: s }), "cerrar");
    sesiones.push(s);
  }
  const par = await Promise.all([S.gerente1.rpc("caja_cuadrar_mesa", { p_sesion_id: sesiones[0], p_notas: null }), S.gerente2.rpc("caja_cuadrar_mesa", { p_sesion_id: sesiones[1], p_notas: null })]);
  revisar("4g. dos mesas distintas del mismo RP cuadradas a la vez: las dos pasan", par.every((r) => !r.error), errores(par));
  const com2 = await db.q("select c.monto::numeric m from public.commissions c where c.tipo = 'rp' and c.reservation_id = any($1::uuid[])", [[R3.id, R4.id]]);
  revisar("4h. la cuota semanal se cuenta bien en paralelo (una $0, otra $100)", com2.map((c) => Number(c.m)).sort((a, b) => a - b).join(",") === "0,100", com2.map((c) => c.m).join(","));

  // ======================= 5. Cerrar la noche =======================
  console.log("\n== 5. Dos gerentes cierran la misma noche a la vez");
  const nocheA = (await db.q("select id::text from public.caja_noches where club_id = $1 and fecha_operacion = $2", [clubs.A, noche]))[0].id;
  const cierre = (s) => s.rpc("caja_cerrar_noche", { p_noche_id: nocheA, p_contado_efectivo_centavos: 100000, p_contado_tarjeta_centavos: 40000, p_contado_otro_centavos: 0, p_notas: null });
  const cier = await Promise.all([cierre(S.gerente1), cierre(S.gerente2), cierre(S.duenoA)]);
  revisar("5a. tres cierres a la vez: pasa exactamente uno", cier.filter((r) => !r.error).length === 1, errores(cier));
  revisar("5b. los otros reciben \"la noche ya está cerrada\"", cier.filter((r) => /ya está cerrada/.test(r.error?.message ?? "")).length === 2);
  revisar("5c. un solo cuadre de noche", (await db.q("select count(*)::int n from public.caja_cuadres where noche_id = $1 and tipo = 'noche'", [nocheA]))[0].n === 1);
  revisar("5d. un solo evento de cierre", (await db.q("select count(*)::int n from public.caja_eventos where noche_id = $1 and tipo = 'cerrar_noche'", [nocheA]))[0].n === 1);
  const dif = (await db.q("select diferencia_centavos::bigint d, registrado_centavos::bigint r from public.caja_cuadres where noche_id = $1 and tipo = 'noche'", [nocheA]))[0];
  revisar("5e. el cierre cuadra al centavo (registrado $1,400, diferencia 0)", Number(dif.r) === 140000 && Number(dif.d) === 0, JSON.stringify(dif));
  const tarde = await S.staff1.rpc("caja_abrir_mesa", { p_mesa_id: mesas.A.T4 });
  revisar("5f. con la noche cerrada ya no se abre mesa", /cerrada/.test(tarde.error?.message ?? ""), tarde.error?.message ?? "NO falló");

  console.log("\n== 5'. Cerrar la noche mientras otro staff abre una mesa (antro B)");
  const SB1 = ok(await S.staffB.rpc("caja_abrir_mesa", { p_mesa_id: mesas.B.T1 }), "abrir B1");
  ok(await S.gerenteB.rpc("caja_cerrar_mesa", { p_sesion_id: SB1 }), "cerrar B1");
  ok(await S.gerenteB.rpc("caja_cuadrar_mesa", { p_sesion_id: SB1, p_notas: null }), "cuadrar B1");
  const nocheB = (await db.q("select id::text from public.caja_noches where club_id = $1 and fecha_operacion = $2", [clubs.B, noche]))[0].id;
  const [cB, aB, aB2] = await Promise.all([
    S.gerenteB.rpc("caja_cerrar_noche", { p_noche_id: nocheB, p_contado_efectivo_centavos: 0, p_contado_tarjeta_centavos: 0, p_contado_otro_centavos: 0, p_notas: null }),
    S.staffB.rpc("caja_abrir_mesa", { p_mesa_id: mesas.B.T2 }),
    S.duenoB.rpc("caja_abrir_mesa", { p_mesa_id: mesas.B.T3 }),
  ]);
  const estB = (await db.q("select n.estado, (select count(*)::int from public.mesa_sesiones s where s.noche_id = n.id and s.estado <> 'cuadrada') pendientes from public.caja_noches n where n.id = $1", [nocheB]))[0];
  revisar("5g. nunca queda una noche cerrada con mesas sin cuadrar", !(estB.estado === "cerrada" && estB.pendientes > 0), `noche ${estB.estado}, pendientes ${estB.pendientes}; cierre: ${cB.error?.message ?? "ok"}; abrir: ${aB.error?.message ?? "ok"} / ${aB2.error?.message ?? "ok"}`);
  revisar("5h. lo que perdió la carrera recibe un aviso claro", estB.estado === "cerrada"
    ? [aB, aB2].every((r) => /cerrada/.test(r.error?.message ?? ""))
    : /Faltan \d+ mesas? por cuadrar/.test(cB.error?.message ?? ""), `${cB.error?.message ?? "ok"} / ${aB.error?.message ?? "ok"} / ${aB2.error?.message ?? "ok"}`);

  // ======================= 6. Un dueño, un antro =======================
  console.log("\n== 6. Un dueño sin antro da de alta dos antros a la vez");
  const nombreNuevo = (n) => `T rls conc nuevo${n} ${TAG}`;
  const antrosDe = async (uid) => (await db.q("select id::text from public.clubs where dueno_id = $1", [uid])).map((x) => x.id);
  // Carrera forzada: la primera alta deja su transacción abierta.
  const d1 = await usuario("duenoNuevo1", "dueno");
  const altaSql = `insert into public.clubs (nombre, direccion, horario, dueno_id) values ($1, 'Calle prueba 1', '22:00-03:00', $2) returning id::text`;
  const carreraAlta = await carreraForzada({ rol: "authenticated", uid: d1 },
    (c) => c.q(altaSql, [nombreNuevo(1), d1]), (c) => c.q(altaSql, [nombreNuevo(2), d1]), { confirmarSegunda: true });
  for (const id of await antrosDe(d1)) clubs["nuevo-" + id] = id;
  revisar("6a. carrera forzada: la segunda alta espera el candado y se rechaza",
    carreraAlta.esperó && /Ya tienes un antro registrado/.test(carreraAlta.error ?? ""), `esperó ${carreraAlta.esperó}; ${carreraAlta.error ?? "PASÓ"}`);
  revisar("6b. …el dueño queda con un solo antro", (await antrosDe(d1)).length === 1, String((await antrosDe(d1)).length));
  // Promise.all por la API, como la pantalla (doble clic en "Registrar").
  const d2 = await usuario("duenoNuevo2", "dueno");
  const SD = await sesion("duenoNuevo2");
  const altas = await Promise.all([1, 2, 3].map((n) => SD.from("clubs").insert({ nombre: nombreNuevo(`api${n}`), direccion: "Calle prueba 1", horario: "22:00-03:00", dueno_id: d2 }).select("id").single()));
  for (const id of await antrosDe(d2)) clubs["nuevo-" + id] = id;
  revisar("6c. tres altas a la vez por la API: pasa exactamente una", altas.filter((r) => !r.error).length === 1, errores(altas));
  revisar("6d. …el dueño queda con un solo antro", (await antrosDe(d2)).length === 1, String((await antrosDe(d2)).length));
  revisar("6e. las rechazadas reciben un aviso (P0001) o el rechazo de la política", altas.filter((r) => r.error).every((r) => r.error.code === "P0001" || r.error.code === "42501"), altas.map((r) => r.error?.code ?? "ok").join(","));
  } // fin de los casos 1–6 (se saltan con --solo-pj3)

  await casosPostJunta3(db);
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await db.fin();
  await limpiar();
  const pasan = resultados.filter((r) => r.paso).length;
  console.log(`\nResultado: ${pasan}/${resultados.length} pasan`);
  if (pasan !== resultados.length) process.exitCode = 1;
}
