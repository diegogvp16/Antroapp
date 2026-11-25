// Pruebas del panel de salud del admin (sql/post-junta-2/32-salud.sql)
// contra antroapp-dev. Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-salud.mjs
//
// La base de dev es compartida: la prueba crea sus propios datos (prefijo
// t_rep_, antros "T rep salud …") y los borra al final aunque falle.
//
// 1. Quién la usa: admin sí (sesión real por PostgREST y por claims);
//    dueño, gerente, staff, RP, cliente, cuenta sin perfil, admin con
//    contraseña temporal, admin dado de baja y anónimo, no.
// 2. Umbrales = los de lib/domain/login.ts, lib/domain/captcha.ts y los del
//    trigger reservations_antiabuso_anon.
// 3. Conteos exactos: en UNA transacción (repeatable read, mismo now()) se
//    leen las filas crudas y se llama admin_salud(); los conteos y los
//    bloqueos se recalculan en JS con las MISMAS funciones de
//    lib/domain/login.ts que usa /api/auth/login, y deben coincidir.
//    Los intentos sintéticos de la prueba (par bloqueado, correo bloqueado,
//    IP bloqueada, par desbloqueado por un éxito, intentos viejos) deben
//    aparecer como tales.
// 4. Ningún hash, usuario_id, navegador ni digest en la respuesta.
// 5. admin_salud_reglas(): cuatro antros de prueba con cada alerta y los
//    números de la semana.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requerir = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = requerir("@supabase/supabase-js");
const { createJiti } = requerir("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": RAIZ } });
const login = await jiti.import(path.join(RAIZ, "lib/domain/login.ts"));
const captcha = await jiti.import(path.join(RAIZ, "lib/domain/captcha.ts"));
const salud = await jiti.import(path.join(RAIZ, "lib/domain/salud.ts"));
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const TAG = "t_rep_" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const ZONA = "America/Mexico_City";
const U = {};
const clubs = {};
const hashes = new Set();
let pasan = 0;
let fallan = 0;
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
function revisar(nombre, paso, detalle = "") {
  if (paso) pasan++; else fallan++;
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${!paso && detalle ? "  — " + detalle : ""}`);
}
// Compara sin importar el orden de las llaves (jsonb las ordena a su modo).
const canon = (x) => Array.isArray(x) ? x.map(canon) : x && typeof x === "object" && !(x instanceof Date)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const igual = (nombre, a, b) => { const [ja, jb] = [JSON.stringify(canon(a)), JSON.stringify(canon(b))]; revisar(nombre, ja === jb, `${ja} ≠ ${jb}`); };
// node-pg entrega "date" como Date a medianoche local.
const fechaTexto = (x) => x instanceof Date
  ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}` : String(x).slice(0, 10);
const hash = (s) => { const h = createHash("sha256").update(`${TAG}|${s}`).digest("hex"); hashes.add(h); return h; };
const noche = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA }).format(new Date(Date.now() - 8 * 3600e3));
const sumarDias = (f, d) => new Date(new Date(f + "T12:00:00Z").getTime() + d * 86400e3).toISOString().slice(0, 10);
const lunes = sumarDias(noche, -((new Date(noche + "T12:00:00Z").getUTCDay() + 6) % 7));
const hace = (min) => new Date(Date.now() - min * 60_000).toISOString();

async function usuario(clave, role, club_id = null, extra = {}, meta = null) {
  const email = `${TAG}_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, ...(meta ? { app_metadata: meta } : {}) }), "crear " + clave);
  if (role) ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `T rep ${clave}`, role, club_id, activo: true, ...extra }), "perfil " + clave);
  U[clave] = { id: u.user.id, email, meta };
  return u.user.id;
}
async function sesion(clave) {
  for (let intento = 0; intento < 4; intento++) {
    const c = nuevoAnon();
    const r = await c.auth.signInWithPassword({ email: U[clave].email, password: PASS });
    if (!r.error) return c;
    if (!/rate|limit|too many/i.test(r.error.message)) throw new Error(`login ${clave}: ${r.error.message}`);
    await new Promise((res) => setTimeout(res, 5000 * (intento + 1)));
  }
  throw new Error(`login ${clave}: límite de Supabase Auth`);
}
async function club(clave, extra) {
  const id = randomUUID();
  ok(await svc.from("clubs").insert({ id, nombre: `T rep salud ${clave} ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", dueno_id: U.dueno.id, suscripcion_activa: false }), "club " + clave);
  ok(await svc.from("clubs").update({ zona_horaria: ZONA, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 0, comision_desbloqueo_reservas: 0, ...extra }).eq("id", id), "config " + clave);
  clubs[clave] = id;
  return id;
}

