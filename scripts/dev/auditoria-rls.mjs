// SOLO DEV. Auditoría de RLS con sesiones reales (carril c-rls, 25/11/2026).
//
//   node scripts/dev/auditoria-rls.mjs [--base=http://localhost:3026] [--markdown=archivo.md] [--estricto]
//
// Qué hace:
//  1. Crea DOS antros de prueba propios ("T rls A" publicado y "T rls B" en
//     borrador; más "T rls C" para un dueño con contraseña temporal), con
//     personal, reservas, caja, nómina, turnos, tarifas, documentos y fotos.
//     Todo con el prefijo t_rls_ y se borra al final (try/finally).
//  2. Inicia sesión (de verdad, con la anon key) como: anónimo, cuenta sin
//     perfil, cliente, RP, staff, gerente y dueño de cada antro, dueño de
//     grupo, admin, staff y RP dados de baja, gerente y RP con contraseña
//     temporal sin cambiar, dueño con contraseña temporal y un gerente sin
//     antro (perfil anómalo).
//  3. Para cada tabla de public: SELECT, INSERT, UPDATE y DELETE de cada
//     sesión contra los datos de A y de B; compara con lo esperado.
//  4. Funciones (RPC), buckets de Storage, candados (triggers) y, si hay
//     servidor (--base), las rutas que leen el rol con la service role.
//  5. Escaneo estático de TODAS las funciones del catálogo buscando
//     autorizaciones que fallan abiertas con NULL; cada coincidencia debe
//     tener veredicto en VEREDICTOS (abajo). Las nuevas salen como aviso
//     (con --estricto cuentan como falla).
//
// Termina con 0 si todo lo esperado coincide con lo obtenido.
// Nunca toca producción: verificarEnvDev() aborta si .env.dev no es de dev.
// No usa ni modifica los datos de Club Demo Dev ni los usuarios dev_*.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const BASE = (arg("base") ?? "http://localhost:3026").replace(/\/$/, "");
const MARKDOWN = arg("markdown");
const ESTRICTO = process.argv.includes("--estricto");

const TAG = "t_rls_" + randomUUID().slice(0, 6);
const PASS = "T-" + randomUUID();
const TAGX = TAG.replace(/_/g, "");
const IPH = (TAG + "0".repeat(64)).slice(0, 64);
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const HOY = hoyMx();
const diaMenos = (n) => new Date(Date.parse(HOY + "T12:00:00Z") - n * 86400e3).toISOString().slice(0, 10);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- resultados
const resultados = []; // { grupo, prueba, actor, esperado, obtenido, ok, detalle }
const avisos = [];
function anotar(grupo, prueba, actor, esperado, obtenido, detalle = "") {
  const ok = esperado === obtenido;
  resultados.push({ grupo, prueba, actor, esperado, obtenido, ok, detalle });
  if (!ok) console.log(`FALLA  [${grupo}] ${prueba} · ${actor}: esperado ${esperado ? "sí" : "no"}, obtenido ${obtenido ? "sí" : "no"}${detalle ? "  — " + detalle : ""}`);
}
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.code ?? ""} ${r.error.message}`);
  return r.data;
};

// ---------------------------------------------------------------- actores
// tipo: anon | sinperfil | normal | baja | temp | anomalo.
// Solo "normal" tiene acceso por rol; los demás solo ven lo público y su perfil.
const A = {}; // actores por clave
const creados = { usuarios: [], clubs: {}, grupos: [], planes: [], correos: [] };
const ids = {}; // filas de prueba por etiqueta

async function login(email) {
  for (let i = 0; i < 8; i++) {
    const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
    const s = await c.auth.signInWithPassword({ email, password: PASS });
    if (!s.error) return c;
    if (s.error.status !== 429) throw new Error("login: " + s.error.message);
    await espera(8000 * (i + 1));
  }
  throw new Error("login: demasiados intentos (429)");
}

async function cuenta(clave, { role = null, club = null, tipo = "normal", meta = {} } = {}) {
  const email = `${TAG}_${clave.toLowerCase()}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, app_metadata: meta }), "usuario " + clave);
  creados.usuarios.push(u.user.id);
  creados.correos.push(email);
  if (role) ok(await svc.from("profiles").insert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id: club ? creados.clubs[club] : null }), "perfil " + clave);
  A[clave] = { key: clave, id: u.user.id, email, role, club, tipo };
  return A[clave];
}
async function conectar(clave) {
  A[clave].c = await login(A[clave].email);
}

// ---------------------------------------------------------------- reglas de "debe"
const N = (a) => a.tipo === "normal";
const es = (a, ...roles) => N(a) && roles.includes(a.role);
const del = (a, f, ...roles) => es(a, ...roles) && !!f.club && a.club === f.club;
const adm = (a) => a.key === "admin";
const grp = (a, f) => a.key === "duenoGrupo" && f.club === "A";
const suyo = (a, f, campo = "rp") => N(a) && f[campo] === a.key;
const STAFF = ["staff", "gerente", "dueno"];
const GER = ["gerente", "dueno"];
const cajaVe = (a, f) => adm(a) || del(a, f, "staff", "gerente", "dueno") || grp(a, f);
const gerVe = (a, f) => adm(a) || del(a, f, ...GER);

