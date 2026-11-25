// Pruebas de punta a punta del paso «Reglas de comisión y RPs» del alta
// (sql/post-junta-2/10-alta-club-reglas.sql, POST /api/admin/alta-club)
// contra el servidor local de dev y antroapp-dev.
//
//   PUERTO=3021 node scripts/dev/servidor-dev.mjs        # en otra terminal
//   node scripts/dev/probar-alta-reglas.mjs [--base=http://localhost:3021]
//
// Revisa:
//   1. Alta por la ruta con regla de CUOTA, «estado, monto y botellas» y 3
//      permisos de caja cambiados: todo queda en la base con quién lo hizo;
//      la regla vale desde el lunes de esta semana; el gerente la ve en
//      config_rp_actual; los permisos se aplican (caja_mis_permisos); una
//      mesa cuadrada por el camino real calcula con ESA regla (no con las
//      columnas viejas) y el panel del RP ve su cuota y las botellas.
//   2. Alta por la ruta con pago POR DÍA (3 tarifas, sin regla): la
//      asistencia del RP genera su pago con la tarifa del día 1.
//   3. La ruta rechaza reglas inválidas sin crear cuentas.
//   4. La base rechaza, llamándola directo como admin, cada regla, tarifa o
//      permiso inválido (sin dejar nada); sin p.rp hace lo de antes; nadie
//      fuera del admin (gerente, dueño, cuenta sin perfil, anónimo) la usa.
// Datos propios con prefijo t_alta_ / «T alta»; al final se borra todo
// (aunque falle). Nunca toca Club Demo Dev ni los usuarios dev_*.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const BASE = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3021").replace(/\/$/, "");
const { password: PASS_DEV } = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};

