// Pruebas por rol de la caja, la puerta, la nómina, el cover y la zona
// horaria, con sesiones REALES contra antroapp-dev (como la app: PostgREST
// con la anon key de dev y RLS). Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-caja.mjs
//
// Crea su propio escenario (dos antros en zonas distintas, un grupo, un
// usuario por rol, reservas de esta noche), lo recorre y al final lo borra
// todo y confirma que quedó en 0. Las filas de caja solo se pueden borrar
// con el permiso de limpieza de pruebas (bloque 6B), por conexión directa
// a dev.

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

const TAG = "caja" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
const clubs = {};
const resultados = [];
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };

function revisar(nombre, paso, detalle = "") {
  resultados.push({ nombre, paso });
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}
async function debeFallar(nombre, promesa, contiene = null) {
  const r = await promesa;
  const fallo = !!r.error;
  const msg = r.error?.message ?? "";
  revisar(nombre, fallo && (!contiene || msg.toLowerCase().includes(contiene.toLowerCase())), fallo ? msg : "NO falló");
  return r;
}
async function debePasar(nombre, promesa) {
  const r = await promesa;
  revisar(nombre, !r.error, r.error?.message ?? "");
  return r.data;
}

// Noche operativa (corte 08:00) en una zona.
const nocheEn = (zona) => new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date(Date.now() - 8 * 3600e3));
function semanaIso(fechaISO) {
  const d = new Date(fechaISO + "T00:00:00Z");
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const anio = d.getUTCFullYear();
  const semana = Math.ceil(((d - Date.UTC(anio, 0, 1)) / 86400e3 + 1) / 7);
  return { anio, semana };
}

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
async function club(clave, zona, dueno) {
  const id = randomUUID();
  ok(await svc.from("clubs").insert({ id, nombre: `Prueba ${clave} ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", dueno_id: dueno, suscripcion_activa: false }), "club " + clave);
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, zona_horaria: zona, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 0, comision_desbloqueo_reservas: 0 }).eq("id", id), "publicar " + clave);
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
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await db.q("delete from public.grupo_clubs where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.grupos where nombre like $1", [`%${TAG}%`]);
      await db.q("delete from public.rp_pagos_dia where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_attendance where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.club_dia_tarifas where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.rp_comision_overrides where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
    }
    // Antros creados por las sesiones durante la prueba (por ejemplo el de RETURNING).
    await db.q("delete from public.clubs where nombre like $1 and not (id = any($2::uuid[]))", [`%${TAG}%`, clubIds]);
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from public.caja_noches n join public.clubs c on c.id = n.club_id where c.nombre like $1)::int noches,
            (select count(*) from public.profiles where nombre like $1)::int perfiles,
            (select count(*) from auth.users where email like $2)::int usuarios,
            (select count(*) from public.grupos where nombre like $1)::int grupos`,
    [`%${TAG}%`, `%${TAG}%`],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

try {
  // ======================= Escenario =======================
  await usuario("admin", "admin");
  const duenoA = await usuario("duenoA", "dueno");
  const duenoB = await usuario("duenoB", "dueno");
  await usuario("grupo", "dueno"); // dueño de grupo (membresía, no rol)
  await usuario("cliente", "cliente");
  await club("A", "America/Mexico_City", duenoA);
  await club("B", "America/Tijuana", duenoB);
  await usuario("staffA", "staff", clubs.A.id);
  await usuario("gerenteA", "gerente", clubs.A.id);
  const rp1 = await usuario("rp1", "rp", clubs.A.id);
  const rp2 = await usuario("rp2", "rp", clubs.A.id);
  await usuario("staffB", "staff", clubs.B.id);

  const g = ok(await svc.from("grupos").insert({ nombre: `Grupo ${TAG}` }).select("id").single(), "grupo");
  ok(await svc.from("grupo_clubs").insert([{ grupo_id: g.id, club_id: clubs.A.id }, { grupo_id: g.id, club_id: clubs.B.id }]), "grupo_clubs");
  ok(await svc.from("grupo_miembros").insert({ grupo_id: g.id, profile_id: U.grupo.id, rol_grupo: "dueno_grupo" }), "grupo_miembros");

  const mesasA = ok(await svc.from("club_tables").insert([{ club_id: clubs.A.id, numero: "1", capacidad: 8 }, { club_id: clubs.A.id, numero: "2", capacidad: 8 }]).select("id, numero"), "mesas A");
  const mesasB = ok(await svc.from("club_tables").insert([{ club_id: clubs.B.id, numero: "1", capacidad: 8 }]).select("id"), "mesas B");
  const M1 = mesasA.find((m) => m.numero === "1").id;
  const M2 = mesasA.find((m) => m.numero === "2").id;
  ok(await svc.from("rp_comision_overrides").insert([
    { club_id: clubs.A.id, rp_id: rp1, comision_tipo: "fijo", comision_monto: 150, comision_desbloqueo_reservas: 0 },
    { club_id: clubs.A.id, rp_id: rp2, comision_tipo: "porcentaje", comision_monto: 10, comision_desbloqueo_reservas: 0 },
  ]), "overrides");

  const R1 = await reserva("A", { source: "rp", rp_id: rp1 });
  const R2 = await reserva("A", { source: "rp", rp_id: rp2 });
  const R3 = await reserva("A", {}); // orgánica
  const R4 = await reserva("A", { source: "rp", rp_id: rp1 }); // nunca entra
  const manana = new Date(new Date(clubs.A.noche + "T12:00:00Z").getTime() + 86400e3).toISOString().slice(0, 10);
  const R5 = await reserva("A", { fecha: manana }); // otra noche
  const RB = await reserva("B", {});

  const S = {
    anon: nuevoAnon(), cliente: await sesion("cliente"), rp1: await sesion("rp1"), rp2: await sesion("rp2"),
    staffA: await sesion("staffA"), gerenteA: await sesion("gerenteA"), duenoA: await sesion("duenoA"),
    duenoB: await sesion("duenoB"), admin: await sesion("admin"), grupo: await sesion("grupo"), staffB: await sesion("staffB"),
  };
  console.log(`Escenario: antro A (${clubs.A.zona}, noche ${clubs.A.noche}), antro B (${clubs.B.zona}, noche ${clubs.B.noche})`);

  // ======================= Puerta =======================
  console.log("\n== Puerta");
  for (const quien of ["anon", "cliente", "rp1"])
    await debeFallar(`${quien}: no puede escanear QR`, S[quien].rpc("puerta_escanear", { p_qr: R1.qr_code }));
  await debeFallar("staff de otro antro: QR ajeno = 'no encontrada'", S.staffB.rpc("puerta_escanear", { p_qr: R1.qr_code }), "no encontrada");
  await debeFallar("staff: QR inexistente = mismo mensaje", S.staffA.rpc("puerta_escanear", { p_qr: "antro-no-existe" }), "no encontrada");
  await debeFallar("staff: confirmar sin escanear", S.staffA.rpc("puerta_confirmar_entrada", { p_reservation_id: R1.id }), "escanea");
  const ficha = await debePasar("staff: escanea QR de esta noche", S.staffA.rpc("puerta_escanear", { p_qr: R1.qr_code }));
  revisar("puerta: la ficha no trae teléfono ni consumo", ficha && !("cliente_telefono" in ficha) && !("consumo_monto" in ficha) && ficha.cliente_nombre === R1.cliente_nombre, JSON.stringify(Object.keys(ficha ?? {})));
  await debeFallar("staff: QR de otra noche", S.staffA.rpc("puerta_escanear", { p_qr: R5.qr_code }), "no para esta noche");
  await debePasar("staff: Confirmar entrada", S.staffA.rpc("puerta_confirmar_entrada", { p_reservation_id: R1.id }));
  const r1 = ok(await svc.from("reservations").select("status, puerta_estado, entrada_en").eq("id", R1.id).single(), "leer R1");
  revisar("puerta: queda usada con hora real de entrada", r1.status === "usada" && r1.puerta_estado === "entro" && !!r1.entrada_en);
  await debeFallar("staff: escanear otra vez = ya entró", S.staffA.rpc("puerta_escanear", { p_qr: R1.qr_code }), "ya entró");
  for (const R of [R2, R3]) {
    ok(await S.gerenteA.rpc("puerta_escanear", { p_qr: R.qr_code }), "escanear");
    ok(await S.gerenteA.rpc("puerta_confirmar_entrada", { p_reservation_id: R.id }), "confirmar");
  }
  {
    await S.staffA.from("reservations").update({ status: "usada" }).eq("id", R4.id);
    const r4 = ok(await svc.from("reservations").select("status").eq("id", R4.id).single(), "leer R4");
    revisar("staff: UPDATE directo a 'usada' no pasa (solo con la puerta)", r4.status !== "usada", r4.status);
  }

  // ======================= Abrir mesa y sentar =======================
  console.log("\n== Abrir mesa y sentar clientes");
  for (const quien of ["anon", "cliente", "rp1", "duenoB", "grupo", "staffB"])
    await debeFallar(`${quien}: no abre mesa del antro A`, S[quien].rpc("caja_abrir_mesa", { p_mesa_id: M1 }));
  const S1 = await debePasar("staff: abre mesa 1", S.staffA.rpc("caja_abrir_mesa", { p_mesa_id: M1 }));
  await debeFallar("staff: la misma mesa no se abre dos veces", S.staffA.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "ya está abierta");
  await debeFallar("no se sienta una reserva sin entrada confirmada", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R4.id }), "confirmar la entrada");
  await debeFallar("no se sienta una reserva de otro antro", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: RB.id }), "no es de este antro");
  const C1 = await debePasar("sienta reserva del RP 1", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R1.id }));
  const C2 = await debePasar("sienta reserva del RP 2 (misma mesa)", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R2.id }));
  const C3 = await debePasar("sienta reserva orgánica (misma mesa)", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R3.id }));
  const C4 = await debePasar("sienta walk-in", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_cliente_nombre: "Walk-in prueba", p_personas: 2 }));
  await debeFallar("una reserva no se sienta dos veces", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_reservation_id: R1.id }), "ya está sentada");
  {
    const cuentas = ok(await S.staffA.from("mesa_cuentas").select("id, rp_id, origen").eq("sesion_id", S1), "cuentas");
    const c1 = cuentas.find((c) => c.id === C1), c2 = cuentas.find((c) => c.id === C2), c3 = cuentas.find((c) => c.id === C3), c4 = cuentas.find((c) => c.id === C4);
    revisar("cada cuenta trae el RP de su reserva (lo pone la base)", c1?.rp_id === rp1 && c2?.rp_id === rp2 && c3?.rp_id === null && c4?.rp_id === null && c4?.origen === "walk_in");
  }

  // ======================= Consumos y anulación =======================
  console.log("\n== Consumos y anulación con motivo");
  await debeFallar("RP no registra consumos", S.rp1.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 1000 }));
  await debeFallar("cliente no registra consumos", S.cliente.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 1000 }));
  await debeFallar("monto 0 no se acepta", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 0 }), "inválido");
  const K1 = await debePasar("consumo cuenta 1: $500", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 50000, p_concepto: "Botella" }));
  const K2 = await debePasar("consumo cuenta 1: $300 (se anulará)", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 30000 }));
  await debePasar("consumo cuenta 2: $1,000", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C2, p_monto_centavos: 100000 }));
  await debePasar("consumo cuenta orgánica: $200", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C3, p_monto_centavos: 20000 }));
  await debePasar("consumo walk-in: $150", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C4, p_monto_centavos: 15000 }));
  await debeFallar("staff no anula (casilla apagada por defecto)", S.staffA.rpc("caja_anular_consumo", { p_consumo_id: K2, p_motivo: "error de captura" }), "permiso");
  await debeFallar("gerente: anular sin motivo no pasa", S.gerenteA.rpc("caja_anular_consumo", { p_consumo_id: K2, p_motivo: "" }), "motivo");
  await debePasar("gerente: anula con motivo", S.gerenteA.rpc("caja_anular_consumo", { p_consumo_id: K2, p_motivo: "Capturado dos veces" }));
  await debeFallar("no se anula dos veces", S.gerenteA.rpc("caja_anular_consumo", { p_consumo_id: K2, p_motivo: "otra vez" }), "ya estaba anulado");

  console.log("\n== Nada se borra");
  {
    await S.staffA.from("caja_consumos").insert({ club_id: clubs.A.id, noche_id: randomUUID(), sesion_id: S1, mesa_id: M1, cuenta_id: C1, monto_centavos: 1, registrado_por: U.staffA.id });
    await S.staffA.from("caja_consumos").update({ monto_centavos: 1 }).eq("id", K1);
    await S.gerenteA.from("caja_consumos").delete().eq("id", K1);
    await S.duenoA.from("caja_consumos").delete().eq("sesion_id", S1);
    await S.admin.from("caja_consumos").delete().eq("id", K1);
    const k = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", S1), "leer consumos");
    revisar("por la API ningún rol inserta, cambia ni borra consumos", k.length === 5 && k.some((x) => x.monto_centavos === 50000), `${k.length} consumos`);
    await debeFallar("ni la service role borra un consumo (trigger)", svc.from("caja_consumos").delete().eq("id", K1), "nada se borra");
    await debeFallar("ni la service role cambia un monto (trigger)", svc.from("caja_consumos").update({ monto_centavos: 1 }).eq("id", K1), "no cambia");
    await debeFallar("ni la service role 'desanula' (trigger)", svc.from("caja_consumos").update({ anulado: false }).eq("id", K2), "anulado");
    await debeFallar("borrar la reserva no se lleva la caja (FK)", svc.from("reservations").delete().eq("id", R1.id));
  }

  // ======================= Pagos, cerrar y cuadrar =======================
  console.log("\n== Cobro, cierre y cuadre");
  await debeFallar("cliente no registra pagos (la app no cobra al cliente)", S.cliente.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: C1, p_metodo: "efectivo", p_monto_centavos: 100 }));
  await debeFallar("anónimo no registra pagos", S.anon.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 100 }));
  await debePasar("staff cobra $1,000 en efectivo", S.staffA.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 100000 }));
  await debeFallar("cerrar con saldo pendiente no pasa", S.staffA.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }), "saldo");
  await debePasar("staff cobra $850 con tarjeta", S.staffA.rpc("caja_registrar_pago", { p_sesion_id: S1, p_cuenta_id: C2, p_metodo: "tarjeta", p_monto_centavos: 85000, p_referencia: "1234" }));
  {
    const antes = ok(await svc.from("commissions").select("id").in("reservation_id", [R1.id, R2.id, R3.id]), "comisiones antes");
    revisar("antes de cuadrar no hay comisión (no nace con el consumo)", antes.length === 0, `${antes.length}`);
  }
  await debePasar("staff cierra la mesa (saldo cero)", S.staffA.rpc("caja_cerrar_mesa", { p_sesion_id: S1 }));
  await debeFallar("con la mesa cerrada no entran consumos", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 100 }), "requiere");
  await debeFallar("staff no cuadra (casilla del gerente)", S.staffA.rpc("caja_cuadrar_mesa", { p_sesion_id: S1 }), "permiso");
  await debePasar("gerente cuadra la mesa", S.gerenteA.rpc("caja_cuadrar_mesa", { p_sesion_id: S1, p_notas: "ok" }));
  {
    const com = ok(await svc.from("commissions").select("reservation_id, rp_id, monto, status, tipo").in("reservation_id", [R1.id, R2.id, R3.id, R4.id]), "comisiones");
    const c1 = com.find((c) => c.reservation_id === R1.id), c2 = com.find((c) => c.reservation_id === R2.id);
    revisar("al cuadrar: RP 1 cobra su fijo de $150 sobre SU cuenta", c1 && Number(c1.monto) === 150 && c1.rp_id === rp1 && c1.status === "pendiente", JSON.stringify(c1));
    revisar("al cuadrar: RP 2 cobra 10% de su cuenta ($1,000) = $100", c2 && Number(c2.monto) === 100 && c2.rp_id === rp2, JSON.stringify(c2));
    revisar("orgánica, walk-in y reserva que no entró: sin comisión", com.length === 2, `${com.length} comisiones`);
    const r1b = ok(await svc.from("reservations").select("consumo_monto").eq("id", R1.id).single(), "R1");
    revisar("consumo de la reserva = solo lo vigente ($500, sin el anulado)", Number(r1b.consumo_monto) === 500, String(r1b.consumo_monto));
  }
  await debeFallar("una mesa cuadrada no se reabre", S.gerenteA.rpc("caja_reabrir_mesa", { p_sesion_id: S1, p_motivo: "prueba" }), "requiere");
  await debeFallar("la liquidación interna no se llama desde la API", S.gerenteA.rpc("caja_liquidar_cuenta", { p_cuenta_id: C1 }));

  // ======================= Casillas de permisos =======================
  console.log("\n== Casillas de permisos");
  const S2 = await debePasar("la mesa 1 queda libre: se abre otra sesión", S.staffA.rpc("caja_abrir_mesa", { p_mesa_id: M1 }));
  const C5 = await debePasar("walk-in en la nueva sesión", S.staffA.rpc("caja_sentar_cliente", { p_sesion_id: S2, p_cliente_nombre: "Walk-in 2" }));
  await debeFallar("staff no configura casillas", S.staffA.rpc("caja_configurar_permiso", { p_club_id: clubs.A.id, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: true }));
  await debeFallar("dueño de otro antro no configura casillas", S.duenoB.rpc("caja_configurar_permiso", { p_club_id: clubs.A.id, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: true }));
  await debePasar("dueño: apaga 'registrar_consumo' solo para este staff", S.duenoA.rpc("caja_configurar_permiso", { p_club_id: clubs.A.id, p_permiso: "registrar_consumo", p_rol: null, p_profile_id: U.staffA.id, p_permitido: false }));
  await debeFallar("staff ya no registra consumos (casilla personal)", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C5, p_monto_centavos: 1000 }), "permiso");
  await debePasar("dueño: vuelve a encenderla", S.duenoA.rpc("caja_configurar_permiso", { p_club_id: clubs.A.id, p_permiso: "registrar_consumo", p_rol: null, p_profile_id: U.staffA.id, p_permitido: true }));
  await debePasar("dueño: enciende 'anular' para todo el staff", S.duenoA.rpc("caja_configurar_permiso", { p_club_id: clubs.A.id, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: true }));
  const K5 = await debePasar("staff registra consumo", S.staffA.rpc("caja_registrar_consumo", { p_cuenta_id: C5, p_monto_centavos: 5000 }));
  await debePasar("staff ya puede anular (casilla del rol)", S.staffA.rpc("caja_anular_consumo", { p_consumo_id: K5, p_motivo: "Cliente lo regresó" }));
  await debePasar("cerrar la mesa con todo anulado (saldo cero)", S.staffA.rpc("caja_cerrar_mesa", { p_sesion_id: S2 }));

  // ======================= Cerrar la noche =======================
  console.log("\n== Cuadre general de la noche");
  const noche = ok(await svc.from("caja_noches").select("id").eq("club_id", clubs.A.id).single(), "noche");
  await debeFallar("staff no cierra la noche", S.staffA.rpc("caja_cerrar_noche", { p_noche_id: noche.id, p_contado_efectivo_centavos: 0, p_contado_tarjeta_centavos: 0, p_contado_otro_centavos: 0 }), "permiso");
  await debeFallar("no se cierra la noche con mesas sin cuadrar", S.gerenteA.rpc("caja_cerrar_noche", { p_noche_id: noche.id, p_contado_efectivo_centavos: 100000, p_contado_tarjeta_centavos: 85000, p_contado_otro_centavos: 0 }), "cuadrar");
  await debePasar("gerente cuadra la segunda sesión", S.gerenteA.rpc("caja_cuadrar_mesa", { p_sesion_id: S2 }));
  await debePasar("gerente cierra la noche con conteo físico (faltan $50)", S.gerenteA.rpc("caja_cerrar_noche", { p_noche_id: noche.id, p_contado_efectivo_centavos: 95000, p_contado_tarjeta_centavos: 85000, p_contado_otro_centavos: 0, p_notas: "faltante" }));
  {
    const cuadre = ok(await svc.from("caja_cuadres").select("registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, diferencia_centavos").eq("noche_id", noche.id).eq("tipo", "noche").single(), "cuadre");
    revisar("cuadre: registrado $1,850, efectivo $1,000, tarjeta $850, diferencia -$50",
      cuadre.registrado_centavos === 185000 && cuadre.cobrado_efectivo_centavos === 100000 && cuadre.cobrado_tarjeta_centavos === 85000 && cuadre.diferencia_centavos === -5000, JSON.stringify(cuadre));
  }
  await debeFallar("noche cerrada: no se abren mesas", S.staffA.rpc("caja_abrir_mesa", { p_mesa_id: M2 }), "cerrada");

  // ======================= Antro B (otra zona) y grupo =======================
  console.log("\n== Antro B en Tijuana y dueño de grupo");
  ok(await S.staffB.rpc("puerta_escanear", { p_qr: RB.qr_code }), "escanear B");
  ok(await S.staffB.rpc("puerta_confirmar_entrada", { p_reservation_id: RB.id }), "confirmar B");
  const SB = await debePasar("staff B abre mesa en su antro", S.staffB.rpc("caja_abrir_mesa", { p_mesa_id: mesasB[0].id }));
  {
    const nb = ok(await svc.from("caja_noches").select("fecha_operacion").eq("club_id", clubs.B.id).single(), "noche B");
    revisar("la noche de B sale en la zona de Tijuana", nb.fecha_operacion === clubs.B.noche, `${nb.fecha_operacion} vs ${clubs.B.noche}`);
  }
  void SB;

  // ======================= Quién ve qué =======================
  console.log("\n== Quién ve qué (RLS)");
  const TABLAS = ["caja_noches", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "caja_permisos", "caja_eventos"];
  const ve = async (c, tabla, clubId) => {
    const { data, error } = await c.from(tabla).select("club_id").eq("club_id", clubId);
    return error ? 0 : data.length;
  };
  const esperado = { staffA: [true, false], gerenteA: [true, false], duenoA: [true, false], admin: [true, true], grupo: [true, true],
    staffB: [false, true], duenoB: [false, true], rp1: [false, false], cliente: [false, false], anon: [false, false] };
  for (const [quien, [vA, vB]] of Object.entries(esperado)) {
    let bien = true;
    const detalle = [];
    for (const t of TABLAS) {
      const nA = await ve(S[quien], t, clubs.A.id);
      const nB = await ve(S[quien], t, clubs.B.id);
      // A tiene filas en las 8 tablas; B no tiene cuadres ni casillas, así
      // que en B solo se exige "no ve" cuando no debe ver.
      const okA = vA ? nA > 0 : nA === 0;
      const okB = vB ? true : nB === 0;
      if (!okA || !okB) { bien = false; detalle.push(`${t}: A=${nA} B=${nB}`); }
    }
    revisar(`${quien}: ve la caja ${vA ? "de A" : "NO de A"}${vB ? " y de B" : ", NO de B"}`, bien, detalle.join("; "));
  }
  {
    const c = ok(await S.rp1.from("commissions").select("reservation_id, monto"), "comisiones RP1");
    revisar("RP 1 ve solo su comisión", c.length === 1 && c[0].reservation_id === R1.id, `${c.length}`);
    const cs = await S.staffA.from("commissions").select("id").eq("rp_id", rp1);
    revisar("staff no ve comisiones (sueldos)", (cs.data ?? []).length === 0);
  }

  // ======================= Nómina =======================
  console.log("\n== Nómina");
  const { anio, semana } = semanaIso(clubs.A.noche);
  await debeFallar("staff no ve la nómina", S.staffA.rpc("nomina_semana", { p_club_id: clubs.A.id, p_anio: anio, p_semana: semana }), "gerente");
  await debeFallar("RP no ve la nómina del antro", S.rp1.rpc("nomina_semana", { p_club_id: clubs.A.id, p_anio: anio, p_semana: semana }));
  await debeFallar("dueño ajeno no ve la nómina de A", S.duenoB.rpc("nomina_semana", { p_club_id: clubs.A.id, p_anio: anio, p_semana: semana }));
  const nom = await debePasar("gerente ve la nómina de la semana", S.gerenteA.rpc("nomina_semana", { p_club_id: clubs.A.id, p_anio: anio, p_semana: semana }));
  {
    const f1 = (nom ?? []).find((f) => f.rp_id === rp1), f2 = (nom ?? []).find((f) => f.rp_id === rp2);
    revisar("nómina: RP 1 $150 y RP 2 $100 pendientes (por noche de la reserva)", f1?.pendiente_centavos === 15000 && f2?.pendiente_centavos === 10000 && f1?.reservas_entraron === 1 && f1?.total_centavos === 15000, JSON.stringify({ f1: f1?.pendiente_centavos, f2: f2?.pendiente_centavos, e: f1?.reservas_entraron }));
  }
  await debePasar("dueño de grupo LEE la nómina", S.grupo.rpc("nomina_semana", { p_club_id: clubs.A.id, p_anio: anio, p_semana: semana }));
  const mia = await debePasar("RP ve solo su fila (nomina_semana_mia)", S.rp1.rpc("nomina_semana_mia", { p_anio: anio, p_semana: semana }));
  revisar("nomina_semana_mia: una sola fila, la suya", (mia ?? []).length === 1 && mia[0].rp_id === rp1);

  // ======================= Panel de grupo =======================
  console.log("\n== Panel de grupo (solo lectura)");
  {
    const rango = { p_desde: clubs.A.noche < clubs.B.noche ? clubs.A.noche : clubs.B.noche, p_hasta: clubs.A.noche > clubs.B.noche ? clubs.A.noche : clubs.B.noche };
    const g = await debePasar("dueño de grupo ve el resumen", S.grupo.rpc("grupo_resumen", rango));
    const a = (g ?? []).find((x) => x.club_id === clubs.A.id);
    revisar("grupo: ve sus dos antros (dos ciudades)", (g ?? []).filter((x) => [clubs.A.id, clubs.B.id].includes(x.club_id)).length === 2, `${(g ?? []).length} filas`);
    revisar("grupo: consumo de A $1,850, 4 cuentas, ticket $462.50, comisiones $250",
      a?.consumo_centavos === 185000 && a?.cuentas_con_consumo === 4 && a?.ticket_promedio_centavos === 46250 && a?.comisiones_centavos === 25000 && a?.noches_cerradas === 1,
      JSON.stringify({ c: a?.consumo_centavos, n: a?.cuentas_con_consumo, t: a?.ticket_promedio_centavos, com: a?.comisiones_centavos, cerr: a?.noches_cerradas }));
    const ger = await debePasar("gerente ve el resumen", S.gerenteA.rpc("grupo_resumen", rango));
    revisar("gerente: solo su antro", (ger ?? []).length === 1 && ger[0].club_id === clubs.A.id, `${(ger ?? []).length} filas`);
    const db = await S.duenoB.rpc("grupo_resumen", rango);
    revisar("dueño de B: solo su antro", (db.data ?? []).length === 1 && db.data[0].club_id === clubs.B.id, `${(db.data ?? []).length} filas`);
    for (const quien of ["staffA", "rp1", "cliente"]) {
      const r = await S[quien].rpc("grupo_resumen", rango);
      revisar(`${quien}: el resumen sale vacío (no ve consumo ni comisiones)`, !r.error && (r.data ?? []).length === 0, r.error?.message ?? `${(r.data ?? []).length} filas`);
    }
    await debeFallar("anónimo no llama el resumen", S.anon.rpc("grupo_resumen", rango));
    await debeFallar("rango de más de 93 días no pasa", S.grupo.rpc("grupo_resumen", { p_desde: "2026-01-01", p_hasta: "2026-12-31" }), "rango");
  }

  // ======================= Estados de la nómina =======================
  console.log("\n== Estados de la nómina");
  const sem = { p_club_id: clubs.A.id, p_anio: anio, p_semana: semana };
  const mover = (c, rp, desde, hacia, motivo) => c.rpc("nomina_cambiar_estado", { ...sem, p_rp_id: rp, p_desde: desde, p_hacia: hacia, p_motivo: motivo ?? null });
  await debeFallar("no se salta de pendiente a pagada", mover(S.gerenteA, rp1, "pendiente", "pagada"), "no se puede");
  await debeFallar("staff no cambia la nómina", mover(S.staffA, rp1, "pendiente", "en_revision"), "gerente");
  await debeFallar("dueño de grupo no cambia la nómina (solo lee)", mover(S.grupo, rp1, "pendiente", "en_revision"), "gerente");
  await debePasar("gerente: pendiente → en revisión", mover(S.gerenteA, rp1, "pendiente", "en_revision"));
  await debePasar("gerente: en revisión → validada", mover(S.gerenteA, rp1, "en_revision", "validada"));
  await debePasar("dueño: validada → pagada (nomina_marcar_pagada)", S.duenoA.rpc("nomina_marcar_pagada", { ...sem, p_rp_id: rp1 }));
  {
    const c = ok(await svc.from("commissions").select("status, pagada_por, estado_cambiado_por").eq("reservation_id", R1.id).single(), "comisión R1");
    revisar("comisión del RP 1 pagada, con quién la marcó", c.status === "pagada" && c.pagada_por === U.duenoA.id && c.estado_cambiado_por === U.duenoA.id);
  }
  await debeFallar("una semana pagada no se anula", mover(S.gerenteA, rp1, "pagada", "anulada", "error"), "no se puede");
  await debeFallar("anular sin motivo no pasa", mover(S.gerenteA, rp2, "pendiente", "anulada"), "motivo");
  await debePasar("gerente anula la semana del RP 2 con motivo", mover(S.gerenteA, rp2, "pendiente", "anulada", "Reserva duplicada"));
  {
    const n2 = ok(await S.gerenteA.rpc("nomina_semana", sem), "nómina");
    const f1 = n2.find((f) => f.rp_id === rp1), f2 = n2.find((f) => f.rp_id === rp2);
    revisar("nómina: RP 1 $150 pagada; RP 2 $100 anulada y fuera del total", f1?.pagada_centavos === 15000 && f2?.anulada_centavos === 10000 && f2?.total_centavos === 0 && f2?.comisiones === 0, JSON.stringify({ p1: f1?.pagada_centavos, a2: f2?.anulada_centavos, t2: f2?.total_centavos }));
    const c2 = ok(await svc.from("commissions").select("status, motivo_anulacion").eq("reservation_id", R2.id).single(), "comisión R2");
    revisar("la comisión anulada no se borra: queda con su motivo", c2.status === "anulada" && c2.motivo_anulacion === "Reserva duplicada");
  }

  // ======================= Cover (informativo) =======================
  console.log("\n== Cover informativo");
  await debePasar("dueño pone cover $350", S.duenoA.from("clubs").update({ cover_modo: "monto", cover_monto: 350 }).eq("id", clubs.A.id));
  await debeFallar("modo 'monto' sin monto no pasa", S.duenoA.from("clubs").update({ cover_modo: "monto", cover_monto: null }).eq("id", clubs.A.id), "coherente");
  await debeFallar("'libre' con monto no pasa", S.duenoA.from("clubs").update({ cover_modo: "libre", cover_monto: 100 }).eq("id", clubs.A.id), "coherente");
  await debeFallar("modo inventado no pasa", S.duenoA.from("clubs").update({ cover_modo: "gratis", cover_monto: null }).eq("id", clubs.A.id), "valido");
  for (const quien of ["staffA", "gerenteA", "cliente", "rp1", "duenoB", "anon"])
    await S[quien].from("clubs").update({ cover_modo: "libre", cover_monto: null }).eq("id", clubs.A.id);
  {
    const c = ok(await svc.from("clubs").select("cover_modo, cover_monto").eq("id", clubs.A.id).single(), "cover");
    revisar("staff, gerente, cliente, RP, dueño ajeno y anónimo no cambian el cover", c.cover_modo === "monto" && Number(c.cover_monto) === 350, JSON.stringify(c));
    const a = await S.anon.from("clubs").select("cover_modo, cover_monto").eq("id", clubs.A.id).maybeSingle();
    revisar("el anónimo lee el cover de un antro publicado", a.data?.cover_modo === "monto" && Number(a.data?.cover_monto) === 350);
  }
  {
    const hoy = clubs.A.noche;
    const r = await S.anon.from("reservations").insert({ cliente_nombre: `Anon ${TAG}`, cliente_telefono: "0000000778", club_id: clubs.A.id, source: "organica", fecha: hoy, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}`, consumo_monto: 100 });
    revisar("reserva sin cuenta: no puede nacer con un monto", !!r.error);
    const r2 = await S.anon.from("reservations").insert({ cliente_nombre: `Anon ${TAG}`, cliente_telefono: "0000000778", club_id: clubs.A.id, source: "organica", fecha: hoy, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
    revisar("reserva sin cuenta sigue funcionando (sin cobro)", !r2.error, r2.error?.message ?? "");
    const r3 = await S.anon.from("reservations").insert({ cliente_nombre: `Anon ${TAG}`, cliente_telefono: "0000000778", club_id: clubs.A.id, source: "organica", fecha: hoy, personas: 2, status: "usada", qr_code: `antro-${randomUUID()}` });
    revisar("reserva sin cuenta no puede nacer 'usada'", !!r3.error);
    const r4 = await S.cliente.from("reservations").insert({ cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000779", club_id: clubs.A.id, cliente_id: U.cliente.id, source: "organica", fecha: hoy, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
    revisar("reserva del cliente con sesión sigue funcionando", !r4.error, r4.error?.message ?? "");
  }

  // ======================= Zona horaria =======================
  console.log("\n== Zona horaria");
  await S.duenoA.from("clubs").update({ zona_horaria: "America/Cancun" }).eq("id", clubs.A.id);
  {
    const z = ok(await svc.from("clubs").select("zona_horaria").eq("id", clubs.A.id).single(), "zona");
    revisar("el dueño no cambia la zona horaria", z.zona_horaria === "America/Mexico_City", z.zona_horaria);
  }
  await debePasar("el admin cambia la zona de B a Cancún", S.admin.from("clubs").update({ zona_horaria: "America/Cancun" }).eq("id", clubs.B.id));
  await debeFallar("zona inválida no pasa", S.admin.from("clubs").update({ zona_horaria: "Marte/Olympus" }).eq("id", clubs.B.id), "inválida");

  // ======================= Hallazgos de la revisión =======================
  console.log("\n== Hallazgos de la revisión adversarial");
  {
    const base = { cliente_nombre: `RP ${TAG}`, cliente_telefono: "0000000790", rp_id: rp1, source: "rp", personas: 2, qr_code: `antro-${randomUUID()}` };
    const otro = await S.rp1.from("reservations").insert({ ...base, club_id: clubs.B.id, fecha: clubs.B.noche, status: "pendiente" });
    revisar("RP no mete reservas en otro antro", !!otro.error, otro.error?.message ?? "pasó");
    const conf = await S.rp1.from("reservations").insert({ ...base, qr_code: `antro-${randomUUID()}`, club_id: clubs.A.id, fecha: clubs.A.noche, status: "confirmada" });
    revisar("RP no crea reservas que nazcan confirmadas", !!conf.error, conf.error?.message ?? "pasó");
    const pasada = await S.rp1.from("reservations").insert({ ...base, qr_code: `antro-${randomUUID()}`, club_id: clubs.A.id, fecha: "2020-01-01", status: "pendiente" });
    revisar("RP no crea reservas en fechas pasadas", !!pasada.error, pasada.error?.message ?? "pasó");

    await debeFallar("staff no convierte una orgánica en reserva de RP", S.staffA.from("reservations").update({ source: "rp", rp_id: rp1 }).eq("id", R3.id), "no se cambian");
    await debeFallar("staff no cambia la fecha de una reserva", S.staffA.from("reservations").update({ fecha: "2030-01-01" }).eq("id", R4.id), "no se cambian");
    const asignar = await S.staffA.from("reservations").update({ mesa_id: M2 }).eq("id", R4.id);
    revisar("staff sí puede seguir asignando mesa (flujo actual)", !asignar.error, asignar.error?.message ?? "");

    await debeFallar("staff no se reactiva/desactiva solo", S.staffA.from("profiles").update({ activo: false }).eq("id", U.staffA.id), "propio");
    await debeFallar("staff no da de baja al gerente", S.staffA.from("profiles").update({ activo: false }).eq("id", U.gerenteA.id), "solo da de baja");
    await debePasar("staff sí da de baja a un RP", S.staffA.from("profiles").update({ activo: false }).eq("id", rp2));
    await debePasar("staff reactiva al RP", S.staffA.from("profiles").update({ activo: true }).eq("id", rp2));

    const cerrada = ok(await svc.from("caja_noches").select("id").eq("club_id", clubs.A.id).single(), "noche A");
    await debeFallar("ni la service role reabre una noche cerrada", svc.from("caja_noches").update({ estado: "abierta" }).eq("id", cerrada.id), "abierta a cerrada");
    await debeFallar("ni la service role reabre una mesa cuadrada", svc.from("mesa_sesiones").update({ estado: "abierta" }).eq("id", S1), "inválida");
    await debeFallar("ni la service role mete un consumo en una noche cerrada", svc.from("caja_consumos").insert({ club_id: clubs.A.id, noche_id: cerrada.id, sesion_id: S1, mesa_id: M1, cuenta_id: C1, monto_centavos: 7777, registrado_por: U.staffA.id }), "mesa abierta");
    await debeFallar("ni la service role quita la liquidación de una cuenta", svc.from("mesa_cuentas").update({ liquidada_en: null }).eq("id", C1), "liquidada");

    const ret = await S.duenoB.from("clubs").insert({ nombre: `Prueba RETURNING ${TAG}`, direccion: "x", horario: "x", dueno_id: U.duenoB.id }).select("id, cover_modo, estado_verificacion").single();
    revisar("dueño: INSERT de antro con RETURNING sigue pasando", !ret.error && ret.data?.estado_verificacion === "borrador", ret.error?.message ?? "");

    const evStaff = ok(await S.staffA.from("caja_eventos").select("tipo").eq("club_id", clubs.A.id).like("tipo", "nomina%"), "eventos staff");
    const evGer = ok(await S.gerenteA.from("caja_eventos").select("tipo").eq("club_id", clubs.A.id).like("tipo", "nomina%"), "eventos gerente");
    revisar("el staff no ve en la bitácora los pagos de nómina; el gerente sí", evStaff.length === 0 && evGer.length > 0, `staff=${evStaff.length} gerente=${evGer.length}`);
  }

  // ======================= Estabilidad (bloque 5) =======================
  console.log("\n== Una reserva por cliente y noche");
  {
    const r = await S.cliente.from("reservations").insert({ cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000779", club_id: clubs.A.id, cliente_id: U.cliente.id, source: "organica", fecha: clubs.A.noche, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
    revisar("el mismo cliente no reserva dos veces el mismo antro la misma noche", r.error?.code === "23505", r.error?.code ?? "sin error");
    const r2 = await S.cliente.from("reservations").insert({ cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000779", club_id: clubs.B.id, cliente_id: U.cliente.id, source: "organica", fecha: clubs.B.noche, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
    revisar("sí puede reservar otro antro esa noche", !r2.error, r2.error?.message ?? "");
    const r3 = await S.rp1.from("reservations").insert({ cliente_nombre: `Otro ${TAG}`, cliente_telefono: "0000000780", club_id: clubs.A.id, rp_id: rp1, source: "rp", fecha: clubs.A.noche, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
    const r4 = await S.rp1.from("reservations").insert({ cliente_nombre: `Otro2 ${TAG}`, cliente_telefono: "0000000781", club_id: clubs.A.id, rp_id: rp1, source: "rp", fecha: clubs.A.noche, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
    revisar("un RP sí trae a varios clientes la misma noche", !r3.error && !r4.error, r3.error?.message ?? r4.error?.message ?? "");
  }

  console.log("\n== registrar_comision_reserva (ya no confía en el navegador)");
  {
    await debePasar("re-liquidar una mesa cuadrada no duplica", S.gerenteA.rpc("registrar_comision_reserva", { p_reservation_id: R1.id, p_rp_id: rp1, p_club_id: clubs.A.id, p_consumo_monto: 999999, p_week_start: new Date(0).toISOString(), p_week_end: new Date().toISOString() }));
    const c = ok(await svc.from("commissions").select("monto").eq("reservation_id", R1.id), "comisión R1");
    revisar("sigue una sola comisión de $150 (ignora el consumo del navegador)", c.length === 1 && Number(c[0].monto) === 150, JSON.stringify(c));
    await debeFallar("reserva sin mesa: no hay comisión fuera de la caja", S.staffA.rpc("registrar_comision_reserva", { p_reservation_id: R4.id, p_rp_id: rp1, p_club_id: clubs.A.id, p_consumo_monto: 5000, p_week_start: new Date(0).toISOString(), p_week_end: new Date().toISOString() }), "no está sentada");
    await debeFallar("staff de otro antro no registra comisiones de A", S.staffB.rpc("registrar_comision_reserva", { p_reservation_id: R1.id, p_rp_id: rp1, p_club_id: clubs.A.id, p_consumo_monto: 1, p_week_start: new Date(0).toISOString(), p_week_end: new Date().toISOString() }), "no autorizado");
  }

  console.log("\n== registrar_pago_dia (semana calculada en la base)");
  {
    ok(await svc.from("clubs").update({ pago_rp_modo: "dia" }).eq("id", clubs.B.id), "B en modo día");
    ok(await svc.from("club_dia_tarifas").insert([{ club_id: clubs.B.id, posicion: 1, monto: 300 }, { club_id: clubs.B.id, posicion: 2, monto: 400 }]), "tarifas B");
    const rpB = await usuario("rpB", "rp", clubs.B.id);
    const ayer = new Date(new Date(clubs.B.noche + "T12:00:00Z").getTime() - 86400e3).toISOString().slice(0, 10);
    const lunesDe = (f) => { const d = new Date(f + "T12:00:00Z"); const dia = d.getUTCDay() || 7; return new Date(d.getTime() - (dia - 1) * 86400e3).toISOString().slice(0, 10); };
    const mismaSemana = lunesDe(ayer) === lunesDe(clubs.B.noche);
    const a1 = ok(await S.staffB.from("rp_attendance").insert({ rp_id: rpB, club_id: clubs.B.id, fecha: ayer, metodo: "manual", marcado_por: U.staffB.id }).select("id").single(), "asistencia 1");
    const a2 = ok(await S.staffB.from("rp_attendance").insert({ rp_id: rpB, club_id: clubs.B.id, fecha: clubs.B.noche, metodo: "qr", marcado_por: U.staffB.id }).select("id").single(), "asistencia 2");
    const semanaFalsa = { p_week_start: "2000-01-01T00:00:00Z", p_week_end: "2000-01-02T00:00:00Z" };
    await debePasar("staff registra el pago del día 1 (semana mandada falsa: se ignora)", S.staffB.rpc("registrar_pago_dia", { p_rp_attendance_id: a1.id, p_rp_id: rpB, p_club_id: clubs.B.id, p_fecha: ayer, ...semanaFalsa }));
    await debePasar("registrar el mismo día otra vez no duplica", S.staffB.rpc("registrar_pago_dia", { p_rp_attendance_id: a1.id, p_rp_id: rpB, p_club_id: clubs.B.id, p_fecha: ayer, ...semanaFalsa }));
    await debePasar("staff registra el pago del día 2", S.staffB.rpc("registrar_pago_dia", { p_rp_attendance_id: a2.id, p_rp_id: rpB, p_club_id: clubs.B.id, p_fecha: clubs.B.noche, ...semanaFalsa }));
    const pagos = ok(await svc.from("rp_pagos_dia").select("rp_attendance_id, posicion, monto").eq("rp_id", rpB), "pagos");
    const p2 = pagos.find((p) => p.rp_attendance_id === a2.id);
    revisar("un pago por asistencia", pagos.length === 2, `${pagos.length}`);
    revisar(`segundo día de la semana = tarifa 2 ($400)${mismaSemana ? "" : " (cruce de semana: tarifa 1)"}`,
      mismaSemana ? p2?.posicion === 2 && Number(p2?.monto) === 400 : p2?.posicion === 1 && Number(p2?.monto) === 300, JSON.stringify(p2));
    await debeFallar("asistencia de otro antro no pasa", S.staffA.rpc("registrar_pago_dia", { p_rp_attendance_id: a1.id, p_rp_id: rpB, p_club_id: clubs.B.id, p_fecha: ayer, ...semanaFalsa }), "no autorizado");
    await debeFallar("RP no se registra su propio pago", (await sesion("rpB")).rpc("registrar_pago_dia", { p_rp_attendance_id: a1.id, p_rp_id: rpB, p_club_id: clubs.B.id, p_fecha: ayer, ...semanaFalsa }), "no autorizado");
  }
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await limpiar();
  const fallas = resultados.filter((r) => !r.paso);
  console.log(`\nResultado: ${resultados.length - fallas.length}/${resultados.length} pasan`);
  if (fallas.length) process.exitCode = 1;
}