// ---------------------------------------------------------------- escaneo estático
// Cada función con un patrón sospechoso necesita veredicto. "seguro" explica
// por qué el NULL no deja pasar; "arreglado" dice en qué SQL; "explotable"
// cuenta como falla.
const PATRONES = [
  { id: "if-not-sin-coalesce", re: /\bif\s+not\s*\((?![^;]*coalesce)/i, texto: "«if not (…)» sin coalesce" },
  { id: "if-not-funcion", re: /\bif\s+not\s+(?!found\b|exists\b|coalesce\b)[a-z_.]+\s*\(/i, texto: "«if not f(…)»: depende de que f nunca devuelva NULL" },
  { id: "rol-not-in", re: /\bv_rol\s+not\s+in\s*\(/i, texto: "«v_rol not in (…)»" },
  { id: "distinto-admin", re: /<>\s*'admin'/i, texto: "«<> 'admin'»" },
];
const VEREDICTOS = {
  "actividad_club(uuid,date,date)": "seguro: es_gerente_o_dueno() nunca devuelve NULL (coalesce y ramas booleanas)",
  "admin_alta_club(jsonb)": "seguro: solo admin (is distinct from 'admin'); un rol nulo del payload no cae en el if pero el INSERT en profiles.role (not null) lo rechaza y revierte todo. Endurecer cuando se redefina (lo hace el carril del alta)",
  "caja_abrir_mesa(uuid)": "seguro: caja_tiene_permiso() solo es NULL si el permiso es NULL; aquí es una constante",
  "caja_anular_consumo(uuid,text)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_anular_pago(uuid,text)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_cerrar_mesa(uuid)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_cerrar_noche(uuid,bigint,bigint,bigint,text)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_cuadrar_mesa(uuid,text)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_reabrir_mesa(uuid,text)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_registrar_consumo(uuid,bigint,text,uuid)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_registrar_consumo_producto(uuid,uuid,integer,uuid)": "seguro: caja_tiene_permiso() con permiso constante; «if not v_prod.activo» sobre columna not null",
  "caja_registrar_pago(uuid,uuid,text,bigint,text,uuid,bigint,bigint)": "seguro: caja_tiene_permiso() con permiso constante; «p_metodo not in» va después de «p_metodo is null or»",
  "caja_sentar_cliente(uuid,uuid,text,integer)": "seguro: caja_tiene_permiso() con permiso constante",
  "caja_tiene_permiso(uuid,text)": "seguro: «v_rol is null or v_rol not in (…)»",
  "caja_sin_borrar()": "seguro: trigger; compara estados con valores not null y no autoriza por rol",
  "clubs_candado_verificacion()": "seguro: el «if not (old.estado in … and new.estado = …)» compara columnas not null con check; la puerta de admin es «= 'admin'» (NULL no la abre)",
  "clubs_candado_zona_horaria()": "seguro: coalesce(current_role_name(), '') <> 'admin'",
  "config_rp_actual(uuid)": "seguro: es_gerente_o_dueno() nunca devuelve NULL",
  "config_rp_cambiar_regla(uuid,text,integer,integer,bigint)": "seguro: es_gerente_o_dueno() nunca NULL; «p_tipo not in» va después de «p_tipo is null»",
  "config_rp_cambiar_visibilidad(uuid,text)": "seguro: es_gerente_o_dueno() nunca NULL; un p_nivel NULL lo rechaza el check de club_config_rp",
  "config_rp_historial(uuid)": "seguro: es_gerente_o_dueno() nunca NULL",
  "grupo_rendimiento_rp(uuid,date,date)": "seguro: coalesce(…, false) (10a, ya en producción)",
  "nomina_cambiar_estado(uuid,uuid,integer,integer,text,text,text)": "arreglado en sql/post-junta-2/60: nomina_transicion_valida(NULL, …) daba NULL y pasaba el if; era inocuo (el UPDATE con status = NULL no toca filas) pero ahora rechaza",
  "nomina_semana(uuid,integer,integer)": "seguro: es_gerente_o_dueno() y club_es_dueno_grupo() nunca devuelven NULL (probado con sesión real: sin perfil, baja y temporal)",
  "personal_cambiar_estado(uuid,boolean,text)": "arreglado en sql/post-junta-2/60: un gerente con club_id NULL (perfil anómalo) pasaba el if por «current_club_id() = club» NULL y daba de baja staff de cualquier antro",
  "personal_historial(uuid,integer)": "seguro: coalesce(…, false)",
  "producto_ajustar_existencias(uuid,integer,text)": "seguro: «not found or not es_gerente_o_dueno()», nunca NULL",
  "producto_guardar(uuid,uuid,text,text,bigint,integer,boolean,integer)": "seguro: es_gerente_o_dueno() nunca NULL",
  "producto_importar(uuid,jsonb)": "seguro: es_gerente_o_dueno() nunca NULL",
  "puerta_reserva_para_escribir(uuid)": "seguro: «not found or not caja_tiene_permiso()» con permiso constante",
  "registrar_comision_reserva(uuid,uuid,uuid,numeric,timestamp with time zone,timestamp with time zone)": "seguro: coalesce(…, false) (7d, ya en producción)",
  "registrar_pago_dia(uuid,uuid,uuid,date,timestamp with time zone,timestamp with time zone)": "seguro: coalesce(…, false) (7d, ya en producción)",
  "caja_insert_coherente()": "seguro: trigger de coherencia, no autoriza por rol",
  "caja_liquidar_cuenta(uuid)": "seguro: interna (sin execute para authenticated)",
  "nomina_transicion_valida(text,text)": "arreglado en sql/post-junta-2/60 (coalesce)",
};

async function escaneoEstatico(db) {
  const funcs = await db.q(`select p.oid::regprocedure::text as firma, pg_get_functiondef(p.oid) as def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' order by 1`);
  const filas = [];
  for (const f of funcs) {
    const firma = f.firma.replace(/^public\./, "");
    const cuerpo = f.def.split(/\$function\$/)[1] ?? f.def;
    const golpes = PATRONES.filter((p) => p.re.test(cuerpo)).map((p) => p.id);
    if (!golpes.length) continue;
    const v = VEREDICTOS[firma];
    filas.push({ firma, golpes, veredicto: v ?? "SIN REVISAR" });
    if (!v) avisos.push(`función sin veredicto: ${firma} (${golpes.join(", ")})`);
    else if (/^explotable/.test(v)) anotar("NULL", firma, "-", false, true, v);
  }
  return { total: funcs.length, filas };
}

// ---------------------------------------------------------------- escenario
const filas = {}; // tabla -> [{ id, club, rp, cliente, perfil, upd, del, etiqueta }]
const fila = (t, f) => (filas[t] ??= []).push(f);
const C = (k) => creados.clubs[k];

async function escenario() {
  // Antros: A publicado, B en borrador, C en borrador (dueño con contraseña temporal).
  for (const [k, pub] of [["A", true], ["B", false], ["C", false]]) {
    const r = ok(await svc.from("clubs").insert({
      nombre: `T rls ${k} ${TAG}`, direccion: "Calle prueba 1", horario: "Vie-Sáb", pago_rp_modo: "reserva",
      comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0,
      estado_verificacion: pub ? "verificado" : "borrador", suscripcion_activa: pub,
    }).select("id").single(), "club " + k);
    creados.clubs[k] = r.id;
    fila("clubs", { id: r.id, club: k, upd: true, etiqueta: k });
  }
  // Personas.
  await cuenta("sinperfil", { tipo: "sinperfil" });
  await cuenta("sinperfil2", { tipo: "sinperfil" }); // para el registro legítimo
  await cuenta("cliente", { role: "cliente" });
  await cuenta("admin", { role: "admin" });
  for (const k of ["A", "B"]) {
    await cuenta("dueno" + k, { role: "dueno" });
    ok(await svc.from("clubs").update({ dueno_id: A["dueno" + k].id }).eq("id", C(k)), "dueño " + k);
    A["dueno" + k].club = k;
    for (const r of ["gerente", "staff", "rp"]) await cuenta(r + k, { role: r, club: k });
    await cuenta("rp2" + k, { role: "rp", club: k }); // sin sesión: destino de tarifas
    await cuenta("staffBaja" + k, { role: "staff", club: k, tipo: "baja" });
  }
  await cuenta("duenoGrupo", { role: "dueno" });
  await cuenta("rpBaja", { role: "rp", club: "A", tipo: "baja" });
  await cuenta("gerenteTemp", { role: "gerente", club: "A", tipo: "temp", meta: { debe_cambiar: true } });
  await cuenta("rpTemp", { role: "rp", club: "A", tipo: "temp", meta: { debe_cambiar: true } });
  await cuenta("duenoTemp", { role: "dueno", tipo: "temp", meta: { debe_cambiar: true } });
  ok(await svc.from("clubs").update({ dueno_id: A.duenoTemp.id }).eq("id", C("C")), "dueño C");
  A.duenoTemp.club = "C";
  await cuenta("gerenteSinClub", { role: "gerente", tipo: "anomalo" });
  for (const a of Object.values(A)) if (a.role) fila("profiles", { id: a.id, club: a.role === "dueno" ? null : a.club, perfil: a.key, upd: /^rp[AB]$/.test(a.key), etiqueta: a.key });

  for (const k of ["A", "B", "C"]) fila("club_photos", { id: ok(await svc.from("club_photos").insert({ club_id: C(k), url: "https://example.com/t.png", storage_path: `${C(k)}/${TAG}.png` }).select("id").single(), "foto").id, club: k, upd: true, etiqueta: "foto" + k });

  // Grupos: G = {A} con duenoGrupo; H = {B} sin miembros.
  for (const [g, k] of [["G", "A"], ["H", "B"]]) {
    const r = ok(await svc.from("grupos").insert({ nombre: `${TAG} grupo ${g}` }).select("id").single(), "grupo");
    creados.grupos.push(r.id);
    ids["grupo" + g] = r.id;
    fila("grupos", { id: r.id, club: k, upd: true, etiqueta: g });
    ok(await svc.from("grupo_clubs").insert({ grupo_id: r.id, club_id: C(k) }), "grupo_clubs");
    fila("grupo_clubs", { id: C(k), pk: "club_id", club: k, upd: true, etiqueta: g + "-" + k });
  }
  ok(await svc.from("grupo_miembros").insert({ grupo_id: ids.grupoG, profile_id: A.duenoGrupo.id, rol_grupo: "dueno_grupo" }), "miembro");
  fila("grupo_miembros", { id: A.duenoGrupo.id, pk: "profile_id", club: "A", perfil: "duenoGrupo", upd: true, etiqueta: "G-duenoGrupo" });
  const rD = ok(await svc.from("grupos").insert({ nombre: `${TAG} grupo D (borrar)` }).select("id").single(), "grupo D");
  creados.grupos.push(rD.id);
  fila("grupos", { id: rD.id, club: null, del: true, etiqueta: "D" });

  // Bajas: staff por personal_cambiar_estado (borra sus sesiones; la sesión se abre después) y RP como hoy.
  for (const k of ["A", "B"]) {
    await conectar("dueno" + k);
    ok(await A["dueno" + k].c.rpc("personal_cambiar_estado", { p_profile_id: A["staffBaja" + k].id, p_activo: false, p_motivo: "prueba t_rls" }), "baja staff " + k);
  }
  ok(await svc.from("profiles").update({ activo: false }).eq("id", A.rpBaja.id), "baja rp");

  // Datos por antro.
  for (const k of ["A", "B"]) {
    const club = C(k);
    const rp = A["rp" + k], rp2 = A["rp2" + k];
    const mesas = ok(await svc.from("club_tables").insert(["1", "2", "3", "borrar"].map((n) => ({ club_id: club, numero: `${TAG}-${n}`, capacidad: 4 }))).select("id, numero"), "mesas");
    ids["mesa1" + k] = mesas[0].id; ids["mesa2" + k] = mesas[1].id;
    fila("club_tables", { id: mesas[2].id, club: k, upd: true, etiqueta: "mesa" + k });
    fila("club_tables", { id: mesas[3].id, club: k, del: true, etiqueta: "mesa-borrar" + k });
    const fotoDel = ok(await svc.from("club_photos").insert({ club_id: club, url: "https://example.com/b.png", storage_path: `${club}/${TAG}-b.png` }).select("id").single(), "foto borrar");
    fila("club_photos", { id: fotoDel.id, club: k, del: true, etiqueta: "foto-borrar" + k });

    const reserva = async (extra, etiqueta, marcas = {}) => {
      const r = ok(await svc.from("reservations").insert({ cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000999", personas: 2, status: "pendiente", fecha: HOY, club_id: club, qr_code: `antro-${randomUUID()}`, source: "organica", ...extra }).select("id, qr_code").single(), "reserva " + etiqueta);
      fila("reservations", { id: r.id, club: k, rp: extra.rp_id ? Object.values(A).find((a) => a.id === extra.rp_id).key : null, cliente: extra.cliente_id ? "cliente" : null, etiqueta, ...marcas });
      ids[etiqueta] = r.id; ids["qr-" + etiqueta] = r.qr_code;
      return r.id;
    };
    const resOrg = await reserva(k === "A" ? { cliente_id: A.cliente.id } : {}, "resOrg" + k, { upd: true });
    const resRp = await reserva({ source: "rp", rp_id: rp.id }, "resRp" + k);
    await reserva({}, "resPuerta" + k);
    const resCaja = await reserva({ source: "rp", rp_id: rp.id, status: "usada", puerta_estado: "entro", entrada_en: new Date().toISOString() }, "resCaja" + k);
    const resPropias = [];
    if (k === "A") for (const x of ["rpBaja", "rpTemp"]) resPropias.push([x, await reserva({ source: "rp", rp_id: A[x].id }, "res" + x)]);

    const ce = ok(await svc.from("consumption_entries").insert({ reservation_id: resRp, monto: 100 }).select("id").single(), "consumo viejo");
    fila("consumption_entries", { id: ce.id, club: k, upd: true, etiqueta: "ce" + k });
    const com = ok(await svc.from("commissions").insert([
      { reservation_id: resRp, rp_id: rp.id, tipo: "rp", monto: 100, status: "pendiente" },
      { reservation_id: resOrg, rp_id: null, tipo: "plataforma", monto: 50, status: "pendiente" },
      ...resPropias.map(([x, r]) => ({ reservation_id: r, rp_id: A[x].id, tipo: "rp", monto: 100, status: "pendiente" })),
    ]).select("id, rp_id"), "comisiones");
    for (const c of com) fila("commissions", { id: c.id, club: k, rp: c.rp_id ? Object.values(A).find((a) => a.id === c.rp_id).key : null, upd: true, etiqueta: "com" + k });

    const rpsTurno = [rp, ...(k === "A" ? [A.rpBaja, A.rpTemp] : [])];
    for (const [i, quien] of rpsTurno.entries()) {
      const s = ok(await svc.from("rp_schedule").insert({ rp_id: quien.id, club_id: club, fecha: HOY }).select("id").single(), "turno");
      fila("rp_schedule", { id: s.id, club: k, rp: quien.key, upd: i === 0, etiqueta: "turno-" + quien.key });
      const at = ok(await svc.from("rp_attendance").insert({ rp_id: quien.id, club_id: club, fecha: HOY, metodo: "manual" }).select("id").single(), "asistencia");
      fila("rp_attendance", { id: at.id, club: k, rp: quien.key, upd: i === 0, etiqueta: "asist-" + quien.key });
      ids["asist-" + quien.key] = at.id;
      const pg = ok(await svc.from("rp_pagos_dia").insert({ rp_attendance_id: at.id, rp_id: quien.id, club_id: club, fecha: HOY, posicion: 1, monto: 300 }).select("id").single(), "pago día");
      fila("rp_pagos_dia", { id: pg.id, club: k, rp: quien.key, upd: i === 0, etiqueta: "pago-" + quien.key });
      const ov = ok(await svc.from("rp_comision_overrides").insert({ club_id: club, rp_id: quien.id, comision_tipo: "fijo", comision_monto: 120, comision_desbloqueo_reservas: 0 }).select("id").single(), "override");
      fila("rp_comision_overrides", { id: ov.id, club: k, rp: quien.key, upd: i === 0, etiqueta: "ov-" + quien.key });
    }
    const sDel = ok(await svc.from("rp_schedule").insert({ rp_id: rp2.id, club_id: club, fecha: diaMenos(1) }).select("id").single(), "turno borrar");
    fila("rp_schedule", { id: sDel.id, club: k, rp: "rp2" + k, del: true, etiqueta: "turno-borrar" + k });
    const ovDel = ok(await svc.from("rp_comision_overrides").insert({ club_id: club, rp_id: rp2.id, comision_tipo: "fijo", comision_monto: 1, comision_desbloqueo_reservas: 0 }).select("id").single(), "override borrar");
    fila("rp_comision_overrides", { id: ovDel.id, club: k, rp: "rp2" + k, del: true, etiqueta: "ov-borrar" + k });
    const tar = ok(await svc.from("club_dia_tarifas").insert([{ club_id: club, posicion: 1, monto: 200 }, { club_id: club, posicion: 2, monto: 250 }]).select("id"), "tarifas");
    fila("club_dia_tarifas", { id: tar[0].id, club: k, upd: true, etiqueta: "tarifa" + k });
    fila("club_dia_tarifas", { id: tar[1].id, club: k, del: true, etiqueta: "tarifa-borrar" + k });
    const od = ok(await svc.from("rp_dia_tarifa_overrides").insert([{ club_id: club, rp_id: rp.id, posicion: 1, monto: 220 }, { club_id: club, rp_id: rp2.id, posicion: 1, monto: 1 }]).select("id"), "tarifa rp");
    fila("rp_dia_tarifa_overrides", { id: od[0].id, club: k, upd: true, etiqueta: "odia" + k });
    fila("rp_dia_tarifa_overrides", { id: od[1].id, club: k, del: true, etiqueta: "odia-borrar" + k });
    const doc = ok(await svc.from("verificacion_documentos").insert({ club_id: club, tipo: "comprobante_fiscal", storage_path: `${club}/comprobante_fiscal-${TAG}.pdf` }).select("id").single(), "doc");
    fila("verificacion_documentos", { id: doc.id, club: k, upd: true, etiqueta: "doc" + k });
    ok(await svc.from("suscripciones").insert({ club_id: club, estado: "activa" }), "suscripción");
    fila("suscripciones", { id: club, pk: "club_id", club: k, upd: true, etiqueta: "sus" + k });
    const pm = ok(await svc.from("pagos_mensualidad").insert({ club_id: club, stripe_invoice_id: `in_${TAG}_${k}`, monto_centavos: 250000, moneda: "mxn", estado: "pagado" }).select("id").single(), "pago mensualidad");
    fila("pagos_mensualidad", { id: pm.id, club: k, upd: true, etiqueta: "pm" + k });

    // Caja por el camino real (gerente): cuadrada (con comisión) y una abierta con walk-in.
    await conectar("gerente" + k);
    const g = A["gerente" + k].c;
    const s1 = ok(await g.rpc("caja_abrir_mesa", { p_mesa_id: ids["mesa1" + k] }), "abrir mesa");
    const cta = ok(await g.rpc("caja_sentar_cliente", { p_sesion_id: s1, p_reservation_id: resCaja }), "sentar");
    ok(await g.rpc("caja_registrar_consumo", { p_cuenta_id: cta, p_monto_centavos: 50000, p_concepto: "Botella t_rls" }), "consumo");
    ok(await g.rpc("caja_registrar_pago", { p_sesion_id: s1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 50000 }), "pago");
    ok(await g.rpc("caja_cerrar_mesa", { p_sesion_id: s1 }), "cerrar");
    ok(await g.rpc("caja_cuadrar_mesa", { p_sesion_id: s1 }), "cuadrar");
    const s2 = ok(await g.rpc("caja_abrir_mesa", { p_mesa_id: ids["mesa2" + k] }), "abrir mesa 2");
    ids["cuenta2" + k] = ok(await g.rpc("caja_sentar_cliente", { p_sesion_id: s2, p_cliente_nombre: "Walk-in t_rls", p_personas: 2 }), "walk-in");
    ok(await g.rpc("caja_registrar_consumo", { p_cuenta_id: ids["cuenta2" + k], p_monto_centavos: 10000 }), "consumo 2");
    const prod = ok(await g.rpc("producto_guardar", { p_club_id: club, p_id: null, p_nombre: `Producto ${TAG}`, p_categoria: "Botellas", p_precio_centavos: 100000, p_existencias_minimas: 0, p_activo: true, p_existencias_iniciales: 5 }), "producto");
    ids["producto" + k] = prod;
    ok(await g.rpc("producto_ajustar_existencias", { p_producto_id: prod, p_cantidad: 1, p_motivo: "prueba t_rls" }), "ajuste");
    ok(await g.rpc("config_rp_cambiar_visibilidad", { p_club: club, p_nivel: "estado" }), "visibilidad");
    ok(await A["dueno" + k].c.rpc("config_rp_cambiar_regla", { p_club: club, p_tipo: "fijo", p_cuota: 0, p_porcentaje_bp: null, p_monto_centavos: 15000 }), "regla");
    ok(await A["dueno" + k].c.rpc("caja_configurar_permiso", { p_club_id: club, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: false }), "permiso caja");
    const comCaja = ok(await svc.from("commissions").select("id").eq("reservation_id", resCaja), "comisión de caja");
    for (const c of comCaja) fila("commissions", { id: c.id, club: k, rp: "rp" + k, etiqueta: "comCaja" + k });
  }
  // Filas de caja y configuración, leídas de la base (club_id directo).
  const porClub = async (t, pk = "id", marcaUpd = true) => {
    const r = ok(await svc.from(t).select(`${pk}, club_id`).in("club_id", [C("A"), C("B")]), t);
    const vistos = new Set();
    for (const x of r) {
      const k = x.club_id === C("A") ? "A" : "B";
      fila(t, { id: x[pk], pk, club: k, upd: marcaUpd && !vistos.has(k), etiqueta: t + k });
      vistos.add(k);
    }
  };
  for (const t of ["caja_noches", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "caja_eventos", "caja_permisos", "productos", "producto_movimientos", "reglas_comision", "config_rp_cambios", "personal_movimientos"]) await porClub(t);
  await porClub("club_config_rp", "club_id");

  // Globales y bitácoras.
  const alta = ok(await svc.from("club_altas").insert({ alta_id: randomUUID(), club_id: C("A"), creado_por: A.admin.id, publicado: true }).select("id").single(), "club_altas");
  fila("club_altas", { id: alta.id, club: "A", upd: true, etiqueta: "alta" });
  const err = ok(await svc.from("app_errores").insert({ mensaje: `prueba ${TAG}`, ruta: `/${TAG}` }).select("id").single(), "app_errores");
  fila("app_errores", { id: err.id, club: null, upd: true, etiqueta: "error" });
  for (const n of ["", "-borrar"]) {
    const pl = ok(await svc.from("planes").insert({ clave: `${TAG}${n}`, nombre: `Plan ${TAG}${n}`, stripe_price_id: `price_${TAGX}${n.slice(1)}` }).select("id").single(), "plan");
    creados.planes.push(pl.id);
    fila("planes", { id: pl.id, club: null, upd: !n, del: !!n, etiqueta: "plan" + n });
  }
  await conectar("cliente"); await conectar("rpA");
  for (const q of ["cliente", "rpA"]) {
    const ac = ok(await A[q].c.from("aceptaciones_legales").insert({ profile_id: A[q].id, documento: "terminos", version: "2026-11-24-borrador" }).select("id").single(), "aceptación " + q);
    fila("aceptaciones_legales", { id: ac.id, club: null, perfil: q, upd: true, etiqueta: "acept-" + q });
  }
  // Tablas sin acceso por API (solo service_role): una fila marcada para que haya algo que ver.
  const marcas = {
    registro_intentos: { ip_hash: IPH, tipo: "cliente" },
    stripe_eventos: { id: `evt_${TAGX}`, tipo: "prueba" },
    alertas_enviadas: { tipo: TAG },
  };
  for (const [t, v] of Object.entries(marcas)) {
    const r = await svc.from(t).insert(v).select("*").single();
    if (r.error) avisos.push(`no se pudo marcar ${t}: ${r.error.message}`);

  }

  // Storage: una foto y un documento por antro (para leer y borrar).
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const pdf = Buffer.from("%PDF-1.4\n% t_rls\n");
  for (const k of ["A", "B"]) {
    ok(await svc.storage.from("club-photos").upload(`${C(k)}/${TAG}-borrar.png`, png, { contentType: "image/png" }), "foto storage");
    ok(await svc.storage.from("verificacion-docs").upload(`${C(k)}/comprobante_fiscal-${TAG}.pdf`, pdf, { contentType: "application/pdf" }), "doc storage");
  }
  ids.png = png; ids.pdf = pdf;

  // Sesiones que faltan (las bajas, después de la baja).
  for (const k of Object.keys(A)) if (!A[k].c && A[k].tipo !== "anon" && k !== "sinperfil2" && !/^rp2/.test(k)) await conectar(k);
  A.anon = { key: "anon", tipo: "anon", role: null, club: null, c: createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts) };
}

// ---------------------------------------------------------------- especificación por tabla
// ver(a, f): ¿la sesión a debe ver la fila f?  ins: { fila(a, k), puede(a, k) }.
// upd: { col, puede(a, f) }  del: { puede(a, f) }. Por omisión: nadie escribe.
const nadie = () => false;
const publicado = (f) => f.club === "A";
const clubVisible = (a, f) => publicado(f) || adm(a) || (f.club === "B" && N(a) && a.club === "B") || (f.club === "C" && a.key === "duenoTemp");
const SPEC = {
  clubs: {
    ver: clubVisible,
    upd: { col: "horario", puede: (a, f) => adm(a) || (es(a, "dueno") && a.club === f.club) },
  },
  club_photos: {
    ver: clubVisible,
    ins: { fila: (a, k) => ({ club_id: C(k), url: "https://example.com/x.png", storage_path: `${C(k)}/${TAG}-${a.key}.png` }), puede: (a, k) => adm(a) || (es(a, "dueno") && a.club === k), clubs: ["A", "B", "C"] },
    upd: { col: "orden", puede: nadie },
    del: { puede: (a, f) => adm(a) || (es(a, "dueno") && a.club === f.club) },
  },
  club_tables: {
    ver: (a, f) => adm(a) || del(a, f, ...STAFF),
    ins: { fila: (a, k) => ({ club_id: C(k), numero: `${TAG}-i-${a.key}`, capacidad: 2 }), puede: (a, k) => adm(a) || (es(a, "dueno") && a.club === k) },
    upd: { col: "capacidad", puede: nadie },
    del: { puede: (a, f) => adm(a) || del(a, f, "dueno") },
  },
  profiles: {
    ver: (a, f) => (f.perfil === a.key && a.tipo !== "anon" && a.tipo !== "sinperfil") || adm(a) || del(a, f, ...STAFF),
    // Cada quien edita su propio perfil (nombre, teléfono); el rol, el antro y «activo» los cuida el trigger.
    upd: { col: "nombre", puede: (a, f) => adm(a) || del(a, f, ...STAFF) || f.perfil === a.key },
  },
  reservations: {
    ver: (a, f) => adm(a) || del(a, f, ...STAFF) || suyo(a, f, "rp") || suyo(a, f, "cliente"),
    ins: {
      fila: (a, k) => ({ cliente_nombre: `Ins ${TAG}`, cliente_telefono: "0000000998", personas: 2, fecha: HOY, club_id: C(k), qr_code: `antro-${randomUUID()}`, status: "pendiente",
        ...(a.role === "rp" ? { source: "rp", rp_id: a.id } : { source: "organica", ...(a.id ? { cliente_id: a.id } : {}) }) }),
      // Sin cuenta o cliente: solo en antros publicados. RP: solo en su antro.
      puede: (a, k) => ((a.tipo === "anon" || es(a, "cliente")) && k === "A") || (es(a, "rp") && a.club === k),
    },
    upd: { col: "cliente_nombre", puede: (a, f) => del(a, f, ...STAFF) },
  },
  consumption_entries: {
    ver: (a, f) => adm(a) || del(a, f, ...STAFF),
    ins: { fila: (a, k) => ({ reservation_id: ids["resRp" + k], monto: 1 }), puede: (a, k) => adm(a) || (es(a, ...STAFF) && a.club === k) },
    upd: { col: "monto", puede: nadie },
  },
  commissions: {
    ver: (a, f) => gerVe(a, f) || suyo(a, f, "rp"),
    ins: { fila: (a, k) => ({ reservation_id: ids["resRp" + k], rp_id: A["rp" + k].id, tipo: "rp", monto: 999, status: "pendiente" }), puede: (a) => adm(a) },
    upd: { col: "monto", puede: nadie },
  },
  rp_schedule: {
    ver: (a, f) => adm(a) || del(a, f, ...STAFF) || suyo(a, f, "rp"),
    ins: { fila: (a, k) => ({ rp_id: A["rp" + k].id, club_id: C(k), fecha: diaMenos(3) }), puede: (a, k) => es(a, ...STAFF) && a.club === k },
    upd: { col: "fecha", puede: nadie },
    del: { puede: (a, f) => del(a, f, ...STAFF) },
  },
  rp_attendance: {
    ver: (a, f) => adm(a) || del(a, f, ...STAFF) || suyo(a, f, "rp"),
    ins: { fila: (a, k, i) => ({ rp_id: A["rp" + k].id, club_id: C(k), fecha: diaMenos(10 + i), metodo: "manual" }), puede: (a, k) => es(a, ...STAFF) && a.club === k },
    upd: { col: "metodo", puede: nadie },
  },
  rp_pagos_dia: {
    ver: (a, f) => gerVe(a, f) || suyo(a, f, "rp"),
    ins: { fila: (a, k) => ({ rp_attendance_id: ids["asist-rp" + k], rp_id: A["rp" + k].id, club_id: C(k), fecha: HOY, posicion: 9, monto: 1 }), puede: (a) => adm(a) },
    upd: { col: "monto", puede: nadie },
  },
  club_dia_tarifas: {
    ver: gerVe,
    ins: { fila: (a, k, i) => ({ club_id: C(k), posicion: 20 + i, monto: 1 }), puede: (a, k) => adm(a) || (es(a, ...GER) && a.club === k) },
    upd: { col: "monto", puede: gerVe },
    del: { puede: gerVe },
  },
  rp_comision_overrides: {
    ver: (a, f) => gerVe(a, f) || suyo(a, f, "rp"),
    ins: { fila: (a, k) => ({ club_id: C(k), rp_id: A["rp2" + k].id, comision_tipo: "fijo", comision_monto: 1, comision_desbloqueo_reservas: 0 }), puede: (a, k) => adm(a) || (es(a, ...GER) && a.club === k) },
    upd: { col: "comision_monto", puede: gerVe },
    del: { puede: gerVe },
  },
  rp_dia_tarifa_overrides: {
    ver: gerVe,
    ins: { fila: (a, k, i) => ({ club_id: C(k), rp_id: A["rp2" + k].id, posicion: 20 + i, monto: 1 }), puede: (a, k) => adm(a) || (es(a, ...GER) && a.club === k) },
    upd: { col: "monto", puede: gerVe },
    del: { puede: gerVe },
  },
  verificacion_documentos: {
    ver: (a, f) => adm(a) || del(a, f, "dueno"),
    ins: { fila: (a, k) => ({ club_id: C(k), tipo: "identificacion", storage_path: `${C(k)}/identificacion-${TAG}-${a.key}.pdf` }), puede: (a, k) => es(a, "dueno") && a.club === k, clubs: ["A", "B", "C"] },
    upd: { col: "storage_path", puede: nadie },
  },
  ...Object.fromEntries(["caja_noches", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "caja_eventos", "caja_permisos", "productos"].map((t) => [t, {
    ver: cajaVe,
    ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie },
    upd: { col: "club_id", puede: nadie },
  }])),
  ...Object.fromEntries(["producto_movimientos", "reglas_comision", "config_rp_cambios", "club_config_rp"].map((t) => [t, {
    ver: gerVe,
    ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie },
    upd: { col: t === "club_config_rp" ? "nivel_visibilidad" : "club_id", puede: nadie },
  }])),
  personal_movimientos: { ver: gerVe, ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie }, upd: { col: "motivo", puede: nadie } },
  suscripciones: { ver: (a, f) => adm(a) || del(a, f, "dueno"), ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie }, upd: { col: "estado", puede: nadie } },
  pagos_mensualidad: { ver: (a, f) => adm(a) || del(a, f, "dueno"), ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie }, upd: { col: "estado", puede: nadie } },
  grupos: {
    ver: (a, f) => adm(a) || (a.key === "duenoGrupo" && f.etiqueta === "G"),
    ins: { fila: (a) => ({ nombre: `${TAG} ins ${a.key}` }), puede: adm, clubs: ["-"] },
    upd: { col: "nombre", puede: adm },
    del: { puede: adm },
  },
  grupo_clubs: {
    ver: (a, f) => adm(a) || (a.key === "duenoGrupo" && f.club === "A"),
    ins: { fila: (a, k) => ({ grupo_id: ids.grupoH, club_id: C(k) }), puede: adm },
    upd: { col: "agregado_en", puede: adm },
    del: { puede: adm },
  },
  grupo_miembros: {
    ver: (a, f) => adm(a) || f.perfil === a.key,
    ins: { fila: (a) => ({ grupo_id: ids.grupoH, profile_id: a.id ?? A.cliente.id, rol_grupo: "dueno_grupo" }), puede: adm, clubs: ["-"] },
    upd: { col: "rol_grupo", puede: adm },
    del: { puede: adm },
  },
  aceptaciones_legales: {
    ver: (a, f) => adm(a) || f.perfil === a.key,
    ins: { fila: (a) => ({ profile_id: a.id ?? A.cliente.id, documento: "privacidad", version: "2026-11-24-borrador" }), puede: (a) => a.tipo !== "anon", clubs: ["-"] },
    upd: { col: "documento", puede: nadie },
  },
  club_altas: { ver: adm, ins: { fila: () => ({ alta_id: randomUUID(), creado_por: A.admin.id, publicado: false }), puede: nadie, clubs: ["-"] }, upd: { col: "publicado", puede: nadie } },
  app_errores: { ver: adm, ins: { fila: () => ({ mensaje: TAG }), puede: nadie, clubs: ["-"] }, upd: { col: "mensaje", puede: nadie } },
  planes: {
    ver: (a) => adm(a) || es(a, "dueno"),
    ins: { fila: (a) => ({ clave: `${TAG}-${a.key.toLowerCase()}`, nombre: TAG, stripe_price_id: `price_${TAGX}${a.key}` }), puede: adm, clubs: ["-"] },
    upd: { col: "nombre", puede: adm },
    del: { puede: nadie },
  },
};
SPEC.club_config_rp.pk = "club_id";
SPEC.suscripciones.pk = "club_id";
SPEC.grupo_clubs.pk = "club_id";
SPEC.grupo_miembros.pk = "profile_id";
// Globales sin filas propias: se mide si se ve alguna.
const GLOBALES = {
  config_plataforma: { ver: adm, ins: { clave: TAG, valor: true }, upd: ["clave", "mensualidad_real", "valor"] },
  versiones_legales: { ver: (a) => a.tipo !== "anon", ins: { version: TAG }, upd: ["version", "2026-11-24-borrador", "version"] },
  // Solo service_role (sin GRANT para anon ni authenticated): nadie las ve ni escribe, ni el admin.
  login_intentos: { ver: nadie, ins: { email_hash: TAG, ip_hash: TAG, exito: false } },
  registro_intentos: { ver: nadie, ins: { ip_hash: IPH, tipo: "cliente" }, upd: ["ip_hash", IPH, "tipo"] },
  stripe_eventos: { ver: nadie, ins: { id: `evt_${TAGX}x`, tipo: "prueba" }, upd: ["id", `evt_${TAGX}`, "tipo"] },
  alertas_enviadas: { ver: nadie, ins: { tipo: TAG + "x" }, upd: ["tipo", TAG, "tipo"] },
};

