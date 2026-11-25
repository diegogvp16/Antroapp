// Pruebas de «Clonar antro» (B2): sql/post-junta-2/11-clonar-club.sql
// (admin_club_plantilla y admin_alta_club con p.clonar_de),
// lib/domain/alta-club.ts (precargaDesdePlantilla) y POST /api/admin/alta-club,
// contra el servidor local de dev y antroapp-dev.
//
//   PUERTO=3021 node scripts/dev/servidor-dev.mjs        # en otra terminal
//   node scripts/dev/probar-clonar-club.mjs [--base=http://localhost:3021]
//
// Revisa:
//   0. (sin base) La plantilla se convierte bien en el asistente precargado
//      y avisa de lo que no se copia igual.
//   1. Arma un ORIGEN con todo lo que NO se debe copiar: reservas, una noche
//      de caja completa (sesión, cuenta, consumo, pago, cuadre, comisión),
//      turno, asistencia, pago por día, overrides por RP, permiso por persona,
//      foto, documento de verificación, dueño, grupo, regla programada,
//      productos con existencias e historial.
//   2. La plantilla trae SOLO configuración (sin nombre, dirección, dueño,
//      ubicación, teléfonos ni personas).
//   3. Clona por la ruta (como el asistente) y revisa que se copió la
//      configuración, que NO se copió nada de lo demás (0 filas) y que el
//      origen quedó idéntico (huella md5 por tabla antes y después).
//   4. La regla clonada manda en la caja del antro nuevo (camino real).
//   5. Clon de un antro que paga por día: las tarifas pasan.
//   6. Origen inexistente o mal escrito, idempotencia, y nadie fuera del
//      admin (gerente, dueño, dueño del origen, cuenta sin perfil, anónimo)
//      lee la plantilla ni clona.
// Datos propios con prefijo t_alta_ / «T alta»; al final se borra todo
// (aunque falle). Club Demo Dev solo se LEE (su plantilla).

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";
import {
  esquemaAltaClub,
  esquemaPlantilla,
  precargaDesdePlantilla,
  cambiosDePermisos,
  payloadSql,
  centavosATexto,
  bpATexto,
} from "../../lib/domain/alta-club.ts";
import { porcentajeABp } from "../../lib/domain/config-rp.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const BASE = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3021").replace(/\/$/, "");
const { password: PASS_DEV } = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB_DEMO_DEV = "0de70000-0000-4000-8000-000000000001";

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
const gruposCreados = new Set();

