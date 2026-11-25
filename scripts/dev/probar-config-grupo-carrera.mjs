// Pruebas de concurrencia y de «por reserva sin regla» de la configuración
// por grupo (sql/post-junta-2/12-config-grupo.sql), contra antroapp-dev, con
// DOS conexiones a la vez (como dos personas en dos teléfonos). Datos propios
// (prefijo t_alta_ / «T alta carrera») que se borran al final aunque falle.
//
//   node scripts/dev/probar-config-grupo-carrera.mjs
//
// Cada carrera: la conexión 1 hace su cambio y NO confirma; la 2 lanza el
// suyo (que debe quedarse esperando el candado); se confirma la 1, luego la
// 2, y se revisa que lo guardado y la marca «propio / del grupo» digan lo
// mismo (antes, el cambio del gerente se borraba en silencio y el antro
// quedaba marcado propio con la regla del grupo).
//   1. Regla: gerente primero, grupo después  → gana el gerente, cuenta propio.
//   2. Regla: grupo primero, gerente después  → gana el gerente (llegó al final).
//   3. Qué ven los RPs: gerente primero       → gana el gerente.
//   4. Tarifa por día del dueño vs modo del grupo → gana el dueño.
//   5. Cover del dueño (UPDATE de clubs) vs cover del grupo → gana el dueño.
//   6. Regla con BLOQUEO del grupo vs gerente → gana el grupo y no queda propio.
//   7. Por reserva sin regla: el grupo pasa a «por reserva» un antro por día
//      sin reglas → rechazado si el grupo no tiene regla; con regla del grupo,
//      se le pone (desde este lunes) y nunca queda con las columnas viejas.
//      Igual con «volver al del grupo».

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const TAG = "cc" + randomUUID().slice(0, 6);
const ids = [], clubIds = [], grupoIds = [];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const lunesDe = (f) => {
  const d = new Date(f + "T12:00:00Z");
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3).toISOString().slice(0, 10);
};
const sumar = (f, n) => new Date(Date.parse(f + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);

const db = await conectarDevEscritura();
const q = db.q;
const c1 = await conectarDevEscritura();
const c2 = await conectarDevEscritura();

async function usuario(clave, role, club_id = null) {
  const email = `t_alta_${TAG}_${clave}@example.com`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: "Prueba-" + randomUUID(), email_confirm: true });
  if (error) throw new Error("usuario " + clave + ": " + error.message);
  ids.push(data.user.id);
  await q("insert into public.profiles (id, nombre, role, club_id, activo) values ($1, $2, $3, $4, true)", [data.user.id, `${clave} ${TAG}`, role, club_id]);
  return data.user.id;
}
async function club(k, extra = {}) {
  const cols = { nombre: `T alta carrera ${k} ${TAG}`, direccion: "Calle 1", horario: "Vie", pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 0, ...extra };
  const keys = Object.keys(cols);
  const r = await q(`insert into public.clubs (${keys.join(", ")}) values (${keys.map((_, i) => "$" + (i + 1)).join(", ")}) returning id`, Object.values(cols));
  clubIds.push(r[0].id);
  return r[0].id;
}
async function grupo(k) {
  const r = await q("insert into public.grupos (nombre) values ($1) returning id", [`T alta carrera grupo ${k} ${TAG}`]);
  grupoIds.push(r[0].id);
  return r[0].id;
}
// Entra al grupo SIGUIENDO al grupo en todo (como un alta con «usar lo del grupo»).
async function alGrupo(g, c) {
  await q("insert into public.grupo_clubs (grupo_id, club_id) values ($1, $2)", [g, c]);
  await q("delete from public.club_config_propia where club_id = $1", [c]);
}
// Abre una transacción en la conexión como si fuera esa cuenta (con RLS).
async function como(cx, uid) {
  await cx.q("begin");
  await cx.q("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: uid, role: "authenticated" }), uid]);
  await cx.q("set local role authenticated");
}
const marcas = async (c) => (await q("select clave from public.club_config_propia where club_id = $1 order by clave", [c])).map((x) => x.clave);
const reglas = async (c) => (await q("select tipo, monto_centavos::int as monto, vigente_desde::text as desde, vigente_hasta::text as hasta from public.reglas_comision where club_id = $1 order by vigente_desde", [c]));
const vis = async (c) => (await q("select public.rp_nivel_visibilidad($1) as v", [c]))[0].v;

// La 2 lanza su cambio con la 1 abierta: debe quedarse esperando.
async function carrera(primero, segundo, nombre) {
  await primero.cx.q(primero.sql, primero.params);
  let listo = false;
  const p2 = segundo.cx.q(segundo.sql, segundo.params).then(
    (r) => ((listo = true), { r }),
    (e) => ((listo = true), { e }),
  );
  await espera(1500);
  revisar(!listo, `${nombre}: el segundo cambio espera el candado del primero`);
  await primero.cx.q("commit");
  const res = await p2;
  if (res.e) await segundo.cx.q("rollback").catch(() => {});
  else await segundo.cx.q("commit");
  return res;
}

try {
  const hoy = hoyMx();
  const lunes = lunesDe(hoy);
  const sigLunes = sumar(lunes, 7);

  const g = await grupo("G");
  const duenoG = await usuario("duenog", "dueno");
  await q("insert into public.grupo_miembros (grupo_id, profile_id, rol_grupo) values ($1, $2, 'dueno_grupo')", [g, duenoG]);
  const duenoX = await usuario("duenox", "dueno");
  const X = await club("X", { dueno_id: duenoX });
  const gerX = await usuario("gerentex", "gerente", X);
  await q("insert into public.reglas_comision (club_id, tipo, monto_centavos, vigente_desde, creada_por) values ($1, 'fijo', 10000, $2::date, $3)", [X, sumar(lunes, -7), duenoX]);
  await alGrupo(g, X);
  revisar((await marcas(X)).length === 0, "X sigue al grupo en todo");

  // ---------- 1. Regla: gerente primero ----------
  await como(c1, gerX);
  await como(c2, duenoG);
  const r1 = await carrera(
    { cx: c1, sql: "select public.config_rp_cambiar_regla($1, 'fijo', 0, null, 50000)", params: [X] },
    { cx: c2, sql: "select public.grupo_config_cambiar($1, 'regla_comision', $2::jsonb) as r", params: [g, JSON.stringify({ tipo: "fijo", monto_centavos: 25000 })] },
    "regla, gerente primero");
  const res1 = r1.r?.[0]?.r;
  const rx1 = await reglas(X);
  const ultima1 = rx1[rx1.length - 1];
  revisar(!r1.e && res1?.propios === 1 && res1?.siguen === 0 && res1?.cambiaron === 0, "…el grupo lo cuenta como propio (siguen 0, propios 1)", JSON.stringify(r1.e?.message ?? res1));
  revisar((await marcas(X)).includes("regla_comision") && ultima1?.monto === 50000 && ultima1.desde === sigLunes && ultima1.hasta === null,
    "…la regla del gerente ($500 desde el lunes) se queda y X está marcado propio: pantalla y dinero dicen lo mismo", JSON.stringify(rx1));

  // ---------- 2. Regla: grupo primero (X vuelve a seguir al grupo) ----------
  await q("delete from public.club_config_propia where club_id = $1", [X]);
  await como(c1, duenoG);
  await como(c2, gerX);
  const r2 = await carrera(
    { cx: c1, sql: "select public.grupo_config_cambiar($1, 'regla_comision', $2::jsonb)", params: [g, JSON.stringify({ tipo: "fijo", monto_centavos: 30000 })] },
    { cx: c2, sql: "select public.config_rp_cambiar_regla($1, 'fijo', 0, null, 60000)", params: [X] },
    "regla, grupo primero");
  const rx2 = await reglas(X);
  revisar(!r2.e && (await marcas(X)).includes("regla_comision") && rx2[rx2.length - 1]?.monto === 60000 && rx2.filter((x) => x.hasta === null).length === 1,
    "…gana el gerente (llegó al final), queda propio y una sola regla abierta", JSON.stringify(r2.e?.message ?? rx2));

  // ---------- 3. Qué ven los RPs: gerente primero ----------
  await como(c1, gerX);
  await como(c2, duenoG);
  const r3 = await carrera(
    { cx: c1, sql: "select public.config_rp_cambiar_visibilidad($1, 'estado')", params: [X] },
    { cx: c2, sql: "select public.grupo_config_cambiar($1, 'visibilidad_rp', '\"estado_monto_botellas\"'::jsonb) as r", params: [g] },
    "visibilidad, gerente primero");
  revisar(!r3.e && r3.r?.[0]?.r?.propios === 1 && (await vis(X)) === "estado" && (await marcas(X)).includes("visibilidad_rp"),
    "…se queda «estado» del gerente, X marcado propio y el grupo lo cuenta así", JSON.stringify(r3.e?.message ?? r3.r?.[0]?.r));

  // ---------- 4. Tarifa por día del dueño vs modo del grupo ----------
  await como(c1, duenoX);
  await como(c2, duenoG);
  const r4 = await carrera(
    { cx: c1, sql: "insert into public.club_dia_tarifas (club_id, posicion, monto) values ($1, 1, 100)", params: [X] },
    { cx: c2, sql: "select public.grupo_config_cambiar($1, 'modo_pago', $2::jsonb) as r", params: [g, JSON.stringify({ modo: "dia", tarifas_dia: [{ posicion: 1, monto_centavos: 30000 }] })] },
    "tarifa del dueño vs modo del grupo");
  const t4 = await q("select posicion, monto::text from public.club_dia_tarifas where club_id = $1", [X]);
  const m4 = (await q("select pago_rp_modo from public.clubs where id = $1", [X]))[0].pago_rp_modo;
  revisar(!r4.e && r4.r?.[0]?.r?.propios === 1 && m4 === "reserva" && t4.length === 1 && Number(t4[0].monto) === 100 && (await marcas(X)).includes("modo_pago"),
    "…X sigue por reserva con la tarifa del dueño ($100) y marcado propio", JSON.stringify(r4.e?.message ?? { m4, t4 }));

  // ---------- 5. Cover del dueño (UPDATE de clubs) vs cover del grupo ----------
  await como(c1, duenoX);
  await como(c2, duenoG);
  const r5 = await carrera(
    { cx: c1, sql: "update public.clubs set cover_modo = 'libre' where id = $1", params: [X] },
    { cx: c2, sql: "select public.grupo_config_cambiar($1, 'cover', $2::jsonb) as r", params: [g, JSON.stringify({ cover_modo: "monto", cover_monto_centavos: 20000 })] },
    "cover del dueño vs cover del grupo");
  const cov5 = (await q("select cover_modo from public.clubs where id = $1", [X]))[0].cover_modo;
  revisar(!r5.e && r5.r?.[0]?.r?.propios === 1 && cov5 === "libre" && (await marcas(X)).includes("cover"),
    "…se queda el cover libre del dueño y X marcado propio", JSON.stringify(r5.e?.message ?? { cov5, r: r5.r?.[0]?.r }));

  // ---------- 6. Regla con BLOQUEO del grupo vs gerente ----------
  await como(c1, gerX);
  await como(c2, duenoG);
  const r6 = await carrera(
    { cx: c1, sql: "select public.config_rp_cambiar_regla($1, 'fijo', 0, null, 70000)", params: [X] },
    { cx: c2, sql: "select public.grupo_config_cambiar($1, 'regla_comision', $2::jsonb, true) as r", params: [g, JSON.stringify({ tipo: "fijo", monto_centavos: 40000 })] },
    "bloqueo del grupo vs gerente");
  const rx6 = await reglas(X);
  revisar(!r6.e && r6.r?.[0]?.r?.siguen === 1 && !(await marcas(X)).includes("regla_comision") && rx6[rx6.length - 1]?.monto === 40000,
    "…con bloqueo gana el grupo ($400) y X ya no queda marcado propio (sigue al grupo)", JSON.stringify(r6.e?.message ?? { rx6, m: await marcas(X) }));
  await como(c1, gerX);
  const r6b = await c1.q("select public.config_rp_cambiar_regla($1, 'fijo', 0, null, 80000)", [X]).then(() => null, (e) => e);
  await c1.q("rollback");
  revisar(r6b?.code === "P0001" && /lo define el grupo/.test(r6b.message), "…y después el gerente ya no puede cambiarla (bloqueada)", r6b?.message);

  // ---------- 7. Por reserva sin regla ----------
  const g2 = await grupo("G2");
  await q("insert into public.grupo_miembros (grupo_id, profile_id, rol_grupo) values ($1, $2, 'dueno_grupo')", [g2, duenoG]);
  const Y = await club("Y", { pago_rp_modo: "dia" });
  await q("insert into public.club_dia_tarifas (club_id, posicion, monto) values ($1, 1, 300)", [Y]);
  await alGrupo(g2, Y);
  await como(c1, duenoG);
  const e7 = await c1.q("select public.grupo_config_cambiar($1, 'modo_pago', '{\"modo\":\"reserva\"}'::jsonb)", [g2]).then(() => null, (e) => e);
  await c1.q("rollback");
  const y7 = (await q("select pago_rp_modo from public.clubs where id = $1", [Y]))[0].pago_rp_modo;
  revisar(e7?.code === "P0001" && /hace falta la regla de comisión/.test(e7.message) && y7 === "dia" && (await reglas(Y)).length === 0,
    "grupo sin regla pasa a «por reserva» un antro por día sin reglas: rechazado (P0001) y el antro sigue por día", e7?.message);

  // El grupo define su regla mientras Y la tiene «propia» (sin ninguna fila).
  await q("insert into public.club_config_propia (club_id, clave) values ($1, 'regla_comision')", [Y]);
  await como(c1, duenoG);
  await c1.q("select public.grupo_config_cambiar($1, 'regla_comision', $2::jsonb)", [g2, JSON.stringify({ tipo: "porcentaje", porcentaje_bp: 1000 })]);
  await c1.q("commit");
  revisar((await reglas(Y)).length === 0, "…la regla del grupo no toca a Y (propia, sin filas)");
  await como(c1, duenoG);
  const ok7 = await c1.q("select public.grupo_config_cambiar($1, 'modo_pago', '{\"modo\":\"reserva\"}'::jsonb) as r", [g2]).then((r) => r[0].r, (e) => e);
  await c1.q(ok7 instanceof Error ? "rollback" : "commit");
  const ry = await reglas(Y);
  const desc = (await q("select public.regla_comision_descripcion($1, public.club_fecha_operacion($1, now())) as d", [Y]))[0].d;
  const y7b = (await q("select pago_rp_modo from public.clubs where id = $1", [Y]))[0].pago_rp_modo;
  revisar(!(ok7 instanceof Error) && y7b === "reserva" && ry.length === 1 && ry[0].tipo === "porcentaje" && ry[0].desde === lunes && ry[0].hasta === null,
    `con regla en el grupo: Y pasa a «por reserva» con la regla del grupo (10 %) desde este lunes ${lunes}`, JSON.stringify(ok7 instanceof Error ? ok7.message : ry));
  revisar(desc?.origen !== "anterior", "…y su comisión ya NO sale de las columnas viejas (clubs.comision_*)", JSON.stringify(desc));
  revisar(!(await marcas(Y)).includes("regla_comision"), "…y Y queda siguiendo la regla del grupo");

  // «Volver al del grupo» con un grupo sin regla: rechazado.
  const g3 = await grupo("G3");
  await q("insert into public.grupo_miembros (grupo_id, profile_id, rol_grupo) values ($1, $2, 'dueno_grupo')", [g3, duenoG]);
  const duenoV = await usuario("duenov", "dueno");
  const V = await club("V", { pago_rp_modo: "dia", dueno_id: duenoV });
  await q("insert into public.club_dia_tarifas (club_id, posicion, monto) values ($1, 1, 300)", [V]);
  await q("insert into public.grupo_clubs (grupo_id, club_id) values ($1, $2)", [g3, V]); // queda propio en todo
  await como(c1, duenoG);
  const rg3 = await c1.q("select public.grupo_config_cambiar($1, 'modo_pago', '{\"modo\":\"reserva\"}'::jsonb) as r", [g3]).then((r) => r[0].r, (e) => e);
  await c1.q(rg3 instanceof Error ? "rollback" : "commit");
  revisar(!(rg3 instanceof Error) && rg3.propios === 1, "grupo sin regla define «por reserva»: V es propio, no se toca ni se rechaza", JSON.stringify(rg3 instanceof Error ? rg3.message : rg3));
  await como(c1, duenoV);
  const eh = await c1.q("select public.club_config_heredar($1, 'modo_pago')", [V]).then(() => null, (e) => e);
  await c1.q("rollback");
  const v7 = (await q("select pago_rp_modo from public.clubs where id = $1", [V]))[0].pago_rp_modo;
  revisar(eh?.code === "P0001" && /hace falta la regla de comisión/.test(eh.message) && v7 === "dia" && (await marcas(V)).includes("modo_pago"),
    "«volver al del grupo» a «por reserva» sin regla en ningún lado: rechazado y V sigue por día y propio", eh?.message);
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
  for (const cx of [c1, c2]) await cx.q("rollback").catch(() => {});
} finally {
  try {
    await q("begin");
    await q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      await q("delete from public.grupo_clubs where club_id = any($1::uuid[])", [clubIds]);
      for (const t of ["config_rp_cambios", "reglas_comision", "club_config_rp", "club_dia_tarifas", "caja_permisos"])
        await q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (grupoIds.length) {
      await q("delete from public.grupo_miembros where grupo_id = any($1::uuid[])", [grupoIds]);
      await q("delete from public.grupos where id = any($1::uuid[])", [grupoIds]);
    }
    if (ids.length) await q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await q("commit");
  } catch (e) {
    await q("rollback");
    console.log("Limpieza falló: " + e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const restos = (await q("select (select count(*) from public.clubs where nombre like $1)::int c, (select count(*) from public.grupos where nombre like $1)::int g, (select count(*) from auth.users where email like $2)::int u",
    [`%${TAG}%`, `t\\_alta\\_${TAG}\\_%`]))[0];
  await Promise.all([db.fin(), c1.fin(), c2.fin()]);
  console.log(`\nLimpieza: ${clubIds.length} antros, ${grupoIds.length} grupos y ${ids.length} cuentas de prueba borrados; restos: ${JSON.stringify(restos)}.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
