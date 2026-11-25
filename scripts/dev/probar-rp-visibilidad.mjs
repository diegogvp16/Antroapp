// SOLO DEV. Qué ve el RP y su cuota (B10, sql/post-junta-2/41-rp-visibilidad.sql):
//   1. Fuga de «solo el estado»: el RP ya no lee reservations directo (ni
//      consumo_monto ni nada), con su sesión real y la anon key. Staff,
//      gerente, dueño, admin y cliente siguen leyendo lo de siempre; el RP
//      sigue creando reservas.
//   2. «Estado, monto y botellas»: renglones del catálogo (fase 2) agrupados
//      por producto, sin anulados, conceptos libres aparte; sin la fase 2 en
//      la base, sin renglones (como «estado y monto").
//   3. Cuota con bordes: D=0, D=1, la D-ésima paga, regla nueva con cuota,
//      cambio de semana el lunes (hora del antro, corte 08:00) y regla
//      programada para el lunes siguiente que no es retroactiva.
//
//   node scripts/dev/probar-rp-visibilidad.mjs                       # base
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> //     node scripts/dev/probar-rp-visibilidad.mjs http://localhost:3024 [--fase2]
//   (con URL, además pantallas a 390×844 y 360×740 en screenshots-b-cliente/;
//   --fase2 si el servidor corre con NEXT_PUBLIC_FASE2=1)
//
// Crea sus propios antros («T cli …») y cuentas (t_cli_…@example.com) y los
// borra al final aunque algo falle. Solo LEE Club Demo Dev (dev_rp y
// dev_admin, sin cambiarles nada). Las noches de otras semanas se arman con
// SQL (como postgres, con los triggers de la caja activos) y se liquidan con
// la función real caja_liquidar_cuenta.

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";
import { botellasParaRp } from "../../lib/domain/rp-reservas.ts";
import { desdeMisReservas, resumirPeriodo } from "../../lib/rp-rendimiento.ts";
import { avisoVisibilidad, describirRegla } from "../../lib/domain/config-rp.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const CRED = JSON.parse(readFileSync(path.join(RAIZ, "backups", "dev-credenciales.json"), "utf8"));
const CLUB_DEMO = "0de70000-0000-4000-8000-000000000001";
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
const FASE2 = process.argv.includes("--fase2");
const SHOTS = path.join(RAIZ, "screenshots-b-cliente") + path.sep;
async function cargarPlaywright() {
  try {
    return createRequire(path.join(RAIZ, "package.json"))("playwright");
  } catch {
    if (!process.env.PLAYWRIGHT_DESDE) throw new Error("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright)");
    return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
  }
}

const TAG = Date.now().toString(36);
const PASS = "Prueba-" + randomUUID();
let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK     " : "FALLA  "}${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
const ids = [];
const clubIds = [];
const db = await conectarDevEscritura();