// Llama una función como lo haría PostgREST: rol authenticated (o anon) y
// los claims del JWT. Siempre en una transacción que se deshace.
async function comoUsuario(db, clave, sql) {
  await db.q("begin");
  try {
    if (clave === "anon") {
      await db.q("set local role anon");
      await db.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    } else {
      await db.q("set local role authenticated");
      const claims = { sub: U[clave].id, role: "authenticated", app_metadata: U[clave].meta ?? {} };
      await db.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    }
    return { filas: await db.q(sql) };
  } catch (e) {
    return { error: { code: e.code, message: e.message } };
  } finally {
    await db.q("rollback").catch(() => {});
  }
}

async function limpiar(db) {
  const ids = Object.values(U).map((u) => u.id);
  const clubIds = Object.values(clubs);
  const hs = [...hashes];
  try {
    await db.q("rollback").catch(() => {});
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      await db.q("delete from public.rp_pagos_dia where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_attendance where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.caja_noches where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_comision_overrides where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_dia_tarifa_overrides where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.reglas_comision where club_id = any($1::uuid[])", [clubIds]);
    }
    if (hs.length) {
      await db.q("delete from public.login_intentos where email_hash = any($1::text[]) or ip_hash = any($1::text[])", [hs]);
      await db.q("delete from public.registro_intentos where ip_hash = any($1::text[])", [hs]);
      if (tieneReservaIntentos) await db.q("delete from public.reserva_intentos where ip_hash = any($1::text[]) or telefono_hash = any($1::text[])", [hs]);
    }
    await db.q("delete from public.app_errores where mensaje like $1", [`%${TAG}%`]);
    await db.q("delete from public.alertas_enviadas where tipo like $1", [`${TAG}%`]);
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const [quedan] = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from public.profiles where id = any($3::uuid[]))::int perfiles,
            (select count(*) from auth.users where email like $2)::int usuarios,
            (select count(*) from public.login_intentos where email_hash = any($4::text[]) or ip_hash = any($4::text[]))::int login,
            (select count(*) from public.registro_intentos where ip_hash = any($4::text[]))::int registro,
            (select count(*) from public.app_errores where mensaje like $1)::int errores,
            (select count(*) from public.alertas_enviadas where tipo like $2)::int alertas`,
    [`%${TAG}%`, `${TAG}%`, ids, hs],
  );
  if (tieneReservaIntentos) {
    const [r] = await db.q("select count(*)::int n from public.reserva_intentos where ip_hash = any($1::text[]) or telefono_hash = any($1::text[])", [hs]);
    quedan.reservas_intentos = r.n;
  }
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan)}`);
  return Object.values(quedan).every((n) => n === 0);
}

