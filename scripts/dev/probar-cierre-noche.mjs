// Pruebas del reporte "Cierre de la noche" (sql/post-junta-2/30-cierre-noche.sql)
// contra antroapp-dev, con sesiones REALES (PostgREST + anon key + RLS).
// Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-cierre-noche.mjs
//
// 1. Escenario propio (prefijo t_rep_, se borra al final aunque falle): dos
//    antros en zonas distintas, un grupo, una persona por rol y una noche
//    completa en caja: 2 grupos en una mesa (con reapertura), walk-ins,
//    consumo y cobro anulados, reserva que no llega, reserva que entra sin
//    consumir, cuadre con faltante y cierre. El reporte se compara cifra por
//    cifra con lo esperado, con grupo_resumen y con grupo_rendimiento_rp,
//    con la noche abierta y ya cerrada.
// 2. Quién lo ve: admin, dueño, dueño de grupo y gerente activo sí; staff,
//    RP, cliente, anónimo, dueño y gerente de otro antro, cuenta sin perfil,
//    gerente dado de baja y con contraseña temporal, no.
// 3. Club Demo Dev (solo lectura, en una transacción READ ONLY): para cada
//    noche de caja, el reporte = caja, cuadres, /grupo y rendimiento por RP,
//    al centavo (las mismas consultas de scripts/verificar-cuadre.mjs).

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

const CLUB_DEMO = "0de70000-0000-4000-8000-000000000001";
const TAG = "t_rep_" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
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
  const r = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000777", personas: 3, status: "confirmada",
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
      await db.q("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_comision_overrides where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
    }
    if (ids.length) {
      await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    }
    if (clubIds.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const [quedan] = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from public.profiles where nombre like 'T rep %' and id = any($3::uuid[]))::int perfiles,
            (select count(*) from auth.users where email like $2)::int usuarios,
            (select count(*) from public.grupos where nombre like $1)::int grupos`,
    [`%${TAG}%`, `${TAG}%`, ids],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan)}`);
  return Object.values(quedan).every((n) => n === 0);
}

// Cifras del reporte que deben coincidir con grupo_resumen(fecha, fecha).
async function compararConGrupo(donde, c, clubId, fecha, rep) {
  const filas = ok(await c.rpc("grupo_resumen", { p_desde: fecha, p_hasta: fecha }), "grupo_resumen");
  const g = filas.find((f) => f.club_id === clubId);
  revisar(`${donde}: /grupo devuelve el antro`, !!g);
  if (!g) return;
  igual(`${donde}: reservas = /grupo`, rep.reservas.reservas, g.reservas);
  igual(`${donde}: entraron = /grupo`, rep.reservas.entraron, g.entraron);
  igual(`${donde}: consumieron = /grupo`, rep.reservas.consumieron, g.reservas_con_consumo);
  igual(`${donde}: consumo = /grupo`, rep.consumo.total_centavos, g.consumo_centavos);
  igual(`${donde}: consumo con reserva = /grupo`, rep.consumo.con_reserva_centavos, g.consumo_con_reserva_centavos);
  igual(`${donde}: cuentas con consumo = /grupo`, rep.consumo.cuentas_con_consumo, g.cuentas_con_consumo);
  igual(`${donde}: ticket promedio = /grupo`, rep.consumo.ticket_promedio_centavos, g.ticket_promedio_centavos);
  igual(`${donde}: comisiones y pagos = /grupo`, rep.comisiones.total_centavos, g.comisiones_centavos);
  const rend = ok(await c.rpc("grupo_rendimiento_rp", { p_club_id: clubId, p_desde: fecha, p_hasta: fecha }), "rendimiento");
  const conDatos = rend.filter((r) => r.reservas > 0 || r.comisiones_centavos > 0);
  igual(`${donde}: RPs en el reporte = rendimiento con datos`, rep.rps.length, conDatos.length);
  for (const r of conDatos) {
    const x = rep.rps.find((y) => y.rp_id === r.rp_id);
    revisar(`${donde}: RP ${r.rp_nombre} igual que /grupo`, !!x && ["reservas", "entraron", "consumieron", "consumo_centavos", "ticket_centavos", "comisiones_centavos"].every((k) => Number(x[k]) === Number(r[k])), JSON.stringify({ x, r }));
  }
}