// ---------- 0. Sin base: plantilla → asistente ----------
function pruebasDeDominio() {
  const ORIGEN = randomUUID();
  const GRUPO = randomUUID();
  const plantilla = {
    origen: { id: ORIGEN, nombre: "Origen" },
    club: {
      ciudad: "Monterrey", zona_horaria: "America/Monterrey", horario: "Vie y Sáb 10pm a 4am", ambiente: "Electrónica",
      tipo_musica: "House", codigo_vestimenta: "Casual elegante", edad_minima: 21, deposito_monto: 150.5, cover_modo: "monto",
      cover_monto: 200, tolerancia_hora: "23:30",
    },
    mesas: [{ numero: "1", capacidad: 6 }, { numero: "VIP 1", capacidad: 12 }, { numero: "vip 1", capacidad: 4 }],
    modo_pago: "reserva",
    regla: { origen: "regla", tipo: "cuota", cuota: 2, porcentaje_bp: null, monto_centavos: 25000, id: randomUUID(), vigente_desde: "2026-11-23" },
    regla_programada_desde: "2026-11-30",
    visibilidad: "estado_monto_botellas",
    tarifas_dia: [{ posicion: 2, monto_centavos: 45050 }, { posicion: 1, monto_centavos: 30000 }],
    caja_permisos: [{ permiso: "cobrar", rol: "staff", permitido: false }, { permiso: "anular", rol: "staff", permitido: true }, { permiso: "cobrar", rol: "rp", permitido: true }],
    permisos_por_persona: 2,
    productos: [{ nombre: "Botella", categoria: "Licor", precio_centavos: 250000, existencias_minimas: 2, activo: true }, { nombre: "Vieja", categoria: "Licor", precio_centavos: 100, existencias_minimas: 0, activo: false }],
    grupo_id: GRUPO,
  };
  const leida = esquemaPlantilla.safeParse(plantilla);
  revisar(leida.success, "dominio: la plantilla completa se lee con zod");
  const pre = precargaDesdePlantilla(leida.data);
  revisar(pre.datos.ciudad === "Monterrey" && pre.datos.zona_horaria === "America/Monterrey" && pre.datos.horario === "Vie y Sáb 10pm a 4am", "dominio: ciudad, zona y horario precargados");
  revisar(!("nombre" in pre.datos) && !("direccion" in pre.datos), "dominio: la precarga no trae nombre ni dirección");
  const p = pre.politicas;
  revisar(p.cover_modo === "monto" && p.cover_texto === "200" && p.deposito_texto === "150.50" && p.edad_texto === "21" && p.tolerancia_hora === "23:30" && p.ambiente === "Electrónica",
    "dominio: cover $200, depósito 150.50, edad 21, tolerancia y textos", JSON.stringify(p));
  revisar(pre.mesas.length === 2 && pre.mesas[1].numero === "VIP 1" && pre.mesas[1].capacidad === 12, "dominio: mesas sin repetir (VIP 1 / vip 1 → una)");
  revisar(pre.rp.modo_pago === "reserva" && pre.rp.tipo === "cuota" && pre.rp.cuota_texto === "2" && pre.rp.monto_texto === "250" && pre.rp.visibilidad === "estado_monto_botellas",
    "dominio: regla de cuota 2 / $250 y visibilidad precargadas", JSON.stringify(pre.rp));
  revisar(pre.rp.tarifas.join(",") === "300,450.50", "dominio: tarifas ordenadas por día (300, 450.50)");
  const cambios = cambiosDePermisos(pre.permisos.matriz);
  revisar(pre.permisos.personalizar && cambios.length === 2 && cambios.some((c) => c.permiso === "cobrar" && c.rol === "staff" && !c.permitido), "dominio: 2 permisos por rol (el de RP se ignora)", JSON.stringify(cambios));
  revisar(pre.grupo_id === GRUPO && pre.productos?.total === 2 && pre.productos.activos === 1, "dominio: grupo y conteo del catálogo");
  revisar(pre.avisos.some((a) => /programada desde el 2026-11-30/.test(a)), "dominio: avisa de la regla programada que no se copia");
  revisar(pre.avisos.some((a) => /2 permisos de caja por persona no se copian/.test(a)), "dominio: avisa de los permisos por persona");
  revisar(pre.avisos.some((a) => /tarifas por día quedan precargadas/.test(a)), "dominio: avisa que las tarifas solo cuentan en modo día");
  revisar(!pre.avisos.some((a) => /regla anterior/.test(a)), "dominio: con regla nueva no avisa de la anterior");

  const vieja = precargaDesdePlantilla(esquemaPlantilla.parse({
    ...plantilla, regla: { origen: "anterior", tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 0, modo_pago: "reserva" },
    regla_programada_desde: null, tarifas_dia: [], caja_permisos: [], permisos_por_persona: 0, productos: null, grupo_id: null,
    club: { ...plantilla.club, zona_horaria: "Europe/Madrid", cover_modo: "raro", tolerancia_hora: null, edad_minima: null, deposito_monto: 0 },
  }));
  revisar(vieja.avisos.some((a) => /regla anterior/.test(a)) && vieja.avisos.some((a) => /no está completa/.test(a)) && vieja.rp.monto_texto === "",
    "dominio: regla anterior en $0 → monto vacío y dos avisos", JSON.stringify(vieja.avisos));
  revisar(vieja.datos.zona_horaria === "America/Mexico_City" && vieja.avisos.some((a) => /zona horaria/.test(a)), "dominio: zona fuera de la lista → Centro, con aviso");
  revisar(vieja.politicas.cover_modo === "oculto" && vieja.politicas.tolerancia_hora === "" && vieja.politicas.edad_texto === "" && vieja.politicas.deposito_texto === "",
    "dominio: cover desconocido → oculto; sin tolerancia, edad ni depósito");
  revisar(!vieja.permisos.personalizar && vieja.productos === null && vieja.grupo_id === null && vieja.rp.tarifas.length === 1 && vieja.rp.tarifas[0] === "",
    "dominio: sin permisos, sin catálogo (fase 2 apagada), sin grupo y una tarifa vacía");
  const porc = precargaDesdePlantilla(esquemaPlantilla.parse({ ...plantilla, regla: { origen: "regla", tipo: "porcentaje", cuota: 0, porcentaje_bp: 1250, monto_centavos: null } }));
  revisar(porc.rp.tipo === "porcentaje" && porc.rp.porcentaje_texto === "12.5" && porcentajeABp(porc.rp.porcentaje_texto) === 1250, "dominio: porcentaje 1250 bp → «12.5» → 1250");
  const dia = precargaDesdePlantilla(esquemaPlantilla.parse({ ...plantilla, modo_pago: "dia" }));
  revisar(dia.rp.modo_pago === "dia" && dia.avisos.some((a) => /paga por día: su regla por reserva no se guarda/.test(a)) && !dia.avisos.some((a) => /quedan precargadas/.test(a)),
    "dominio: origen por día con regla → aviso de que la regla no se guarda");
  const muchas = precargaDesdePlantilla(esquemaPlantilla.parse({ ...plantilla, mesas: Array.from({ length: 305 }, (_, i) => ({ numero: `M${i}`, capacidad: 4 })) }));
  revisar(muchas.mesas.length === 300 && muchas.avisos.some((a) => /305 mesas/.test(a)), "dominio: más de 300 mesas → las primeras 300, con aviso");
  revisar(!esquemaPlantilla.safeParse({ club: {} }).success && !esquemaPlantilla.safeParse(null).success, "dominio: una plantilla sin origen no se acepta (la pantalla muestra error)");
  revisar(centavosATexto(15050) === "150.50" && centavosATexto(20000) === "200" && bpATexto(1000) === "10", "dominio: centavos y puntos base a texto");

  // clonar_de en el esquema del alta y en el payload.
  const baseAlta = {
    datos: { nombre: "Clon", direccion: "Calle 2", ciudad: "Monterrey", zona_horaria: "America/Monterrey", horario: "Vie 10pm" },
    politicas: { cover_modo: "oculto", cover_monto: null, deposito_monto: 0, edad_minima: 18, codigo_vestimenta: "", tipo_musica: "", ambiente: "", tolerancia_hora: null },
    mesas: [], rp: { modo_pago: "reserva", regla: { tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 100 }, visibilidad: "estado", tarifas_dia: [] },
    dueno: null, personal: [], grupo: { modo: "ninguno" }, publicar: false,
  };
  const sin = esquemaAltaClub.parse(baseAlta);
  revisar(sin.clonar_de === null && !("clonar_de" in payloadSql(sin, new Map(), randomUUID())), "dominio: sin clonar_de el payload es el de siempre");
  const con = esquemaAltaClub.parse({ ...baseAlta, clonar_de: ORIGEN });
  revisar(payloadSql(con, new Map(), randomUUID()).clonar_de === ORIGEN, "dominio: con clonar_de el payload lo lleva");
  revisar(!esquemaAltaClub.safeParse({ ...baseAlta, clonar_de: "abc" }).success, "dominio: clonar_de que no es uuid se rechaza");
}