// ---------------------------------------------------------------- matriz
const ACTORES = () => ["anon", "sinperfil", "cliente", "rpA", "staffA", "gerenteA", "duenoA", "rpB", "staffB", "gerenteB", "duenoB", "duenoGrupo", "admin", "staffBajaA", "rpBaja", "gerenteTemp", "rpTemp", "duenoTemp", "gerenteSinClub"].map((k) => A[k]);
const matriz = {}; // tabla -> actor -> { S, I, U, D, mal: [] }
const celda = (t, a) => ((matriz[t] ??= {})[a] ??= { S: "", I: "", U: "", D: "", mal: [] });
const permitidoPorRls = (e) => !e || ["23505", "23503", "23502", "23514"].includes(e.code); // pasó RLS; chocó con datos

async function correrTabla(t, spec) {
  const fs = filas[t] ?? [];
  const pk = spec.pk ?? fs[0]?.pk ?? "id";
  if (!fs.length) avisos.push(`${t}: sin filas de prueba (SELECT sin contenido)`);
  // SELECT
  await Promise.all(ACTORES().map(async (a) => {
    const r = await a.c.from(t).select(pk).in(pk, fs.map((f) => f.id));
    const vistos = new Set((r.data ?? []).map((x) => String(x[pk])));
    const c = celda(t, a.key);
    const vis = [];
    for (const f of fs) {
      const deb = !!spec.ver(a, f), obt = vistos.has(String(f.id));
      if (obt) vis.push(f.etiqueta);
      anotar(t, `SELECT ${f.etiqueta}`, a.key, deb, obt, r.error ? r.error.code : "");
      if (deb !== obt) c.mal.push(`S:${f.etiqueta}`);
    }
    c.S = vis.length ? (vis.length === fs.length ? "todo" : [...new Set(fs.filter((f) => vistos.has(String(f.id))).map((f) => f.club ?? "·"))].join("") || "·") : "—";
  }));
  // INSERT
  if (spec.ins) {
    for (const k of spec.ins.clubs ?? ["A", "B"]) {
      await Promise.all(ACTORES().map(async (a, i) => {
        const valores = spec.ins.fila(a, k === "-" ? "A" : k, i);
        const r = await a.c.from(t).insert(valores);
        const obt = permitidoPorRls(r.error);
        const deb = !!spec.ins.puede(a, k === "-" ? "A" : k);
        anotar(t, `INSERT ${k === "-" ? "" : k}`, a.key, deb, obt, r.error ? `${r.error.code} ${r.error.message.slice(0, 70)}` : "");
        const c = celda(t, a.key);
        if (obt) c.I += k === "-" ? "✓" : k;
        if (deb !== obt) c.mal.push(`I:${k}`);
      }));
    }
  }
  // UPDATE (mismo valor: mide el permiso sin cambiar datos)
  if (spec.upd) {
    const blancos = fs.filter((f) => f.upd);
    const cols = ok(await svc.from(t).select(`${pk}, ${spec.upd.col}`).in(pk, blancos.map((f) => f.id)), "valores " + t);
    await Promise.all(ACTORES().map(async (a) => {
      for (const f of blancos) {
        const valor = cols.find((x) => String(x[pk]) === String(f.id))?.[spec.upd.col];
        const r = await a.c.from(t).update({ [spec.upd.col]: valor }, { count: "exact" }).eq(pk, f.id);
        const obt = !r.error && (r.count ?? 0) > 0;
        const deb = !!spec.upd.puede(a, f);
        anotar(t, `UPDATE ${f.etiqueta}`, a.key, deb, obt, r.error ? `${r.error.code} ${r.error.message.slice(0, 70)}` : "");
        const c = celda(t, a.key);
        if (obt) c.U += f.club ?? "✓";
        if (deb !== obt) c.mal.push(`U:${f.etiqueta}`);
      }
    }));
  }
  // DELETE (filas de sacrificio; si alguien borra, se restaura)
  const blancosDel = fs.filter((f) => f.del);
  const objetivo = blancosDel.length ? blancosDel : fs.filter((f) => f.upd);
  const puedeBorrar = spec.del?.puede ?? nadie;
  for (const f of objetivo) {
    const original = ok(await svc.from(t).select("*").eq(pk, f.id).maybeSingle(), "respaldo " + t);
    for (const a of ACTORES()) {
      const r = await a.c.from(t).delete({ count: "exact" }).eq(pk, f.id);
      const obt = !r.error && (r.count ?? 0) > 0;
      const deb = !!puedeBorrar(a, f);
      anotar(t, `DELETE ${f.etiqueta}`, a.key, deb, obt, r.error ? `${r.error.code} ${r.error.message.slice(0, 70)}` : "");
      const c = celda(t, a.key);
      if (obt) c.D += f.club ?? "✓";
      if (deb !== obt) c.mal.push(`D:${f.etiqueta}`);
      if (obt && original) {
        const re = await svc.from(t).insert(original);
        if (re.error) avisos.push(`no se pudo restaurar ${t} ${f.etiqueta}: ${re.error.message}`);
      }
    }
  }
}

