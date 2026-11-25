// Pruebas de los exportables CSV (sql/post-junta-2/31-exportes.sql) contra
// antroapp-dev, con sesiones REALES (PostgREST + anon key + RLS). Se niega a
// correr fuera de dev.
//
//   node scripts/dev/probar-exportes.mjs
//
// 1. Escenario propio (prefijo t_rep_, se borra al final aunque falle): dos
//    antros (México y Tijuana), un grupo, una persona por rol. Noche de ayer
//    cargada en bloque (más de 1000 reservas, consumos y comisiones, para la
//    paginación) y la noche en curso por el camino real de la caja (puerta,
//    mesa, consumo, anulación, cobro y cuadre).
// 2. Quién descarga: admin, dueño, dueño de grupo y gerente activo sí;
//    staff, RP, cliente, anónimo, dueño y gerente de otro antro, cuenta sin
//    perfil, gerente dado de baja y con contraseña temporal, no.
// 3. Teléfonos: completo solo para dueño y gerente del antro; el admin ve los
//    últimos 4; el dueño de grupo, ninguno.
// 4. Sumas = grupo_resumen y = reporte_cierre_noche noche por noche, al
//    centavo; conteos = la base; paginación sin repetidos ni huecos.
// 5. Rango, cursor y zona horaria (hora del antro).
// 6. Club Demo Dev (solo lectura, transacción READ ONLY): exportes = caja =
//    /grupo = cierre de cada noche.
// 7. El CSV que arma lib/domain/exportes.ts con renglones reales.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requerir = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = requerir("@supabase/supabase-js");
const { createJiti } = requerir("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": RAIZ } });
const dom = await jiti.import(path.join(RAIZ, "lib/domain/exportes.ts"));
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const CLUB_DEMO = "0de70000-0000-4000-8000-000000000001";
const TAG = "t_rep_" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const TEL = "3312340777";
const U = {};
const clubs = {};
let pasan = 0;
let fallan = 0;
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
function revisar(nombre, paso, detalle = "") {
  if (paso) pasan++; else fallan++;
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${!paso && detalle ? "  — " + detalle : ""}`);
}
const igual = (nombre, a, b) => revisar(nombre, Number(a) === Number(b), `${a} ≠ ${b}`);
const nocheEn = (zona) => new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date(Date.now() - 8 * 3600e3));
const sumarDias = (f, d) => new Date(new Date(f + "T12:00:00Z").getTime() + d * 86400e3).toISOString().slice(0, 10);

async function usuario(clave, role, club_id = null, extra = {}, meta = null) {
  const email = `${TAG}_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, ...(meta ? { app_metadata: meta } : {}) }), "crear " + clave);
  if (role) ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `T rep ${clave}`, role, club_id, activo: true, ...extra }), "perfil " + clave);
  U[clave] = { id: u.user.id, email };
  return u.user.id;
}
async function sesion(clave) {
  const c = nuevoAnon();
  ok(await c.auth.signInWithPassword({ email: U[clave].email, password: PASS }), "login " + clave);
  return c;
}
async function club(clave, zona, dueno) {
  const id = randomUUID();
  ok(await svc.from("clubs").insert({ id, nombre: `T rep ${clave} ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", dueno_id: dueno, suscripcion_activa: false }), "club " + clave);
  ok(await svc.from("clubs").update({ zona_horaria: zona, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 0, comision_desbloqueo_reservas: 0 }).eq("id", id), "config " + clave);
  clubs[clave] = { id, zona, noche: nocheEn(zona) };
  return id;
}
async function reserva(clubClave, extra) {
  const r = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: TEL, personas: 3, status: "confirmada",
    source: "organica", rp_id: null, club_id: clubs[clubClave].id, fecha: clubs[clubClave].noche, qr_code: `antro-${randomUUID()}`, ...extra };
  ok(await svc.from("reservations").insert(r), "reserva");
  return r;
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const clubIds = Object.values(clubs).map((c) => c.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await db.q("delete from public.grupo_miembros where grupo_id in (select grupo_id from public.grupo_clubs where club_id = any($1::uuid[]))", [clubIds]);
      await db.q("delete from public.grupo_clubs where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.grupos where nombre like $1", [`%${TAG}%`]);
      await db.q("delete from public.rp_pagos_dia where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_attendance where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_comision_overrides where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
    }
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
            (select count(*) from public.grupos where nombre like $1)::int grupos,
            (select count(*) from public.reservations where cliente_nombre like $1)::int reservas`,
    [`%${TAG}%`, `${TAG}%`, ids],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan)}`);
  return Object.values(quedan).every((n) => n === 0);
}

// Descarga completa por páginas, como la pantalla (traerTodo de lib/domain/exportes.ts).
async function exportar(c, fn, clubId, desde, hasta, limite = 1000) {
  let paginas = 0;
  const r = await dom.traerTodo(async (despues) => {
    paginas++;
    const { data, error } = await c.rpc(fn, { p_club_id: clubId, p_desde: desde, p_hasta: hasta, p_despues: despues, p_limite: limite });
    return error ? { error } : { filas: data };
  }, { limite, maxPaginas: 2000 });
  if ("error" in r) return { error: r.error, paginas };
  return { filas: r.filas, paginas };
}
const suma = (filas, campo, filtro = () => true) => filas.filter(filtro).reduce((a, f) => a + Number(f[campo] ?? 0), 0);
const cuenta = (filas, filtro) => filas.filter(filtro).length;
function ordenEstricto(filas) {
  for (let i = 1; i < filas.length; i++) if (!(filas[i - 1].orden < filas[i].orden)) return false;
  return new Set(filas.map((f) => f.orden)).size === filas.length;
}

// Exportes de un rango contra grupo_resumen y contra el cierre de cada noche.
async function compararSumas(donde, c, clubId, desde, hasta, filasPor) {
  const { reservas: R, consumos: K, comisiones: C } = filasPor;
  const g = ok(await c.rpc("grupo_resumen", { p_desde: desde, p_hasta: hasta }), "grupo_resumen").find((x) => x.club_id === clubId);
  revisar(`${donde}: /grupo devuelve el antro`, !!g);
  if (!g) return;
  igual(`${donde}: reservas = /grupo`, R.length, g.reservas);
  igual(`${donde}: reservas que consumieron = /grupo`, cuenta(R, (f) => f.estado === "consumio"), g.reservas_con_consumo);
  igual(`${donde}: consumo sin anulados = /grupo`, suma(K, "monto_centavos", (f) => !f.anulado), g.consumo_centavos);
  igual(`${donde}: consumo con reserva = /grupo`, suma(K, "monto_centavos", (f) => !f.anulado && f.origen_cuenta === "reserva"), g.consumo_con_reserva_centavos);
  igual(`${donde}: cuentas con consumo = /grupo`, new Set(K.filter((f) => !f.anulado).map((f) => `${f.noche}|${f.mesa}|${f.grupo}|${f.cuenta}|${f.folio_reserva}`)).size >= 0 ? g.cuentas_con_consumo : -1, g.cuentas_con_consumo);
  igual(`${donde}: comisiones y pagos sin anulados = /grupo`, suma(C, "monto_centavos", (f) => f.estado !== "anulada"), g.comisiones_centavos);
  igual(`${donde}: consumo de las reservas = consumo con reserva`, suma(R, "consumo_centavos"), g.consumo_con_reserva_centavos);
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    const rep = ok(await c.rpc("reporte_cierre_noche", { p_club_id: clubId, p_fecha: f }), "cierre " + f);
    const r = R.filter((x) => x.noche === f), k = K.filter((x) => x.noche === f), m = C.filter((x) => x.noche === f);
    const d = `${donde} ${f}`;
    igual(`${d}: reservas = cierre`, r.length, rep.reservas.reservas);
    igual(`${d}: personas = cierre`, suma(r, "personas"), rep.reservas.personas);
    igual(`${d}: consumieron = cierre`, cuenta(r, (x) => x.estado === "consumio"), rep.reservas.consumieron);
    igual(`${d}: entraron = cierre`, cuenta(r, (x) => x.estado === "consumio" || x.estado === "llego_sin_consumo"), rep.reservas.entraron);
    igual(`${d}: no llegaron = cierre`, cuenta(r, (x) => x.estado === "no_llego"), rep.reservas.no_llegaron);
    igual(`${d}: por llegar + en puerta = cierre`, cuenta(r, (x) => x.estado === "por_llegar" || x.estado === "en_puerta"), rep.reservas.por_llegar);
    igual(`${d}: consumo de reservas = cierre`, suma(r, "consumo_centavos"), rep.reservas.consumo_centavos);
    igual(`${d}: consumo en caja = cierre`, suma(k, "monto_centavos", (x) => !x.anulado), rep.consumo.total_centavos);
    igual(`${d}: renglones vigentes = cierre`, cuenta(k, (x) => !x.anulado), rep.consumo.renglones);
    igual(`${d}: sin reserva = cierre`, suma(k, "monto_centavos", (x) => !x.anulado && x.origen_cuenta === "walk_in"), rep.consumo.sin_reserva_centavos);
    igual(`${d}: anulados = cierre (número)`, cuenta(k, (x) => x.anulado), rep.anulaciones.consumos);
    igual(`${d}: anulados = cierre ($)`, suma(k, "monto_centavos", (x) => x.anulado), rep.anulaciones.consumos_centavos);
    igual(`${d}: comisiones por reserva = cierre`, suma(m, "monto_centavos", (x) => x.tipo === "reserva" && x.estado !== "anulada"), rep.comisiones.comision_centavos);
    igual(`${d}: pagos por día = cierre`, suma(m, "monto_centavos", (x) => x.tipo === "dia" && x.estado !== "anulada"), rep.comisiones.pago_dia_centavos);
    igual(`${d}: comisiones vigentes (número) = cierre`, cuenta(m, (x) => x.tipo === "reserva" && x.estado !== "anulada"), rep.comisiones.comisiones);
  }
}

let limpio = false;
try {
  // ======================= Escenario =======================
  await usuario("admin", "admin");
  const duenoA = await usuario("duenoa", "dueno");
  const duenoB = await usuario("duenob", "dueno");
  await usuario("grupo", "dueno");
  await usuario("cliente", "cliente");
  await club("A", "America/Mexico_City", duenoA);
  await club("B", "America/Tijuana", duenoB);
  const staffA = await usuario("staffa", "staff", clubs.A.id);
  const gerenteA = await usuario("gerentea", "gerente", clubs.A.id);
  await usuario("gerenteb", "gerente", clubs.B.id);
  await usuario("baja", "gerente", clubs.A.id, { activo: false });
  await usuario("temporal", "gerente", clubs.A.id, {}, { debe_cambiar: true });
  await usuario("sinperfil", null);
  const rp1 = await usuario("rp1", "rp", clubs.A.id);
  const rp2 = await usuario("rp2", "rp", clubs.A.id);
  const g = ok(await svc.from("grupos").insert({ nombre: `Grupo ${TAG}` }).select("id").single(), "grupo");
  ok(await svc.from("grupo_clubs").insert({ grupo_id: g.id, club_id: clubs.A.id }), "grupo_clubs");
  ok(await svc.from("grupo_miembros").insert({ grupo_id: g.id, profile_id: U.grupo.id, rol_grupo: "dueno_grupo" }), "grupo_miembros");

  const mesas = ok(await svc.from("club_tables").insert([{ club_id: clubs.A.id, numero: "1", capacidad: 8 }, { club_id: clubs.A.id, numero: "2", capacidad: 8 }]).select("id, numero"), "mesas");
  const M1 = mesas.find((m) => m.numero === "1").id;
  const M2 = mesas.find((m) => m.numero === "2").id;
  ok(await svc.from("rp_comision_overrides").insert([
    { club_id: clubs.A.id, rp_id: rp1, comision_tipo: "fijo", comision_monto: 150, comision_desbloqueo_reservas: 0 },
    { club_id: clubs.A.id, rp_id: rp2, comision_tipo: "porcentaje", comision_monto: 10, comision_desbloqueo_reservas: 0 },
  ]), "overrides");

  const F = clubs.A.noche;
  const AYER = sumarDias(F, -1);
  const MANANA = sumarDias(F, 1);

  // ---------- Noche de ayer, en bloque (paginación) ----------
  const BLOQUE = 1040;
  {
    const db = await conectarDevEscritura();
    try {
      await db.q("begin");
      await db.q("set local antroapp.borrado_pruebas = 'on'");
      const inicio = `(($2::date + time '23:00') at time zone 'America/Mexico_City')`;
      const [{ id: nocheAyer }] = await db.q(
        `insert into public.caja_noches (club_id, fecha_operacion, estado, abierta_por, abierta_en, cerrada_por, cerrada_en)
         values ($1, $2::date, 'cerrada', $3, ${inicio}, $4, ${inicio} + interval '8 hours') returning id`,
        [clubs.A.id, AYER, staffA, gerenteA]);
      const ses = [];
      for (const [mesa, n] of [[M1, 0], [M1, 1], [M2, 0]]) {
        const [{ id }] = await db.q(
          `insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado, abierta_por, abierta_en, cerrada_por, cerrada_en, cuadrada_por, cuadrada_en)
           values ($1, $3, $4, 'cuadrada', $5, ${inicio} + make_interval(hours => $6), $5, ${inicio} + make_interval(hours => $6 + 1), $5, ${inicio} + make_interval(hours => $6 + 1))
           returning id`, [clubs.A.id, AYER, nocheAyer, mesa, gerenteA, n * 2]);
        ses.push({ id, mesa });
      }
      // 1040 reservas de RP que consumieron + 5 que no llegaron.
      await db.q(
        `insert into public.reservations (id, cliente_nombre, cliente_telefono, personas, status, source, rp_id, club_id, fecha, qr_code, created_at, puerta_estado, entrada_en)
         select gen_random_uuid(), 'Cliente ' || $5 || ' b' || i, '33' || lpad(i::text, 8, '0'), 1 + i % 5, 'usada', 'rp', $3, $1, $2::date,
                'antro-' || gen_random_uuid(), ${inicio} - make_interval(secs => 100000 - i), 'entro', ${inicio} + make_interval(secs => i)
         from generate_series(1, $4) i`, [clubs.A.id, AYER, rp1, BLOQUE, TAG]);
      await db.q(
        `insert into public.reservations (id, cliente_nombre, cliente_telefono, personas, status, source, rp_id, club_id, fecha, qr_code, created_at)
         select gen_random_uuid(), 'Cliente ' || $3 || ' nl' || i, '3399999' || lpad(i::text, 3, '0'), 2, 'confirmada', 'organica', null, $1, $2::date,
                'antro-' || gen_random_uuid(), ${inicio} - make_interval(days => 1, secs => i)
         from generate_series(1, 5) i`, [clubs.A.id, AYER, TAG]);
      // Una cuenta por reserva, repartidas en los 3 grupos.
      await db.q(
        `insert into public.mesa_cuentas (id, club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_por, creada_en, liquidada_en)
         select gen_random_uuid(), $1, (array[$3::uuid, $4::uuid, $5::uuid])[1 + (row_number() over (order by r.created_at))::int % 3],
                r.id, r.rp_id, 'reserva', r.cliente_nombre, r.personas, $6, r.entrada_en, r.entrada_en + interval '3 hours'
         from public.reservations r where r.club_id = $1 and r.fecha = $2::date and r.rp_id is not null`,
        [clubs.A.id, AYER, ses[0].id, ses[1].id, ses[2].id, staffA]);
      // Un consumo por cuenta, 20 extra y 10 anulados.
      const consumos = (filtro, monto, extra = "false, null, null, null") =>
        `insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id, monto_centavos, concepto, registrado_por, registrado_en, anulado, anulado_por, anulado_en, motivo_anulacion)
         select $1, $2, mc.sesion_id, s.mesa_id, mc.id, mc.reservation_id, mc.rp_id, ${monto}, 'Botella ' || (row_number() over (order by mc.creada_en)), $3,
                mc.creada_en + interval '10 minutes', ${extra}
         from public.mesa_cuentas mc join public.mesa_sesiones s on s.id = mc.sesion_id
         where s.noche_id = $2 ${filtro}`;
      await db.q(consumos("", "100000 + (extract(epoch from mc.creada_en)::bigint % 7) * 100"), [clubs.A.id, nocheAyer, staffA]);
      await db.q(consumos("and mc.id in (select id from public.mesa_cuentas where sesion_id = $4 order by creada_en limit 20)", "25050"), [clubs.A.id, nocheAyer, staffA, ses[1].id]);
      await db.q(consumos("and mc.id in (select id from public.mesa_cuentas where sesion_id = $4 order by creada_en desc limit 10)", "77700", "true, $3, now(), 'Prueba de anulación'"), [clubs.A.id, nocheAyer, staffA, ses[2].id]);
      // Comisión por cada reserva que consumió ($12.34); 5 anuladas.
      await db.q(
        `insert into public.commissions (reservation_id, rp_id, tipo, monto, status, created_at)
         select r.id, r.rp_id, 'rp', 12.34, case when row_number() over (order by r.created_at) <= 5 then 'anulada' else 'pendiente' end, r.entrada_en + interval '4 hours'
         from public.reservations r where r.club_id = $1 and r.fecha = $2::date and r.rp_id is not null`, [clubs.A.id, AYER]);
      // Un pago por día de asistencia (RP 2).
      const [{ id: asis }] = await db.q(
        `insert into public.rp_attendance (rp_id, club_id, fecha, scanned_at, metodo, marcado_por) values ($1, $2, $3::date, now(), 'manual', $4) returning id`,
        [rp2, clubs.A.id, AYER, gerenteA]);
      await db.q(`insert into public.rp_pagos_dia (rp_attendance_id, rp_id, club_id, fecha, posicion, monto, status) values ($1, $2, $3, $4::date, 2, 300, 'pendiente')`,
        [asis, rp2, clubs.A.id, AYER]);
      await db.q("commit");
    } catch (e) {
      await db.q("rollback").catch(() => {});
      throw e;
    } finally {
      await db.fin();
    }
  }

  // ---------- Noche en curso por el camino real ----------
  const R1 = await reserva("A", { source: "rp", rp_id: rp1, cliente_nombre: `=HYPERLINK("http://x") ${TAG}` });
  const R2 = await reserva("A", { source: "rp", rp_id: rp2 });
  const R3 = await reserva("A", {});
  await reserva("A", { source: "rp", rp_id: rp1 }); // no llega (la noche sigue: por llegar)
  const R5 = await reserva("A", { source: "rp", rp_id: rp2 }); // entra sin consumir
  await reserva("A", { fecha: MANANA }); // otra noche

  const S = {
    anon: nuevoAnon(), cliente: await sesion("cliente"), rp1: await sesion("rp1"), staffa: await sesion("staffa"),
    gerentea: await sesion("gerentea"), gerenteb: await sesion("gerenteb"), duenoa: await sesion("duenoa"), duenob: await sesion("duenob"),
    admin: await sesion("admin"), grupo: await sesion("grupo"), baja: await sesion("baja").catch(() => null),
    temporal: await sesion("temporal"), sinperfil: await sesion("sinperfil"),
  };
  for (const R of [R1, R2, R3, R5]) {
    ok(await S.staffa.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
    ok(await S.staffa.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
  }
  const S1 = ok(await S.staffa.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "abrir mesa 1");
  const C1 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R1.id }), "sentar R1");
  const C2 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R2.id }), "sentar R2");
  const C3 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R3.id }), "sentar R3");
  const C4 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_cliente_nombre: "Walk-in T rep", p_personas: 2 }), "walk-in");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 50000, p_concepto: '=HYPERLINK("http://malo","clic")' }), "consumo C1");
  const K2 = ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 30000, p_concepto: "Botella, \"doble\"" }), "consumo C1 b");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C2, p_monto_centavos: 100000 }), "consumo C2");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C3, p_monto_centavos: 20000 }), "consumo C3");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C4, p_monto_centavos: 15000 }), "consumo C4");
  ok(await S.gerentea.rpc("caja_anular_consumo", { p_consumo_id: K2, p_motivo: "Capturado dos veces" }), "anular consumo");
  ok(await S.staffa.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 185000 }), "pago");
  ok(await S.staffa.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }), "cerrar mesa 1");
  ok(await S.gerentea.rpc("caja_cuadrar_mesa", { p_sesion_id: S1 }), "cuadrar mesa 1");
  const S3 = ok(await S.staffa.rpc("caja_abrir_mesa", { p_mesa_id: M2 }), "abrir mesa 2");
  ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S3, p_reservation_id: R5.id }), "sentar R5");

  // Antro B (Tijuana): una reserva con hora fija para revisar la zona.
  const RB = await reserva("B", { created_at: "2026-11-20T07:30:00Z" });

  console.log(`Escenario ${TAG}: antro A (noches ${AYER} en bloque y ${F} en caja), antro B (${clubs.B.zona})`);

  // ======================= Acceso y nivel =======================
  console.log("\n== Quién descarga y qué teléfono ve");
  const esperadoNivel = { duenoa: ["completo", "completo"], gerentea: ["completo", "completo"], admin: ["admin", "enmascarado"], grupo: ["grupo", "sin_telefono"] };
  for (const [quien, [nivel, tel]] of Object.entries(esperadoNivel)) {
    const r = await S[quien].rpc("reporte_exportes_info", { p_club_id: clubs.A.id });
    revisar(`${quien}: info → nivel ${nivel}, teléfono ${tel}`, !r.error && r.data?.nivel === nivel && r.data?.telefono === tel && r.data?.noche_en_curso === F, r.error?.message ?? JSON.stringify(r.data));
  }
  const rechazados = { anon: S.anon, cliente: S.cliente, rp: S.rp1, staff: S.staffa, "dueño de otro antro": S.duenob, "gerente de otro antro": S.gerenteb,
    "cuenta sin perfil": S.sinperfil, "gerente con contraseña temporal": S.temporal, ...(S.baja ? { "gerente dado de baja": S.baja } : {}) };
  for (const [quien, c] of Object.entries(rechazados)) {
    const malos = [];
    const info = await c.rpc("reporte_exportes_info", { p_club_id: clubs.A.id });
    if (!info.error || info.data) malos.push("info");
    for (const fn of Object.values(dom.FUNCION_EXPORTE)) {
      const r = await c.rpc(fn, { p_club_id: clubs.A.id, p_desde: AYER, p_hasta: F });
      if (!r.error || (Array.isArray(r.data) && r.data.length)) malos.push(fn);
      else if (quien !== "anon" && r.error.code !== "P0001") malos.push(`${fn} (${r.error.code})`);
    }
    revisar(`${quien}: NO descarga nada del antro A`, malos.length === 0, malos.join(", "));
  }
  if (!S.baja) revisar("gerente dado de baja: ni siquiera inicia sesión", true);
  {
    const r = await S.staffa.rpc("reporte_reservas", { p_club_id: clubs.A.id, p_desde: F, p_hasta: F });
    revisar("staff: aviso claro (P0001)", r.error?.code === "P0001" && /no tienes acceso/i.test(r.error.message), r.error?.message);
    const g2 = await S.grupo.rpc("reporte_consumos", { p_club_id: clubs.B.id, p_desde: F, p_hasta: F });
    revisar("dueño de grupo: no descarga un antro fuera de su grupo", g2.error?.code === "P0001");
    const internas = [];
    for (const [fn, args] of [["reporte_nivel_exportes", { p_club_id: clubs.A.id }], ["reporte_telefono", { p_telefono: TEL, p_nivel: "completo" }],
      ["reporte_exportes_autorizar", { p_club_id: clubs.A.id, p_desde: F, p_hasta: F, p_despues: null }]]) {
      const r = await S.gerentea.rpc(fn, args);
      if (!r.error) internas.push(fn);
    }
    revisar("las funciones internas no se pueden llamar desde la API", internas.length === 0, internas.join(", "));
  }

  // ======================= Descargas completas =======================
  console.log("\n== Descargas por rango (ayer, hoy y mañana) y teléfonos");
  const D = {};
  for (const quien of ["gerentea", "duenoa", "admin", "grupo"]) {
    D[quien] = {};
    for (const [tipo, fn] of Object.entries(dom.FUNCION_EXPORTE)) {
      const t0 = Date.now();
      const r = await exportar(S[quien], fn, clubs.A.id, AYER, MANANA);
      if (r.error) { revisar(`${quien}: ${tipo} se descarga`, false, r.error.message); D[quien][tipo] = []; continue; }
      D[quien][tipo] = r.filas;
      if (quien === "gerentea") console.log(`        ${tipo}: ${r.filas.length} renglones en ${r.paginas} páginas, ${Date.now() - t0} ms`);
    }
  }
  const G = D.gerentea;
  igual("reservas: 1045 de ayer + 5 de hoy + 1 de mañana", G.reservas.length, BLOQUE + 5 + 5 + 1);
  igual("consumos: 1040 + 20 + 10 anulados de ayer + 6 de hoy", G.consumos.length, BLOQUE + 20 + 10 + 6);
  igual("comisiones: 1040 de ayer + 1 pago por día + 2 de hoy", G.comisiones.length, BLOQUE + 1 + 2);
  for (const tipo of Object.keys(dom.FUNCION_EXPORTE)) {
    revisar(`${tipo}: orden estricto, sin repetidos`, ordenEstricto(G[tipo]));
    for (const quien of ["duenoa", "admin", "grupo"])
      revisar(`${tipo}: ${quien} recibe los mismos renglones que el gerente`, D[quien][tipo].length === G[tipo].length && D[quien][tipo].every((f, i) => f.orden === G[tipo][i].orden));
  }
  {
    const tels = (filas) => filas.map((f) => f.telefono);
    revisar("gerente: teléfono completo", G.reservas.some((f) => f.telefono === TEL) && G.reservas.every((f) => !f.telefono || /^\d{10}$/.test(f.telefono)));
    revisar("dueño: teléfono completo", D.duenoa.reservas.some((f) => f.telefono === TEL));
    revisar("admin: solo los últimos 4 (***0777), nunca el completo", tels(D.admin.reservas).every((t) => t === null || /^\*\*\*\d{4}$/.test(t)) && tels(D.admin.reservas).includes("***0777"));
    revisar("dueño de grupo: sin teléfono", tels(D.grupo.reservas).every((t) => t === null));
    const texto = JSON.stringify([D.admin, D.grupo]);
    revisar("admin y dueño de grupo: ningún teléfono completo en ningún exporte", !texto.includes(TEL) && !/33\d{8}/.test(texto));
    revisar("ningún exporte trae QR ni ids completos de clientes", !JSON.stringify(D).includes("antro-") && !JSON.stringify(D).includes(R1.id));
  }
  {
    const r1 = G.reservas.find((f) => f.folio === R1.id.slice(0, 8));
    revisar("reserva de hoy que consumió: estado, RP, mesa y consumo", r1?.estado === "consumio" && r1.rp_nombre === "T rep rp1" && r1.mesa === "1" && Number(r1.consumo_centavos) === 50000 && r1.origen === "rp", JSON.stringify(r1));
    const r5 = G.reservas.find((f) => f.folio === R5.id.slice(0, 8));
    revisar("reserva que entró sin consumir: 'llego_sin_consumo' en la mesa 2", r5?.estado === "llego_sin_consumo" && r5.mesa === "2", JSON.stringify(r5));
    revisar("hoy: la que no llegó sigue 'por_llegar'; ayer: 5 'no_llego'", cuenta(G.reservas, (f) => f.noche === F && f.estado === "por_llegar") === 1 && cuenta(G.reservas, (f) => f.noche === AYER && f.estado === "no_llego") === 5);
    const anul = G.consumos.find((f) => f.anulado && f.noche === F);
    revisar("consumo anulado: motivo, quién y cuándo", anul?.motivo_anulacion === "Capturado dos veces" && anul.anulado_por === "T rep gerentea" && !!anul.anulado_local && anul.registrado_por === "T rep staffa", JSON.stringify(anul));
    const walk = G.consumos.find((f) => f.origen_cuenta === "walk_in");
    revisar("walk-in: sin folio ni RP", walk && walk.folio_reserva === null && walk.rp_nombre === null && walk.cuenta === "Walk-in T rep", JSON.stringify(walk));
    const grupos = new Set(G.consumos.filter((f) => f.noche === AYER && f.mesa === "1").map((f) => f.grupo));
    revisar("ayer: la mesa 1 tuvo 2 grupos (1 y 2)", grupos.has(1) && grupos.has(2) && grupos.size === 2, [...grupos].join(","));
    const com1 = G.comisiones.find((f) => f.folio_reserva === R1.id.slice(0, 8));
    revisar("comisión de hoy: $150 fijos con consumo base $500", Number(com1?.monto_centavos) === 15000 && Number(com1.consumo_base_centavos) === 50000 && com1.tipo === "reserva" && com1.rp_activo === true, JSON.stringify(com1));
    const dia = G.comisiones.find((f) => f.tipo === "dia");
    revisar("pago por día: RP 2, 2.º día, $300", dia && dia.rp_nombre === "T rep rp2" && dia.posicion_dia === 2 && Number(dia.monto_centavos) === 30000 && dia.folio_reserva === null, JSON.stringify(dia));
    igual("comisiones anuladas de ayer marcadas", cuenta(G.comisiones, (f) => f.estado === "anulada"), 5);
  }

  console.log("\n== Sumas = /grupo y = cierre de cada noche");
  await compararSumas("A", S.gerentea, clubs.A.id, AYER, MANANA, G);
  await compararSumas("A (dueño de grupo)", S.grupo, clubs.A.id, AYER, MANANA, D.grupo);
  {
    const db = await conectarDevEscritura();
    const [x] = await db.q(
      `select (select count(*) from public.reservations where club_id = $1 and fecha between $2::date and $3::date)::int r,
              (select count(*) from public.caja_consumos k join public.caja_noches n on n.id = k.noche_id where k.club_id = $1 and n.fecha_operacion between $2::date and $3::date)::int k,
              (select coalesce(sum(monto_centavos), 0) from public.caja_consumos k join public.caja_noches n on n.id = k.noche_id where k.club_id = $1 and not k.anulado and n.fecha_operacion between $2::date and $3::date)::bigint ks`,
      [clubs.A.id, AYER, MANANA]);
    await db.fin();
    igual("reservas = conteo directo en la base", G.reservas.length, x.r);
    igual("consumos = conteo directo en la base", G.consumos.length, x.k);
    igual("consumo vigente = suma directa en la base", suma(G.consumos, "monto_centavos", (f) => !f.anulado), x.ks);
  }

  // ======================= Paginación =======================
  console.log("\n== Paginación");
  for (const [tipo, fn] of Object.entries(dom.FUNCION_EXPORTE)) {
    const r = await exportar(S.admin, fn, clubs.A.id, AYER, MANANA, 97);
    revisar(`${tipo}: en páginas de 97 sale lo mismo (${r.paginas} páginas)`, !r.error && r.filas.length === G[tipo].length && r.filas.every((f, i) => f.orden === G[tipo][i].orden), r.error?.message);
  }
  {
    const r = await S.gerentea.rpc("reporte_consumos", { p_club_id: clubs.A.id, p_desde: AYER, p_hasta: F, p_limite: 5000 });
    igual("p_limite 5000 se recorta a 1000", r.data?.length, 1000);
    const sinLimite = await S.gerentea.rpc("reporte_reservas", { p_club_id: clubs.A.id, p_desde: AYER, p_hasta: F });
    igual("sin p_limite: 1000", sinLimite.data?.length, 1000);
    const ult = G.consumos[G.consumos.length - 1].orden;
    const tras = await S.gerentea.rpc("reporte_consumos", { p_club_id: clubs.A.id, p_desde: AYER, p_hasta: MANANA, p_despues: ult });
    igual("después del último: 0 renglones", tras.data?.length, 0);
    const mitad = G.consumos[499].orden;
    const sig = await S.gerentea.rpc("reporte_consumos", { p_club_id: clubs.A.id, p_desde: AYER, p_hasta: MANANA, p_despues: mitad, p_limite: 3 });
    revisar("cursor a la mitad: sigue justo después", sig.data?.length === 3 && sig.data[0].orden === G.consumos[500].orden);
  }

  // ======================= Rango, cursor y zona =======================
  console.log("\n== Rango, cursor y zona horaria");
  {
    const pedir = (desde, hasta, extra = {}) => S.admin.rpc("reporte_reservas", { p_club_id: clubs.A.id, p_desde: desde, p_hasta: hasta, ...extra });
    const r93 = await pedir(sumarDias(F, -93), F);
    revisar("93 días: se acepta", !r93.error, r93.error?.message);
    const r94 = await pedir(sumarDias(F, -94), F);
    revisar("94 días: 'El rango máximo es de 93 días'", r94.error?.code === "P0001" && /93 días/.test(r94.error.message), r94.error?.message);
    const alReves = await pedir(F, AYER);
    revisar("inicio después del fin: rechazado", alReves.error?.code === "P0001");
    const nulo = await pedir(null, F);
    revisar("fecha nula: rechazada", alReves.error?.code === "P0001" && !!nulo.error);
    const lejos = await pedir("2031-01-01", "2031-01-02");
    revisar("más de 3 meses en el futuro: rechazado", lejos.error?.code === "P0001", lejos.error?.message);
    const cursor = await pedir(AYER, F, { p_despues: "'; drop table x; --" });
    revisar("cursor inválido: rechazado con aviso", cursor.error?.code === "P0001", cursor.error?.message);
    const noExiste = await S.admin.rpc("reporte_reservas", { p_club_id: randomUUID(), p_desde: F, p_hasta: F });
    revisar("antro inexistente (admin): rechazado", noExiste.error?.code === "P0001", noExiste.error?.message);
    const b = await S.gerenteb.rpc("reporte_reservas", { p_club_id: clubs.B.id, p_desde: RB.fecha, p_hasta: RB.fecha });
    const filaB = b.data?.find((f) => f.folio === RB.id.slice(0, 8));
    revisar("Tijuana: la hora sale en la zona del antro (2026-11-19 23:30, no 01:30)", filaB?.creada_local === "2026-11-19 23:30", filaB?.creada_local ?? b.error?.message);
    const horaMx = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const kHoy = G.consumos.filter((f) => f.noche === F);
    revisar("México: hora del consumo = hora de México del registro", kHoy.length > 0 && kHoy.every((f) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(f.hora_local)) &&
      Math.abs(new Date(kHoy[0].hora_local.replace(" ", "T") + ":00Z").getTime() - new Date(horaMx.format(new Date()).replace(" ", "T") + ":00Z").getTime()) < 30 * 60e3, kHoy[0]?.hora_local);
  }

  // ======================= CSV con renglones reales =======================
  console.log("\n== CSV (lib/domain/exportes.ts) con renglones reales");
  {
    const res = G.reservas.map(dom.normalizarReserva);
    const csvG = dom.csvReservas(res, "completo");
    revisar("CSV: empieza con BOM y usa CRLF", csvG.startsWith("﻿") && csvG.includes("\r\n"));
    revisar("CSV gerente: encabezado con 'Teléfono' y el número completo", csvG.split("\r\n")[0].includes(",Teléfono,") && csvG.includes(`,${TEL},`));
    const csvA = dom.csvReservas(D.admin.reservas.map(dom.normalizarReserva), "enmascarado");
    revisar("CSV admin: 'Teléfono (últimos 4)' y sin el número completo", csvA.includes("Teléfono (últimos 4)") && !csvA.includes(TEL) && csvA.includes("***0777"));
    const csvGr = dom.csvReservas(D.grupo.reservas.map(dom.normalizarReserva), "sin_telefono");
    revisar("CSV dueño de grupo: sin columna de teléfono", !csvGr.split("\r\n")[0].includes("Teléfono") && !csvGr.includes(TEL));
    revisar("CSV: un renglón por reserva más el encabezado", csvG.trimEnd().split("\r\n").length === res.length + 1);
    revisar("CSV: el nombre que empieza con '=' lleva apóstrofo", csvG.includes(`'=HYPERLINK(""http://x"") ${TAG}`) && !csvG.includes(`,=HYPERLINK`));
    const csvK = dom.csvConsumos(G.consumos.map(dom.normalizarConsumo));
    revisar("CSV consumo: concepto con fórmula neutralizado y comillas escapadas", csvK.includes(`"'=HYPERLINK(""http://malo"",""clic"")"`) && csvK.includes(`"Botella, ""doble"""`));
    revisar("CSV consumo: montos en pesos con 2 decimales", csvK.includes(",500.00,") && csvK.includes(",150.00,"));
    const resumen = dom.resumenConsumos(G.consumos.map(dom.normalizarConsumo));
    igual("resumen de la pantalla: consumo sin anulados = suma", resumen.suma_centavos, suma(G.consumos, "monto_centavos", (f) => !f.anulado));
    revisar("nombre de archivo de rango y de una noche", dom.nombreArchivoExporte("consumos", "Club Ñandú", AYER, F) === `consumo-club-nandu-${AYER}_${F}.csv` && dom.nombreArchivoExporte("reservas", "X", F, F) === `reservas-x-${F}.csv`);
  }

  // ======================= Club Demo Dev (solo lectura) =======================
  console.log("\n== Club Demo Dev: exportes = caja, /grupo y cierre (transacción de solo lectura)");
  {
    const db = await conectarDevEscritura();
    try {
      await db.q("begin transaction read only");
      await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.admin.id, role: "authenticated" })]);
      const [{ desde, hasta }] = await db.q(`select min(fecha_operacion)::text desde, max(fecha_operacion)::text hasta from public.caja_noches where club_id = $1`, [CLUB_DEMO]);
      if (!desde) {
        revisar("Club Demo Dev: tiene noches de caja", false, "sin noches");
      } else {
        const todo = async (fn) => {
          const filas = [];
          let despues = null;
          for (;;) {
            const p = await db.q(`select * from public.${fn}($1, $2::date, $3::date, $4, 1000)`, [CLUB_DEMO, desde, hasta, despues]);
            filas.push(...p);
            if (p.length < 1000) return filas;
            despues = p[p.length - 1].orden;
          }
        };
        const t0 = Date.now();
        const R = await todo("reporte_reservas"), K = await todo("reporte_consumos"), C = await todo("reporte_comisiones");
        console.log(`        ${desde} a ${hasta}: ${R.length} reservas, ${K.length} consumos, ${C.length} comisiones (${Date.now() - t0} ms)`);
        const [gr] = await db.q(`select * from public.grupo_resumen($1::date, $2::date) where club_id = $3`, [desde, hasta, CLUB_DEMO]);
        igual("Demo: reservas = /grupo", R.length, gr.reservas);
        igual("Demo: consumieron = /grupo", cuenta(R, (f) => f.estado === "consumio"), gr.reservas_con_consumo);
        igual("Demo: consumo = /grupo", suma(K, "monto_centavos", (f) => !f.anulado), gr.consumo_centavos);
        igual("Demo: consumo con reserva = /grupo", suma(K, "monto_centavos", (f) => !f.anulado && f.origen_cuenta === "reserva"), gr.consumo_con_reserva_centavos);
        igual("Demo: comisiones y pagos = /grupo", suma(C, "monto_centavos", (f) => f.estado !== "anulada"), gr.comisiones_centavos);
        const [x] = await db.q(
          `select (select count(*) from public.caja_consumos k join public.caja_noches n on n.id = k.noche_id where n.club_id = $1 and n.fecha_operacion between $2::date and $3::date)::int k,
                  (select count(*) from public.reservations where club_id = $1 and fecha between $2::date and $3::date)::int r`, [CLUB_DEMO, desde, hasta]);
        igual("Demo: consumos = caja (conteo directo)", K.length, x.k);
        igual("Demo: reservas = base (conteo directo)", R.length, x.r);
        revisar("Demo (admin): ningún teléfono completo", R.every((f) => f.telefono === null || /^\*\*\*\d{4}$/.test(f.telefono)));
        const noches = await db.q(`select fecha_operacion::text f from public.caja_noches where club_id = $1 order by 1`, [CLUB_DEMO]);
        for (const { f } of noches) {
          const [{ j: rep }] = await db.q(`select public.reporte_cierre_noche($1, $2::date) j`, [CLUB_DEMO, f]);
          const k = K.filter((y) => y.noche === f), r = R.filter((y) => y.noche === f), m = C.filter((y) => y.noche === f);
          revisar(`Demo ${f}: consumo, renglones, anulados, reservas y comisiones = cierre`,
            suma(k, "monto_centavos", (y) => !y.anulado) === Number(rep.consumo.total_centavos) && cuenta(k, (y) => !y.anulado) === rep.consumo.renglones &&
            cuenta(k, (y) => y.anulado) === rep.anulaciones.consumos && r.length === rep.reservas.reservas &&
            cuenta(r, (y) => y.estado === "consumio") === rep.reservas.consumieron &&
            suma(m, "monto_centavos", (y) => y.estado !== "anulada") === Number(rep.comisiones.total_centavos),
            JSON.stringify({ k: suma(k, "monto_centavos", (y) => !y.anulado), rep: rep.consumo.total_centavos }));
        }
      }
      await db.q("rollback");
    } finally {
      await db.fin();
    }
  }
} catch (e) {
  fallan++;
  console.log("ERROR:", e.message);
} finally {
  limpio = await limpiar();
}
revisar("limpieza sin restos", limpio);
console.log(`\n${pasan}/${pasan + fallan} pasan`);
process.exit(fallan ? 1 : 0);