// ---------- Ayudas con servidor y base ----------
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
const masDias = (f, n) => new Date(new Date(f + "T12:00:00Z").getTime() + n * 86400e3).toISOString().slice(0, 10);

async function noche(clubId, mesaId, ger, rp, centavos, concepto) {
  const r = { id: randomUUID(), cliente_nombre: `Cliente ${PREFIJO}`, cliente_telefono: "0000000777", personas: 3, status: "usada", puerta_estado: "entro", entrada_en: new Date().toISOString(), source: "rp", rp_id: rp, club_id: clubId, fecha: hoyMx(), qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(r), "reserva");
  const sesionMesa = ok(await ger.rpc("caja_abrir_mesa", { p_mesa_id: mesaId }), "abrir mesa");
  const cta = ok(await ger.rpc("caja_sentar_cliente", { p_sesion_id: sesionMesa, p_reservation_id: r.id }), "sentar");
  ok(await ger.rpc("caja_registrar_consumo", { p_cuenta_id: cta, p_monto_centavos: centavos, p_concepto: concepto }), "consumo");
  ok(await ger.rpc("caja_registrar_pago", { p_sesion_id: sesionMesa, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: centavos }), "pago");
  ok(await ger.rpc("caja_cerrar_mesa", { p_sesion_id: sesionMesa }), "cerrar");
  ok(await ger.rpc("caja_cuadrar_mesa", { p_sesion_id: sesionMesa }), "cuadrar");
  const com = ok(await svc.from("commissions").select("monto, regla_id").eq("reservation_id", r.id).maybeSingle(), "comisión");
  return { centavos: com ? Math.round(Number(com.monto) * 100) : null, regla: com?.regla_id ?? null, reserva: r.id };
}

// Huella de todo lo de un antro: filas y md5 por tabla (para «el origen no
// cambió» y para «el clon tiene 0 filas de esto»).
const TABLAS_POR_CLUB = [
  "club_tables", "reglas_comision", "club_config_rp", "club_dia_tarifas", "caja_permisos", "config_rp_cambios", "club_altas",
  "reservations", "caja_noches", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "caja_eventos",
  "rp_schedule", "rp_attendance", "rp_pagos_dia", "rp_comision_overrides", "rp_dia_tarifa_overrides", "club_photos",
  "verificacion_documentos", "grupo_clubs", "productos", "producto_movimientos",
];
async function huella(db, clubId) {
  const salida = {};
  const club = await db.q("select md5(c::text) h from public.clubs c where id = $1", [clubId]);
  salida.clubs = { n: club.length, h: club[0]?.h ?? "" };
  for (const t of TABLAS_POR_CLUB) {
    const existe = (await db.q("select to_regclass($1) is not null as e", [`public.${t}`]))[0].e;
    if (!existe) continue;
    const r = await db.q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.${t} x where club_id = $1`, [clubId]);
    salida[t] = r[0];
  }
  for (const [t, col] of [["commissions", "reservation_id"], ["consumption_entries", "reservation_id"]]) {
    const r = await db.q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.${t} x where ${col} in (select id from public.reservations where club_id = $1)`, [clubId]);
    salida[t] = r[0];
  }
  const per = await db.q("select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.profiles x where club_id = $1", [clubId]);
  salida.profiles = per[0];
  return salida;
}

// Cuerpo de la ruta a partir de la precarga, igual que aEntrada del asistente
// (components/admin/alta/estado.ts) con lo que el admin escribe a mano.
const pesos = (t) => (t.trim() ? Math.round(Number(t) * 100) : null);
function cuerpoDeClon(pre, { nombre, direccion, personal = [], dueno = null }) {
  const p = pre.politicas;
  const rp = pre.rp;
  return {
    datos: { nombre, direccion, ciudad: pre.datos.ciudad, zona_horaria: pre.datos.zona_horaria, horario: pre.datos.horario },
    politicas: {
      cover_modo: p.cover_modo,
      cover_monto: p.cover_modo === "monto" ? pesos(p.cover_texto) / 100 : null,
      deposito_monto: p.deposito_texto ? pesos(p.deposito_texto) / 100 : 0,
      edad_minima: p.edad_texto ? Number(p.edad_texto) : null,
      codigo_vestimenta: p.codigo_vestimenta, tipo_musica: p.tipo_musica, ambiente: p.ambiente,
      tolerancia_hora: p.tolerancia_hora || null,
    },
    mesas: pre.mesas,
    rp: {
      modo_pago: rp.modo_pago,
      regla: rp.modo_pago === "reserva"
        ? { tipo: rp.tipo, cuota: rp.tipo === "cuota" ? Number(rp.cuota_texto) : 0, porcentaje_bp: rp.tipo === "porcentaje" ? porcentajeABp(rp.porcentaje_texto) : null, monto_centavos: rp.tipo === "porcentaje" ? null : pesos(rp.monto_texto) }
        : null,
      visibilidad: rp.visibilidad,
      tarifas_dia: rp.modo_pago === "dia" ? rp.tarifas.map(pesos) : [],
    },
    caja_permisos: pre.permisos.personalizar ? cambiosDePermisos(pre.permisos.matriz) : [],
    dueno,
    personal,
    grupo: pre.grupo_id ? { modo: "existente", grupo_id: pre.grupo_id, dueno_grupo: "ninguno", cuenta: null } : { modo: "ninguno" },
    publicar: false,
    clonar_de: pre.origen.id,
  };
}