async function correrGlobal(t, g) {
  await Promise.all(ACTORES().map(async (a) => {
    const r = await a.c.from(t).select("*", { count: "exact", head: true });
    const obt = !r.error && (r.count ?? 0) > 0;
    anotar(t, "SELECT (alguna fila)", a.key, !!g.ver(a), obt, r.error ? r.error.code : "");
    const c = celda(t, a.key);
    c.S = obt ? "todo" : "—";
    if (!!g.ver(a) !== obt) c.mal.push("S");
    const i = await a.c.from(t).insert(g.ins);
    const io = permitidoPorRls(i.error);
    anotar(t, "INSERT", a.key, false, io, i.error ? i.error.code : "");
    if (io) { c.I = "✓"; c.mal.push("I"); await svc.from(t).delete().eq(Object.keys(g.ins)[0], Object.values(g.ins)[0]); }
    if (!g.upd) return;
    const [filtro, valor, col] = g.upd;
    const actual = (await svc.from(t).select(col).eq(filtro, valor).maybeSingle()).data;
    if (actual) {
      const u = await a.c.from(t).update({ [col]: actual[col] }, { count: "exact" }).eq(filtro, valor);
      const uo = !u.error && (u.count ?? 0) > 0;
      anotar(t, "UPDATE", a.key, false, uo, u.error ? u.error.code : "");
      if (uo) { c.U = "✓"; c.mal.push("U"); }
    }
  }));
}