async function sesion(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  ok(await c.auth.signInWithPassword({ email, password }), "login " + email.split("@")[0]);
  return c;
}
async function cuenta(clave, role, club_id = null) {
  const email = `t_cli_${TAG}_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "usuario " + clave);
  ids.push(u.user.id);
  ok(await svc.from("profiles").insert({ id: u.user.id, nombre: `T cli ${clave}`, role, club_id }), "perfil " + clave);
  return { id: u.user.id, email, c: await sesion(email, PASS) };
}
async function antro(k, extra = {}) {
  const dueno = await cuenta(`dueno${k}`, "dueno");
  const club = ok(await svc.from("clubs").insert({
    nombre: `T cli ${k} ${TAG}`, direccion: "Calle 1", horario: "Vie", dueno_id: dueno.id,
    pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0, ...extra,
  }).select("id").single(), "club " + k);
  clubIds.push(club.id);
  const mesas = ok(await svc.from("club_tables").insert(Array.from({ length: 24 }, (_, i) => ({ club_id: club.id, numero: `M${i + 1}`, capacidad: 6 }))).select("id"), "mesas");
  const c = { id: club.id, dueno, mesas: mesas.map((m) => m.id) };
  c.gerente = await cuenta(`gerente${k}`, "gerente", club.id);
  return c;
}
const fechaOp = async (clubId, instante) =>
  (await db.q("select public.club_fecha_operacion($1, $2::timestamptz)::text as f", [clubId, instante]))[0].f;
const sumar = (f, n) => new Date(Date.parse(f + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);

// Noche de cualquier fecha, armada con SQL y liquidada por la función real.
async function liquidarEn(club, rpId, fecha, centavos) {
  const resId = randomUUID();
  await db.q(
    `insert into public.reservations (id, cliente_nombre, cliente_telefono, personas, status, puerta_estado, entrada_en, source, rp_id, club_id, fecha, qr_code)
     values ($1, 'T cli cliente', '0000000555', 2, 'usada', 'entro', now(), 'rp', $2, $3, $4, $5)`,
    [resId, rpId, club.id, fecha, `antro-${randomUUID()}`]);
  let noche = (await db.q("select id from public.caja_noches where club_id = $1 and fecha_operacion = $2", [club.id, fecha]))[0]?.id;
  if (!noche) noche = (await db.q("insert into public.caja_noches (club_id, fecha_operacion, estado) values ($1, $2, 'abierta') returning id", [club.id, fecha]))[0].id;
  const mesa = club.mesas.shift();
  const ses = (await db.q("insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado) values ($1, $2, $3, 'abierta') returning id", [club.id, noche, mesa]))[0].id;
  const cta = (await db.q("insert into public.mesa_cuentas (club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas) values ($1, $2, $3, $4, 'reserva', 'T cli cliente', 2) returning id", [club.id, ses, resId, rpId]))[0].id;
  await db.q("insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id, monto_centavos, concepto, registrado_por) values ($1, $2, $3, $4, $5, $6, $7, $8, 'T cli consumo', $9)",
    [club.id, noche, ses, mesa, cta, resId, rpId, centavos, club.gerente.id]);
  await db.q("select public.caja_liquidar_cuenta($1)", [cta]);
  const com = (await db.q("select monto::text, regla_id from public.commissions where reservation_id = $1", [resId]))[0];
  return { centavos: com ? Math.round(Number(com.monto) * 100) : null, regla: com?.regla_id ?? null };
}

try {
  // ======================= 0. Dominio (sin base) =======================
  console.log("\n— Dominio —");
  const base = { nivel: "estado_monto_botellas", renglones: [{ concepto: "3 × Buchanan's", producto: "Buchanan's", categoria: "Whisky", cantidad: 3, monto_centavos: 540000 }], otros_centavos: 20000 };
  const b = botellasParaRp(base, true);
  revisar(b?.items.length === 1 && b.items[0].cantidad === 3 && b.items[0].producto === "Buchanan's" && b.otros === 20000, "botellas con la fase 2: producto, cantidad y «otros consumos»");
  revisar(botellasParaRp(base, false) === null, "con la fase 2 apagada no se muestran botellas (igual que «estado y monto»)");
  revisar(botellasParaRp({ ...base, nivel: "estado_monto" }, true) === null && botellasParaRp({ ...base, renglones: null }, true) === null, "otro nivel o sin renglones → nada");
  revisar(botellasParaRp({ nivel: "estado_monto_botellas", renglones: [{ concepto: "Botella vieja", monto_centavos: 100 }] }, true)?.items[0].producto === "Botella vieja", "renglón de la función anterior (solo concepto) se sigue leyendo");
  revisar(botellasParaRp({ nivel: "estado_monto_botellas", renglones: [], otros_centavos: 0 }, true) === null, "sin productos ni otros → no hay sección");
  const filas = [
    { reservation_id: "a", cliente_nombre: "A", fecha: "2026-11-23", estado: "consumio", comision_centavos: "15000", comision_estado: "pendiente" },
    { reservation_id: "b", cliente_nombre: "B", fecha: "2026-11-23", estado: "llego_sin_consumo", comision_centavos: null, comision_estado: null },
    { reservation_id: "c", cliente_nombre: "C", fecha: "2026-11-24", estado: "no_llego", comision_centavos: null, comision_estado: null },
    { reservation_id: "d", cliente_nombre: "D", fecha: "2026-11-24", estado: "consumio", comision_centavos: 0, comision_estado: "anulada" },
  ];
  const m = desdeMisReservas(filas);
  const res = resumirPeriodo(m.reservas, m.comisiones, { desde: "2026-11-23", hasta: "2026-11-29" });
  revisar(res.reservas === 4 && res.entraron === 3 && res.sinEntrar === 1 && res.ganado === 150 && res.registrosGanancia === 1, "rendimiento desde rp_mis_reservas: 4 reservas, 3 entraron, $150 ganado (lo anulado no cuenta)", JSON.stringify(res));
  revisar(describirRegla({ tipo: "cuota", cuota: 2, porcentaje_bp: 1000, monto_centavos: null }) === "Las primeras 2 reservas de la semana no pagan; desde la 3.ª, 10 % del consumo cada una", "texto de la regla anterior de porcentaje con desbloqueo (antes decía $0)");
  revisar(describirRegla({ tipo: "cuota", cuota: 4, porcentaje_bp: null, monto_centavos: 20000 }) === "Las primeras 4 reservas de la semana no pagan; desde la 5.ª, $200 cada una", "texto de la cuota de siempre, igual");
  revisar(/calcular cuánto consumió/.test(avisoVisibilidad("estado", { tipo: "porcentaje", cuota: 0, porcentaje_bp: 1000, monto_centavos: null }, false) ?? "") && avisoVisibilidad("estado", { tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 100 }, false) === null, "aviso: «solo estado» con porcentaje delata el consumo; con fijo no");
  revisar(/todavía no está encendido/.test(avisoVisibilidad("estado_monto_botellas", null, false) ?? "") && avisoVisibilidad("estado_monto_botellas", null, true) === null, "aviso: botellas sin la fase 2");

  // ======================= 1. Fuga de «solo estado» =======================
  console.log("\n— Lectura directa de reservations —");
  const politica = await db.q("select count(*)::int as n from pg_policy where polrelid = 'public.reservations'::regclass and polname = 'reservations_select_rp_own'");
  revisar(politica[0].n === 0, "ya no existe la política reservations_select_rp_own");
  const nivelAcl = await db.q("select has_function_privilege('authenticated', 'public.rp_nivel_visibilidad(uuid)', 'execute') as a, has_function_privilege('anon', 'public.rp_nivel_visibilidad(uuid)', 'execute') as b");
  revisar(!nivelAcl[0].a && !nivelAcl[0].b, "rp_nivel_visibilidad sin EXECUTE para authenticated ni anon");
  const fn = await db.q("select p.prosecdef, array_to_string(p.proconfig, ',') as cfg, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth from pg_proc p where p.oid = 'public.rp_mis_reservas(date,date)'::regprocedure");
  revisar(fn[0].prosecdef && fn[0].cfg === 'search_path=""' && !fn[0].anon && fn[0].auth, "rp_mis_reservas: security definer, search_path vacío, sin anon");

  const B = await antro("B");
  B.staff = await cuenta("staffB", "staff", B.id);
  B.rp = await cuenta("rpB", "rp", B.id);
  B.cliente = await cuenta("clienteB", "cliente");
  const hoyB = await fechaOp(B.id, new Date().toISOString());

  // Reserva del RP por el camino real de la caja, con catálogo (fase 2).
  const R = randomUUID();
  ok(await svc.from("reservations").insert({ id: R, cliente_nombre: "T cli cliente B", cliente_telefono: "0000000556", personas: 4, status: "usada", puerta_estado: "entro", entrada_en: new Date().toISOString(), source: "rp", rp_id: B.rp.id, club_id: B.id, fecha: hoyB, qr_code: `antro-${randomUUID()}` }), "reserva B");
  const prods = ok(await svc.from("productos").insert([
    { club_id: B.id, nombre: `Buchanan's ${TAG}`, categoria: "Whisky", precio_centavos: 180000, existencias: 20, creado_por: B.gerente.id },
    { club_id: B.id, nombre: `Don Julio 70 ${TAG}`, categoria: "Tequila", precio_centavos: 250000, existencias: 20, creado_por: B.gerente.id },
  ]).select("id, nombre"), "productos");
  const G = B.gerente.c;
  const sesB = ok(await G.rpc("caja_abrir_mesa", { p_mesa_id: B.mesas.shift() }), "abrir mesa");
  const ctaB = ok(await G.rpc("caja_sentar_cliente", { p_sesion_id: sesB, p_reservation_id: R }), "sentar");
  ok(await G.rpc("caja_registrar_consumo_producto", { p_cuenta_id: ctaB, p_producto_id: prods[0].id, p_cantidad: 2 }), "2 Buchanan's");
  ok(await G.rpc("caja_registrar_consumo_producto", { p_cuenta_id: ctaB, p_producto_id: prods[0].id, p_cantidad: 1 }), "1 Buchanan's");
  const anular = ok(await G.rpc("caja_registrar_consumo_producto", { p_cuenta_id: ctaB, p_producto_id: prods[1].id, p_cantidad: 1 }), "Don Julio que se anula");
  ok(await G.rpc("caja_anular_consumo", { p_consumo_id: anular, p_motivo: "T cli: se capturó por error" }), "anular");
  ok(await G.rpc("caja_registrar_consumo", { p_cuenta_id: ctaB, p_monto_centavos: 20000, p_concepto: "Cover" }), "concepto libre");
  const total = 3 * 180000 + 20000;
  ok(await G.rpc("caja_registrar_pago", { p_sesion_id: sesB, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: total }), "pago");
  ok(await G.rpc("caja_cerrar_mesa", { p_sesion_id: sesB }), "cerrar");
  ok(await G.rpc("caja_cuadrar_mesa", { p_sesion_id: sesB }), "cuadrar");
  const guardado = (await db.q("select consumo_monto::text as c from public.reservations where id = $1", [R]))[0].c;
  revisar(Number(guardado) === total / 100, `la base guardó consumo_monto ($${total / 100}) al cuadrar`);

  ok(await B.dueno.c.rpc("config_rp_cambiar_visibilidad", { p_club: B.id, p_nivel: "estado" }), "solo estado");
  const RP = B.rp.c;
  const d1 = await RP.from("reservations").select("consumo_monto").eq("id", R);
  revisar(!d1.error && (d1.data ?? []).length === 0, "RP con «solo estado»: select('consumo_monto') directo → 0 filas", JSON.stringify(d1));
  const d2 = await RP.from("reservations").select("*").eq("rp_id", B.rp.id);
  revisar(!d2.error && (d2.data ?? []).length === 0, "RP: select('*') de sus reservas → 0 filas");
  const d3 = await RP.from("reservations").select("id", { count: "exact", head: true });
  revisar(!d3.error && d3.count === 0, "RP: conteo de reservations → 0");
  const d4 = await RP.from("commissions").select("monto, reservations(consumo_monto)").eq("reservation_id", R);
  revisar(!d4.error && d4.data?.length === 1 && d4.data[0].reservations === null, "RP: ve su comisión, pero el embed reservations(consumo_monto) sale vacío", JSON.stringify(d4.data));
  const v1 = (ok(await RP.rpc("rp_mis_reservas", { p_desde: hoyB, p_hasta: hoyB }), "mis reservas")).find((x) => x.reservation_id === R);
  revisar(v1?.estado === "consumio" && v1.consumo_centavos === null && v1.renglones === null && v1.otros_centavos === null && v1.nivel === "estado", "rp_mis_reservas con «solo estado»: consumió, sin monto ni renglones", JSON.stringify(v1));
  revisar(!!(await RP.rpc("rp_nivel_visibilidad", { p_club_id: B.id })).error && !!(await G.rpc("rp_nivel_visibilidad", { p_club_id: B.id })).error, "rp_nivel_visibilidad ya no se llama con sesión (ni RP ni gerente)");

  // El RP sigue creando reservas (el panel no pide la fila de regreso).
  const nueva = await RP.from("reservations").insert({ cliente_nombre: "T cli nueva", cliente_telefono: "0000000557", rp_id: B.rp.id, club_id: B.id, source: "rp", fecha: hoyB, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
  revisar(!nueva.error, "el RP sigue creando reservas", nueva.error?.message);
  const v2 = ok(await RP.rpc("rp_mis_reservas", { p_desde: hoyB, p_hasta: hoyB }), "mis reservas 2");
  revisar(v2.some((x) => x.cliente_nombre === "T cli nueva" && x.estado === "por_llegar"), "y la ve en rp_mis_reservas (por llegar)");

  // Los demás roles no cambian.
  const leer = async (c) => (await c.from("reservations").select("id, consumo_monto").eq("id", R)).data?.[0]?.consumo_monto;
  revisar(Number(await leer(B.staff.c)) === total / 100, "el staff sigue leyendo la reserva (con consumo)");
  revisar(Number(await leer(G)) === total / 100, "el gerente también");
  revisar(Number(await leer(B.dueno.c)) === total / 100, "el dueño también");
  const admin = await sesion(CRED.usuarios.admin, CRED.password);
  revisar(Number(await leer(admin)) === total / 100, "el admin (dev_admin) también");
  const st = await B.staff.c.from("reservations").select("*").eq("club_id", B.id);
  revisar(!st.error && st.data.length === 2, "select('*') del staff sobre su antro sigue funcionando (2 reservas)");
  // (El antro de prueba no está publicado, así que la reserva del cliente se
  // siembra con service_role: aquí solo importa que la siga leyendo.)
  ok(await svc.from("reservations").insert({ cliente_nombre: "T cli cliente", cliente_telefono: "0000000558", club_id: B.id, cliente_id: B.cliente.id, source: "organica", fecha: hoyB, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` }), "reserva del cliente");
  const cl = await B.cliente.c.from("reservations").select("*").eq("cliente_id", B.cliente.id);
  revisar(!cl.error && cl.data.length === 1 && "qr_code" in cl.data[0], "el cliente lee su reserva con select('*')", cl.error?.message);
  revisar(!!(await B.staff.c.rpc("rp_mis_reservas", { p_desde: hoyB, p_hasta: hoyB })).error, "rp_mis_reservas sigue siendo solo para RPs");
  // Club Demo Dev, solo lectura: el RP de siempre tampoco lee la tabla.
  const devRp = await sesion(CRED.usuarios.rp, CRED.password);
  const dd = await devRp.from("reservations").select("id, consumo_monto").eq("club_id", CLUB_DEMO).limit(5);
  revisar(!dd.error && dd.data.length === 0, "dev_rp en Club Demo Dev: 0 filas directas");
  const ddr = await devRp.rpc("rp_mis_reservas", { p_desde: sumar(hoyB, -30), p_hasta: hoyB });
  revisar(!ddr.error, `dev_rp sigue viendo sus reservas por rp_mis_reservas (${ddr.data?.length ?? 0} en 30 días)`, ddr.error?.message);

  // ======================= 2. Botellas =======================
  console.log("\n— Estado, monto y botellas —");
  ok(await G.rpc("config_rp_cambiar_visibilidad", { p_club: B.id, p_nivel: "estado_monto" }), "estado y monto");
  let v = (ok(await RP.rpc("rp_mis_reservas", { p_desde: hoyB, p_hasta: hoyB }), "v")).find((x) => x.reservation_id === R);
  revisar(Number(v.consumo_centavos) === total && v.renglones === null && v.otros_centavos === null, "«estado y monto»: monto, sin renglones");
  ok(await G.rpc("config_rp_cambiar_visibilidad", { p_club: B.id, p_nivel: "estado_monto_botellas" }), "botellas");
  v = (ok(await RP.rpc("rp_mis_reservas", { p_desde: hoyB, p_hasta: hoyB }), "v")).find((x) => x.reservation_id === R);
  const ren = v.renglones ?? [];
  revisar(ren.length === 1 && ren[0].producto === prods[0].nombre && ren[0].cantidad === 3 && Number(ren[0].monto_centavos) === 540000 && ren[0].categoria === "Whisky", "botellas: 3 × Buchanan's agrupado, con categoría y monto", JSON.stringify(ren));
  revisar(!ren.some((x) => String(x.producto).startsWith("Don Julio")), "lo anulado no aparece");
  revisar(Number(v.otros_centavos) === 20000 && Number(v.consumo_centavos) === total, "el concepto libre va aparte («otros»: $200) y el total no cambia");
  revisar(ren[0].concepto === `3 × ${prods[0].nombre}`, "renglón compatible con la pantalla anterior (concepto «3 × …»)");
  const vNueva = (ok(await RP.rpc("rp_mis_reservas", { p_desde: hoyB, p_hasta: hoyB }), "v")).find((x) => x.cliente_nombre === "T cli nueva");
  revisar(Array.isArray(vNueva.renglones) && vNueva.renglones.length === 0 && Number(vNueva.otros_centavos) === 0, "reserva sin consumo: renglones vacíos");
  // Sin la fase 2 en la base: se simula dentro de una transacción que se deshace.
  let sinFase2 = null;
  try {
    await db.q("begin");
    await db.q("set local lock_timeout = '3s'");
    await db.q("alter table public.productos rename to productos_t_cli_tmp");
    await db.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: B.rp.id, role: "authenticated" })]);
    await db.q("set local role authenticated");
    sinFase2 = (await db.q("select renglones, otros_centavos::text as o, consumo_centavos::text as c, nivel from public.rp_mis_reservas($1, $1) where reservation_id = $2", [hoyB, R]))[0];
  } finally {
    await db.q("rollback");
  }
  revisar(sinFase2 && sinFase2.renglones === null && sinFase2.o === null && Number(sinFase2.c) === total && sinFase2.nivel === "estado_monto_botellas", "sin la fase 2 en la base: sin renglones, con monto (igual que «estado y monto»)", JSON.stringify(sinFase2));
  revisar((await db.q("select to_regclass('public.productos') is not null as ok"))[0].ok, "la tabla productos quedó como estaba");

  // ======================= 2b. Pantallas (opcional) =======================
  if (BASE) {
    console.log(`\n— Pantallas (${BASE}, fase 2 ${FASE2 ? "ENCENDIDA" : "apagada"}) —`);
    const { chromium } = await cargarPlaywright();
    mkdirSync(SHOTS, { recursive: true });
    const nav = await chromium.launch();
    const modo = FASE2 ? "fase2" : "sinfase2";
    // Regla de porcentaje para ver el aviso de «solo estado» (no se guarda nada desde la pantalla).
    await db.q("update public.clubs set comision_tipo = 'porcentaje', comision_monto = 10 where id = $1", [B.id]);
    try {
      for (const [ancho, alto] of [[390, 844], [360, 740]]) {
        const errores = [];
        const ctx = await nav.newContext({ viewport: { width: ancho, height: alto } });
        const p = await ctx.newPage();
        p.on("pageerror", (e) => errores.push(e.message.slice(0, 120)));
        p.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errores.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });
        await p.goto(BASE + "/cliente/login");
        await p.fill("#email", B.rp.email); await p.fill("#password", PASS);
        await p.click("button[type=submit]");
        await p.waitForURL(/rp\/panel/, { timeout: 90000 });
        const fila = p.getByRole("button", { name: /T cli cliente B, Consumió$/ });
        await fila.waitFor({ timeout: 60000 });
        await fila.click();
        await p.getByText("Mi comisión").waitFor({ timeout: 20000 });
        const d = await p.locator("body").innerText();
        await p.screenshot({ path: `${SHOTS}rp-detalle-${modo}-${ancho}.png`, fullPage: true });
        if (FASE2) {
          revisar(d.includes("Botellas y productos") && d.includes(`3 × ${prods[0].nombre}`) && d.includes("Whisky") && /Otros consumos\s*\$200/.test(d) && !d.includes("Don Julio"), `${ancho}: el RP ve sus botellas (3 × Buchanan's, Whisky) y «Otros consumos $200»`);
          const altos = await p.locator("section:has(h3:text('Botellas y productos')) li").evaluateAll((xs) => xs.map((x) => x.getBoundingClientRect().height));
          revisar(altos.length === 2 && altos.every((h) => h >= 40), `${ancho}: renglones de ≥ 40 px`, JSON.stringify(altos));
        } else {
          revisar(!d.includes("Botellas y productos") && !d.includes("Buchanan") && /\$5,600/.test(d), `${ancho}: sin fase 2 el RP ve el monto ($5,600) y ninguna botella`);
        }
        revisar((await p.evaluate(() => document.documentElement.scrollWidth)) <= ancho, `${ancho}: detalle sin scroll horizontal`);
        await p.getByRole("button", { name: "Volver a mis reservas" }).click();
        await p.getByRole("button", { name: "Perfil" }).click();
        await p.getByText(/entraron/).first().waitFor({ timeout: 30000 });
        const perfil = await p.locator("body").innerText();
        await p.screenshot({ path: `${SHOTS}rp-perfil-${modo}-${ancho}.png`, fullPage: true });
        revisar(/Esta semana\s*\$100(\.00)?\s*1 de 2 entraron/.test(perfil) && !perfil.includes("No pudimos cargar"), `${ancho}: «lo que llevas ganado» sale de rp_mis_reservas ($100, 1 de 2 entraron)`, perfil.match(/Esta semana[^\n]*\n[^\n]*\n[^\n]*/)?.[0]);
        revisar(errores.length === 0, `${ancho}: sin errores de consola ni HTTP en el panel del RP`, errores.join(" | "));
        await ctx.close();

        // Dueño: «Qué ven tus RPs» con sus avisos.
        const ctx2 = await nav.newContext({ viewport: { width: ancho, height: alto } });
        const q2 = await ctx2.newPage();
        await q2.goto(BASE + "/cliente/login");
        await q2.fill("#email", B.dueno.email); await q2.fill("#password", PASS);
        await q2.click("button[type=submit]");
        await q2.waitForURL(/dueno\/panel/, { timeout: 90000 });
        const tarjeta = q2.locator("div[data-slot=card]", { has: q2.getByRole("heading", { name: "Qué ven tus RPs de sus clientes" }) });
        await tarjeta.waitFor({ timeout: 60000 });
        await tarjeta.scrollIntoViewIfNeeded();
        const tBot = await tarjeta.innerText();
        revisar(FASE2 ? !tBot.includes("todavía no está encendido") : tBot.includes("todavía no está encendido"), `${ancho}: dueño con botellas: aviso de catálogo ${FASE2 ? "oculto (fase 2 encendida)" : "visible (fase 2 apagada)"}`);
        await tarjeta.screenshot({ path: `${SHOTS}dueno-visibilidad-botellas-${modo}-${ancho}.png` });
        await tarjeta.getByText("Solo el estado").click();
        await q2.waitForTimeout(300);
        const tEst = await tarjeta.innerText();
        revisar(tEst.includes("puede calcular cuánto consumió"), `${ancho}: dueño elige «solo el estado» con regla de porcentaje → aviso`);
        await tarjeta.screenshot({ path: `${SHOTS}dueno-visibilidad-estado-${modo}-${ancho}.png` });
        revisar((await q2.evaluate(() => document.documentElement.scrollWidth)) <= ancho, `${ancho}: panel del dueño sin scroll horizontal`);
        await ctx2.close();
      }
    } finally {
      await nav.close();
      await db.q("update public.clubs set comision_tipo = 'fijo', comision_monto = 100 where id = $1", [B.id]);
    }
  }

  // ======================= 3. Cuota =======================
  console.log("\n— Cuota y semana —");
  const C = await antro("C");
  C.rps = {};
  for (const k of ["d0", "d1", "d3", "sem", "n1"]) C.rps[k] = await cuenta(`rp${k}C`, "rp", C.id);
  const hoyC = await fechaOp(C.id, new Date().toISOString());
  const L = (await db.q("select public.lunes_de($1::date)::text as l", [hoyC]))[0].l;
  const setD = (d) => db.q("update public.clubs set comision_desbloqueo_reservas = $2 where id = $1", [C.id, d]);
  // D = 0 y D = 1: la primera ya paga; sin cuota en el panel.
  await setD(0);
  const z = [await liquidarEn(C, C.rps.d0.id, sumar(L, -21), 50000), await liquidarEn(C, C.rps.d0.id, sumar(L, -20), 50000)];
  revisar(z.every((x) => x.centavos === 10000), "D=0: la 1.ª y la 2.ª pagan $100", JSON.stringify(z));
  revisar(((await C.rps.d0.c.rpc("rp_progreso_cuota")).data)?.tiene_cuota === false, "D=0: el panel dice «sin cuota»");
  await setD(1);
  const u = await liquidarEn(C, C.rps.d1.id, sumar(L, -14), 50000);
  revisar(u.centavos === 10000, "D=1: la 1.ª ya paga", JSON.stringify(u));
  revisar(((await C.rps.d1.c.rpc("rp_progreso_cuota")).data)?.tiene_cuota === false, "D=1: también «sin cuota»");
  // D = 3: la 3.ª es la primera que paga (esta semana, para ver el panel).
  await setD(3);
  const t1 = await liquidarEn(C, C.rps.d3.id, L, 50000);
  const t2 = await liquidarEn(C, C.rps.d3.id, L, 50000);
  const p3 = (await C.rps.d3.c.rpc("rp_progreso_cuota")).data;
  revisar(p3?.tiene_cuota && p3.cuota === 3 && p3.llevas === 2 && p3.siguiente_paga === true && p3.semana_desde === L, "D=3 tras 2: panel «llevas 2 de 3, la siguiente paga», semana desde el lunes", JSON.stringify(p3));
  const t3 = await liquidarEn(C, C.rps.d3.id, L, 50000);
  const t4 = await liquidarEn(C, C.rps.d3.id, L, 50000);
  revisar([t1, t2, t3, t4].map((x) => x.centavos).join() === "0,0,10000,10000", "D=3: $0, $0, la 3.ª paga $100 y la 4.ª también", JSON.stringify([t1, t2, t3, t4]));
  // Cambio de semana: D = 2 (la 2.ª paga). Domingo y lunes de semanas distintas.
  await setD(2);
  const dom = sumar(L, -8), lun = sumar(L, -7);
  const s1 = await liquidarEn(C, C.rps.sem.id, dom, 50000);
  const s2 = await liquidarEn(C, C.rps.sem.id, lun, 50000);
  const s3 = await liquidarEn(C, C.rps.sem.id, dom, 50000);
  const s4 = await liquidarEn(C, C.rps.sem.id, lun, 50000);
  revisar(s1.centavos === 0 && s2.centavos === 0, "D=2: la 1.ª del domingo no paga y la 1.ª del lunes tampoco (la semana se reinicia, no es la 2.ª)", JSON.stringify([s1, s2]));
  revisar(s3.centavos === 10000 && s4.centavos === 10000, "la 2.ª del domingo paga en su semana y la 2.ª del lunes en la suya", JSON.stringify([s3, s4]));
  // ¿A qué noche pertenece la madrugada del lunes? Hora del antro, corte 08:00.
  const T = await antro("T", { zona_horaria: "America/Tijuana" });
  const lunesUtc = (h) => (db.q("select (($1::date + $2::time) at time zone 'America/Mexico_City')::text as t", [lun, h]));
  const enMx = async (h) => fechaOp(C.id, (await lunesUtc(h))[0].t);
  revisar(await enMx("00:00") === dom && await enMx("07:59:59") === dom && await enMx("08:00") === lun, "CDMX: lunes 00:00 y 07:59 siguen en la noche del domingo; a las 08:00 empieza el lunes");
  revisar(await fechaOp(T.id, (await lunesUtc("08:00"))[0].t) === dom && await fechaOp(T.id, (await lunesUtc("10:00"))[0].t) === lun, "Tijuana (hora del antro): a las 08:00 de CDMX todavía es la noche del domingo; a las 10:00 de CDMX (08:00 allá) ya es lunes");
  revisar((await db.q("select public.lunes_de($1::date)::text as a, public.lunes_de($2::date)::text as b", [dom, lun]))[0].a === sumar(lun, -7), "el domingo cuenta en la semana del lunes anterior");

  // Regla nueva con cuota N=1 (la 2.ª paga), vigente desde hace 4 semanas.
  console.log("\n— Regla nueva con cuota y programación —");
  const Q = await antro("Q");
  Q.rp = await cuenta("rpQ", "rp", Q.id);
  const L4 = sumar(L, -28);
  await db.q("insert into public.reglas_comision (club_id, tipo, cuota, monto_centavos, vigente_desde, creada_por) values ($1, 'cuota', 1, 20000, $2, $3)", [Q.id, L4, Q.gerente.id]);
  const q = [await liquidarEn(Q, Q.rp.id, L4, 50000), await liquidarEn(Q, Q.rp.id, sumar(L4, 2), 50000), await liquidarEn(Q, Q.rp.id, sumar(L4, 6), 50000)];
  revisar(q.map((x) => x.centavos).join() === "0,20000,20000" && q.every((x) => x.regla), "cuota N=1: la 1.ª $0, la 2.ª (D = N+1) paga $200, la 3.ª también; cada una con su regla", JSON.stringify(q));
  revisar(!!(await Q.gerente.c.rpc("config_rp_cambiar_regla", { p_club: Q.id, p_tipo: "cuota", p_cuota: 0, p_porcentaje_bp: null, p_monto_centavos: 20000 })).error, "cuota 0 se rechaza (para eso está «monto fijo»)");
  const q1 = await liquidarEn(Q, Q.rp.id, hoyC, 50000);
  const pq = (await Q.rp.c.rpc("rp_progreso_cuota")).data;
  revisar(q1.centavos === 0 && pq?.cuota === 2 && pq.llevas === 1 && pq.siguiente_paga === true, "esta semana con N=1: la 1.ª $0 y el panel dice «la siguiente paga» (cuota 2)", JSON.stringify(pq));
  // Programar: vale desde el lunes siguiente, nunca antes.
  const prog = await Q.gerente.c.rpc("config_rp_cambiar_regla", { p_club: Q.id, p_tipo: "fijo", p_cuota: 0, p_porcentaje_bp: null, p_monto_centavos: 30000 });
  revisar(!prog.error && prog.data.vigente_desde === sumar(L, 7), `la regla nueva se programa para el lunes ${sumar(L, 7)}`, JSON.stringify(prog.error ?? prog.data));
  const repro = await Q.dueno.c.rpc("config_rp_cambiar_regla", { p_club: Q.id, p_tipo: "fijo", p_cuota: 0, p_porcentaje_bp: null, p_monto_centavos: 25000 });
  const reglasQ = await db.q("select tipo, monto_centavos::int as m, vigente_desde::text as d, vigente_hasta::text as h from public.reglas_comision where club_id = $1 order by vigente_desde", [Q.id]);
  revisar(!repro.error && reglasQ.length === 2 && reglasQ[0].h === sumar(L, 6) && reglasQ[1].m === 25000 && reglasQ[1].h === null, "reprogramar reemplaza la programada; la vigente cierra el domingo", JSON.stringify(reglasQ));
  const q2 = await liquidarEn(Q, Q.rp.id, hoyC, 50000);
  const q3 = await liquidarEn(Q, Q.rp.id, sumar(L, 6), 50000);
  const q4 = await liquidarEn(Q, Q.rp.id, sumar(L, 7), 50000);
  const q5 = await liquidarEn(Q, Q.rp.id, sumar(L, 8), 50000);
  revisar(q2.centavos === 20000 && q3.centavos === 20000, "lo que falta de esta semana sigue con la cuota (2.ª y 3.ª pagan $200): no es retroactiva", JSON.stringify([q2, q3]));
  revisar(q4.centavos === 25000 && q5.centavos === 25000 && q4.regla && q4.regla !== q2.regla, "desde el lunes siguiente: $250 fijo, con la regla nueva", JSON.stringify([q4, q5]));
  const cfgQ = (await Q.gerente.c.rpc("config_rp_actual", { p_club: Q.id })).data;
  revisar(cfgQ?.vigente?.tipo === "cuota" && cfgQ.programada?.monto_centavos === 25000 && cfgQ.siguiente_lunes === sumar(L, 7), "la pantalla ve la cuota vigente y la programada", JSON.stringify(cfgQ));
  // Un RP con regla propia gana sobre la del antro también aquí.
  const N1 = C.rps.n1;
  ok(await svc.from("rp_comision_overrides").insert({ club_id: C.id, rp_id: N1.id, comision_tipo: "fijo", comision_monto: 75, comision_desbloqueo_reservas: 2 }), "override");
  const o = [await liquidarEn(C, N1.id, sumar(L, -35), 50000), await liquidarEn(C, N1.id, sumar(L, -34), 50000)];
  revisar(o.map((x) => x.centavos).join() === "0,7500", "regla propia del RP con D=2: $0 y la 2.ª $75", JSON.stringify(o));
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      await db.q("delete from public.producto_movimientos where club_id = any($1::uuid[])", [clubIds]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const t of ["config_rp_cambios", "reglas_comision", "club_config_rp", "rp_comision_overrides", "reservations", "productos", "club_tables"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza falló: " + e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedan = await db.q("select (select count(*) from public.clubs where nombre like 'T cli %' and nombre like $1)::int as clubs, (select count(*) from auth.users where email like $2)::int as cuentas", [`%${TAG}`, `t_cli_${TAG}_%`]);
  await db.fin();
  console.log(`\nLimpieza: ${clubIds.length} antros y ${ids.length} cuentas de prueba borrados (quedan ${quedan[0].clubs} antros y ${quedan[0].cuentas} cuentas).`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