// Identidades internas que siempre deben cumplirse.
function identidades(donde, rep) {
  const r = rep.reservas;
  igual(`${donde}: entraron + no llegaron + por llegar = reservas`, r.entraron + r.no_llegaron + r.por_llegar, r.reservas);
  for (const k of ["reservas", "personas", "entraron", "consumieron", "no_llegaron", "por_llegar", "consumo_centavos"])
    igual(`${donde}: por origen suma el total (${k})`, rep.por_origen.reduce((a, o) => a + Number(o[k]), 0), r[k]);
  igual(`${donde}: con + sin reserva = consumo`, rep.consumo.con_reserva_centavos + rep.consumo.sin_reserva_centavos, rep.consumo.total_centavos);
  igual(`${donde}: consumo walk-in = consumo sin reserva`, rep.walk_ins.consumo_centavos, rep.consumo.sin_reserva_centavos);
  igual(`${donde}: cobrado + por cobrar = consumo`, rep.cobros.total_centavos + rep.cobros.por_cobrar_centavos, rep.consumo.total_centavos);
  igual(`${donde}: efectivo + tarjeta + otro = cobrado`, rep.cobros.efectivo_centavos + rep.cobros.tarjeta_centavos + rep.cobros.otro_centavos, rep.cobros.total_centavos);
  igual(`${donde}: comisión + pago por día = total`, rep.comisiones.comision_centavos + rep.comisiones.pago_dia_centavos, rep.comisiones.total_centavos);
  igual(`${donde}: grupos por estado suman los grupos`, rep.mesas.grupos_abiertos + rep.mesas.grupos_cerrados + rep.mesas.grupos_cuadrados, rep.mesas.grupos);
  const rpOrigen = rep.por_origen.find((o) => o.origen === "rp");
  igual(`${donde}: suma de RPs = reservas de RP`, rep.rps.reduce((a, x) => a + x.reservas, 0), rpOrigen?.reservas ?? 0);
  igual(`${donde}: consumo de RPs = consumo de reservas de RP`, rep.rps.reduce((a, x) => a + Number(x.consumo_centavos), 0), rpOrigen?.consumo_centavos ?? 0);
  igual(`${donde}: comisiones de RPs = total`, rep.rps.reduce((a, x) => a + Number(x.comisiones_centavos), 0), rep.comisiones.total_centavos);
  if (rep.cuadre) {
    const q = rep.cuadre;
    igual(`${donde}: cuadre registrado = consumo`, q.registrado_centavos, rep.consumo.total_centavos);
    igual(`${donde}: cuadre efectivo = cobros`, q.cobrado_efectivo_centavos, rep.cobros.efectivo_centavos);
    igual(`${donde}: cuadre tarjeta = cobros`, q.cobrado_tarjeta_centavos, rep.cobros.tarjeta_centavos);
    igual(`${donde}: cuadre otro = cobros`, q.cobrado_otro_centavos, rep.cobros.otro_centavos);
    igual(`${donde}: diferencia = contado − cobrado`, q.diferencia_centavos,
      q.contado_efectivo_centavos + q.contado_tarjeta_centavos + q.contado_otro_centavos - rep.cobros.total_centavos);
  }
}
const sinDatosDeClientes = (rep) => {
  const texto = JSON.stringify(rep);
  return !texto.includes("0000000777") && !texto.includes(`Cliente ${TAG}`) && !texto.includes("Walk-in T rep") && !/telefono|cliente_nombre/.test(texto);
};

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
  await usuario("staffa", "staff", clubs.A.id);
  await usuario("gerentea", "gerente", clubs.A.id);
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

  const R1 = await reserva("A", { source: "rp", rp_id: rp1 });
  const R2 = await reserva("A", { source: "rp", rp_id: rp2 });
  const R3 = await reserva("A", {});
  await reserva("A", { source: "rp", rp_id: rp1 }); // R4: no llega
  const R5 = await reserva("A", { source: "rp", rp_id: rp2 }); // entra sin consumir
  const manana = new Date(new Date(clubs.A.noche + "T12:00:00Z").getTime() + 86400e3).toISOString().slice(0, 10);
  await reserva("A", { fecha: manana }); // otra noche: no cuenta

  const S = {
    anon: nuevoAnon(), cliente: await sesion("cliente"), rp1: await sesion("rp1"), staffa: await sesion("staffa"),
    gerentea: await sesion("gerentea"), gerenteb: await sesion("gerenteb"), duenoa: await sesion("duenoa"), duenob: await sesion("duenob"),
    admin: await sesion("admin"), grupo: await sesion("grupo"), baja: await sesion("baja").catch(() => null),
    temporal: await sesion("temporal"), sinperfil: await sesion("sinperfil"),
  };
  const F = clubs.A.noche;
  const reporte = async (c, clubId = clubs.A.id, fecha = F) => c.rpc("reporte_cierre_noche", { p_club_id: clubId, p_fecha: fecha });
  console.log(`Escenario ${TAG}: antro A (${clubs.A.zona}, noche ${F}), antro B (${clubs.B.zona})`);

  // ======================= Noche sin caja =======================
  console.log("\n== Antes de abrir la caja");
  {
    const rep = ok(await reporte(S.gerentea), "reporte sin caja");
    revisar("sin caja: estado 'sin_caja', noche en curso, no terminó", rep.noche.estado === "sin_caja" && rep.momento === "en_curso" && rep.termino === false, JSON.stringify(rep.noche));
    revisar("sin caja: 5 reservas por llegar, consumo 0, cuadre null", rep.reservas.reservas === 5 && rep.reservas.por_llegar === 5 && rep.consumo.total_centavos === 0 && rep.cuadre === null, JSON.stringify(rep.reservas));
    identidades("sin caja", rep);
  }

  // ======================= La noche en caja =======================
  for (const R of [R1, R2, R3, R5]) {
    ok(await S.staffa.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
    ok(await S.staffa.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
  }
  const S1 = ok(await S.staffa.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "abrir mesa 1");
  const C1 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R1.id }), "sentar R1");
  const C2 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R2.id }), "sentar R2");
  const C3 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R3.id }), "sentar R3");
  const C4 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_cliente_nombre: "Walk-in T rep", p_personas: 2 }), "walk-in 1");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 50000, p_concepto: "Botella" }), "consumo C1");
  const K2 = ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 30000 }), "consumo C1 b");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C2, p_monto_centavos: 100000 }), "consumo C2");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C3, p_monto_centavos: 20000 }), "consumo C3");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C4, p_monto_centavos: 15000 }), "consumo C4");
  ok(await S.gerentea.rpc("caja_anular_consumo", { p_consumo_id: K2, p_motivo: "Capturado dos veces" }), "anular consumo");
  const P0 = ok(await S.staffa.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 5000 }), "pago a anular");
  ok(await S.gerentea.rpc("caja_anular_pago", { p_pago_id: P0, p_motivo: "Cobro duplicado" }), "anular pago");
  ok(await S.staffa.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 100000 }), "pago efectivo");
  ok(await S.staffa.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: C2, p_metodo: "tarjeta", p_monto_centavos: 85000, p_referencia: "1234" }), "pago tarjeta");
  ok(await S.staffa.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }), "cerrar mesa 1");

  console.log("\n== Noche abierta, mesa 1 cerrada sin cuadrar");
  {
    const rep = ok(await reporte(S.gerentea), "reporte abierta");
    revisar("abierta: estado 'abierta', no terminó", rep.noche.estado === "abierta" && rep.termino === false);
    revisar("abierta: aún sin comisiones y 2 cuentas de RP sin cuadrar", rep.comisiones.total_centavos === 0 && rep.comisiones.cuentas_rp_sin_cuadrar === 2, JSON.stringify(rep.comisiones));
    revisar("abierta: la reserva que no llegó está 'por llegar' (no 'no llegó')", rep.reservas.por_llegar === 1 && rep.reservas.no_llegaron === 0, JSON.stringify(rep.reservas));
  }
  ok(await S.gerentea.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: "ok" }), "cuadrar mesa 1");
  // Segundo grupo en la mesa 1, con reapertura.
  const S2 = ok(await S.staffa.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "abrir mesa 1 otra vez");
  const C5 = ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S2, p_cliente_nombre: "Walk-in T rep 2", p_personas: 1 }), "walk-in 2");
  ok(await S.staffa.rpc("caja_registrar_consumo", { p_cuenta_id: C5, p_monto_centavos: 4000 }), "consumo C5");
  ok(await S.staffa.rpc("caja_registrar_pago", { p_sesion_id: S2, p_cuenta_id: null, p_metodo: "otro", p_monto_centavos: 4000 }), "pago otro");
  ok(await S.staffa.rpc("caja_cerrar_mesa", { p_sesion_id: S2 }), "cerrar mesa 1 grupo 2");
  ok(await S.gerentea.rpc("caja_reabrir_mesa", { p_sesion_id: S2, p_motivo: "Faltó un renglón" }), "reabrir");
  ok(await S.staffa.rpc("caja_cerrar_mesa", { p_sesion_id: S2 }), "cerrar otra vez");
  ok(await S.gerentea.rpc("caja_cuadrar_mesa", { p_sesion_id: S2 }), "cuadrar grupo 2");
  // Mesa 2: la reserva que entró y no consumió.
  const S3 = ok(await S.staffa.rpc("caja_abrir_mesa", { p_mesa_id: M2 }), "abrir mesa 2");
  ok(await S.staffa.rpc("caja_sentar_cliente", { p_sesion_id: S3, p_reservation_id: R5.id }), "sentar R5");
  ok(await S.staffa.rpc("caja_cerrar_mesa", { p_sesion_id: S3 }), "cerrar mesa 2");
  ok(await S.gerentea.rpc("caja_cuadrar_mesa", { p_sesion_id: S3 }), "cuadrar mesa 2");

  const esperado = (cerrada) => ({
    reservas: { reservas: 5, personas: 15, entraron: 4, en_puerta: 0, consumieron: 3, entraron_sin_consumo: 1,
      no_llegaron: cerrada ? 1 : 0, por_llegar: cerrada ? 0 : 1, consumo_centavos: 170000 },
    consumo: { total_centavos: 189000, con_reserva_centavos: 170000, sin_reserva_centavos: 19000, cuentas_con_consumo: 5, ticket_promedio_centavos: 37800 },
    walk_ins: { cuentas_total: 6, cuentas_reserva: 4, cuentas: 2, personas: 3, con_consumo: 2, consumo_centavos: 19000 },
    cobros: { efectivo_centavos: 100000, tarjeta_centavos: 85000, otro_centavos: 4000, total_centavos: 189000, cobros: 3, por_cobrar_centavos: 0 },
    anulaciones: { consumos: 1, consumos_centavos: 30000, cobros: 1, cobros_centavos: 5000, mesas_reabiertas: 1 },
    mesas: { mesas_antro: 2, mesas_usadas: 2, grupos: 3, grupos_abiertos: 0, grupos_cerrados: 0, grupos_cuadrados: 3, mesas_varios_grupos: 1 },
    comisiones: { comisiones: 2, comisiones_en_cero: 0, comision_centavos: 25000, pagos_dia: 0, pago_dia_centavos: 0, cuentas_rp_sin_cuadrar: 0, total_centavos: 25000 },
  });
  const revisarEsperado = (donde, rep, esp) => {
    for (const [seccion, campos] of Object.entries(esp)) {
      const malos = Object.entries(campos).filter(([k, v]) => Number(rep[seccion]?.[k]) !== v).map(([k, v]) => `${k}=${rep[seccion]?.[k]} (esperado ${v})`);
      revisar(`${donde}: ${seccion}`, malos.length === 0, malos.join(", "));
    }
    const o = Object.fromEntries(rep.por_origen.map((x) => [x.origen, x]));
    revisar(`${donde}: por origen (4 de RP, 1 orgánica)`, o.rp?.reservas === 4 && o.organica?.reservas === 1 && o.rp?.consumieron === 2 && o.organica?.consumieron === 1, JSON.stringify(o));
    const r1 = rep.rps.find((x) => x.rp_id === rp1), r2 = rep.rps.find((x) => x.rp_id === rp2);
    revisar(`${donde}: RP 1 (2 reservas, 1 entró, $500, comisión $150)`, r1 && r1.reservas === 2 && r1.entraron === 1 && r1.consumieron === 1 && Number(r1.consumo_centavos) === 50000 && Number(r1.comisiones_centavos) === 15000, JSON.stringify(r1));
    revisar(`${donde}: RP 2 (2 reservas, 2 entraron, $1,000, comisión 10% = $100)`, r2 && r2.reservas === 2 && r2.entraron === 2 && r2.consumieron === 1 && Number(r2.consumo_centavos) === 100000 && Number(r2.comisiones_centavos) === 10000, JSON.stringify(r2));
  };

  console.log("\n== Noche abierta, todas las mesas cuadradas");
  {
    const rep = ok(await reporte(S.gerentea), "reporte cuadrada");
    revisarEsperado("abierta", rep, esperado(false));
    revisar("abierta: cuadre general todavía null", rep.cuadre === null);
    identidades("abierta", rep);
    await compararConGrupo("abierta", S.gerentea, clubs.A.id, F, rep);
    revisar("abierta: sin nombres ni teléfonos de clientes", sinDatosDeClientes(rep));
  }

  const noche = ok(await svc.from("caja_noches").select("id").eq("club_id", clubs.A.id).single(), "noche");
  ok(await S.gerentea.rpc("caja_cerrar_noche", { p_noche_id: noche.id, p_contado_efectivo_centavos: 95000, p_contado_tarjeta_centavos: 85000, p_contado_otro_centavos: 4000, p_notas: "faltante de $50" }), "cerrar noche");

  console.log("\n== Noche cerrada");
  {
    const rep = ok(await reporte(S.gerentea), "reporte cerrada");
    revisarEsperado("cerrada", rep, esperado(true));
    revisar("cerrada: estado, quién y cuándo", rep.noche.estado === "cerrada" && rep.termino === true && rep.noche.cerrada_por_nombre === "T rep gerentea" && !!rep.noche.cerrada_en && rep.noche.abierta_por_nombre === "T rep staffa", JSON.stringify(rep.noche));
    const q = rep.cuadre ?? {};
    revisar("cerrada: cuadre con faltante de $50", q.registrado_centavos === 189000 && q.contado_efectivo_centavos === 95000 && q.diferencia_centavos === -5000 && q.notas === "faltante de $50" && q.hecho_por_nombre === "T rep gerentea", JSON.stringify(q));
    identidades("cerrada", rep);
    await compararConGrupo("cerrada", S.gerentea, clubs.A.id, F, rep);
    const { data: fila } = await svc.from("caja_cuadres").select("*").eq("noche_id", noche.id).eq("tipo", "noche").single();
    revisar("cerrada: cuadre = fila de caja_cuadres", ["registrado_centavos", "cobrado_efectivo_centavos", "cobrado_tarjeta_centavos", "cobrado_otro_centavos", "contado_efectivo_centavos", "contado_tarjeta_centavos", "contado_otro_centavos", "diferencia_centavos", "saldo_sin_cobrar_centavos"].every((k) => Number(fila[k]) === Number(q[k])));
    revisar("cerrada: sin nombres ni teléfonos de clientes", sinDatosDeClientes(rep));
    // Otra noche (mañana) sale vacía y como futura.
    const futura = ok(await reporte(S.gerentea, clubs.A.id, manana), "mañana");
    revisar("mañana: 1 reserva por llegar, futura, sin caja", futura.momento === "futura" && futura.noche.estado === "sin_caja" && futura.reservas.reservas === 1 && futura.reservas.por_llegar === 1, JSON.stringify(futura.reservas));
  }

  // ======================= Quién lo ve =======================
  console.log("\n== Acceso");
  for (const quien of ["admin", "duenoa", "grupo", "gerentea"]) {
    const r = await reporte(S[quien]);
    revisar(`${quien}: ve el cierre del antro A`, !r.error && r.data?.consumo?.total_centavos === 189000, r.error?.message);
  }
  const rechazados = { anon: S.anon, cliente: S.cliente, rp: S.rp1, staff: S.staffa, "dueño de otro antro": S.duenob, "gerente de otro antro": S.gerenteb,
    "cuenta sin perfil": S.sinperfil, "gerente con contraseña temporal": S.temporal, ...(S.baja ? { "gerente dado de baja": S.baja } : {}) };
  for (const [quien, c] of Object.entries(rechazados)) {
    const r = await reporte(c);
    revisar(`${quien}: NO ve el cierre del antro A`, !!r.error && !r.data, r.error ? "" : "lo vio");
  }
  if (!S.baja) revisar("gerente dado de baja: ni siquiera inicia sesión", true);
  {
    const r = await reporte(S.staffa);
    revisar("staff: el aviso es claro (P0001)", r.error?.code === "P0001" && /no tienes acceso/i.test(r.error.message), r.error?.message);
    const g2 = await reporte(S.grupo, clubs.B.id);
    revisar("dueño de grupo: no ve un antro fuera de su grupo", !!g2.error);
    const gb = await reporte(S.gerenteb, clubs.B.id);
    revisar("gerente de B: sí ve su antro (zona Tijuana)", !gb.error && gb.data?.club?.zona_horaria === "America/Tijuana" && gb.data?.fecha === clubs.B.noche, gb.error?.message ?? `${gb.data?.fecha} vs ${clubs.B.noche}`);
    const lejos = await reporte(S.admin, clubs.A.id, "2031-01-01");
    revisar("fecha fuera de rango: rechazada con aviso", lejos.error?.code === "P0001", lejos.error?.message);
    const nulo = await S.admin.rpc("reporte_cierre_noche", { p_club_id: clubs.A.id, p_fecha: null });
    revisar("fecha nula: rechazada", !!nulo.error);
    const noExiste = await reporte(S.admin, randomUUID());
    revisar("antro inexistente (admin): aviso 'No encontramos'", /no encontramos/i.test(noExiste.error?.message ?? ""), noExiste.error?.message);
  }

  // ======================= Club Demo Dev (solo lectura) =======================
  console.log("\n== Club Demo Dev: reporte = caja, cuadres y /grupo (transacción de solo lectura)");
  const db = await conectarDevEscritura();
  try {
    await db.q("begin transaction read only");
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.admin.id, role: "authenticated" })]);
    const noches = await db.q(`select id, fecha_operacion::text as fecha, estado from public.caja_noches where club_id = $1 order by 2`, [CLUB_DEMO]);
    for (const n of noches) {
      const donde = `Club Demo Dev ${n.fecha}`;
      const [{ j: rep }] = await db.q(`select public.reporte_cierre_noche($1, $2::date) as j`, [CLUB_DEMO, n.fecha]);
      const [caja] = await db.q(
        `select coalesce((select sum(monto_centavos) from public.caja_consumos k where k.noche_id = $1 and not k.anulado), 0)::bigint as consumo,
                (select count(distinct cuenta_id) from public.caja_consumos k where k.noche_id = $1 and not k.anulado)::int as cuentas,
                coalesce((select sum(monto_centavos) from public.caja_pagos p where p.noche_id = $1 and not p.anulado and p.metodo = 'efectivo'), 0)::bigint as efectivo,
                coalesce((select sum(monto_centavos) from public.caja_pagos p where p.noche_id = $1 and not p.anulado and p.metodo = 'tarjeta'), 0)::bigint as tarjeta,
                coalesce((select sum(monto_centavos) from public.caja_pagos p where p.noche_id = $1 and not p.anulado and p.metodo = 'otro'), 0)::bigint as otro,
                (select count(*) from public.caja_consumos k where k.noche_id = $1 and k.anulado)::int as anulados,
                (select count(*) from public.mesa_sesiones s where s.noche_id = $1)::int as grupos,
                (select count(distinct mesa_id) from public.mesa_sesiones s where s.noche_id = $1)::int as mesas`,
        [n.id],
      );
      igual(`${donde}: consumo = caja`, rep.consumo.total_centavos, caja.consumo);
      igual(`${donde}: cuentas con consumo = caja`, rep.consumo.cuentas_con_consumo, caja.cuentas);
      igual(`${donde}: efectivo = caja`, rep.cobros.efectivo_centavos, caja.efectivo);
      igual(`${donde}: tarjeta = caja`, rep.cobros.tarjeta_centavos, caja.tarjeta);
      igual(`${donde}: otro = caja`, rep.cobros.otro_centavos, caja.otro);
      igual(`${donde}: consumos anulados = caja`, rep.anulaciones.consumos, caja.anulados);
      igual(`${donde}: grupos = sesiones`, rep.mesas.grupos, caja.grupos);
      igual(`${donde}: mesas usadas`, rep.mesas.mesas_usadas, caja.mesas);
      const [q] = await db.q(`select * from public.caja_cuadres where noche_id = $1 and tipo = 'noche'`, [n.id]);
      revisar(`${donde}: cuadre presente solo si la noche cerró`, (n.estado === "cerrada") === !!rep.cuadre && (!q || Number(q.diferencia_centavos) === Number(rep.cuadre.diferencia_centavos)));
      identidades(donde, rep);
      const g = (await db.q(`select * from public.grupo_resumen($1::date, $1::date) where club_id = $2`, [n.fecha, CLUB_DEMO]))[0];
      igual(`${donde}: reservas = /grupo`, rep.reservas.reservas, g.reservas);
      igual(`${donde}: entraron = /grupo`, rep.reservas.entraron, g.entraron);
      igual(`${donde}: consumieron = /grupo`, rep.reservas.consumieron, g.reservas_con_consumo);
      igual(`${donde}: consumo = /grupo`, rep.consumo.total_centavos, g.consumo_centavos);
      igual(`${donde}: consumo con reserva = /grupo`, rep.consumo.con_reserva_centavos, g.consumo_con_reserva_centavos);
      igual(`${donde}: ticket = /grupo`, rep.consumo.ticket_promedio_centavos, g.ticket_promedio_centavos);
      igual(`${donde}: comisiones = /grupo`, rep.comisiones.total_centavos, g.comisiones_centavos);
      const rend = (await db.q(`select * from public.grupo_rendimiento_rp($1, $2::date, $2::date)`, [CLUB_DEMO, n.fecha])).filter((r) => r.reservas > 0 || Number(r.comisiones_centavos) > 0);
      revisar(`${donde}: RPs = rendimiento por RP`, rend.length === rep.rps.length && rend.every((r) => {
        const x = rep.rps.find((y) => y.rp_id === r.rp_id);
        return x && x.reservas === r.reservas && x.consumieron === r.consumieron && Number(x.consumo_centavos) === Number(r.consumo_centavos) && Number(x.comisiones_centavos) === Number(r.comisiones_centavos);
      }));
      {
        // Ningún teléfono, nombre de cliente ni QR de las reservas o cuentas de esa noche aparece en el reporte.
        const texto = JSON.stringify(rep);
        const privados = await db.q(
          `select r.cliente_telefono as v from public.reservations r where r.club_id = $1 and r.fecha = $2::date and coalesce(r.cliente_telefono, '') <> ''
           union select r.cliente_nombre from public.reservations r where r.club_id = $1 and r.fecha = $2::date and coalesce(r.cliente_nombre, '') <> ''
           union select r.qr_code from public.reservations r where r.club_id = $1 and r.fecha = $2::date and r.qr_code is not null
           union select mc.cliente_nombre from public.mesa_cuentas mc join public.mesa_sesiones s on s.id = mc.sesion_id where s.noche_id = $3`,
          [CLUB_DEMO, n.fecha, n.id],
        );
        const fugas = privados.filter((p) => texto.includes(`"${p.v}"`));
        revisar(`${donde}: sin teléfonos, nombres de clientes ni QR (${privados.length} revisados)`, fugas.length === 0 && !/telefono|cliente_nombre|qr_code/.test(texto), `${fugas.length} fugas`);
      }
      if (n.fecha === "2026-11-25") {
        console.log(`        25/11: ${rep.reservas.reservas} reservas, ${rep.reservas.entraron} entraron, ${rep.reservas.consumieron} consumieron, ${rep.reservas.por_llegar} por llegar; ` +
          `consumo ${rep.consumo.total_centavos} (con reserva ${rep.consumo.con_reserva_centavos}), ticket ${rep.consumo.ticket_promedio_centavos}, ` +
          `cobrado ${rep.cobros.total_centavos}, ${rep.anulaciones.consumos} anulado(s) por ${rep.anulaciones.consumos_centavos}, ` +
          `${rep.mesas.mesas_usadas} mesas / ${rep.mesas.grupos} grupos, comisiones ${rep.comisiones.total_centavos} (centavos)`);
      }
    }
    await db.q("rollback");
  } finally {
    await db.fin();
  }
} catch (e) {
  revisar("error inesperado", false, e.message);
} finally {
  limpio = await limpiar();
  revisar("limpieza: no quedan antros, perfiles, usuarios ni grupos de la prueba", limpio);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