// ---------------------------------------------------------------- funciones
const NEGADO = /No tienes|Solo |solo |No autorizado|Necesitas iniciar|Inicia sesión|desactivada|No tienes acceso|Reserva no encontrada en tu antro|permission denied|Asistencia inválida|Una de las cuentas/i;
async function rpc(grupo, nombre, args, puede, { autorizado, etiqueta } = {}) {
  await Promise.all(ACTORES().map(async (a) => {
    const r = await a.c.rpc(nombre, args);
    const obt = autorizado ? autorizado(r, a) : !r.error || !NEGADO.test(r.error.message);
    anotar(grupo, etiqueta ?? nombre, a.key, !!puede(a), obt, r.error ? `${r.error.code} ${r.error.message.slice(0, 80)}` : "");
  }));
}
const isoSemana = (f) => {
  const d = new Date(f + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const anio = d.getUTCFullYear();
  return { anio, semana: 1 + Math.round(((d - Date.UTC(anio, 0, 4)) / 86400e3 - 3 + ((new Date(Date.UTC(anio, 0, 4)).getUTCDay() + 6) % 7)) / 7) };
};

async function correrFunciones() {
  const cA = C("A"), cB = C("B");
  const { anio, semana } = isoSemana(HOY);
  const gerA = (a) => adm(a) || (es(a, ...GER) && a.club === "A");
  const gerOGrupoA = (a) => gerA(a) || a.key === "duenoGrupo";
  const staffA = (a) => adm(a) || (es(a, ...STAFF) && a.club === "A");
  await rpc("RPC", "nomina_semana", { p_club_id: cA, p_anio: anio, p_semana: semana }, gerOGrupoA);
  await rpc("RPC", "grupo_rendimiento_rp", { p_club_id: cA, p_desde: diaMenos(7), p_hasta: HOY }, gerOGrupoA);
  await rpc("RPC", "actividad_club", { p_club_id: cA, p_desde: HOY, p_hasta: HOY }, gerA);
  await rpc("RPC", "personal_historial", { p_club_id: cA }, gerA);
  await rpc("RPC", "config_rp_actual", { p_club: cA }, gerA);
  await rpc("RPC", "config_rp_historial", { p_club: cA }, gerA);
  await rpc("RPC", "config_rp_cambiar_visibilidad", { p_club: cA, p_nivel: "estado_monto" }, gerA);
  await rpc("RPC", "caja_configurar_permiso", { p_club_id: cA, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: false }, (a) => adm(a) || (es(a, "dueno") && a.club === "A"));
  await rpc("RPC", "producto_guardar", { p_club_id: cA, p_id: ids.productoA, p_nombre: `Producto ${TAG}`, p_categoria: "Botellas", p_precio_centavos: 100000, p_existencias_minimas: 0, p_activo: true, p_existencias_iniciales: 0 }, gerA);
  await rpc("RPC", "nomina_cambiar_estado", { p_club_id: cA, p_rp_id: A.rpA.id, p_anio: anio, p_semana: semana, p_desde: "en_revision", p_hacia: "pendiente" }, gerA);
  await rpc("RPC", "caja_registrar_consumo", { p_cuenta_id: ids.cuenta2A, p_monto_centavos: 100, p_concepto: "t_rls" }, staffA);
  await rpc("RPC", "puerta_escanear", { p_qr: ids["qr-resPuertaA"] }, staffA);
  await rpc("RPC", "registrar_pago_dia", { p_rp_attendance_id: ids["asist-rpA"], p_rp_id: A.rpA.id, p_club_id: cA, p_fecha: HOY, p_week_start: null, p_week_end: null }, (a) => staffA(a) && a.key !== "anon");
  await rpc("RPC", "registrar_comision_reserva", { p_reservation_id: ids.resRpA, p_rp_id: A.rpA.id, p_club_id: cA, p_consumo_monto: 1, p_week_start: null, p_week_end: null }, staffA);
  await rpc("RPC", "admin_alta_club", { p: {} }, adm);
  await rpc("RPC", "caja_mis_permisos", { p_club_id: cA }, staffA, { autorizado: (r) => !r.error && Object.values(r.data ?? {}).some(Boolean) });
  await rpc("RPC", "rp_mis_reservas", { p_desde: HOY, p_hasta: HOY }, (a) => es(a, "rp"));
  await rpc("RPC", "rp_progreso_cuota", {}, (a) => es(a, "rp"));
  await rpc("RPC", "nomina_semana_mia", { p_anio: anio, p_semana: semana }, (a) => es(a, "rp"));
  await rpc("RPC", "obtener_reserva_por_qr", { p_qr: ids["qr-resOrgA"] }, () => true, {
    autorizado: (r) => !r.error && r.data?.length === 1 && !("cliente_telefono" in r.data[0]),
  });
  // Bajas de personal: con p_activo = true sobre alguien activo, quien SÍ tiene permiso recibe «ya está activo».
  const yaActivo = (r) => /ya está/.test(r.error?.message ?? "");
  await rpc("RPC", "personal_cambiar_estado", { p_profile_id: A.staffA.id, p_activo: true, p_motivo: "prueba t_rls" }, gerA, { autorizado: yaActivo, etiqueta: "personal_cambiar_estado (staff de A)" });
  await rpc("RPC", "personal_cambiar_estado", { p_profile_id: A.staffB.id, p_activo: true, p_motivo: "prueba t_rls" }, (a) => adm(a) || (es(a, ...GER) && a.club === "B"), { autorizado: yaActivo, etiqueta: "personal_cambiar_estado (staff de B)" });
  // grupo_resumen: qué antros nuestros devuelve a cada quien.
  await Promise.all(ACTORES().map(async (a) => {
    const r = await a.c.rpc("grupo_resumen", { p_desde: diaMenos(7), p_hasta: HOY });
    const vistos = new Set((r.data ?? []).map((x) => x.club_id));
    for (const [k, id] of [["A", cA], ["B", cB]]) {
      const deb = adm(a) || (es(a, ...GER) && a.club === k) || (a.key === "duenoGrupo" && k === "A");
      anotar("RPC", `grupo_resumen ve ${k}`, a.key, deb, vistos.has(id), r.error ? r.error.message.slice(0, 60) : "");
    }
  }));
}
// ---------------------------------------------------------------- candados y coherencia
async function coherencia() {
  const g = "candados";
  const intento = async (texto, quien, fn, debe) => {
    const r = await fn(A[quien].c);
    const obt = !r.error && (r.count === undefined || r.count === null || r.count > 0);
    anotar(g, texto, quien, debe, obt, r.error ? `${r.error.code} ${r.error.message.slice(0, 80)}` : "");
    return r;
  };
  const cA = C("A"), cB = C("B");
  // Perfiles: escalar rol o club, reactivarse.
  await intento("el cliente se pone rol admin", "cliente", (c) => c.from("profiles").update({ role: "admin" }, { count: "exact" }).eq("id", A.cliente.id), false);
  await intento("el RP se cambia de antro", "rpA", (c) => c.from("profiles").update({ club_id: cB }, { count: "exact" }).eq("id", A.rpA.id), false);
  await intento("el RP dado de baja se reactiva", "rpBaja", (c) => c.from("profiles").update({ activo: true }, { count: "exact" }).eq("id", A.rpBaja.id), false);
  await intento("el staff da de baja a su gerente directo", "staffA", (c) => c.from("profiles").update({ activo: false }, { count: "exact" }).eq("id", A.gerenteA.id), false);
  await intento("el gerente da de baja a un staff directo (sin motivo)", "gerenteA", (c) => c.from("profiles").update({ activo: false }, { count: "exact" }).eq("id", A.staffA.id), false);
  // Perfil propio con club ajeno (sql/2026-11-25-perfil-sin-club-ajeno.sql).
  await intento("cuenta sin perfil crea perfil dueño con club ajeno", "sinperfil", (c) => c.from("profiles").insert({ id: A.sinperfil.id, nombre: "x", role: "dueno", club_id: cA }), false);
  await intento("cuenta sin perfil crea perfil cliente con club ajeno", "sinperfil", (c) => c.from("profiles").insert({ id: A.sinperfil.id, nombre: "x", role: "cliente", club_id: cA }), false);
  await intento("cuenta sin perfil crea perfil staff", "sinperfil", (c) => c.from("profiles").insert({ id: A.sinperfil.id, nombre: "x", role: "staff" }), false);
  await intento("cuenta sin perfil crea perfil a nombre de otro", "sinperfil", (c) => c.from("profiles").insert({ id: A.sinperfil2.id, nombre: "x", role: "cliente" }), false);
  A.sinperfil2.c = await login(A.sinperfil2.email);
  await intento("registro legítimo: perfil cliente propio sin antro", "sinperfil2", (c) => c.from("profiles").insert({ id: A.sinperfil2.id, nombre: `x ${TAG}`, role: "cliente" }), true);
  // Reservas: campos fijos y puerta.
  await intento("el staff le cambia el RP a una reserva", "staffA", (c) => c.from("reservations").update({ rp_id: A.rpB.id }, { count: "exact" }).eq("id", ids.resOrgA), false);
  await intento("el staff marca «usada» sin la puerta", "staffA", (c) => c.from("reservations").update({ status: "usada" }, { count: "exact" }).eq("id", ids.resPuertaA), false);
  await intento("el cliente reserva con estado «usada»", "cliente", (c) => c.from("reservations").insert({ cliente_nombre: "x", personas: 2, fecha: HOY, club_id: cA, qr_code: `antro-${randomUUID()}`, source: "organica", cliente_id: A.cliente.id, status: "usada" }), false);
  // Antros: verificación, bono, dueño.
  await intento("el dueño se autoverifica", "duenoB", (c) => c.from("clubs").update({ estado_verificacion: "verificado" }, { count: "exact" }).eq("id", cB), false);
  await intento("el dueño se cambia el bono", "duenoA", (c) => c.from("clubs").update({ bono_organica_monto: 1 }, { count: "exact" }).eq("id", cA), false);
  await intento("el dueño regala su antro a otro dueño", "duenoA", (c) => c.from("clubs").update({ dueno_id: A.duenoB.id }, { count: "exact" }).eq("id", cA), false);
  // Crear antros (se borran al momento).
  const crear = async (quien, debe, texto) => {
    const nombre = `T rls nuevo ${TAG} ${quien}`;
    const r = await intento(texto, quien, (c) => c.from("clubs").insert({ nombre, direccion: "x", horario: "x", dueno_id: A[quien].id }), debe);
    await svc.from("clubs").delete().eq("nombre", nombre);
    return r;
  };
  await crear("sinperfil", false, "cuenta sin perfil crea un antro a su nombre");
  await crear("cliente", false, "un cliente crea un antro a su nombre");
  await crear("rpA", false, "un RP crea un antro a su nombre");
  await crear("duenoA", false, "un dueño con antro crea un segundo antro (rompe /dueno/panel)");
  await crear("duenoTemp", false, "dueño con contraseña temporal crea otro antro");
  await crear("duenoGrupo", true, "un dueño sin antro registra el suyo (auto-registro)");
  // Turnos y tarifas para un RP de otro antro.
  await intento("el staff de A le asigna turno a un RP de B en A", "staffA", (c) => c.from("rp_schedule").insert({ rp_id: A.rpB.id, club_id: cA, fecha: diaMenos(5) }), false);
  await intento("el staff de A registra asistencia de un RP de B en A", "staffA", (c) => c.from("rp_attendance").insert({ rp_id: A.rpB.id, club_id: cA, fecha: diaMenos(5), metodo: "manual" }), false);
  await intento("el gerente de A pone tarifa propia a un RP de B", "gerenteA", (c) => c.from("rp_comision_overrides").insert({ club_id: cA, rp_id: A.rpB.id, comision_tipo: "fijo", comision_monto: 1, comision_desbloqueo_reservas: 0 }), false);
  await intento("el gerente de A pone tarifa por día a un RP de B", "gerenteA", (c) => c.from("rp_dia_tarifa_overrides").insert({ club_id: cA, rp_id: A.rpB.id, posicion: 30, monto: 1 }), false);
  // Grupo y legales.
  await intento("el dueño de grupo se mete a otro grupo", "duenoGrupo", (c) => c.from("grupo_miembros").insert({ grupo_id: ids.grupoH, profile_id: A.duenoGrupo.id, rol_grupo: "dueno_grupo" }), false);
  await intento("el cliente acepta legales a nombre del RP", "cliente", (c) => c.from("aceptaciones_legales").insert({ profile_id: A.rpA.id, documento: "terminos", version: "2026-11-24-borrador" }), false);
  // NULL en nómina: transición nula.
  await intento("nomina_cambiar_estado con transición NULL", "gerenteA", (c) => c.rpc("nomina_cambiar_estado", { p_club_id: cA, p_rp_id: A.rpA.id, p_anio: isoSemana(HOY).anio, p_semana: isoSemana(HOY).semana, p_desde: null, p_hacia: null }), false);
  // Gerente sin antro (perfil anómalo) da de baja a staff de B.
  const r = await A.gerenteSinClub.c.rpc("personal_cambiar_estado", { p_profile_id: A.staffB.id, p_activo: false, p_motivo: "prueba t_rls" });
  const bajo = !r.error;
  anotar(g, "gerente sin antro da de baja a staff de otro antro", "gerenteSinClub", false, bajo, r.error?.message?.slice(0, 80) ?? "LO DIO DE BAJA");
  if (bajo) {
    const db = await conectarDevEscritura();
    try { await db.q("begin"); await db.q("select set_config('antroapp.cambio_personal','si',true)"); await db.q("update public.profiles set activo = true where id = $1", [A.staffB.id]); await db.q("commit"); } finally { await db.fin(); }
  }
}

// ---------------------------------------------------------------- storage
async function storage() {
  const g = "storage";
  const png = ids.png, pdf = ids.pdf;
  const subir = async (a, bucket, ruta, cuerpo, tipo) => {
    const r = await a.c.storage.from(bucket).upload(ruta, cuerpo, { contentType: tipo, upsert: false });
    if (!r.error) await svc.storage.from(bucket).remove([ruta]);
    return !r.error;
  };
  for (const a of ACTORES()) {
    for (const k of ["A", "B", "C"]) {
      const ruta = `${C(k)}/${TAG}-${a.key}.png`;
      anotar(g, `club-photos subir a ${k}`, a.key, adm(a) || (es(a, "dueno") && a.club === k), await subir(a, "club-photos", ruta, png, "image/png"));
      const doc = `${C(k)}/identificacion-${TAG}-${a.key}.pdf`;
      anotar(g, `verificacion-docs subir a ${k}`, a.key, es(a, "dueno") && a.club === k, await subir(a, "verificacion-docs", doc, pdf, "application/pdf"));
    }
    for (const k of ["A", "B"]) {
      const d = await a.c.storage.from("verificacion-docs").download(`${C(k)}/comprobante_fiscal-${TAG}.pdf`);
      anotar(g, `verificacion-docs leer de ${k}`, a.key, adm(a) || (es(a, "dueno") && a.club === k), !d.error && !!d.data);
      const l = await a.c.storage.from("verificacion-docs").list(C(k));
      anotar(g, `verificacion-docs listar ${k}`, a.key, adm(a) || (es(a, "dueno") && a.club === k), (l.data ?? []).some((o) => o.name.includes(TAG)));
      // Borrar la foto de prueba (se vuelve a subir si alguien la borra).
      const ruta = `${C(k)}/${TAG}-borrar.png`;
      const b = await a.c.storage.from("club-photos").remove([ruta]);
      const borro = !b.error && (b.data ?? []).length > 0;
      anotar(g, `club-photos borrar en ${k}`, a.key, adm(a) || (es(a, "dueno") && a.club === k), borro);
      if (borro) await svc.storage.from("club-photos").upload(ruta, png, { contentType: "image/png" });
      const rutaDoc = `${C(k)}/comprobante_fiscal-${TAG}.pdf`;
      const bd = await a.c.storage.from("verificacion-docs").remove([rutaDoc]);
      const borroDoc = !bd.error && (bd.data ?? []).length > 0;
      anotar(g, `verificacion-docs borrar en ${k}`, a.key, es(a, "dueno") && a.club === k, borroDoc);
      if (borroDoc) await svc.storage.from("verificacion-docs").upload(rutaDoc, pdf, { contentType: "application/pdf" });
    }
  }
  // Bucket público como hosting: un dueño (o cualquiera que registre un antro) sube HTML o un archivo enorme.
  const html = await A.duenoA.c.storage.from("club-photos").upload(`${C("A")}/${TAG}.html`, Buffer.from("<script>alert(1)</script>"), { contentType: "text/html", upsert: true });
  let tipoServido = "";
  if (!html.error) {
    const url = svc.storage.from("club-photos").getPublicUrl(`${C("A")}/${TAG}.html`).data.publicUrl;
    tipoServido = (await fetch(url)).headers.get("content-type") ?? "";
    await svc.storage.from("club-photos").remove([`${C("A")}/${TAG}.html`]);
  }
  anotar(g, "club-photos acepta HTML", "duenoA", false, !html.error, tipoServido ? `se sirve como ${tipoServido}` : html.error?.message ?? "");
  const grande = await A.duenoA.c.storage.from("club-photos").upload(`${C("A")}/${TAG}-grande.png`, Buffer.alloc(11 * 1024 * 1024, 1), { contentType: "image/png", upsert: true });
  if (!grande.error) await svc.storage.from("club-photos").remove([`${C("A")}/${TAG}-grande.png`]);
  anotar(g, "club-photos acepta 11 MB", "duenoA", false, !grande.error, grande.error?.message ?? "");
}

// ---------------------------------------------------------------- rutas con service role
async function rutas() {
  const g = "rutas";
  const vivo = await fetch(BASE + "/api/salud", { signal: AbortSignal.timeout(60000) }).then((r) => r.status).catch(() => 0);
  if (!vivo) { avisos.push(`rutas: no hay servidor en ${BASE} (saltadas)`); return; }
  const web = async (quien) => {
    const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ email: A[quien].email, password: PASS }) });
    return { status: r.status, galletas: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  };
  const post = (ruta, galletas, cuerpo) => fetch(BASE + ruta, { method: "POST", headers: { "content-type": "application/json", cookie: galletas }, body: JSON.stringify(cuerpo) });
  // Gerente con contraseña temporal: ¿crea RPs antes de cambiarla?
  const ger = await web("gerenteTemp");
  const correoNuevo = `${TAG}_creado_por_temp@example.com`;
  creados.correos.push(correoNuevo);
  const cs = await post("/api/admin/create-staff", ger.galletas, { email: correoNuevo, password: PASS, nombre: "RP t_rls", role: "rp", club_id: C("A") });
  anotar(g, "create-staff con contraseña temporal sin cambiar", "gerenteTemp", false, cs.status === 200, `login ${ger.status}, create-staff ${cs.status}`);
  // Control: el gerente normal sí crea.
  const gn = await web("gerenteA");
  const correoCtl = `${TAG}_creado_por_gerente@example.com`;
  creados.correos.push(correoCtl);
  const cs2 = await post("/api/admin/create-staff", gn.galletas, { email: correoCtl, password: PASS, nombre: "RP t_rls", role: "rp", club_id: C("A") });
  anotar(g, "create-staff del gerente normal (control)", "gerenteA", true, cs2.status === 200, `create-staff ${cs2.status}`);
  const cs3 = await post("/api/admin/create-staff", gn.galletas, { email: `${TAG}_x@example.com`, password: PASS, nombre: "RP", role: "rp", club_id: C("B") });
  anotar(g, "create-staff del gerente de A en el antro B", "gerenteA", false, cs3.status === 200, `create-staff ${cs3.status}`);
  // Dueño con contraseña temporal y la mensualidad de su antro.
  const due = await web("duenoTemp");
  const ck = await post("/api/mensualidad/checkout", due.galletas, { club_id: C("C"), plan_id: creados.planes[0] });
  anotar(g, "mensualidad con contraseña temporal sin cambiar", "duenoTemp", false, ck.status !== 403 && ck.status !== 401, `checkout ${ck.status}`);
}

