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
// Crea sus propios antros "T rls conc …" y cuentas t_rls_…@example.com, y al
// final lo borra todo aunque falle (try/finally). No toca Club Demo Dev.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const TAG = "t_rls_" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
const clubs = {};
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
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await borrar(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await borrar("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      await borrar("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      await borrar("delete from public.reserva_intentos where club_id = any($1::uuid[])", [clubIds]);
      await borrar("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
      await borrar("update public.clubs set dueno_id = null where id = any($1::uuid[])", [clubIds]);
    }
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
            (select count(*) from auth.users where email like $2)::int usuarios`,
    [`%${TAG}%`, `${TAG}%`],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
  if (quedan[0].clubs || quedan[0].perfiles || quedan[0].usuarios) revisar("la limpieza no deja restos", false, JSON.stringify(quedan[0]));
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
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await db.fin();
  await limpiar();
  const pasan = resultados.filter((r) => r.paso).length;
  console.log(`\nResultado: ${pasan}/${resultados.length} pasan`);
  if (pasan !== resultados.length) process.exitCode = 1;
}