let tieneReservaIntentos = false;
const db = await conectarDevEscritura();
let limpio = false;
try {
  [{ tieneReservaIntentos }] = await db.q("select to_regclass('public.reserva_intentos') is not null as \"tieneReservaIntentos\"");

  // ---------- Personas ----------
  await usuario("dueno", "dueno");
  await usuario("admin", "admin");
  await usuario("admin_temp", "admin", null, {}, { debe_cambiar: true });
  await usuario("admin_baja", "admin", null, { activo: false });
  await usuario("cliente", "cliente");
  await usuario("sinperfil", null);
  const A = await club("A", {});
  const B = await club("B", { pago_rp_modo: "dia" });
  const C = await club("C", {});
  const D = await club("D", { comision_monto: 100 });
  const E = await club("E", {}); // anterior en $0, pero su único RP tiene regla propia
  await usuario("gerente", "gerente", C);
  await usuario("staff", "staff", C);
  const rp1 = await usuario("rp1", "rp", C);
  const rp2 = await usuario("rp2", "rp", C);
  const rpB = await usuario("rpB", "rp", B);
  const rpE = await usuario("rpE", "rp", E);

  // ---------- Reglas (antro C) ----------
  const R1 = randomUUID();
  const R2 = randomUUID();
  await db.q(
    `insert into public.reglas_comision (id, club_id, tipo, monto_centavos, porcentaje_bp, vigente_desde, vigente_hasta, creada_por)
     values ($1, $3, 'fijo', 15000, null, $4::date - 70, $4::date + 6, $5),
            ($2, $3, 'porcentaje', null, 1000, $4::date + 7, null, $5)`,
    [R1, R2, C, lunes, U.admin.id],
  );
  await db.q(`insert into public.rp_comision_overrides (club_id, rp_id, comision_tipo, comision_monto, comision_desbloqueo_reservas)
              values ($1, $2, 'fijo', 200, 0), ($3, $4, 'fijo', 100, 0)`, [C, rp2, E, rpE]);
  // Reglas propias que NO deben contar en C: un RP dado de baja y un RP que
  // ya es de otro antro (B). Más tarifas por día propias: rp1 (activo, de C)
  // sí cuenta; los otros dos no.
  const rpBajaC = await usuario("rpbajac", "rp", C, { activo: false });
  await db.q(`insert into public.rp_comision_overrides (club_id, rp_id, comision_tipo, comision_monto, comision_desbloqueo_reservas)
              values ($1, $2, 'fijo', 300, 0), ($1, $3, 'fijo', 300, 0)`, [C, rpBajaC, rpB]);
  await db.q(`insert into public.rp_dia_tarifa_overrides (club_id, rp_id, posicion, monto)
              values ($1, $2, 1, 300), ($1, $2, 2, 350), ($1, $3, 1, 300), ($1, $4, 1, 300)`, [C, rp1, rpBajaC, rpB]);

  async function reservaCom(rp, fecha, monto, status, regla) {
    const id = randomUUID();
    await db.q(
      `insert into public.reservations (id, cliente_nombre, cliente_telefono, personas, status, source, rp_id, club_id, fecha, qr_code)
       values ($1, $2, '3312340888', 2, 'confirmada', 'rp', $3, $4, $5, $6)`,
      [id, `Cliente ${TAG}`, rp, C, fecha, `antro-${randomUUID()}`],
    );
    await db.q(`insert into public.commissions (reservation_id, rp_id, tipo, monto, status, regla_id) values ($1, $2, 'rp', $3, $4, $5)`,
      [id, rp, monto, status, regla]);
  }
  await reservaCom(rp1, noche, 150, "pendiente", R1);          // bien
  await reservaCom(rp1, noche, 100, "pendiente", null);        // sin regla_id con regla vigente: inconsistente
  await reservaCom(rp2, noche, 0, "pendiente", null);          // RP con regla propia: bien (y en $0)
  await reservaCom(rp1, noche, 50, "pendiente", R2);           // apunta a la programada: inconsistente
  await reservaCom(rp1, noche, 999, "anulada", null);          // anulada: no cuenta
  await reservaCom(rp1, sumarDias(noche, -40), 150, "pendiente", R1); // pendiente vieja
  await db.q(`insert into public.caja_noches (club_id, fecha_operacion, estado, abierta_por) values ($1, $2::date - 3, 'abierta', $3)`,
    [C, noche, U.gerente.id]);
  await db.q(`insert into public.caja_noches (club_id, fecha_operacion, estado, abierta_por) values ($1, $2::date, 'abierta', $3)`,
    [C, noche, U.gerente.id]); // la de hoy no es alerta

  // Antro B (pago por día, sin tarifas): un pago de la semana.
  const att = randomUUID();
  await db.q(`insert into public.rp_attendance (id, rp_id, club_id, fecha, scanned_at, metodo) values ($1, $2, $3, $4, now(), 'manual')`, [att, rpB, B, noche]);
  await db.q(`insert into public.rp_pagos_dia (rp_attendance_id, rp_id, club_id, fecha, posicion, monto, status) values ($1, $2, $3, $4, 1, 300, 'pendiente')`, [att, rpB, B, noche]);

  // ---------- Intentos sintéticos ----------
  const L = [];
  for (let i = 0; i < 6; i++) L.push([hash("e1"), hash("i1"), false, hace(5 - i * 0.5)]);       // par bloqueado
  for (let i = 0; i < 31; i++) L.push([hash("e2"), hash("i2_" + i), false, hace(10 - i * 0.2)]); // correo bloqueado
  for (let i = 0; i < 21; i++) L.push([hash("e3_" + i), hash("i3"), false, hace(9 - i * 0.2)]);  // IP bloqueada
  for (let i = 0; i < 6; i++) L.push([hash("e4"), hash("i4"), false, hace(8 - i * 0.5)]);
  L.push([hash("e4"), hash("i4"), true, hace(1)]);                                               // éxito: desbloquea
  for (let i = 0; i < 3; i++) L.push([hash("e6"), hash("i6"), false, hace(4 - i)]);              // solo con límite degradado
  for (let i = 0; i < 10; i++) L.push([hash("e5"), hash("i5"), false, hace(120 + i)]);           // hace 2 h: solo en 24 h
  for (const [e, ip, ex, t] of L)
    await db.q("insert into public.login_intentos (email_hash, ip_hash, exito, creado_en) values ($1, $2, $3, $4)", [e, ip, ex, t]);
  const R = [];
  for (let i = 0; i < 5; i++) R.push([hash("r1"), "cliente", false, hace(20 + i)]);  // al límite normal
  for (let i = 0; i < 2; i++) R.push([hash("r2"), "dueno", true, hace(30 + i)]);     // al límite degradado
  R.push([hash("r3"), "cliente", false, hace(10)]);                                  // libre
  R.push([hash("r4"), "cliente", true, hace(300)]);                                  // hace 5 h
  for (const [ip, tipo, deg, t] of R)
    await db.q("insert into public.registro_intentos (ip_hash, tipo, degradado, creado_en) values ($1, $2, $3, $4)", [ip, tipo, deg, t]);
  if (tieneReservaIntentos) {
    for (let i = 0; i < 20; i++)
      await db.q("insert into public.reserva_intentos (ip_hash, club_id, telefono_hash, fecha, creado_en) values ($1, $2, $3, $4, $5)",
        [hash("ri1"), A, hash("t_" + i), noche, hace(10 + i)]);
    for (let i = 0; i < 3; i++)
      await db.q("insert into public.reserva_intentos (ip_hash, club_id, telefono_hash, fecha, creado_en) values ($1, $2, $3, $4, $5)",
        [hash("ri2_" + i), A, hash("tel_rep"), noche, hace(70 + i)]);
  }
  for (let i = 0; i < 3; i++)
    await db.q("insert into public.app_errores (ruta, mensaje, creado_en, navegador, digest, ip_hash) values ($1, $2, $3, 'Navegador de prueba', 'dig', $4)",
      ["/t_rep/salud", `Error de prueba ${TAG}`, hace(30 + i), hash("err")]);
  await db.q("insert into public.app_errores (ruta, mensaje, creado_en) values ($1, $2, $3)", ["/t_rep/salud", `Error de prueba ${TAG}`, hace(3 * 1440)]);
  await db.q("insert into public.alertas_enviadas (tipo, enviado_en) values ($1, $2), ($1, $3)", [`${TAG}_alerta`, hace(60), hace(9 * 1440)]);

  // ---------- 1. Quién la usa (claims, sin pasar por Auth) ----------
  console.log("\n— Acceso (claims) —");
  for (const fn of ["admin_salud()", "admin_salud_reglas()"]) {
    const r = await comoUsuario(db, "admin", `select public.${fn}`);
    revisar(`admin ejecuta ${fn}`, !r.error, r.error?.message);
    for (const clave of ["dueno", "gerente", "staff", "rp1", "cliente", "sinperfil", "admin_temp", "admin_baja"]) {
      const x = await comoUsuario(db, clave, `select public.${fn}`);
      revisar(`${clave} rechazado en ${fn} (P0001)`, x.error?.code === "P0001", x.error ? x.error.code : "pasó");
    }
    const an = await comoUsuario(db, "anon", `select public.${fn}`);
    revisar(`anónimo sin permiso en ${fn} (42501)`, an.error?.code === "42501", an.error ? an.error.code : "pasó");
  }

  // ---------- Catálogo ----------
  const cat = await db.q(
    `select p.proname, p.prosecdef, p.proconfig, p.provolatile,
            has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('public', p.oid, 'execute') pub,
            has_function_privilege('authenticated', p.oid, 'execute') auth
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('admin_salud', 'admin_salud_reglas') order by 1`);
  for (const f of cat) {
    revisar(`${f.proname}: security definer, search_path vacío, stable`, f.prosecdef && JSON.stringify(f.proconfig) === JSON.stringify(['search_path=""']) && f.provolatile === "s", JSON.stringify(f));
    revisar(`${f.proname}: sin execute para anon ni public; sí authenticated`, !f.anon && !f.pub && f.auth, JSON.stringify(f));
  }
  const idx = await db.q("select indexname from pg_indexes where schemaname = 'public' and indexname in ('login_intentos_creado', 'registro_intentos_creado') order by 1");
  igual("índices por creado_en", idx.map((x) => x.indexname), ["login_intentos_creado", "registro_intentos_creado"]);

  // ---------- 2 y 3. Conteos exactos en una sola foto ----------
  console.log("\n— Conteos (misma transacción) —");
  await db.q("begin isolation level repeatable read");
  let foto;
  try {
    const [{ ahora }] = await db.q("select now() as ahora");
    const li = await db.q("select email_hash, ip_hash, exito, creado_en from public.login_intentos where creado_en >= now() - interval '24 hours' order by creado_en desc");
    const ri = await db.q("select ip_hash, tipo, degradado, creado_en from public.registro_intentos where creado_en >= now() - interval '24 hours'");
    const rs = tieneReservaIntentos ? await db.q("select ip_hash, club_id, telefono_hash, fecha, creado_en from public.reserva_intentos where creado_en >= now() - interval '24 hours'") : null;
    const er = await db.q("select ruta, mensaje, creado_en from public.app_errores where creado_en >= now() - interval '7 days'");
    const al = await db.q("select tipo, max(enviado_en) ultima, count(*) filter (where enviado_en >= now() - interval '7 days')::int veces from public.alertas_enviadas group by tipo");
    const fuente = tieneReservaIntentos
      ? (await db.q("select pg_get_functiondef('public.reservations_antiabuso_anon()'::regprocedure) d"))[0].d : "";
    await db.q("set local role authenticated");
    await db.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.admin.id, role: "authenticated" })]);
    const [{ s }] = await db.q("select public.admin_salud() as s");
    foto = { ahora: new Date(ahora), li, ri, rs, er, al, s, fuente };
  } finally {
    await db.q("rollback");
  }
  const { ahora, li, ri, rs, er, al, s, fuente } = foto;
  const ms = (x) => new Date(x).getTime();
  const hora = ms(ahora) - 3600e3;

  // Umbrales.
  igual("umbrales de login = lib/domain/login.ts", [s.umbrales.ventana_minutos, s.umbrales.max_fallos_correo_ip, s.umbrales.max_fallos_correo, s.umbrales.max_fallos_ip],
    [login.VENTANA_MINUTOS, login.MAX_FALLOS_POR_CORREO_E_IP, login.MAX_FALLOS_POR_CORREO, login.MAX_FALLOS_POR_IP]);
  igual("umbrales degradados = lib/domain/captcha.ts", [s.umbrales.degradado_max_fallos_correo_ip, s.umbrales.degradado_max_fallos_ip, s.umbrales.registros_por_ip_hora, s.umbrales.degradado_registros_por_ip_hora],
    [captcha.DEGRADADO_MAX_FALLOS_POR_CORREO_E_IP, captcha.DEGRADADO_MAX_FALLOS_POR_IP, captcha.REGISTROS_POR_IP_HORA, captcha.DEGRADADO_REGISTROS_POR_IP_HORA]);
  if (tieneReservaIntentos) {
    revisar("umbral de reservas por IP = trigger", new RegExp(`interval '1 hour'\\)\\s*>=\\s*${s.umbrales.reservas_por_ip_hora}\\b`).test(fuente));
    revisar("umbral de reservas por teléfono = trigger", new RegExp(`r\\.fecha = new\\.fecha\\)\\s*>=\\s*${s.umbrales.reservas_por_telefono_noche}\\b`).test(fuente));
  }

  // Login: totales.
  const enHora = li.filter((x) => ms(x.creado_en) >= hora);
  const distintos = (arr, k) => new Set(arr.map((x) => x[k])).size;
  igual("login 1 h", s.login.hora, { total: enHora.length, fallidos: enHora.filter((x) => !x.exito).length, correos: distintos(enHora, "email_hash"), ips: distintos(enHora, "ip_hash") });
  igual("login 24 h", s.login.dia, { total: li.length, fallidos: li.filter((x) => !x.exito).length, correos: distintos(li, "email_hash"), ips: distintos(li, "ip_hash") });
  revisar("los intentos de hace 2 h cuentan en 24 h y no en 1 h", li.filter((x) => x.email_hash === hash("e5")).length === 10 && enHora.every((x) => x.email_hash !== hash("e5")));

  // Bloqueos, recalculados con las funciones de /api/auth/login.
  const ventana = li.filter((x) => ms(x.creado_en) >= ms(ahora) - login.VENTANA_MINUTOS * 60_000).map((x) => ({ ...x, creado_en: new Date(x.creado_en).toISOString() }));
  const agrupar = (arr, k) => { const m = new Map(); for (const x of arr) { const c = k(x); if (!m.has(c)) m.set(c, []); m.get(c).push(x); } return m; };
  const bloq = (fallos, max) => login.minutosDeBloqueo(fallos, max, ahora) > 0;
  const pares = agrupar(ventana, (x) => x.email_hash + "|" + x.ip_hash);
  const correos = agrupar(ventana, (x) => x.email_hash);
  const ips = agrupar(ventana, (x) => x.ip_hash);
  const parBloq = (lista, max) => bloq(login.fallosDesdeUltimoExito(lista), max);
  const ipBloq = (lista, max) => bloq(lista.filter((x) => !x.exito), max);
  const contar = (m, f, max) => [...m.values()].filter((l) => f(l, max)).length;
  igual("bloqueos = cálculo de /api/auth/login", s.bloqueos, {
    pares_correo_ip: contar(pares, parBloq, login.MAX_FALLOS_POR_CORREO_E_IP),
    correos: contar(correos, parBloq, login.MAX_FALLOS_POR_CORREO),
    ips: contar(ips, ipBloq, login.MAX_FALLOS_POR_IP),
    pares_correo_ip_degradado: contar(pares, parBloq, captcha.DEGRADADO_MAX_FALLOS_POR_CORREO_E_IP),
    ips_degradado: contar(ips, ipBloq, captcha.DEGRADADO_MAX_FALLOS_POR_IP),
  });
  const p = (e, i) => pares.get(hash(e) + "|" + hash(i)) ?? [];
  revisar("par de prueba (6 fallos) bloqueado", parBloq(p("e1", "i1"), login.MAX_FALLOS_POR_CORREO_E_IP));
  revisar("correo de prueba (31 fallos, 31 IPs) bloqueado", parBloq(correos.get(hash("e2")) ?? [], login.MAX_FALLOS_POR_CORREO));
  revisar("IP de prueba (21 fallos) bloqueada", ipBloq(ips.get(hash("i3")) ?? [], login.MAX_FALLOS_POR_IP));
  revisar("par con éxito al final NO bloqueado", !parBloq(p("e4", "i4"), login.MAX_FALLOS_POR_CORREO_E_IP));
  revisar("par con 3 fallos: solo con el límite degradado", !parBloq(p("e6", "i6"), 5) && parBloq(p("e6", "i6"), 3));
  revisar("bloqueos mínimos de la prueba", s.bloqueos.pares_correo_ip >= 1 && s.bloqueos.correos >= 1 && s.bloqueos.ips >= 1 && s.bloqueos.pares_correo_ip_degradado >= 2, JSON.stringify(s.bloqueos));

  // Registros.
  const riHora = ri.filter((x) => ms(x.creado_en) >= hora);
  const porIpHora = agrupar(riHora, (x) => x.ip_hash);
  const porIpDia = agrupar(ri, (x) => x.ip_hash);
  const tipos = {};
  for (const x of ri) tipos[x.tipo] = (tipos[x.tipo] ?? 0) + 1;
  const top = [...porIpDia.values()].map((l) => ({ registros: l.length, degradados: l.filter((x) => x.degradado).length }))
    .sort((a, b) => b.registros - a.registros || b.degradados - a.degradados).slice(0, 10);
  igual("registros 1 h", s.registro.hora, { total: riHora.length, degradados: riHora.filter((x) => x.degradado).length });
  igual("registros 24 h", s.registro.dia, {
    total: ri.length, degradados: ri.filter((x) => x.degradado).length, ips: porIpDia.size,
    ips_con_degradado: [...porIpDia.values()].filter((l) => l.some((x) => x.degradado)).length, por_tipo: tipos });
  igual("IPs al límite de registros", s.registro.ips_al_limite_hora,
    [...porIpHora.values()].filter((l) => l.length >= captcha.REGISTROS_POR_IP_HORA || (l.some((x) => x.degradado) && l.length >= captcha.DEGRADADO_REGISTROS_POR_IP_HORA)).length);
  igual("top de IPs (solo números)", s.registro.top_ips_dia, top);
  revisar("las 2 IPs de prueba al límite cuentan", s.registro.ips_al_limite_hora >= 2);

  // Reservas sin cuenta.
  if (tieneReservaIntentos) {
    const rsHora = rs.filter((x) => ms(x.creado_en) >= hora);
    const tel = agrupar(rs, (x) => `${x.club_id}|${x.telefono_hash}|${fechaTexto(x.fecha)}`);
    igual("reservas sin cuenta", s.reservas_sin_cuenta, {
      hora: rsHora.length, dia: rs.length,
      ips_al_limite_hora: [...agrupar(rsHora, (x) => x.ip_hash).values()].filter((l) => l.length >= 20).length,
      telefonos_al_limite: [...tel.values()].filter((l) => l.length >= 3).length,
    });
    revisar("IP y teléfono de prueba al límite", s.reservas_sin_cuenta.ips_al_limite_hora >= 1 && s.reservas_sin_cuenta.telefonos_al_limite >= 1);
  } else {
    revisar("sin reserva_intentos: el bloque sale null", s.reservas_sin_cuenta === null);
  }

  // Errores y alertas.
  const grupoPrueba = s.errores.grupos.find((g) => g.mensaje === `Error de prueba ${TAG}`);
  igual("grupo de errores de la prueba", grupoPrueba && { ruta: grupoPrueba.ruta, veces: grupoPrueba.veces, veces_24h: grupoPrueba.veces_24h }, { ruta: "/t_rep/salud", veces: 4, veces_24h: 3 });
  igual("errores 24 h y 7 días", [s.errores.dia, s.errores.semana, s.errores.grupos_total],
    [er.filter((x) => ms(x.creado_en) >= ms(ahora) - 86400e3).length, er.length, new Set(er.map((x) => `${x.mensaje}|${x.ruta}`)).size]);
  revisar("grupos ordenados por 24 h", s.errores.grupos.every((g, i, a) => i === 0 || a[i - 1].veces_24h >= g.veces_24h));
  const alPrueba = s.alertas.find((a) => a.tipo === `${TAG}_alerta`);
  revisar("alerta de prueba: 2 envíos, 1 en 7 días", alPrueba?.veces_7d === 1 && al.find((a) => a.tipo === `${TAG}_alerta`)?.veces === 1, JSON.stringify(alPrueba));

  // ---------- 4. Nada personal ----------
  const texto = JSON.stringify(s);
  revisar("ninguna cadena de 64 hex (hashes)", !/[0-9a-f]{64}/i.test(texto));
  revisar("ninguno de los hashes de prueba", [...hashes].every((h) => !texto.includes(h)));
  revisar("sin usuario_id, navegador, digest ni ip_hash", !/usuario_id|navegador|digest|ip_hash|email_hash|telefono_hash|Navegador de prueba/.test(texto));

  // ---------- 5. Reglas por antro ----------
  console.log("\n— Reglas por antro —");
  const rg = await comoUsuario(db, "admin", "select * from public.admin_salud_reglas()");
  const fila = (id) => rg.filas?.find((x) => x.club_id === id);
  const fA = fila(A), fB = fila(B), fC = fila(C), fD = fila(D);
  revisar("los 4 antros de prueba aparecen", fA && fB && fC && fD);
  igual("A (anterior, $0): alertas", fA?.alertas, ["legacy", "sin_regla"]);
  igual("A: regla anterior", fA?.regla?.origen, "anterior");
  igual("B (por día, sin tarifas): alertas", fB?.alertas, ["dia_sin_tarifas"]);
  igual("B: pagos por día de la semana", [fB?.pagos_dia_semana, Number(fB?.pagos_dia_semana_centavos)], [1, 30000]);
  igual("C: regla vigente = R1", [fC?.regla?.origen, fC?.regla?.id], ["regla", R1]);
  igual("C: programada = R2 desde el lunes que viene", [fC?.programada?.tipo, fC?.programada?.porcentaje_bp, String(fC?.programada?.vigente_desde).slice(0, 10)], ["porcentaje", 1000, sumarDias(lunes, 7)]);
  igual("C: RPs activos y con regla propia (sin bajas ni RPs de otro antro)", [fC?.rps_activos, fC?.rps_con_regla_propia], [2, 1]);
  igual("C: RPs con tarifa por día propia (sin bajas ni RPs de otro antro; 2 posiciones = 1 RP)", fC?.rps_con_tarifa_dia_propia, 1);
  revisar("C: 'con regla propia' nunca pasa de 'activos'", (fC?.rps_con_regla_propia ?? 0) <= (fC?.rps_activos ?? 0) && (fC?.rps_con_tarifa_dia_propia ?? 0) <= (fC?.rps_activos ?? 0));
  {
    const todos = rg.filas ?? [];
    const malos = todos.filter((x) => x.rps_con_regla_propia > x.rps_activos || x.rps_con_tarifa_dia_propia > x.rps_activos).map((x) => x.nombre);
    revisar("ningún antro de dev con más 'con regla propia' que activos", malos.length === 0, malos.join(", "));
  }
  igual("C: comisiones de la semana (sin anuladas)", [fC?.comisiones_semana, fC?.comisiones_semana_en_cero, Number(fC?.comision_semana_centavos)], [4, 1, 30000]);
  igual("C: inconsistentes, noches sin cerrar, pendientes viejas", [fC?.comisiones_inconsistentes, fC?.noches_sin_cerrar, fC?.pendientes_viejas], [2, 1, 1]);
  igual("C: alertas", fC?.alertas, ["regla_id_inconsistente", "noche_sin_cerrar", "pendientes_viejas"]);
  igual("D (anterior, $100): solo legacy", fD?.alertas, ["legacy"]);
  igual("E (anterior, $0, todos sus RPs con regla propia): solo legacy", fila(E)?.alertas, ["legacy"]);
  igual("semana desde el lunes", fechaTexto(fC?.semana_desde), lunes);
  igual("Club Demo Dev aparece", !!rg.filas?.find((x) => x.club_id === "0de70000-0000-4000-8000-000000000001"), true);
  igual("descripción de la regla de C", salud.describirRegla(fC?.regla), "$150 por reserva que consume");
  igual("descripción de la programada", salud.describirRegla(fC?.programada), "10 % del consumo");

  // ---------- 1b. Sesiones reales (PostgREST) ----------
  console.log("\n— Acceso (sesiones reales) —");
  const cAdmin = await sesion("admin");
  const r1 = await cAdmin.rpc("admin_salud");
  revisar("admin por PostgREST: admin_salud", !r1.error && r1.data?.login?.dia?.total >= 0, r1.error?.message);
  const r2 = await cAdmin.rpc("admin_salud_reglas");
  revisar("admin por PostgREST: admin_salud_reglas", !r2.error && r2.data?.some((x) => x.club_id === C), r2.error?.message);
  for (const clave of ["dueno", "admin_temp"]) {
    const c = await sesion(clave);
    const x = await c.rpc("admin_salud");
    revisar(`${clave} por PostgREST: rechazado`, x.error?.code === "P0001", x.error?.code ?? "pasó");
  }
  const an = await nuevoAnon().rpc("admin_salud");
  revisar("anónimo por PostgREST: rechazado", !!an.error && !an.data, an.error?.code);

  // Reglas puras.
  igual("porcentajeFallo", [salud.porcentajeFallo(1, 8), salud.porcentajeFallo(0, 0), salud.porcentajeFallo(2, 3)], ["12.5 %", "—", "66.7 %"]);
  igual("tonoFallo", [salud.tonoFallo(1, 5), salud.tonoFallo(4, 10), salud.tonoFallo(7, 10)], ["ok", "warn", "err"]);
} catch (e) {
  fallan++;
  console.log("FALLA  error inesperado:", e.message);
} finally {
  limpio = await limpiar(db);
  await db.fin();
}
revisar("limpieza sin restos", limpio);
console.log(`\n${pasan}/${pasan + fallan} pasan`);
process.exit(fallan ? 1 : 0);