// ---------------------------------------------------------------- limpieza
async function limpiar() {
  const clubIds = Object.values(creados.clubs);
  const db = await conectarDevEscritura();
  let borradas = 0;
  try {
    // Cuentas creadas por las rutas (por correo).
    const extra = await db.q("select id from auth.users where email like $1", [`${TAG}%`]);
    const perfiles = [...new Set([...creados.usuarios, ...extra.map((x) => x.id)])];
    const refs = await db.q(`select c.conrelid::regclass::text as tabla, a.attname as col, c.confrelid::regclass::text as ref
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confrelid::regclass::text in ('profiles', 'clubs', 'grupos', 'planes')`);
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    const borrar = async (sql, p) => {
      await db.q("savepoint s");
      try { const r = await db.cliente.query(sql, p); borradas += r.rowCount; await db.q("release savepoint s"); return true; } catch { await db.q("rollback to savepoint s"); return false; }
    };
    const conjuntos = { profiles: perfiles, clubs: clubIds, grupos: creados.grupos, planes: creados.planes };
    for (let vuelta = 0; vuelta < 8; vuelta++) {
      let pendientes = 0;
      await borrar("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const f of refs) {
        if (f.tabla === "clubs" && f.col === "dueno_id") continue;
        const ok2 = await borrar(`delete from ${f.tabla} where ${f.col} = any($1::uuid[])`, [conjuntos[f.ref]]);
        if (!ok2) pendientes++;
      }
      if (!pendientes) break;
    }
    await borrar("delete from public.clubs where id = any($1::uuid[]) or nombre like $2", [clubIds, `T rls nuevo ${TAG}%`]);
    await borrar("delete from public.grupos where id = any($1::uuid[]) or nombre like $2", [creados.grupos, `${TAG}%`]);
    await borrar("delete from public.planes where clave like $1", [`${TAG}%`]);
    await borrar("delete from public.app_errores where mensaje like $1 or ruta like $2", [`%${TAG}%`, `%${TAG}%`]);
    for (const t of ["login_intentos", "registro_intentos"]) await borrar(`delete from public.${t} where ip_hash = any($1)`, [[TAG, IPH]]);
    await borrar("delete from public.alertas_enviadas where tipo like $1", [`${TAG}%`]);
    await borrar("delete from public.stripe_eventos where id = $1", [`evt_${TAGX}`]);
    await borrar("delete from public.alertas_enviadas where tipo = $1", [TAG]);
    await borrar("delete from public.profiles where id = any($1::uuid[])", [perfiles]);
    await db.q("commit");
    for (const b of ["club-photos", "verificacion-docs"]) for (const id of clubIds) {
      const l = await svc.storage.from(b).list(id, { limit: 1000 });
      const rutas = (l.data ?? []).map((o) => `${id}/${o.name}`);
      if (rutas.length) await svc.storage.from(b).remove(rutas);
    }
    for (const id of perfiles) await svc.auth.admin.deleteUser(id);
    const quedan = await db.q("select (select count(*) from public.clubs where nombre like $1)::int as clubs, (select count(*) from auth.users where email like $2)::int as cuentas, (select count(*) from public.profiles where nombre like $3)::int as perfiles", [`T rls%${TAG}%`, `${TAG}%`, `%${TAG}%`]);
    console.log(`\nLimpieza: ${borradas} filas, ${perfiles.length} cuentas. Quedan: ${JSON.stringify(quedan[0])}`);
    if (quedan[0].clubs || quedan[0].cuentas || quedan[0].perfiles) avisos.push("la limpieza dejó restos: " + JSON.stringify(quedan[0]));
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("Limpieza falló: " + e.message);
    avisos.push("limpieza falló: " + e.message);
  } finally {
    await db.fin();
  }
}