pruebasDeDominio();

let db = null;
try {
  db = await conectarDevEscritura();
  const sAdmin = await sesion("dev_admin@example.com", PASS_DEV);
  revisar(sAdmin.status === 200, "admin inicia sesión");
  const ca = await clienteDe("dev_admin@example.com", PASS_DEV);
  const { data: adminU } = await svc.from("profiles").select("id").eq("role", "admin").eq("nombre", "Admin Dev").maybeSingle();
  const hoy = hoyMx();
  const lunes = lunesDe(hoy);

  // ---------- 1. Origen con todo ----------
  const rO = await alta(sAdmin.galletas, {
    datos: { nombre: `${PREFIJO} origen`, direccion: "Av. Origen 100, Centro", ciudad: "Monterrey", zona_horaria: "America/Monterrey", horario: "Jue a Sáb 10pm a 4am" },
    politicas: { cover_modo: "monto", cover_monto: 200, deposito_monto: 150.5, edad_minima: 21, codigo_vestimenta: "Casual elegante", tipo_musica: "House", ambiente: "Electrónica, luces bajas", tolerancia_hora: "23:30" },
    mesas: [...Array.from({ length: 4 }, (_, i) => ({ numero: String(i + 1), capacidad: 6 })), { numero: "VIP 1", capacidad: 12 }],
    rp: { modo_pago: "reserva", regla: { tipo: "cuota", cuota: 2, porcentaje_bp: null, monto_centavos: 25000 }, visibilidad: "estado_monto_botellas", tarifas_dia: [] },
    caja_permisos: [{ permiso: "cobrar", rol: "staff", permitido: false }, { permiso: "anular", rol: "staff", permitido: true }],
    dueno: { nombre: "Dueña Origen T alta", correo: correo("duena") },
    personal: [
      { nombre: "Gerente Origen T alta", correo: correo("gerente"), rol: "gerente" },
      { nombre: "Staff Origen T alta", correo: correo("staff"), rol: "staff" },
      { nombre: "RP Origen T alta", correo: correo("rp"), rol: "rp" },
    ],
    grupo: { modo: "nuevo", nombre: `${PREFIJO} grupo`, dueno_grupo: "dueno_antro", cuenta: null },
    publicar: false,
  });
  revisar(rO.status === 200 && rO.cuerpo.ok, "origen dado de alta por la ruta", JSON.stringify(rO.cuerpo.error ?? ""));
  const origen = rO.cuerpo.resultado.club_id;
  const grupo = rO.cuerpo.resultado.grupo_id;
  gruposCreados.add(grupo);
  const credsO = rO.cuerpo.credenciales ?? [];
  const gerO = await entrarComo(credsO.find((c) => c.rol === "gerente"));
  const stfO = await entrarComo(credsO.find((c) => c.rol === "staff"));
  const rpO = await entrarComo(credsO.find((c) => c.rol === "rp"));
  const duenaO = await entrarComo(credsO.find((c) => c.rol === "dueno"));

  // Una noche de caja completa (reserva, sesión, cuenta, consumo, pago, cuadre, comisión).
  const { data: mesasO } = await svc.from("club_tables").select("id").eq("club_id", origen).order("numero");
  await noche(origen, mesasO[0].id, gerO.c, rpO.id, 80000, "Botella origen");
  // Regla programada a futuro (la del lunes siguiente), por la función real.
  ok(await gerO.c.rpc("config_rp_cambiar_regla", { p_club: origen, p_tipo: "fijo", p_cuota: 0, p_porcentaje_bp: null, p_monto_centavos: 30000 }), "regla programada");
  // Lo demás que nunca se copia, directo en dev.
  const asisO = ok(await svc.from("rp_attendance").insert({ rp_id: rpO.id, club_id: origen, fecha: hoy, metodo: "manual", marcado_por: gerO.id }).select("id").single(), "asistencia");
  await db.q("insert into public.rp_pagos_dia (rp_attendance_id, rp_id, club_id, fecha, posicion, monto) values ($1, $2, $3, $4, 1, 300)", [asisO.id, rpO.id, origen, hoy]);
  await db.q("insert into public.rp_schedule (rp_id, club_id, fecha, es_fijo, dias_semana, fecha_inicio) values ($1, $2, $3, true, '{3,4,5,6}', $3)", [rpO.id, origen, hoy]);
  await db.q("insert into public.rp_comision_overrides (club_id, rp_id, comision_tipo, comision_monto, comision_desbloqueo_reservas) values ($1, $2, 'fijo', 500, 0)", [origen, rpO.id]);
  await db.q("insert into public.rp_dia_tarifa_overrides (club_id, rp_id, posicion, monto) values ($1, $2, 1, 999)", [origen, rpO.id]);
  await db.q("insert into public.club_dia_tarifas (club_id, posicion, monto) values ($1, 1, 300), ($1, 2, 450)", [origen]);
  await db.q("insert into public.caja_permisos (club_id, permiso, profile_id, permitido, actualizado_por) values ($1, 'cobrar', $2, true, $3)", [origen, stfO.id, adminU.id]);
  await db.q("insert into public.club_photos (club_id, url, storage_path, orden) values ($1, 'https://example.com/t_alta.jpg', $2, 0)", [origen, `${origen}/t_alta-foto.jpg`]);
  await db.q("insert into public.verificacion_documentos (club_id, tipo, storage_path) values ($1, 'foto_local', $2)", [origen, `${origen}/foto_local-t_alta.jpg`]);
  await db.q("update public.clubs set lat = 25.6866, lng = -100.3161 where id = $1", [origen]);
  const hayProductos = (await db.q("select to_regclass('public.productos') is not null as e"))[0].e;
  if (hayProductos) {
    const prods = await db.q(
      `insert into public.productos (club_id, nombre, categoria, precio_centavos, existencias, existencias_minimas, activo, creado_por)
       values ($1, 'Botella T alta', 'Licor', 250000, 25, 3, true, $2), ($1, 'Cerveza T alta', 'Cerveza', 6000, 120, 24, true, $2),
              ($1, 'Descontinuado T alta', 'Licor', 100, 0, 0, false, $2) returning id, existencias`, [origen, adminU.id]);
    for (const pr of prods.filter((x) => x.existencias > 0))
      await db.q("insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, motivo, hecho_por) values ($1, $2, 'alta', $3, 'Existencias iniciales', $4)", [origen, pr.id, pr.existencias, adminU.id]);
  }
  const antesOrigen = await huella(db, origen);
  const conDatos = ["reservations", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "commissions", "rp_schedule", "rp_attendance", "rp_pagos_dia", "rp_comision_overrides", "rp_dia_tarifa_overrides", "club_photos", "verificacion_documentos", "profiles"];
  revisar(conDatos.every((t) => antesOrigen[t]?.n > 0), "el origen tiene datos en todo lo que no se debe copiar", JSON.stringify(Object.fromEntries(conDatos.map((t) => [t, antesOrigen[t]?.n]))));
  revisar(!hayProductos || (antesOrigen.productos.n === 3 && antesOrigen.producto_movimientos.n === 2), "el origen tiene 3 productos con existencias e historial (fase 2)");

  // ---------- 2. La plantilla: solo configuración ----------
  const pl = await ca.rpc("admin_club_plantilla", { p_club: origen });
  revisar(!pl.error, "el admin lee la plantilla del origen", JSON.stringify(pl.error));
  const P = pl.data ?? {};
  const texto = JSON.stringify(P);
  revisar(Object.keys(P.club ?? {}).sort().join(",") === "ambiente,ciudad,codigo_vestimenta,cover_modo,cover_monto,deposito_monto,edad_minima,horario,tipo_musica,tolerancia_hora,zona_horaria",
    "la plantilla trae solo las columnas de configuración (sin nombre, dirección, dueño, ubicación, verificación, suscripción, bono ni comision_*)", Object.keys(P.club ?? {}).join(","));
  revisar(!/0000000777|example\.com|Av\. Origen|T alta\.jpg|25\.68|Gerente Origen|RP Origen|Dueña Origen|Cliente /.test(texto.replace(P.origen?.nombre ?? "~", "")),
    "la plantilla no trae teléfonos, correos, dirección, fotos, ubicación ni personas");
  revisar(P.origen?.id === origen && P.mesas?.length === 5 && P.mesas.some((m) => m.numero === "VIP 1" && m.capacidad === 12), "la plantilla trae las 5 mesas");
  revisar(P.regla?.origen === "regla" && P.regla.tipo === "cuota" && P.regla.cuota === 2 && Number(P.regla.monto_centavos) === 25000, "la plantilla trae la regla que vale hoy (cuota 2 / $250)", JSON.stringify(P.regla));
  revisar(P.regla_programada_desde === masDias(lunes, 7), "la plantilla avisa de la regla programada del lunes siguiente", P.regla_programada_desde);
  revisar(P.visibilidad === "estado_monto_botellas" && P.modo_pago === "reserva", "visibilidad y modo de pago");
  revisar(P.tarifas_dia?.map((t) => `${t.posicion}:${t.monto_centavos}`).join(",") === "1:30000,2:45000", "tarifas por día en centavos");
  revisar(P.caja_permisos?.length === 2 && P.caja_permisos.every((x) => x.rol === "staff") && P.permisos_por_persona === 1, "permisos: 2 por rol; el de persona solo se cuenta");
  revisar(!hayProductos || (P.productos?.length === 3 && P.productos.every((x) => !("existencias" in x) && !("id" in x))), "productos sin existencias ni ids");
  revisar(P.grupo_id === grupo, "la plantilla dice el grupo del origen");
  const demo = await ca.rpc("admin_club_plantilla", { p_club: CLUB_DEMO_DEV });
  revisar(!demo.error && (demo.data?.mesas?.length ?? 0) > 0, "la plantilla de Club Demo Dev se lee (solo lectura)", JSON.stringify(demo.error ?? demo.data?.mesas?.length));

  // ---------- 3. Clon por la ruta ----------
  const pre = precargaDesdePlantilla(esquemaPlantilla.parse(P));
  const cuerpo = cuerpoDeClon(pre, {
    nombre: `${PREFIJO} clon`, direccion: "Av. Clon 200, Sur",
    personal: [{ nombre: "Gerente Clon T alta", correo: correo("gerenteclon"), rol: "gerente" }, { nombre: "RP Clon T alta", correo: correo("rpclon"), rol: "rp" }],
  });
  const rC = await alta(sAdmin.galletas, cuerpo);
  revisar(rC.status === 200 && rC.cuerpo.ok && !rC.cuerpo.aviso, "clon por la ruta: 200, sin aviso", JSON.stringify(rC.cuerpo.error ?? rC.cuerpo.aviso ?? ""));
  const clon = rC.cuerpo.resultado?.club_id;
  revisar(rC.cuerpo.resultado?.clon?.clonado_de === origen && rC.cuerpo.resultado.clon.productos === (hayProductos ? 3 : 0), "la base confirma el clon y los productos copiados", JSON.stringify(rC.cuerpo.resultado?.clon));

  const cols = "nombre, direccion, ciudad, zona_horaria, horario, ambiente, tipo_musica, codigo_vestimenta, edad_minima, deposito_monto, cover_modo, cover_monto, tolerancia_hora, pago_rp_modo, dueno_id, lat, lng, estado_verificacion, suscripcion_activa, verificado_en, comision_tipo, comision_monto, comision_desbloqueo_reservas";
  const { data: cO } = await svc.from("clubs").select(cols).eq("id", origen).maybeSingle();
  const { data: cC } = await svc.from("clubs").select(cols).eq("id", clon).maybeSingle();
  const iguales = ["ciudad", "zona_horaria", "horario", "ambiente", "tipo_musica", "codigo_vestimenta", "edad_minima", "deposito_monto", "cover_modo", "cover_monto", "tolerancia_hora", "pago_rp_modo"];
  const distintos = iguales.filter((k) => String(cO?.[k]) !== String(cC?.[k]));
  revisar(distintos.length === 0, "datos generales, cover y políticas iguales al origen", distintos.map((k) => `${k}: ${cO?.[k]} ≠ ${cC?.[k]}`).join("; "));
  revisar(cC?.nombre === `${PREFIJO} clon` && cC.direccion === "Av. Clon 200, Sur", "nombre y dirección son los nuevos");
  revisar(cC?.dueno_id === null && cC.lat === null && cC.lng === null && cO?.dueno_id !== null && cO.lat !== null, "sin dueño ni ubicación (el origen sí los tiene)");
  revisar(cC?.estado_verificacion === "borrador" && cC.suscripcion_activa === false && cC.verificado_en === null, "nace en borrador, sin suscripción");
  revisar(cC?.comision_tipo === "fijo" && Number(cC.comision_monto) === 0, "columnas viejas de comisión en su valor por defecto (no se copian)");
  const mesasDe = async (id) => ((await svc.from("club_tables").select("numero, capacidad").eq("club_id", id)).data ?? []).map((m) => `${m.numero}:${m.capacidad}`).sort().join(",");
  revisar((await mesasDe(clon)) === (await mesasDe(origen)), "mismas mesas (nombre y capacidad)");
  const { data: reglasC } = await svc.from("reglas_comision").select("id, tipo, cuota, porcentaje_bp, monto_centavos, vigente_desde, vigente_hasta, creada_por").eq("club_id", clon);
  revisar(reglasC?.length === 1 && reglasC[0].tipo === "cuota" && reglasC[0].cuota === 2 && Number(reglasC[0].monto_centavos) === 25000 && reglasC[0].vigente_desde === lunes && reglasC[0].vigente_hasta === null && reglasC[0].creada_por === adminU.id,
    "una sola regla: la vigente del origen (cuota 2 / $250), abierta desde este lunes, creada por el admin; la programada no", JSON.stringify(reglasC));
  const { data: cfgC } = await svc.from("club_config_rp").select("nivel_visibilidad").eq("club_id", clon).maybeSingle();
  revisar(cfgC?.nivel_visibilidad === "estado_monto_botellas", "qué ven los RPs: igual al origen");
  const { data: permC } = await svc.from("caja_permisos").select("permiso, rol, profile_id, permitido").eq("club_id", clon);
  revisar(permC?.length === 2 && permC.every((x) => x.profile_id === null && x.rol === "staff") && permC.some((x) => x.permiso === "cobrar" && !x.permitido) && permC.some((x) => x.permiso === "anular" && x.permitido),
    "permisos de caja por rol iguales; ninguno por persona", JSON.stringify(permC));
  revisar(((await svc.from("club_dia_tarifas").select("id").eq("club_id", clon)).data ?? []).length === 0, "paga por reserva: las tarifas por día no se guardan (como en cualquier alta por reserva)");
  if (hayProductos) {
    const prodC = await db.q("select nombre, categoria, precio_centavos, existencias, existencias_minimas, activo, creado_por from public.productos where club_id = $1 order by nombre", [clon]);
    const prodO = await db.q("select nombre, categoria, precio_centavos, existencias_minimas, activo from public.productos where club_id = $1 order by nombre", [origen]);
    revisar(prodC.length === 3 && prodC.every((x, i) => x.nombre === prodO[i].nombre && x.categoria === prodO[i].categoria && String(x.precio_centavos) === String(prodO[i].precio_centavos) && x.existencias_minimas === prodO[i].existencias_minimas && x.activo === prodO[i].activo),
      "catálogo copiado: nombre, categoría, precio, mínimo y activo");
    revisar(prodC.every((x) => x.existencias === 0 && x.creado_por === adminU.id), "…con existencias en 0 y creado por el admin");
  }
  const dC = await huella(db, clon);
  const NO_COPIA = ["reservations", "consumption_entries", "caja_noches", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "caja_eventos", "commissions", "rp_pagos_dia", "rp_schedule", "rp_attendance", "club_photos", "verificacion_documentos", "rp_comision_overrides", "rp_dia_tarifa_overrides", "producto_movimientos"];
  for (const t of NO_COPIA) if (dC[t]) revisar(dC[t].n === 0, `no se copió: ${t} (0 filas en el clon)`, String(dC[t].n));
  const perfilesC = (await svc.from("profiles").select("nombre, role").eq("club_id", clon)).data ?? [];
  revisar(perfilesC.length === 2 && perfilesC.every((x) => /Clon T alta/.test(x.nombre)), "personal: solo las 2 cuentas nuevas del clon, nadie del origen", JSON.stringify(perfilesC));
  const { data: altaC } = await svc.from("club_altas").select("resumen").eq("club_id", clon).maybeSingle();
  revisar(altaC?.resumen?.clon?.clonado_de === origen, "la bitácora del alta dice de qué antro salió");
  const { data: gc } = await svc.from("grupo_clubs").select("grupo_id").eq("club_id", clon);
  revisar(gc?.length === 1 && gc[0].grupo_id === grupo, "queda en el mismo grupo que el origen");
  const cambiosC = (await svc.from("config_rp_cambios").select("que, hecho_por").eq("club_id", clon)).data ?? [];
  revisar(cambiosC.length === 2 && cambiosC.every((x) => x.hecho_por === adminU.id), "bitácora de configuración propia (regla y visibilidad, del admin), no la del origen", JSON.stringify(cambiosC));

  const despuesOrigen = await huella(db, origen);
  const cambiaron = Object.keys(antesOrigen).filter((t) => JSON.stringify(antesOrigen[t]) !== JSON.stringify(despuesOrigen[t]));
  revisar(cambiaron.length === 0, `el origen quedó idéntico (${Object.keys(antesOrigen).length} tablas, md5 de cada fila)`, cambiaron.join(", "));

  // ---------- 4. La regla clonada manda en la caja del antro nuevo ----------
  const credsC = rC.cuerpo.credenciales ?? [];
  const gerC = await entrarComo(credsC.find((c) => c.rol === "gerente"));
  const rpC = await entrarComo(credsC.find((c) => c.rol === "rp"));
  const { data: mesasC } = await svc.from("club_tables").select("id").eq("club_id", clon).order("numero");
  const pagos = [];
  for (let i = 0; i < 3; i++) pagos.push(await noche(clon, mesasC[i].id, gerC.c, rpC.id, 40000, "Botella clon"));
  revisar(pagos.map((x) => x.centavos).join(",") === "0,0,25000" && pagos.every((x) => x.regla === reglasC?.[0]?.id),
    "en el clon: 1.ª y 2.ª reserva $0, 3.ª $250, con la regla del clon (no la del origen)", JSON.stringify(pagos));
  const pC = (await gerC.c.rpc("caja_mis_permisos", { p_club_id: clon })).data;
  revisar(pC?.cobrar === true && pC.cuadrar_mesa === true, "el gerente del clon tiene los permisos de la plataforma");
  revisar(!!(await gerC.c.rpc("config_rp_actual", { p_club: origen })).error, "el gerente del clon no ve la configuración del origen");
  revisar(JSON.stringify(await huella(db, origen)) === JSON.stringify(despuesOrigen), "la caja del clon no tocó al origen");

  // ---------- 5. Origen que paga por día: las tarifas pasan ----------
  const rD = await ca.rpc("admin_alta_club", { p: {
    alta_id: randomUUID(), club: { nombre: `${PREFIJO} por dia`, direccion: "Calle Día 1", ciudad: "Puebla", horario: "Vie 10pm" },
    mesas: [{ numero: "A", capacidad: 4 }],
    rp: { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [{ posicion: 1, monto_centavos: 30000 }, { posicion: 2, monto_centavos: 45000 }, { posicion: 3, monto_centavos: 60000 }] },
  } });
  revisar(!rD.error, "origen por día dado de alta directo", JSON.stringify(rD.error));
  const plD = esquemaPlantilla.parse(ok(await ca.rpc("admin_club_plantilla", { p_club: rD.data.club_id }), "plantilla por día"));
  const preD = precargaDesdePlantilla(plD);
  const cuerpoD = cuerpoDeClon(preD, { nombre: `${PREFIJO} por dia clon`, direccion: "Calle Día 2" });
  const rDC = await alta(sAdmin.galletas, cuerpoD);
  revisar(rDC.status === 200 && rDC.cuerpo.ok, "clon del antro por día por la ruta", JSON.stringify(rDC.cuerpo.error ?? ""));
  const { data: tarDC } = await svc.from("club_dia_tarifas").select("posicion, monto").eq("club_id", rDC.cuerpo.resultado?.club_id).order("posicion");
  const { data: cDC } = await svc.from("clubs").select("pago_rp_modo").eq("id", rDC.cuerpo.resultado?.club_id).maybeSingle();
  revisar(cDC?.pago_rp_modo === "dia" && tarDC?.map((t) => `${t.posicion}:${Number(t.monto)}`).join(",") === "1:300,2:450,3:600", "modo día y tarifas $300/$450/$600 copiadas", JSON.stringify(tarDC));
  revisar(((await svc.from("reglas_comision").select("id").eq("club_id", rDC.cuerpo.resultado?.club_id)).data ?? []).length === 0, "sin regla por reserva (el origen no tenía)");

  // ---------- 6. Origen inválido, idempotencia y autorización ----------
  const antesU = (await usuariosConSufijo()).length;
  const falso = await alta(sAdmin.galletas, { ...cuerpoDeClon(pre, { nombre: `${PREFIJO} falso`, direccion: "Calle 9", personal: [{ nombre: "RP Falso", correo: correo("falso"), rol: "rp" }] }), clonar_de: randomUUID() });
  revisar(falso.status === 400 && /origen no existe/.test(falso.cuerpo.error ?? ""), "la ruta rechaza un origen que no existe", JSON.stringify(falso.cuerpo));
  const raro = await alta(sAdmin.galletas, { ...cuerpo, datos: { ...cuerpo.datos, nombre: `${PREFIJO} raro` }, personal: [], clonar_de: "abc" });
  revisar(raro.status === 400, "la ruta rechaza un origen mal escrito");
  revisar((await usuariosConSufijo()).length === antesU, "…sin crear cuentas");
  const pClon = (extra = {}) => ({ alta_id: randomUUID(), club: { nombre: `${PREFIJO} rpc`, direccion: "Calle 1", ciudad: "Puebla", horario: "Vie 10pm" }, clonar_de: origen, ...extra });
  for (const [txt, valor] of [["uuid que no existe", randomUUID()], ["texto que no es uuid", "abc"], ["inyección", "x'; drop table clubs; --"], ["número", 5]]) {
    const r = await ca.rpc("admin_alta_club", { p: pClon({ clonar_de: valor }) });
    revisar(r.error?.code === "P0001" && /origen no existe/.test(r.error.message), `la base rechaza clonar_de: ${txt}`, JSON.stringify(r.error));
  }
  revisar((await clubsConPrefijo()).every((c) => c.nombre !== `${PREFIJO} rpc`), "…sin dejar antro");
  const pRep = pClon();
  const r1 = await ca.rpc("admin_alta_club", { p: pRep });
  const r2 = await ca.rpc("admin_alta_club", { p: pRep });
  const nRep = (await clubsConPrefijo()).filter((c) => c.nombre === `${PREFIJO} rpc`);
  const prodRep = hayProductos ? (await db.q("select count(*)::int n from public.productos where club_id = $1", [r1.data?.club_id]))[0].n : 3;
  revisar(!r1.error && /ya se hizo/.test(r2.error?.message ?? "") && nRep.length === 1 && prodRep === 3, "la misma clave dos veces: un solo clon y el catálogo una sola vez", JSON.stringify(r1.error ?? r2.error));
  revisar(r1.data?.clon?.clonado_de === origen && "rp" in (r1.data ?? {}) && r1.data.rp === null, "directo sin p.rp: copia el catálogo y no inventa reglas");
  const r404 = await ca.rpc("admin_club_plantilla", { p_club: randomUUID() });
  revisar(r404.error?.code === "P0001" && /no existe/.test(r404.error.message), "plantilla de un antro que no existe → aviso");

  const intentos = [
    ["gerente de dev", await clienteDe("dev_gerente@example.com", PASS_DEV)],
    ["dueño de dev", await clienteDe("dev_dueno@example.com", PASS_DEV)],
    ["la dueña del ORIGEN", duenaO.c],
    ["el gerente del origen", gerO.c],
  ];
  const passSin = "Prueba-" + randomUUID();
  ok(await svc.auth.admin.createUser({ email: correo("sinperfil"), password: passSin, email_confirm: true }), "cuenta sin perfil");
  intentos.push(["cuenta sin perfil", await clienteDe(correo("sinperfil"), passSin)]);
  for (const [quien, c] of intentos) {
    const a = await c.rpc("admin_club_plantilla", { p_club: origen });
    const b = await c.rpc("admin_alta_club", { p: pClon() });
    revisar(!!a.error && /Solo el admin/.test(a.error.message) && !!b.error && /Solo el admin/.test(b.error.message), `${quien}: no lee la plantilla ni clona`, JSON.stringify([a.error?.message, b.error?.message]));
  }
  const aAnon = await anon.rpc("admin_club_plantilla", { p_club: origen });
  const bAnon = await anon.rpc("admin_alta_club", { p: pClon() });
  revisar(!!aAnon.error && !!bAnon.error && !aAnon.data, "el anónimo no ejecuta ni la plantilla ni el alta");
  const sGer = await sesion("dev_gerente@example.com", PASS_DEV);
  const rGer = await alta(sGer.galletas, cuerpo);
  revisar(rGer.status === 403, "la ruta: un gerente no clona (403)");
  revisar((await clubsConPrefijo()).filter((c) => c.nombre === `${PREFIJO} rpc`).length === 1, "ningún intento ajeno dejó antro");
  revisar(JSON.stringify(await huella(db, origen)) === JSON.stringify(despuesOrigen), "al final, el origen sigue idéntico");
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  // ---------- Limpieza (solo dev) ----------
  const clubIds = (await clubsConPrefijo()).map((c) => c.id);
  const usuarios = await usuariosConSufijo();
  const ids = usuarios.map((u) => u.id);
  if (!db) db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      const fase2 = (await db.q("select to_regclass('public.productos') is not null as e"))[0].e;
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos", "rp_pagos_dia"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      if (fase2) {
        await db.q("delete from public.producto_movimientos where club_id = any($1::uuid[])", [clubIds]);
        await db.q("delete from public.productos where club_id = any($1::uuid[])", [clubIds]);
      }
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const t of ["rp_attendance", "rp_schedule", "rp_comision_overrides", "rp_dia_tarifa_overrides", "club_photos", "verificacion_documentos", "config_rp_cambios", "reglas_comision", "club_config_rp", "club_dia_tarifas", "reservations", "club_tables", "grupo_clubs"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (gruposCreados.size) {
      await db.q("delete from public.grupo_miembros where grupo_id = any($1::uuid[])", [[...gruposCreados]]);
      await db.q("delete from public.grupo_clubs where grupo_id = any($1::uuid[])", [[...gruposCreados]]);
      await db.q("delete from public.grupos where id = any($1::uuid[])", [[...gruposCreados]]);
    }
    if (ids.length) {
      await db.q("delete from public.grupo_miembros where profile_id = any($1::uuid[])", [ids]);
      await db.q("update public.clubs set dueno_id = null where dueno_id = any($1::uuid[])", [ids]);
      await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    }
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
  const quedanGrupos = gruposCreados.size ? ((await svc.from("grupos").select("id").in("id", [...gruposCreados])).data ?? []).length : 0;
  const quedan = (await usuariosConSufijo()).length + (await clubsConPrefijo()).length + quedanGrupos;
  console.log(quedan === 0 ? `\nLimpieza: ${clubIds.length} antros, ${ids.length} cuentas y ${gruposCreados.size} grupo de prueba borrados; no quedó nada.` : `\nLimpieza: QUEDARON ${quedan} registros de la prueba.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan || quedan) process.exitCode = 1;
}