const sufijo = randomUUID().slice(0, 8);
const PREFIJO = `T alta ${sufijo}`;
const correo = (clave) => `t_alta_${clave}_${sufijo}@example.com`;
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function sesion(email, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip() },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, galletas: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
async function alta(galletas, cuerpo) {
  const r = await fetch(BASE + "/api/admin/alta-club", {
    method: "POST",
    headers: { "content-type": "application/json", ...(galletas ? { cookie: galletas } : {}) },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}
async function clienteDe(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  // La base de dev la comparten varios agentes desde la misma IP: si Supabase
  // Auth limita los inicios de sesión, se espera y se reintenta.
  for (let intento = 1; ; intento++) {
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (!error) return c;
    if (!/rate limit/i.test(error.message) || intento >= 6) throw new Error("login " + email + ": " + error.message);
    console.log(`(límite de Supabase Auth; espero ${20 * intento} s)`);
    await new Promise((r) => setTimeout(r, 20000 * intento));
  }
}
async function usuariosConSufijo() {
  const { data } = await svc.auth.admin.listUsers({ perPage: 1000 });
  return (data?.users ?? []).filter((u) => (u.email ?? "").includes(sufijo));
}
async function clubsConPrefijo() {
  return (await svc.from("clubs").select("id, nombre").like("nombre", `${PREFIJO}%`)).data ?? [];
}
// Cuenta creada por el alta: se le quita la marca de contraseña temporal
// (como si ya la hubiera cambiado) y entra con la que dio el alta.
async function entrarComo(cred) {
  const { data } = await svc.auth.admin.listUsers({ perPage: 1000 });
  const u = data.users.find((x) => x.email === cred.correo);
  await svc.auth.admin.updateUserById(u.id, { app_metadata: { alta_club: true, debe_cambiar: false } });
  return { id: u.id, c: await clienteDe(cred.correo, cred.password) };
}

const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const lunesDe = (f) => {
  const d = new Date(f + "T12:00:00Z");
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3).toISOString().slice(0, 10);
};

const datos = (nombre) => ({ nombre, direccion: "Calle Ficticia 10, Centro", ciudad: "Querétaro", zona_horaria: "America/Mexico_City", horario: "Jue a Sáb 10pm a 3am" });
const politicas = { cover_modo: "oculto", cover_monto: null, deposito_monto: 0, edad_minima: 18, codigo_vestimenta: "", tipo_musica: "", ambiente: "", tolerancia_hora: null };
const mesas = (n) => Array.from({ length: n }, (_, i) => ({ numero: String(i + 1), capacidad: 6 }));

// Una reserva del RP que entra, se sienta, consume, paga y se cuadra (camino real).
async function noche(clubId, mesaId, ger, rp, centavos, concepto, antesDePagar = null) {
  const r = { id: randomUUID(), cliente_nombre: `Cliente ${PREFIJO}`, cliente_telefono: "0000000777", personas: 3, status: "usada", puerta_estado: "entro", entrada_en: new Date().toISOString(), source: "rp", rp_id: rp, club_id: clubId, fecha: hoyMx(), qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(r), "reserva");
  const sesionMesa = ok(await ger.rpc("caja_abrir_mesa", { p_mesa_id: mesaId }), "abrir mesa");
  const cta = ok(await ger.rpc("caja_sentar_cliente", { p_sesion_id: sesionMesa, p_reservation_id: r.id }), "sentar");
  ok(await ger.rpc("caja_registrar_consumo", { p_cuenta_id: cta, p_monto_centavos: centavos, p_concepto: concepto }), "consumo");
  if (antesDePagar) await antesDePagar(sesionMesa, centavos);
  ok(await ger.rpc("caja_registrar_pago", { p_sesion_id: sesionMesa, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: centavos }), "pago");
  ok(await ger.rpc("caja_cerrar_mesa", { p_sesion_id: sesionMesa }), "cerrar");
  ok(await ger.rpc("caja_cuadrar_mesa", { p_sesion_id: sesionMesa }), "cuadrar");
  const com = ok(await svc.from("commissions").select("monto, regla_id").eq("reservation_id", r.id).maybeSingle(), "comisión");
  return { centavos: com ? Math.round(Number(com.monto) * 100) : null, regla: com?.regla_id ?? null, reserva: r.id };
}

try {
  const sAdmin = await sesion("dev_admin@example.com", PASS_DEV);
  revisar(sAdmin.status === 200, "admin inicia sesión");
  const { data: adminU } = await svc.from("profiles").select("id, nombre").eq("role", "admin").eq("nombre", "Admin Dev").maybeSingle();
  const hoy = hoyMx();
  const lunes = lunesDe(hoy);

  // ---------- 1. Alta con regla de cuota, visibilidad y permisos ----------
  const nombre1 = `${PREFIJO} cuota`;
  const r1 = await alta(sAdmin.galletas, {
    datos: datos(nombre1),
    politicas,
    mesas: mesas(4),
    rp: { modo_pago: "reserva", regla: { tipo: "cuota", cuota: 1, porcentaje_bp: null, monto_centavos: 20000 }, visibilidad: "estado_monto_botellas", tarifas_dia: [] },
    caja_permisos: [
      { permiso: "cobrar", rol: "staff", permitido: false },
      { permiso: "anular", rol: "staff", permitido: true },
      { permiso: "cerrar_noche", rol: "gerente", permitido: false },
    ],
    dueno: null,
    personal: [
      { nombre: "Gerente T alta", correo: correo("gerente"), rol: "gerente" },
      { nombre: "Staff T alta", correo: correo("staff"), rol: "staff" },
      { nombre: "RP T alta", correo: correo("rp"), rol: "rp" },
    ],
    grupo: { modo: "ninguno" },
    publicar: false,
  });
  revisar(r1.status === 200 && r1.cuerpo.ok && !r1.cuerpo.aviso, "alta con reglas por la ruta: 200, sin aviso", JSON.stringify(r1.cuerpo.error ?? r1.cuerpo.aviso ?? ""));
  const c1 = r1.cuerpo.resultado?.club_id;
  revisar(r1.cuerpo.resultado?.rp?.regla === "cuota" && r1.cuerpo.resultado?.caja_permisos === 3, "la base confirma la regla y los 3 permisos");
  const { data: club1 } = await svc.from("clubs").select("pago_rp_modo, comision_tipo, comision_monto, comision_desbloqueo_reservas").eq("id", c1).maybeSingle();
  revisar(club1?.pago_rp_modo === "reserva", "pago por reserva");
  const { data: reglas1 } = await svc.from("reglas_comision").select("id, tipo, cuota, porcentaje_bp, monto_centavos, vigente_desde, vigente_hasta, creada_por").eq("club_id", c1);
  const regla1 = reglas1?.[0];
  revisar(reglas1?.length === 1 && regla1.tipo === "cuota" && regla1.cuota === 1 && Number(regla1.monto_centavos) === 20000 && regla1.porcentaje_bp === null, "una regla de cuota: la 1.ª no paga, desde la 2.ª $200");
  revisar(regla1?.vigente_desde === lunes && regla1.vigente_hasta === null, `vale desde el lunes de esta semana (${lunes}) y sin fin`, JSON.stringify(regla1));
  revisar(regla1?.creada_por === adminU?.id, "la regla dice que la creó el admin (auth.uid(), no el cuerpo)");
  const { data: cfg1 } = await svc.from("club_config_rp").select("nivel_visibilidad, actualizado_por").eq("club_id", c1).maybeSingle();
  revisar(cfg1?.nivel_visibilidad === "estado_monto_botellas" && cfg1.actualizado_por === adminU?.id, "qué ven los RPs: estado, monto y botellas");
  const { data: perm1 } = await svc.from("caja_permisos").select("permiso, rol, profile_id, permitido, actualizado_por").eq("club_id", c1);
  revisar(perm1?.length === 3 && perm1.every((p) => p.profile_id === null && p.actualizado_por === adminU?.id), "3 permisos de caja por rol (no por persona)");
  const { data: tar1 } = await svc.from("club_dia_tarifas").select("id").eq("club_id", c1);
  revisar((tar1 ?? []).length === 0, "sin tarifas por día (paga por reserva)");
  const { data: bit1 } = await svc.from("club_altas").select("resumen").eq("club_id", c1).maybeSingle();
  revisar(bit1?.resumen?.rp?.modo_pago === "reserva" && bit1.resumen.rp.regla === "cuota" && bit1.resumen.caja_permisos === 3, "la bitácora del alta registra las reglas");

  const creds1 = r1.cuerpo.credenciales ?? [];
  const ger = await entrarComo(creds1.find((c) => c.rol === "gerente"));
  const stf = await entrarComo(creds1.find((c) => c.rol === "staff"));
  const rp = await entrarComo(creds1.find((c) => c.rol === "rp"));

  const actual = (await ger.c.rpc("config_rp_actual", { p_club: c1 })).data;
  revisar(actual?.vigente?.origen === "regla" && actual.vigente.tipo === "cuota" && actual.vigente.cuota === 1 && actual.programada === null && actual.nivel_visibilidad === "estado_monto_botellas",
    "el gerente ve la regla nueva vigente desde ya (no la vieja ni programada)", JSON.stringify(actual));
  const hist = (await ger.c.rpc("config_rp_historial", { p_club: c1 })).data ?? [];
  revisar(hist.length === 2 && hist.every((h) => h.quien === adminU?.nombre) && hist.some((h) => h.que === "visibilidad" && h.antes === "estado_monto" && h.despues === "estado_monto_botellas"),
    "bitácora: 2 cambios hechos por el admin (regla y visibilidad)", JSON.stringify(hist));
  revisar(((await stf.c.from("reglas_comision").select("id")).data ?? []).length === 0 && !!(await stf.c.rpc("config_rp_actual", { p_club: c1 })).error, "el staff nuevo no ve la regla (como cualquier staff)");

  const pStaff = (await stf.c.rpc("caja_mis_permisos", { p_club_id: c1 })).data;
  revisar(pStaff?.cobrar === false && pStaff.anular === true && pStaff.abrir_mesa === true && pStaff.registrar_consumo === true && pStaff.cuadrar_mesa === false,
    "staff: sin cobrar, con anular; lo demás como la plataforma", JSON.stringify(pStaff));
  const pGer = (await ger.c.rpc("caja_mis_permisos", { p_club_id: c1 })).data;
  revisar(pGer?.cerrar_noche === false && pGer.cuadrar_mesa === true && pGer.cobrar === true, "gerente: sin cerrar la noche; lo demás sí", JSON.stringify(pGer));

  const { data: mesas1 } = await svc.from("club_tables").select("id").eq("club_id", c1).order("numero");
  let intentoStaff = null;
  const n1 = await noche(c1, mesas1[0].id, ger.c, rp.id, 50000, "Botella T alta", async (sesionMesa, centavos) => {
    intentoStaff = await stf.c.rpc("caja_registrar_pago", { p_sesion_id: sesionMesa, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: centavos });
  });
  revisar(!!intentoStaff?.error, "en una mesa abierta, la base no deja cobrar al staff de este antro", JSON.stringify(intentoStaff?.error?.message ?? intentoStaff?.data));
  revisar(n1.centavos === 0 && n1.regla === regla1?.id, "1.ª reserva de la semana: $0 con la regla del alta (cuota 1)", JSON.stringify(n1));
  const prog = (await rp.c.rpc("rp_progreso_cuota")).data;
  revisar(prog?.tiene_cuota === true && prog.cuota === 2 && prog.llevas === 1 && prog.siguiente_paga === true, "panel del RP: lleva 1, la siguiente paga", JSON.stringify(prog));
  const n2 = await noche(c1, mesas1[1].id, ger.c, rp.id, 30000, "Botella T alta");
  revisar(n2.centavos === 20000 && n2.regla === regla1?.id, "2.ª reserva: $200 con la regla del alta (las columnas viejas darían $0)", JSON.stringify(n2));
  const vista = (await rp.c.rpc("rp_mis_reservas", { p_desde: hoy, p_hasta: hoy })).data ?? [];
  const mia = vista.find((x) => x.reservation_id === n2.reserva);
  // Con sql/post-junta-2/41-rp-visibilidad.sql (carril b-cliente) los renglones
  // son solo productos del catálogo y el concepto libre va a otros_centavos;
  // sin ese SQL, el concepto sale como renglón. Cualquiera de los dos vale.
  const vioBotellas = mia?.renglones?.[0]?.concepto === "Botella T alta" || (mia?.renglones?.length === 0 && mia?.otros_centavos === 30000);
  revisar(mia?.nivel === "estado_monto_botellas" && vioBotellas, "el RP ve el detalle de su cliente con el nivel del alta (estado, monto y botellas)", JSON.stringify(mia ?? vista.length));
  revisar(club1 && club1.comision_tipo === "fijo" && Number(club1.comision_monto) === 0, "las columnas viejas quedan en su valor por defecto ($0) y ya no mandan");

  // ---------- 2. Alta con pago por día ----------
  const nombre2 = `${PREFIJO} por dia`;
  const r2 = await alta(sAdmin.galletas, {
    datos: datos(nombre2), politicas, mesas: mesas(2),
    rp: { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [30000, 30000, 50000] },
    dueno: null,
    personal: [
      { nombre: "Gerente Dos T alta", correo: correo("gerente2"), rol: "gerente" },
      { nombre: "RP Dos T alta", correo: correo("rp2"), rol: "rp" },
    ],
    grupo: { modo: "ninguno" }, publicar: false,
  });
  revisar(r2.status === 200 && r2.cuerpo.ok, "alta con pago por día por la ruta", JSON.stringify(r2.cuerpo.error ?? ""));
  const c2 = r2.cuerpo.resultado?.club_id;
  const { data: club2 } = await svc.from("clubs").select("pago_rp_modo").eq("id", c2).maybeSingle();
  const { data: tar2 } = await svc.from("club_dia_tarifas").select("posicion, monto").eq("club_id", c2).order("posicion");
  revisar(club2?.pago_rp_modo === "dia" && tar2?.map((t) => `${t.posicion}:${Number(t.monto)}`).join(",") === "1:300,2:300,3:500", "modo día con tarifas 1.º $300, 2.º $300, 3.º $500", JSON.stringify(tar2));
  revisar(((await svc.from("reglas_comision").select("id").eq("club_id", c2)).data ?? []).length === 0, "sin regla por reserva (no aplica en modo día)");
  const { data: cfg2 } = await svc.from("club_config_rp").select("nivel_visibilidad").eq("club_id", c2).maybeSingle();
  revisar(cfg2?.nivel_visibilidad === "estado", "qué ven los RPs: solo el estado");
  const creds2 = r2.cuerpo.credenciales ?? [];
  const ger2 = await entrarComo(creds2.find((c) => c.rol === "gerente"));
  const rp2 = creds2.find((c) => c.rol === "rp");
  const { data: rp2u } = await svc.from("profiles").select("id").eq("club_id", c2).eq("role", "rp").maybeSingle();
  const asis = ok(await svc.from("rp_attendance").insert({ rp_id: rp2u.id, club_id: c2, fecha: hoy, metodo: "manual", marcado_por: ger2.id }).select("id").single(), "asistencia");
  const pd = await ger2.c.rpc("registrar_pago_dia", { p_rp_attendance_id: asis.id, p_rp_id: rp2u.id, p_club_id: c2, p_fecha: hoy, p_week_start: new Date().toISOString(), p_week_end: new Date().toISOString() });
  const { data: pago2 } = await svc.from("rp_pagos_dia").select("posicion, monto").eq("rp_attendance_id", asis.id).maybeSingle();
  revisar(!pd.error && pago2?.posicion === 1 && Number(pago2.monto) === 300, "la asistencia del RP genera $300 (tarifa del día 1 del alta)", JSON.stringify(pd.error ?? pago2));
  revisar(!!rp2, "el RP del antro por día tiene su contraseña temporal");

  // ---------- 3. La ruta rechaza reglas inválidas sin crear cuentas ----------
  const antes = (await usuariosConSufijo()).length;
  const conPersonal = (extra) => ({ datos: datos(`${PREFIJO} ruta mala`), politicas, mesas: [], dueno: null, personal: [{ nombre: "RP Malo", correo: correo("malo"), rol: "rp" }], grupo: { modo: "ninguno" }, publicar: false, ...extra });
  const sinRp = await alta(sAdmin.galletas, conPersonal({}));
  revisar(sinRp.status === 400 && !!sinRp.cuerpo.campos?.rp, "sin reglas de RPs → 400 (el antro no nace con las columnas viejas)");
  const sinRegla = await alta(sAdmin.galletas, conPersonal({ rp: { modo_pago: "reserva", regla: null, visibilidad: "estado", tarifas_dia: [] } }));
  revisar(sinRegla.status === 400 && sinRegla.cuerpo.campos?.["rp.regla"], "pago por reserva sin regla → 400 con el campo marcado");
  const porcMalo = await alta(sAdmin.galletas, conPersonal({ rp: { modo_pago: "reserva", regla: { tipo: "porcentaje", cuota: 0, porcentaje_bp: 0, monto_centavos: null }, visibilidad: "estado", tarifas_dia: [] } }));
  revisar(porcMalo.status === 400 && porcMalo.cuerpo.campos?.["rp.regla.porcentaje_bp"], "porcentaje 0 → 400");
  const permMalo = await alta(sAdmin.galletas, conPersonal({ rp: { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [100] }, caja_permisos: [{ permiso: "cobrar", rol: "rp", permitido: true }] }));
  revisar(permMalo.status === 400, "permiso de caja para RP → 400");
  revisar((await usuariosConSufijo()).length === antes && (await clubsConPrefijo()).every((c) => !c.nombre.endsWith("ruta mala")), "…y ninguna de esas creó cuentas ni antro");

  // ---------- 4. La base, llamada directo ----------
  const ca = await clienteDe("dev_admin@example.com", PASS_DEV);
  let n = 0;
  const pDirecto = (rpExtra, extra = {}) => ({
    alta_id: randomUUID(),
    club: { nombre: `${PREFIJO} rpc ${++n}`, direccion: "Calle 1", ciudad: "Querétaro", horario: "Vie 10pm" },
    rp: rpExtra,
    ...extra,
  });
  const reglaOk = { tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 15000 };
  const rpOk = { modo_pago: "reserva", regla: reglaOk, visibilidad: "estado_monto", tarifas_dia: [] };
  const malos = [
    ["reserva sin regla", { ...rpOk, regla: null }, /hace falta la regla/],
    ["porcentaje 0", { ...rpOk, regla: { tipo: "porcentaje", cuota: 0, porcentaje_bp: 0, monto_centavos: null } }, /porcentaje va/],
    ["porcentaje 100.01 %", { ...rpOk, regla: { tipo: "porcentaje", cuota: 0, porcentaje_bp: 10001, monto_centavos: null } }, /porcentaje va/],
    ["porcentaje con decimales (12.5 bp)", { ...rpOk, regla: { tipo: "porcentaje", cuota: 0, porcentaje_bp: 12.5, monto_centavos: null } }, /porcentaje va/],
    ["porcentaje sin valor", { ...rpOk, regla: { tipo: "porcentaje" } }, /porcentaje va/],
    ["monto $0", { ...rpOk, regla: { ...reglaOk, monto_centavos: 0 } }, /monto va/],
    ["monto negativo", { ...rpOk, regla: { ...reglaOk, monto_centavos: -100 } }, /monto va/],
    ["monto arriba de $100,000", { ...rpOk, regla: { ...reglaOk, monto_centavos: 10000001 } }, /monto va/],
    ["monto como texto raro", { ...rpOk, regla: { ...reglaOk, monto_centavos: "1e5" } }, /monto va/],
    ["cuota 0", { ...rpOk, regla: { tipo: "cuota", cuota: 0, porcentaje_bp: null, monto_centavos: 20000 } }, /cuota va/],
    ["cuota 101", { ...rpOk, regla: { tipo: "cuota", cuota: 101, porcentaje_bp: null, monto_centavos: 20000 } }, /cuota va/],
    ["cuota «abc»", { ...rpOk, regla: { tipo: "cuota", cuota: "abc", porcentaje_bp: null, monto_centavos: 20000 } }, /cuota va/],
    ["tipo de regla desconocido", { ...rpOk, regla: { ...reglaOk, tipo: "regalo" } }, /Tipo de regla/],
    ["regla que no es objeto", { ...rpOk, regla: "fijo" }, /regla de comisión no es válida/],
    ["modo de pago desconocido", { ...rpOk, modo_pago: "semana" }, /cómo se paga/],
    ["sin modo de pago", { regla: reglaOk, visibilidad: "estado" }, /cómo se paga/],
    ["visibilidad desconocida", { ...rpOk, visibilidad: "todo" }, /qué ven los RPs/],
    ["rp que no es objeto", "reserva", /reglas de RPs no son válidas/],
    ["por día sin tarifas", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [] }, /tarifa del día 1/],
    ["tarifa del día 8", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [{ posicion: 8, monto_centavos: 100 }] }, /del día 1 al 7/],
    ["tarifa del día 0", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [{ posicion: 0, monto_centavos: 100 }] }, /del día 1 al 7/],
    ["tarifa negativa", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [{ posicion: 1, monto_centavos: -1 }] }, /del día 1 al 7/],
    ["tarifa sin monto", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [{ posicion: 1 }] }, /del día 1 al 7/],
    ["día repetido", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [{ posicion: 1, monto_centavos: 1 }, { posicion: 1, monto_centavos: 2 }] }, /repetido/],
    ["8 tarifas", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: Array.from({ length: 8 }, (_, i) => ({ posicion: (i % 7) + 1, monto_centavos: 1 })) }, /máximo 7/],
    ["tarifas que no son lista", { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: { posicion: 1 } }, /máximo 7/],
  ];
  for (const [texto, rpMalo, patron] of malos) {
    const r = await ca.rpc("admin_alta_club", { p: pDirecto(rpMalo) });
    revisar(!!r.error && r.error.code === "P0001" && patron.test(r.error.message), `la base rechaza: ${texto}`, r.error ? `${r.error.code} ${r.error.message}` : "sin error");
  }
  const permisosMalos = [
    ["permiso desconocido", [{ permiso: "borrar_todo", rol: "staff", permitido: true }], /Permiso de caja inválido/],
    ["permiso para RP", [{ permiso: "cobrar", rol: "rp", permitido: true }], /Permiso de caja inválido/],
    ["permiso para dueño", [{ permiso: "cobrar", rol: "dueno", permitido: false }], /Permiso de caja inválido/],
    ["permiso sin rol (por persona)", [{ permiso: "cobrar", profile_id: randomUUID(), permitido: true }], /Permiso de caja inválido/],
    ["«permitido» como texto", [{ permiso: "cobrar", rol: "staff", permitido: "true" }], /Permiso de caja inválido/],
    ["«permitido» nulo", [{ permiso: "cobrar", rol: "staff", permitido: null }], /Permiso de caja inválido/],
    ["permiso repetido", [{ permiso: "cobrar", rol: "staff", permitido: false }, { permiso: "cobrar", rol: "staff", permitido: true }], /repetido/],
    ["19 permisos", Array.from({ length: 19 }, () => ({ permiso: "cobrar", rol: "staff", permitido: true })), /no son válidos/],
    ["permisos que no son lista", { permiso: "cobrar" }, /no son válidos/],
  ];
  for (const [texto, lista, patron] of permisosMalos) {
    const r = await ca.rpc("admin_alta_club", { p: pDirecto(rpOk, { caja_permisos: lista }) });
    revisar(!!r.error && r.error.code === "P0001" && patron.test(r.error.message), `la base rechaza: ${texto}`, r.error ? `${r.error.code} ${r.error.message}` : "sin error");
  }
  const rpcMalos = (await clubsConPrefijo()).filter((c) => c.nombre.includes(" rpc "));
  revisar(rpcMalos.length === 0, `ninguno de los ${malos.length + permisosMalos.length} rechazos dejó antro`);

  // Válido directo y compatibilidad.
  const pBueno = pDirecto(rpOk, { caja_permisos: [{ permiso: "reabrir_mesa", rol: "staff", permitido: true }] });
  const bueno = await ca.rpc("admin_alta_club", { p: pBueno });
  revisar(!bueno.error && bueno.data?.rp?.regla === "fijo" && bueno.data.caja_permisos === 1, "directo y válido: guarda regla fija y 1 permiso", JSON.stringify(bueno.error ?? bueno.data));
  const repetido = await ca.rpc("admin_alta_club", { p: pBueno });
  const reglasBueno = (await svc.from("reglas_comision").select("id").eq("club_id", bueno.data?.club_id)).data ?? [];
  revisar(/ya se hizo/.test(repetido.error?.message ?? "") && reglasBueno.length === 1, "la misma clave dos veces: un solo antro y una sola regla");
  const viejo = await ca.rpc("admin_alta_club", { p: { alta_id: randomUUID(), club: { nombre: `${PREFIJO} sin reglas`, direccion: "Calle 1", ciudad: "Querétaro", horario: "Vie 10pm" } } });
  const idViejo = viejo.data?.club_id;
  const reglasViejo = (await svc.from("reglas_comision").select("id").eq("club_id", idViejo)).data ?? [];
  const cfgViejo = (await svc.from("club_config_rp").select("club_id").eq("club_id", idViejo)).data ?? [];
  revisar(!viejo.error && "rp" in (viejo.data ?? {}) && viejo.data.rp === null && reglasViejo.length === 0 && cfgViejo.length === 0,
    "sin p.rp (código anterior) hace lo de antes: antro sin reglas nuevas", JSON.stringify(viejo.error ?? viejo.data));

  // Nadie fuera del admin.
  const pAjeno = () => pDirecto(rpOk, { caja_permisos: [{ permiso: "cobrar", rol: "staff", permitido: false }] });
  for (const rol of ["gerente", "dueno"]) {
    const c = await clienteDe(`dev_${rol}@example.com`, PASS_DEV);
    const r = await c.rpc("admin_alta_club", { p: pAjeno() });
    revisar(!!r.error && /Solo el admin/.test(r.error.message), `${rol} no da de alta antros con reglas`);
  }
  const passSin = "Prueba-" + randomUUID();
  ok(await svc.auth.admin.createUser({ email: correo("sinperfil"), password: passSin, email_confirm: true }), "cuenta sin perfil");
  const cSin = await clienteDe(correo("sinperfil"), passSin);
  const rSin = await cSin.rpc("admin_alta_club", { p: pAjeno() });
  revisar(!!rSin.error && /Solo el admin/.test(rSin.error.message), "una cuenta de Auth sin perfil no da de alta antros");
  const rAnon = await anon.rpc("admin_alta_club", { p: pAjeno() });
  revisar(!!rAnon.error, "el anónimo no puede ejecutar admin_alta_club");
  revisar((await clubsConPrefijo()).filter((c) => c.nombre.includes(" rpc ")).length === 1, "solo quedó el antro del alta directa válida");
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  // ---------- Limpieza (solo dev) ----------
  const clubIds = (await clubsConPrefijo()).map((c) => c.id);
  const usuarios = await usuariosConSufijo();
  const ids = usuarios.map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos", "rp_pagos_dia"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const t of ["rp_attendance", "config_rp_cambios", "reglas_comision", "club_config_rp", "club_dia_tarifas", "reservations", "club_tables"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) {
      await db.q("delete from public.club_altas where club_id = any($1::uuid[])", [clubIds]);
      await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    }
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza falló: " + e.message);
  } finally {
    await db.fin();
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedan = (await usuariosConSufijo()).length + (await clubsConPrefijo()).length;
  console.log(quedan === 0 ? `\nLimpieza: ${clubIds.length} antros y ${ids.length} cuentas de prueba borrados; no quedó nada.` : `\nLimpieza: QUEDARON ${quedan} registros de la prueba.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan || quedan) process.exitCode = 1;
}