// ---------------------------------------------------------------- reporte
function markdown(est) {
  const act = ACTORES().filter(Boolean).map((a) => a.key);
  let md = `<!-- generado por scripts/dev/auditoria-rls.mjs ${new Date().toISOString()} -->\n`;
  md += `Celdas: **S** = filas de prueba que ve (A, B, C, «todo» o —), **I/U/D** = en qué antro pudo insertar, actualizar o borrar. ⚠ = distinto de lo esperado.\n\n`;
  for (const t of Object.keys(matriz).sort()) {
    md += `#### ${t}\n\n| Sesión | S | I | U | D |\n|---|---|---|---|---|\n`;
    for (const a of act) {
      const c = matriz[t][a];
      if (!c) continue;
      md += `| ${a} | ${c.S || "—"} | ${c.I || "—"} | ${c.U || "—"} | ${c.D || "—"} |${c.mal.length ? " ⚠ " + c.mal.join(" ") : ""}\n`;
    }
    md += "\n";
  }
  md += "#### Funciones, candados, storage y rutas\n\n| Grupo | Prueba | Sesión | Esperado | Obtenido |\n|---|---|---|---|---|\n";
  for (const r of resultados.filter((x) => ["RPC", "candados", "storage", "rutas"].includes(x.grupo) && (x.esperado || x.obtenido || !x.ok)))
    md += `| ${r.grupo} | ${r.prueba} | ${r.actor} | ${r.esperado ? "sí" : "no"} | ${r.obtenido ? "sí" : "no"}${r.ok ? "" : " ⚠"} |\n`;
  md += `\n#### Escaneo de NULL (${est.total} funciones; ${est.filas.length} con patrón)\n\n| Función | Patrón | Veredicto |\n|---|---|---|\n`;
  for (const f of est.filas) md += `| \`${f.firma}\` | ${f.golpes.join(", ")} | ${f.veredicto} |\n`;
  return md;
}

// ---------------------------------------------------------------- principal
let est = { total: 0, filas: [] };
try {
  console.log(`Auditoría RLS contra antroapp-dev (marca ${TAG})`);
  await escenario();
  console.log(`Escenario listo: ${Object.keys(A).length} sesiones, ${Object.values(filas).flat().length} filas de prueba.`);
  const tablas = (await (async () => { const db = await conectarDevEscritura(); try { return await db.q(`select c.relname as t, c.relrowsecurity as rls from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') order by 1`); } finally { await db.fin(); } })());
  for (const { t, rls } of tablas) {
    anotar("tablas", `${t} tiene RLS`, "-", true, rls);
    if (SPEC[t]) await correrTabla(t, SPEC[t]);
    else if (GLOBALES[t]) await correrGlobal(t, GLOBALES[t]);
    else {
      // Tabla nueva sin matriz: nadie que no sea admin debería ver filas sin que alguien lo decida.
      const vistas = await Promise.all(ACTORES().map(async (a) => [a.key, (await a.c.from(t).select("*", { count: "exact", head: true })).count ?? 0]));
      avisos.push(`tabla sin matriz: ${t} (filas visibles: ${vistas.filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(", ") || "ninguna"})`);
    }
  }
  await correrFunciones();
  await coherencia();
  await storage();
  await rutas();
  const db = await conectarDevEscritura();
  try { est = await escaneoEstatico(db); } finally { await db.fin(); }
} catch (e) {
  anotar("ejecución", "error inesperado", "-", true, false, e.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  await limpiar();
  const malas = resultados.filter((r) => !r.ok);
  const porGrupo = {};
  const ESPECIALES = ["RPC", "candados", "storage", "rutas", "NULL", "ejecución"];
  for (const r of resultados) {
    const g = (porGrupo[ESPECIALES.includes(r.grupo) ? r.grupo : "tablas"] ??= { ok: 0, mal: 0 });
    if (r.ok) g.ok++; else g.mal++;
  }
  console.log("\nResumen:", Object.entries(porGrupo).map(([k, v]) => `${k} ${v.ok}/${v.ok + v.mal}`).join(" · "));
  for (const a of avisos) console.log("AVISO  " + a);
  if (MARKDOWN) { writeFileSync(MARKDOWN, markdown(est)); console.log("Matriz en " + MARKDOWN); }
  const sinVeredicto = est.filas.filter((f) => f.veredicto === "SIN REVISAR").length;
  console.log(`\n${resultados.length - malas.length} coinciden, ${malas.length} no coinciden${sinVeredicto ? `, ${sinVeredicto} funciones sin veredicto` : ""}`);
  if (malas.length || (ESTRICTO && sinVeredicto)) process.exitCode = 1;
}
