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
//  6. Post-junta-3 (bloque 9, 27/11/2026): banderas por antro encendidas por
//     el admin solo para A y B; datos por el camino real (POS, lista negra,
//     WhatsApp, inventario, propinas); matriz de las tablas nuevas (las de
//     solo funciones en SIN_API_PJ3, las de propinas con SELECT en SPEC);
//     quién puede llamar cada función nueva con la bandera de A apagada
//     (permiso antes que bandera) y encendida; cruces entre antros; y el
//     catálogo (GRANT de anon/authenticated y search_path fijo). Antifraude
//     (30) incluido desde la parte 3 (marcas «ANTIFRAUDE»): 6 tablas sin API.
//
//   node scripts/dev/auditoria-rls.mjs --limpiar=t_rls_xxxxxx   (restos de una corrida cortada)
//   AUDITORIA_TRAZA=1 …                                          (imprime cada tabla y fase)
//
// Termina con 0 si todo lo esperado coincide con lo obtenido.
// Nunca toca producción: verificarEnvDev() aborta si .env.dev no es de dev.
// No usa ni modifica los datos de Club Demo Dev ni los usuarios dev_*.

import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
// Cada petición con tope de 90 s: una petición colgada (red o gateway) sale como error en vez de dejar
// el proceso esperando para siempre sin llegar a la limpieza (pasó en dev el 27/11/2026).
const conTope = (url, o = {}) => fetch(url, { ...o, signal: o.signal ?? AbortSignal.timeout(90000) });
const opts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: conTope } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const BASE = (arg("base") ?? "http://localhost:3026").replace(/\/$/, "");
const MARKDOWN = arg("markdown");
const ESTRICTO = process.argv.includes("--estricto");

// --limpiar=t_rls_xxxxxx: solo borra los restos de una corrida cortada (p. ej. un proceso matado) y sale.
const LIMPIAR = arg("limpiar");
if (LIMPIAR && !/^t_rls_[0-9a-f]{6}$/.test(LIMPIAR)) throw new Error("--limpiar espera una marca t_rls_xxxxxx");
const TAG = LIMPIAR ?? "t_rls_" + randomUUID().slice(0, 6);
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
// Lecturas de la service role con reintento: la base de dev la comparten
// varios agentes y un DDL ajeno (aplicar-dev en una transacción) puede tener
// la tabla bloqueada unos segundos (57014 statement timeout / 55P03 lock).
async function leer(fn, d) {
  for (let i = 0; ; i++) {
    const r = await fn();
    if (!r.error || i >= 4 || !["57014", "55P03"].includes(r.error.code)) return ok(r, d);
    await espera(5000 * (i + 1));
  }
}

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
  "_admin_alta_club_base(jsonb)": "seguro: es el cuerpo de admin_alta_club renombrado por b-alta 12; solo service_role lo ejecuta y repite la puerta de admin (is distinct from), con el mismo «v_rol not in» que rechaza el INSERT en profiles.role (not null)",
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
  // Post-junta-3 (revisado el 27/11/2026; las demás funciones de 00–81 envuelven cada «if not» en coalesce(…, false)).
  "para_clubes_contacto_enviar(text,text,text,text,text,text,text,text)": "seguro: «if not para_clubes_activa()» y para_clubes_activa() es coalesce((select activa …), false): nunca NULL; no autoriza por rol (lo puede llamar el anónimo a propósito)",
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
  // Ayudantes que devuelven boolean: ¿pueden dar NULL?, ¿se usan en políticas
  // o en «if not f(…)»? En una política NULL ya niega (permisiva o
  // restrictiva, también con NOT), así que el riesgo real es el «if not».
  const politicas = await db.q(`select coalesce(qual, '') || ' ' || coalesce(with_check, '') as e from pg_policies`);
  const booleanas = await db.q(`select p.proname, p.oid::regprocedure::text as firma from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prorettype = 'bool'::regtype order by 1`);
  const bool = [];
  for (const b of booleanas) {
    const firma = b.firma.replace(/^public\./, "");
    const enPoliticas = politicas.filter((p) => p.e.includes(b.proname + "(")).length;
    const enIfNot = funcs.filter((f) => !f.firma.replace(/^public[.]/, "").startsWith(`${b.proname}(`) && new RegExp(`if\\s+not\\s+(public\\.)?${b.proname}\\s*\\(`, "i").test(f.def))
      .map((f) => f.firma.replace(/^public\./, "").split("(")[0]);
    const v = VEREDICTOS_BOOL[firma];
    bool.push({ firma, enPoliticas, enIfNot, veredicto: v ?? "SIN REVISAR" });
    if (!v && (enPoliticas || enIfNot.length)) avisos.push(`ayudante boolean sin veredicto: ${firma}`);
    else if (v && /^explotable/.test(v)) anotar("NULL", firma, "-", false, true, v);
  }
  return { total: funcs.length, filas, bool };
}
const VEREDICTOS_BOOL = {
  "caja_puede_ver(uuid)": "nunca NULL: coalesce(…, false)",
  "caja_tiene_permiso(uuid,text)": "NULL solo si p_permiso es NULL («return p_permiso in (…)»); todos los que llaman pasan una constante y caja_permisos.permitido es not null",
  "club_es_dueno(uuid)": "nunca NULL: «uid is not null and rol is not null and exists(…)»",
  "club_es_dueno_grupo(uuid)": "nunca NULL: «uid is not null and rol is not null and exists(…)»",
  "dueno_tiene_club()": "nunca NULL: exists(…) (sql/post-junta-2/62)",
  "es_gerente_o_dueno(uuid)": "nunca NULL: coalesce y ramas booleanas",
  "invitacion_puede(uuid,text)": "nunca NULL: returns false / coalesce en cada rama",
  "nomina_transicion_valida(text,text)": "nunca NULL desde sql/post-junta-2/60 (antes NULL con estados nulos)",
  "puede_ver_club(uuid)": "nunca NULL: coalesce",
  "puerta_es_tarde(uuid,date,timestamp with time zone)": "NULL a propósito (antro sin tolerancia); no autoriza: solo llena reservations.llegada_tarde",
  "rp_es_del_club(uuid,uuid)": "nunca NULL: coalesce(exists(…), false) (sql/post-junta-2/64)",
  "sesion_sin_acceso()": "nunca NULL: «uid is not null and (exists(…) or coalesce(…))» (sql/post-junta-2/61)",
  "soy_rp_dado_de_baja()": "nunca NULL: exists(…)",
  // b-alta 12 (configuración por grupo; solo postgres los ejecuta, se llaman desde funciones definer).
  "_club_config_puede(uuid,text)": "nunca NULL: cada rama en coalesce(…, false)",
  "_config_aplicar_club(uuid,text,jsonb,uuid,date)": "no autoriza: devuelve si hubo cambio; solo lo ejecuta postgres (lo llaman funciones que ya autorizaron)",
  "es_dueno_de_grupo(uuid)": "nunca NULL: coalesce(uid is not null and rol = dueno and exists(…), false)",
  "grupo_puede_editar(uuid)": "nunca NULL: coalesce(… admin, false) or es_dueno_de_grupo() (nunca NULL)",
  // Post-junta-3 (00–81). Todas solo para service_role salvo boleto_muestra_codigo y para_clubes_activa (anon).
  "funcion_activa(uuid,text)": "nunca NULL: coalesce(club, grupo, false); quien la llama la envuelve además en coalesce(…, false)",
  "pos_puede_usar(uuid)": "nunca NULL: «return false» si falta sesión, antro o rol; si no, coalesce(es_gerente_o_dueno) or coalesce(club_es_dueno_grupo)",
  "_lista_negra_gestiona(uuid)": "nunca NULL: coalesce(…, false) por fuera",
  "_lista_negra_ve_avisos(uuid)": "nunca NULL: coalesce(…, false) por fuera",
  "_lista_negra_manual(uuid,text,uuid)": "nunca NULL: coalesce(exists(…), false); no autoriza (dice si hay bloqueo)",
  "_lista_negra_auto(uuid,text)": "nunca NULL: «return false» o coalesce(v_n >= …, false); no autoriza",
  "_whatsapp_trabaja(uuid)": "nunca NULL: coalesce(…, false) por fuera",
  "boleto_muestra_codigo(text)": "nunca NULL: coalesce(…, false); no autoriza (sí/no del código corto en el boleto)",
  "para_clubes_activa()": "nunca NULL: coalesce((select activa …), false)",
  // 30 antifraude (revisado el 27/11/2026: sus dos «if not» van en coalesce(…, false); el escaneo no encuentra patrones).
  "fraude_puede_revisar(uuid)": "nunca NULL: coalesce(uid is not null and rol is not null and (coalesce(es_gerente_o_dueno) or coalesce(club_es_dueno_grupo)), false)",
  "fraude_regla_activa(uuid,text)": "nunca NULL: coalesce(activa, true); no autoriza (regla encendida por defecto)",
};

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
    // Invitaciones (carril b-equipo) y bandeja de correos: filas sembradas con la service role.
    for (const rol of ["rp", "gerente"]) {
      const inv = ok(await svc.from("invitaciones").insert({ club_id: club, rol, correo: `${TAG}_inv_${rol}_${k.toLowerCase()}@example.com`, nombre: `Invitado ${TAG}` }).select("id").single(), "invitación");
      fila("invitaciones", { id: inv.id, club: k, rolInv: rol, upd: true, etiqueta: `inv-${rol}${k}` });
    }
    // Lotes de invitaciones (b-equipo, etapa 2): solo si la tabla existe en dev.
    for (const rol of ["rp", "gerente"]) {
      const lote = await svc.from("invitacion_lotes").insert({ id: randomUUID(), club_id: club, rol, total: 1 }).select("id").single();
      if (lote.error && ["PGRST205", "42P01"].includes(lote.error.code)) break;
      fila("invitacion_lotes", { id: ok(lote, "lote").id, club: k, rolInv: rol, upd: true, etiqueta: `lote-${rol}${k}` });
    }
    const cor = ok(await svc.from("correos_salida").insert({ club_id: club, plantilla: "t_rls", destinatario: `${TAG}@example.com`, asunto: "Prueba t_rls", cuerpo: "t_rls", estado: "archivado", entorno: "development" }).select("id").single(), "correo");
    fila("correos_salida", { id: cor.id, club: k, upd: true, etiqueta: "correo" + k });
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
    ids["sesion2" + k] = s2;
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
  // Post-junta-3: banderas encendidas y datos por el camino real (antes de leer las filas por antro).
  await escenarioPj3();
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
  for (const t of ["caja_noches", "mesa_sesiones", "mesa_cuentas", "caja_consumos", "caja_pagos", "caja_cuadres", "caja_eventos", "caja_permisos", "productos", "producto_movimientos", "reglas_comision", "config_rp_cambios", "personal_movimientos",
    "caja_propinas", "propinas_repartos", "propinas_reparto_lineas"]) await porClub(t);
  await porClub("club_config_rp", "club_id");
  await porClub("propinas_cobro_anuladas", "pago_id");

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

// ---------------------------------------------------------------- post-junta-3 (escenario)
// Banderas por antro (sql/post-junta-3/00): el admin las enciende para A y B
// con funcion_cambiar (nunca para otro antro); viven en club_funciones y se
// van con los antros de prueba. reportes_pdf de A llega por su grupo G
// (grupo_funcion_cambiar), para probar la herencia; B la tiene propia.
// ANTIFRAUDE (sql/post-junta-3/30, tablas fraude_*): integrado el 27/11/2026
// (bloque 9, parte 3). Bandera «antifraude»; la alerta de A y B sale de una
// búsqueda real (fraude_detectar) con la regla de ráfaga a 3 reservas.
const BANDERAS_PJ3 = ["pos_ventas", "escaner_respaldo", "lista_negra", "whatsapp", "inventario", "propinas", "antifraude"];
const pj3 = {}; // ids sembrados por el camino real
const telPrueba = () => "55" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const TEXTO_WA = `Hola {nombre}, te esperamos en {antro} (${TAG}).`;
async function escenarioPj3() {
  if (!A.admin.c) await conectar("admin");
  const ad = A.admin.c;
  for (const k of ["A", "B"]) for (const f of BANDERAS_PJ3)
    ok(await ad.rpc("funcion_cambiar", { p_club_id: C(k), p_funcion: f, p_activa: true }), `bandera ${f} ${k}`);
  ok(await ad.rpc("grupo_funcion_cambiar", { p_grupo_id: ids.grupoG, p_funcion: "reportes_pdf", p_activa: true }), "bandera de grupo");
  ok(await ad.rpc("funcion_cambiar", { p_club_id: C("B"), p_funcion: "reportes_pdf", p_activa: true }), "reportes B");
  pj3.telA = telPrueba();
  pj3.telB = telPrueba();
  for (const k of ["A", "B"]) {
    const g = A["gerente" + k].c, club = C(k);
    // POS (10): un mapeo y un archivo de una línea que se liga sola a la mesa 2 (abierta, walk-in).
    pj3["mapeo" + k] = ok(await g.rpc("pos_mapeo_guardar", { p_club_id: club, p_nombre: `Mapeo ${TAG}`, p_config: { columnas: { ticket: "Ticket", fecha: "Fecha", producto: "Producto", total: "Total" } } }), "mapeo " + k);
    pj3["lineas" + k] = [{ linea: 1, ticket: `T-${TAG}`, fecha_hora: `${HOY}T22:30`, mesa: `${TAG}-2`, producto: "Cerveza t_rls", total_centavos: 5000 }];
    pj3["hash" + k] = createHash("sha256").update(TAG + k).digest("hex");
    const imp = ok(await g.rpc("pos_importar", { p_club_id: club, p_archivo_nombre: `ventas-${TAG}.csv`, p_archivo_hash: pj3["hash" + k], p_formato: "csv", p_mapeo_id: pj3["mapeo" + k], p_lineas: pj3["lineas" + k] }), "importar " + k);
    pj3["imp" + k] = imp.importacion_id;
    // Lista negra (40): política y un bloqueo manual por antro (teléfonos distintos).
    ok(await g.rpc("lista_negra_politica_guardar", { p_club: club, p_avisar_desde: 2, p_ventana_dias: 90, p_bloquear_desde: null }), "política " + k);
    pj3["bloqueo" + k] = ok(await g.rpc("lista_negra_bloquear", { p_club: club, p_telefono: pj3["tel" + k], p_reserva_id: null, p_motivo: `prueba ${TAG}`, p_dias: null, p_nombre: "Bloqueado t_rls" }), "bloquear " + k);
    // WhatsApp (60).
    ok(await g.rpc("whatsapp_plantilla_guardar", { p_club: club, p_tipo: "confirmacion", p_texto: TEXTO_WA }), "plantilla " + k);
    // Inventario (80): una entrada por el camino nuevo.
    ok(await g.rpc("inventario_entrada", { p_producto_id: ids["producto" + k], p_cantidad: 2, p_costo_centavos: 1000, p_referencia: `factura ${TAG}`, p_clave: randomUUID() }), "entrada " + k);
    // Propinas (81): regla, una propina suelta en la mesa 2, un cobro con propina (anulada sola) y un reparto.
    ok(await g.rpc("propinas_config_guardar", { p_club_id: club, p_pct_personal: 80, p_pct_rp: 10, p_pct_casa: 10, p_incluye_gerente: false }), "regla propinas " + k);
    pj3["noche" + k] = ok(await svc.from("caja_noches").select("id").eq("club_id", club).single(), "noche " + k).id;
    pj3["propina" + k] = ok(await g.rpc("caja_registrar_propina", { p_noche_id: pj3["noche" + k], p_sesion_id: ids["sesion2" + k], p_cuenta_id: ids["cuenta2" + k], p_metodo: "efectivo", p_monto_centavos: 2000, p_nota: "prueba t_rls", p_clave: randomUUID() }), "propina " + k);
    pj3["pago" + k] = ok(await g.rpc("caja_registrar_pago", { p_sesion_id: ids["sesion2" + k], p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 5000, p_clave: randomUUID(), p_propina_centavos: 1000 }), "cobro con propina " + k);
    ok(await g.rpc("propinas_anular_de_cobro", { p_pago_id: pj3["pago" + k], p_motivo: "prueba t_rls" }), "anular propina de cobro " + k);
    // El reparto pide la noche cerrada (y la mesa 2 sigue abierta para otras pruebas): se siembra con la service role (el candado revisa la coherencia).
    const rep = ok(await svc.from("propinas_repartos").insert({ club_id: club, noche_id: pj3["noche" + k], total_centavos: 2000, pct_personal: 80, pct_rp: 10, pct_casa: 10, incluye_gerente: false, participantes: [A["staff" + k].id], hecho_por: A["gerente" + k].id }).select("id").single(), "reparto " + k);
    pj3["reparto" + k] = rep.id;
    ok(await svc.from("propinas_reparto_lineas").insert({ reparto_id: rep.id, club_id: club, tipo: "casa", profile_id: null, monto_centavos: 2000 }), "línea de reparto " + k);
  }
  // /para-clubes (50): sin tocar las banderas de plataforma (son de todos). Filas marcadas con la service role.
  ok(await svc.from("contactos_clubes").insert({ nombre: "T rls", club_nombre: "Antro t_rls", ciudad: "CDMX", correo: `${TAG}@example.com` }), "contacto");
  pj3.contacto = ok(await svc.from("contactos_clubes").select("id").eq("correo", `${TAG}@example.com`).single(), "contacto").id;
  ok(await svc.from("contacto_intentos").insert({ ip_hash: IPH, correo_hash: TAG }), "intento de contacto");
  ok(await svc.from("para_clubes_bitacora").insert({ accion: "bandera", detalle: "t_rls", hecho_por: A.admin.id }), "bitácora para-clubes");
  // Antifraude (30): regla de ráfaga a 3 reservas en 240 min, 3 reservas nuevas del RP de cada antro y una
  // búsqueda real del gerente (crea la alerta); luego una revisión y una reapertura con nota (bitácora).
  for (const k of ["A", "B"]) {
    const g = A["gerente" + k].c, club = C(k);
    ok(await g.rpc("fraude_regla_guardar", { p_club_id: club, p_regla: "rafaga", p_activa: true, p_parametros: { min_reservas: 3, minutos: 240 } }), "regla ráfaga " + k);
    ok(await svc.from("reservations").insert([1, 2, 3].map(() => ({ cliente_nombre: "Ráfaga " + TAG, cliente_telefono: telPrueba(), personas: 2, status: "pendiente", fecha: HOY, club_id: club, qr_code: "antro-" + randomUUID(), source: "rp", rp_id: A["rp" + k].id }))), "ráfaga " + k);
    ok(await g.rpc("fraude_detectar", { p_club_id: club, p_desde: HOY, p_hasta: HOY }), "detectar " + k);
    pj3["alerta" + k] = ok(await svc.from("fraude_alertas").select("id").eq("club_id", club).eq("regla", "rafaga").eq("rp_id", A["rp" + k].id).limit(1).single(), "alerta " + k).id;
    ok(await g.rpc("fraude_alerta_cambiar", { p_alerta_id: pj3["alerta" + k], p_estado: "descartada", p_nota: "Revisado en la prueba t_rls" }), "revisar alerta " + k);
    ok(await g.rpc("fraude_alerta_cambiar", { p_alerta_id: pj3["alerta" + k], p_estado: "revisar", p_nota: "Se reabre en la prueba t_rls" }), "reabrir alerta " + k);
  }
  // Ids de bitácoras para los filtros de SIN_API_PJ3.
  const uno = async (t, col, filtro) => {
    let q = svc.from(t).select(col);
    for (const [c, v] of Object.entries(filtro)) q = q.eq(c, v);
    return ok(await q.order(col).limit(1).single(), t)[col];
  };
  pj3.cambioFuncion = await uno("funciones_cambios", "id", { club_id: C("A") });
  pj3.ventaA = await uno("pos_ventas", "id", { importacion_id: pj3.impA });
  pj3.eventoLN = await uno("lista_negra_eventos", "id", { club_id: C("A"), tipo: "bloqueo" });
  pj3.cambioWA = await uno("whatsapp_plantillas_cambios", "id", { club_id: C("A") });
  pj3.claveLinea = await uno("pos_importacion_lineas", "clave", { importacion_id: pj3.impA });
  pj3.cambioRegla = await uno("fraude_reglas_cambios", "id", { club_id: C("A") });
  pj3.cambioAlerta = await uno("fraude_alertas_cambios", "id", { alerta_id: pj3.alertaA });
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
    // Con b-cliente 41 (rp-visibilidad) el RP ya no lee reservations directo: todo lo suyo sale de rp_mis_reservas.
    ver: (a, f) => adm(a) || del(a, f, ...STAFF) || (RP_LEE_RESERVAS && suyo(a, f, "rp")) || suyo(a, f, "cliente"),
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
  // invitacion_puede(): admin; dueño de su antro (cualquier rol); gerente o staff solo RPs de su antro.
  invitaciones: {
    ver: (a, f) => adm(a) || del(a, f, "dueno") || (del(a, f, "gerente", "staff") && f.rolInv === "rp"),
    ins: { fila: (a, k) => ({ club_id: C(k), rol: "rp", correo: `${TAG}_ins_${a.key.toLowerCase()}@example.com`, nombre: "Ins t_rls" }), puede: nadie },
    upd: { col: "nombre", puede: nadie },
  },
  invitacion_lotes: {
    ver: (a, f) => adm(a) || del(a, f, "dueno") || (del(a, f, "gerente", "staff") && f.rolInv === "rp"),
    ins: { fila: (a, k) => ({ id: randomUUID(), club_id: C(k), rol: "rp", total: 1 }), puede: nadie },
    upd: { col: "total", puede: nadie },
  },
  correos_salida: {
    ver: adm,
    ins: { fila: (a, k) => ({ club_id: C(k), plantilla: "t_rls", destinatario: `${TAG}@example.com`, asunto: "x", cuerpo: "x", estado: "archivado", entorno: "development" }), puede: nadie },
    upd: { col: "estado", puede: nadie },
  },
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
  // Post-junta-3 / 81 (propinas): solo lectura por la API (GRANT select y una
  // política de SELECT); escribir, solo por funciones. Las sueltas y las
  // anuladas de cobro, quien ve la caja (caja_puede_ver: admin, dueño, dueño
  // de grupo, staff y gerente activos del antro); repartos y líneas, solo
  // gerente y dueño (es_gerente_o_dueno: sin el dueño de grupo).
  ...Object.fromEntries(["caja_propinas", "propinas_cobro_anuladas"].map((t) => [t, {
    ver: cajaVe,
    ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie },
    upd: { col: t === "caja_propinas" ? "nota" : "motivo", puede: nadie },
  }])),
  ...Object.fromEntries(["propinas_repartos", "propinas_reparto_lineas"].map((t) => [t, {
    ver: gerVe,
    ins: { fila: (a, k) => ({ club_id: C(k) }), puede: nadie },
    upd: { col: t === "propinas_repartos" ? "total_centavos" : "monto_centavos", puede: nadie },
  }])),
};
SPEC.propinas_cobro_anuladas.pk = "pago_id";
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
  reserva_intentos: { ver: nadie, ins: { telefono_hash: TAG, club_id: randomUUID(), fecha: HOY } },
  invitacion_intentos: { ver: nadie, ins: { ip_hash: IPH, accion: "consultar" } },
  invitacion_envios: { ver: nadie, ins: { hecho_por: randomUUID(), invitacion_id: randomUUID(), tipo: "crear" } },
};
// Post-junta-3: tablas SIN acceso por la API (sin GRANT para anon ni
// authenticated, RLS activado y sin políticas; todo pasa por funciones). Cada
// una con una fila sembrada por el camino real (escenarioPj3): ninguna sesión
// (ni el admin) la lee, inserta, actualiza (mismo valor) ni borra. Se arma
// después del escenario porque los filtros llevan ids.
const SIN_API_PJ3 = () => ({
  // 00 banderas
  club_funciones: { filtro: { club_id: C("A"), funcion: "propinas" }, col: "activa", ins: { club_id: C("A"), funcion: "reportes_pdf", activa: true } },
  grupo_funciones: { filtro: { grupo_id: ids.grupoG, funcion: "reportes_pdf" }, col: "activa", ins: { grupo_id: ids.grupoH, funcion: "pos_ventas", activa: true } },
  funciones_cambios: { filtro: { id: pj3.cambioFuncion }, col: "activa", ins: { club_id: C("A"), funcion: "pos_ventas", activa: true } },
  // 10 POS
  pos_mapeos: { filtro: { id: pj3.mapeoA }, col: "nombre", ins: { club_id: C("A"), nombre: `x ${TAG}`, config: {} } },
  pos_importaciones: { filtro: { id: pj3.impA }, col: "archivo_nombre", ins: { club_id: C("A"), archivo_nombre: "x.csv", archivo_hash: "0".repeat(64), formato: "csv", lineas_archivo: 0, lineas_nuevas: 0, lineas_repetidas: 0, total_centavos: 0 } },
  pos_importacion_lineas: { filtro: { importacion_id: pj3.impA, clave: pj3.claveLinea }, col: "clave", ins: { importacion_id: pj3.impA, club_id: C("A"), clave: "1".repeat(64) } },
  pos_ventas: { filtro: { id: pj3.ventaA }, col: "producto", ins: { club_id: C("A"), importacion_id: pj3.impA, linea: 9, clave: "2".repeat(64), ticket: "x", fecha_hora_local: `${HOY}T22:00`, fecha_hora: new Date().toISOString(), fecha_operacion: HOY, producto: "x", cantidad: 1, total_centavos: 1, liga: "ninguna", estado_liga: "sin_mesa" } },
  // 40 lista negra
  club_bloqueos: { filtro: { id: pj3.bloqueoA }, col: "motivo", ins: { club_id: C("A"), telefono: "5500000000", motivo: "prueba t_rls" } },
  club_noshow_politica: { filtro: { club_id: C("A") }, col: "avisar_desde", ins: { club_id: C("B"), avisar_desde: 1, ventana_dias: 30 } },
  lista_negra_eventos: { filtro: { id: pj3.eventoLN }, col: "tipo", ins: { club_id: C("A"), tipo: "bloqueo" } },
  // 50 /para-clubes
  plataforma_banderas: { filtro: { clave: "para_clubes" }, col: "activa", ins: { clave: "contacto_requiere_captcha", activa: true } },
  para_clubes_bitacora: { filtro: { hecho_por: A.admin.id, detalle: "t_rls" }, col: "detalle", ins: { accion: "bandera", detalle: "t_rls" } },
  contactos_clubes: { filtro: { id: pj3.contacto }, col: "estado", ins: { nombre: "xx", club_nombre: "xx", ciudad: "xx", correo: `${TAG}x@example.com` } },
  contacto_sal: { filtro: { id: 1 }, col: "sal", ins: { id: 1, sal: "0".repeat(64) } },
  contacto_intentos: { filtro: { correo_hash: TAG }, col: "ip_hash", ins: { correo_hash: TAG + "x" } },
  // 60 WhatsApp
  club_whatsapp_plantillas: { filtro: { club_id: C("A"), tipo: "confirmacion" }, col: "texto", ins: { club_id: C("A"), tipo: "recordatorio", texto: "x" } },
  whatsapp_plantillas_cambios: { filtro: { id: pj3.cambioWA }, col: "texto", ins: { club_id: C("A"), tipo: "confirmacion", texto: "x" } },
  // 81 propinas (la configuración solo por funciones)
  propinas_config: { filtro: { club_id: C("A") }, col: "pct_casa", ins: { club_id: C("B"), pct_personal: 100, pct_rp: 0, pct_casa: 0 } },
  // 30 antifraude: nada por la API; fraude_secreto (clave del HMAC) ni siquiera para service_role
  // (por eso su «original» va fijo: la service role no la puede leer para respaldarla).
  fraude_reglas: { filtro: { club_id: C("A"), regla: "rafaga" }, col: "activa", ins: { club_id: C("A"), regla: "consumo_atipico", activa: false } },
  fraude_reglas_cambios: { filtro: { id: pj3.cambioRegla }, col: "regla", ins: { club_id: C("A"), regla: "rafaga", despues: {} } },
  fraude_alertas: { filtro: { id: pj3.alertaA }, col: "resumen", ins: { club_id: C("A"), regla: "rafaga", sujeto: TAG, ventana_inicio: HOY, ventana_fin: HOY, resumen: "x", evidencia: {} } },
  fraude_alertas_cambios: { filtro: { id: pj3.cambioAlerta }, col: "nota", ins: { alerta_id: pj3.alertaA, club_id: C("A"), de: "revisar", a: "descartada", nota: "x", resumen: "x", evidencia: {} } },
  fraude_detecciones: { filtro: { club_id: C("A") }, col: "hecho_en", ins: { club_id: C("B"), hecho_en: new Date().toISOString() } },
  fraude_secreto: { filtro: { id: true }, col: "id", ins: { id: true, clave: "0".repeat(64) }, original: { id: true } },
});

async function correrSinApi(t, g) {
  const original = g.original ?? await leer(() => svc.from(t).select("*").match(g.filtro).maybeSingle(), "respaldo " + t);
  if (!original) avisos.push(`${t}: no apareció la fila sembrada (${JSON.stringify(g.filtro)})`);
  await Promise.all(ACTORES().map(async (a) => {
    const c = celda(t, a.key);
    const s = await a.c.from(t).select("*", { count: "exact", head: true });
    const sf = await a.c.from(t).select("*").match(g.filtro);
    const so = (!s.error && (s.count ?? 0) > 0) || (sf.data ?? []).length > 0;
    anotar(t, "SELECT (alguna fila o la sembrada)", a.key, false, so, s.error?.code ?? "");
    c.S = so ? "todo" : "—";
    if (so) c.mal.push("S");
    const i = await a.c.from(t).insert(g.ins);
    const io = permitidoPorRls(i.error);
    anotar(t, "INSERT", a.key, false, io, i.error ? i.error.code : "");
    if (io) { c.I = "✓"; c.mal.push("I"); avisos.push(`${t}: ${a.key} insertó por la API (revisar a mano)`); }
    if (original) {
      const u = await a.c.from(t).update({ [g.col]: original[g.col] }, { count: "exact" }).match(g.filtro);
      const uo = !u.error && (u.count ?? 0) > 0;
      anotar(t, "UPDATE (mismo valor)", a.key, false, uo, u.error ? u.error.code : "");
      if (uo) { c.U = "✓"; c.mal.push("U"); }
    }
  }));
  if (!original) return;
  for (const a of ACTORES()) {
    const d = await a.c.from(t).delete({ count: "exact" }).match(g.filtro);
    const dob = !d.error && (d.count ?? 0) > 0;
    anotar(t, "DELETE", a.key, false, dob, d.error ? d.error.code : "");
    if (dob) {
      const c = celda(t, a.key);
      c.D = "✓"; c.mal.push("D");
      const re = await svc.from(t).insert(original);
      if (re.error) avisos.push(`no se pudo restaurar ${t}: ${re.error.message}`);
    }
  }
}

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
    const cols = await leer(() => svc.from(t).select(`${pk}, ${spec.upd.col}`).in(pk, blancos.map((f) => f.id)), "valores " + t);
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
    const original = await leer(() => svc.from(t).select("*").eq(pk, f.id).maybeSingle(), "respaldo " + t);
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
    if (io) { c.I = "✓"; c.mal.push("I"); if (Object.keys(g.ins).length) await svc.from(t).delete().eq(Object.keys(g.ins)[0], Object.values(g.ins)[0]); }
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
  // Invitaciones (b-equipo): cada sesión intenta invitar a un RP y a un gerente en A (correo propio por sesión).
  for (const rol of ["rp", "gerente"]) {
    await Promise.all(ACTORES().map(async (a) => {
      const r = await a.c.rpc("invitacion_crear", { p_club_id: cA, p_rol: rol, p_correo: `${TAG}_rpc_${rol}_${a.key.toLowerCase()}@example.com`, p_nombre: "Invitado t_rls" });
      const deb = adm(a) || (es(a, "dueno") && a.club === "A") || (rol === "rp" && es(a, "gerente", "staff") && a.club === "A");
      anotar("RPC", `invitacion_crear ${rol} en A`, a.key, deb, !r.error, r.error ? `${r.error.code} ${r.error.message.slice(0, 80)}` : "");
    }));
  }
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
// ---------------------------------------------------------------- funciones de post-junta-3
// Quién puede llamar cada función nueva (00–81, sin antifraude), con la
// bandera de A apagada y encendida. Con la bandera apagada, quien SÍ tiene
// permiso recibe «no está activa» y quien no, el rechazo de permiso (nunca se
// le dice si el antro la tiene encendida). Las banderas de A se restauran al
// terminar (encendidas, y reportes_pdf otra vez heredada del grupo).
const APAGADA = /no est[áa]n? activ/i;
const msg = (r) => r.error?.message ?? "";
const sinError = (r) => !r.error;
async function correrFuncionesPj3() {
  const cA = C("A"), cB = C("B");
  const ad = A.admin.c;
  const ahora = new Date().toISOString();
  const lunes = (() => { const d = new Date(HOY + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const manana = diaMenos(-1);
  const gerA = (a) => adm(a) || (es(a, ...GER) && a.club === "A");
  const gerOGrupoA = (a) => gerA(a) || a.key === "duenoGrupo";
  const staffA = (a) => adm(a) || (es(a, ...STAFF) && a.club === "A"); // caja_tiene_permiso('puerta'/'cobrar')
  const cajaA = (a) => staffA(a) || a.key === "duenoGrupo"; // caja_puede_ver
  const puertaA = (a) => gerOGrupoA(a) || (es(a, "staff", "gerente") && a.club === "A"); // _lista_negra_ve_avisos
  const trabajaA = (a) => puertaA(a) || (es(a, "rp") && a.club === "A"); // _whatsapp_trabaja
  const conSesion = (a) => a.tipo !== "anon";
  const todos = () => true;
  const G = "RPC";
  const lineasA = pj3.lineasA;

  // ---- 1) Banderas de A apagadas (reportes_pdf: apagada en el antro aunque el grupo la tenga encendida).
  for (const f of [...BANDERAS_PJ3, "reportes_pdf"]) ok(await ad.rpc("funcion_cambiar", { p_club_id: cA, p_funcion: f, p_activa: false }), "apagar " + f);
  const apagada = (puede) => (r, a) => (puede(a) ? APAGADA.test(msg(r)) : !!r.error && !APAGADA.test(msg(r)));
  const off = (nombre, args, puede) => rpc(G, nombre, args, todos, { autorizado: apagada(puede), etiqueta: `${nombre} con la bandera apagada (permiso antes que bandera)` });
  await off("pos_mapeos_lista", { p_club_id: cA }, gerOGrupoA);
  await off("pos_importar", { p_club_id: cA, p_archivo_nombre: "x.csv", p_archivo_hash: pj3.hashA, p_formato: "csv", p_mapeo_id: null, p_lineas: lineasA }, gerOGrupoA);
  await off("puerta_copia_noche", { p_club_id: cA }, staffA);
  await off("puerta_escanear_codigo", { p_club_id: cA, p_codigo: "ffffff" }, staffA);
  await off("puerta_entrada_diferida", { p_club_id: cA, p_reservation_id: randomUUID(), p_clave: randomUUID(), p_escaneado_en: ahora }, staffA);
  await off("lista_negra_bloqueos", { p_club: cA }, gerOGrupoA);
  await off("lista_negra_bloquear", { p_club: cA, p_telefono: telPrueba(), p_reserva_id: null, p_motivo: "prueba t_rls", p_dias: null }, gerOGrupoA);
  await off("whatsapp_plantilla_guardar", { p_club: cA, p_tipo: "confirmacion", p_texto: TEXTO_WA }, gerOGrupoA);
  await off("clientes_noche", { p_club: cA, p_desfase: 0 }, puertaA);
  await off("reporte_pdf_noche", { p_club_id: cA, p_fecha: HOY }, gerOGrupoA);
  await off("inventario_historial", { p_producto_id: ids.productoA }, gerA);
  await off("inventario_entrada", { p_producto_id: ids.productoA, p_cantidad: 1 }, gerA);
  await off("caja_registrar_propina", { p_noche_id: pj3.nocheA, p_sesion_id: null, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 100 }, staffA);
  await off("propinas_config_leer", { p_club_id: cA }, cajaA);
  await off("propinas_reporte_noche", { p_club_id: cA, p_fecha: HOY }, gerA);
  await off("fraude_reglas_leer", { p_club_id: cA }, gerOGrupoA);
  await off("fraude_detectar", { p_club_id: cA, p_desde: HOY, p_hasta: HOY }, gerOGrupoA);
  await off("fraude_alertas_listar", { p_club_id: cA }, gerOGrupoA);
  await off("fraude_alerta_detalle", { p_alerta_id: pj3.alertaA }, gerOGrupoA);
  await off("fraude_alerta_cambiar", { p_alerta_id: pj3.alertaA, p_estado: "descartada", p_nota: "Nota de la prueba t_rls" }, gerOGrupoA);
  await rpc(G, "fraude_mis_antros", {}, gerOGrupoA, { autorizado: (r) => (r.data ?? []).some((x) => x.club_id === cA && x.activa === false), etiqueta: "fraude_mis_antros con la bandera apagada: A aparece «no activa»" });
  // Las que no dan error sin permiso: con la bandera apagada no devuelven nada a nadie.
  await rpc(G, "mis_funciones", { p_club_id: cA }, conSesion, { autorizado: (r) => !r.error && (r.data ?? []).length === 0, etiqueta: "mis_funciones de A con todo apagado: vacío" });
  await rpc(G, "pos_mis_antros", {}, conSesion, { autorizado: (r) => !r.error && !(r.data ?? []).some((x) => x.club_id === cA), etiqueta: "pos_mis_antros sin A (bandera apagada)" });
  await rpc(G, "boleto_muestra_codigo", { p_qr: ids["qr-resOrgA"] }, todos, { autorizado: (r) => !r.error && r.data === false, etiqueta: "boleto_muestra_codigo con la bandera apagada: no" });
  await rpc(G, "lista_negra_aviso", { p_reserva_id: ids.resRpA }, conSesion, { autorizado: (r) => !r.error && r.data?.activa === false, etiqueta: "lista_negra_aviso con la bandera apagada: {activa:false}" });
  await rpc(G, "whatsapp_plantillas", { p_club: cA }, conSesion, { autorizado: (r) => !r.error && (r.data ?? []).length === 0, etiqueta: "whatsapp_plantillas con la bandera apagada: vacío" });
  // Con lista_negra apagada, el teléfono bloqueado reserva como hoy (el RP de A, mañana).
  const libre = await A.rpA.c.from("reservations").insert({ cliente_nombre: `Libre ${TAG}`, cliente_telefono: pj3.telA, personas: 2, fecha: manana, club_id: cA, qr_code: `antro-${randomUUID()}`, status: "pendiente", source: "rp", rp_id: A.rpA.id });
  anotar("candados", "lista negra apagada: el RP reserva con un teléfono bloqueado (como hoy)", "rpA", true, !libre.error, libre.error?.message ?? "");

  // ---- 2) Encendidas otra vez; reportes_pdf vuelve a seguir al grupo (null = sin valor propio).
  for (const f of BANDERAS_PJ3) ok(await ad.rpc("funcion_cambiar", { p_club_id: cA, p_funcion: f, p_activa: true }), "encender " + f);
  ok(await ad.rpc("funcion_cambiar", { p_club_id: cA, p_funcion: "reportes_pdf", p_activa: null }), "reportes_pdf al grupo");
  const efectivas = ok(await A.gerenteA.c.rpc("mis_funciones", { p_club_id: cA }), "mis_funciones");
  anotar(G, "banderas de A restauradas (reportes_pdf heredada del grupo G)", "gerenteA", true,
    [...BANDERAS_PJ3, "reportes_pdf"].every((f) => efectivas.includes(f)), efectivas.join(","));

  // ---- 3) Con la bandera encendida: quién puede.
  // 00 banderas
  await rpc(G, "funciones_estado", {}, adm);
  await rpc(G, "funcion_cambiar", { p_club_id: cA, p_funcion: "pos_ventas", p_activa: true }, adm);
  await rpc(G, "grupo_funcion_cambiar", { p_grupo_id: ids.grupoG, p_funcion: "reportes_pdf", p_activa: true }, adm);
  await rpc(G, "mis_funciones", { p_club_id: cA }, conSesion, { autorizado: (r) => (r.data ?? []).includes("pos_ventas"), etiqueta: "mis_funciones de A (publicado: toda sesión)" });
  await rpc(G, "mis_funciones", { p_club_id: cB }, (a) => adm(a) || (N(a) && a.club === "B"), { autorizado: (r) => (r.data ?? []).includes("pos_ventas"), etiqueta: "mis_funciones de B (borrador: su gente y el admin)" });
  // 10 POS: admin, dueño, dueño de grupo y gerente activo del antro.
  await rpc(G, "pos_mis_antros", {}, gerOGrupoA, { autorizado: (r) => (r.data ?? []).some((x) => x.club_id === cA), etiqueta: "pos_mis_antros incluye A" });
  await rpc(G, "pos_mapeos_lista", { p_club_id: cA }, gerOGrupoA);
  await rpc(G, "pos_mapeo_guardar", { p_club_id: cA, p_nombre: `Mapeo ${TAG}`, p_config: { columnas: { ticket: "Ticket", fecha: "Fecha", producto: "Producto", total: "Total" } } }, gerOGrupoA);
  await rpc(G, "pos_preparar", { p_club_id: cA, p_lineas: lineasA, p_archivo_hash: pj3.hashA }, gerOGrupoA);
  await rpc(G, "pos_importar", { p_club_id: cA, p_archivo_nombre: "x.csv", p_archivo_hash: pj3.hashA, p_formato: "csv", p_mapeo_id: null, p_lineas: lineasA }, gerOGrupoA, { etiqueta: "pos_importar (mismo archivo: «ya se importó»)" });
  await rpc(G, "pos_importaciones_lista", { p_club_id: cA }, gerOGrupoA);
  await rpc(G, "pos_importacion_deshacer", { p_importacion_id: pj3.impA, p_motivo: "" }, gerOGrupoA, { etiqueta: "pos_importacion_deshacer (sin motivo)" });
  await rpc(G, "pos_asignar", { p_club_id: cA, p_venta_ids: [], p_cuenta_id: null }, gerOGrupoA, { etiqueta: "pos_asignar (sin ventas)" });
  await rpc(G, "pos_religar", { p_club_id: cA, p_fecha: HOY }, gerOGrupoA);
  await rpc(G, "pos_conciliacion", { p_club_id: cA, p_fecha: HOY }, gerOGrupoA);
  await rpc(G, "pos_tickets", { p_club_id: cA, p_fecha: HOY }, gerOGrupoA);
  await rpc(G, "pos_cuentas_noche", { p_club_id: cA, p_fecha: HOY }, gerOGrupoA);
  // pos_mapeo_borrar no distingue «no existe» de «no es tuyo»: una por una, con un mapeo de sacrificio.
  for (const a of ACTORES()) {
    const id = ok(await A.gerenteA.c.rpc("pos_mapeo_guardar", { p_club_id: cA, p_nombre: `Borrar ${TAG}`, p_config: { columnas: { ticket: "T" } } }), "mapeo de sacrificio");
    const r = await a.c.rpc("pos_mapeo_borrar", { p_mapeo_id: id });
    anotar(G, "pos_mapeo_borrar", a.key, gerOGrupoA(a), !r.error, r.error ? `${r.error.code} ${msg(r).slice(0, 80)}` : "");
  }
  // 20 escáner de respaldo: permiso de caja «puerta» (el dueño de grupo no opera la caja).
  await rpc(G, "puerta_copia_noche", { p_club_id: cA }, staffA);
  await rpc(G, "puerta_escanear_codigo", { p_club_id: cA, p_codigo: "ffffff" }, staffA, { etiqueta: "puerta_escanear_codigo (sin coincidencia)" });
  await rpc(G, "puerta_entrada_diferida", { p_club_id: cA, p_reservation_id: randomUUID(), p_clave: null, p_escaneado_en: ahora }, staffA, { etiqueta: "puerta_entrada_diferida (sin clave)" });
  await rpc(G, "boleto_muestra_codigo", { p_qr: ids["qr-resOrgA"] }, todos, { autorizado: (r) => !r.error && r.data === true, etiqueta: "boleto_muestra_codigo con la bandera encendida: sí (también sin sesión)" });
  // 40 lista negra: gestionan admin, dueño, dueño de grupo y gerente activo; avisos también staff; el RP solo de sus reservas.
  await rpc(G, "lista_negra_politica", { p_club: cA }, gerOGrupoA);
  await rpc(G, "lista_negra_politica_guardar", { p_club: cA, p_avisar_desde: 2, p_ventana_dias: 90, p_bloquear_desde: null }, gerOGrupoA);
  await rpc(G, "lista_negra_bloquear", { p_club: cA, p_telefono: pj3.telA, p_reserva_id: null, p_motivo: "prueba t_rls", p_dias: null }, gerOGrupoA, { etiqueta: "lista_negra_bloquear (ya bloqueado)" });
  await rpc(G, "lista_negra_desbloquear", { p_club: cA, p_bloqueo_id: randomUUID(), p_reserva_id: null, p_motivo: "prueba t_rls" }, gerOGrupoA, { etiqueta: "lista_negra_desbloquear (bloqueo inexistente)" });
  await rpc(G, "lista_negra_bloqueos", { p_club: cA }, gerOGrupoA);
  await rpc(G, "lista_negra_ver_telefono", { p_club: cA, p_bloqueo_id: pj3.bloqueoA }, gerOGrupoA);
  await rpc(G, "lista_negra_noshows", { p_club: cA }, gerOGrupoA);
  await rpc(G, "lista_negra_historial", { p_club: cA }, gerOGrupoA);
  await rpc(G, "lista_negra_aviso", { p_reserva_id: ids.resRpA }, (a) => puertaA(a) || (a.key === "rpA"), { autorizado: (r) => r.data?.activa === true, etiqueta: "lista_negra_aviso (reserva del RP de A)" });
  await rpc(G, "lista_negra_aviso", { p_reserva_id: ids.resRpA }, puertaA, { autorizado: (r) => typeof r.data?.bloqueado === "boolean", etiqueta: "lista_negra_aviso: «bloqueado» solo para la puerta y los gestores" });
  await rpc(G, "lista_negra_tachar", { p_bloqueo_id: randomUUID() }, adm, { etiqueta: "lista_negra_tachar (inexistente)" });
  await rpc(G, "lista_negra_tel", { p: "+52 1 55 1234 5678" }, todos, { autorizado: (r) => r.data === "5512345678", etiqueta: "lista_negra_tel (pura, también sin sesión)" });
  // 50 /para-clubes: todo del admin salvo saber si está activa y enviar el formulario.
  await rpc(G, "para_clubes_activa", {}, todos, { autorizado: sinError });
  await rpc(G, "plataforma_banderas_estado", {}, adm);
  await rpc(G, "plataforma_bandera_cambiar", { p_clave: `no_existe_${TAGX}`, p_activa: false }, adm, { etiqueta: "plataforma_bandera_cambiar (clave inexistente: no cambia nada)" });
  await rpc(G, "contactos_clubes_admin", {}, adm);
  await rpc(G, "contactos_clubes_conteo", {}, adm);
  await rpc(G, "contacto_club_marcar", { p_id: pj3.contacto, p_estado: "nuevo" }, adm);
  await rpc(G, "contacto_club_borrar", { p_id: randomUUID() }, adm, { etiqueta: "contacto_club_borrar (inexistente)" });
  const paraClubes = ok(await svc.rpc("para_clubes_activa"), "para_clubes_activa");
  if (!paraClubes) {
    await rpc(G, "para_clubes_contacto_enviar", { p_nombre: "T rls", p_club: "Antro t_rls", p_ciudad: "CDMX", p_correo: `${TAG}@example.com` }, nadie,
      { autorizado: (r) => !r.error, etiqueta: "para_clubes_contacto_enviar con /para-clubes apagada: nadie" });
  } else avisos.push("para_clubes está encendida en dev (otro carril): se saltó el envío del formulario en la matriz (lo cubre C5 con IP de prueba)");
  // 60 WhatsApp
  await rpc(G, "whatsapp_plantillas", { p_club: cA }, trabajaA, { autorizado: (r) => (r.data ?? []).length > 0 });
  await rpc(G, "whatsapp_plantilla_guardar", { p_club: cA, p_tipo: "confirmacion", p_texto: TEXTO_WA }, gerOGrupoA);
  await rpc(G, "whatsapp_reserva", { p_reserva_id: ids.resRpA }, (a) => puertaA(a) || a.key === "rpA", { autorizado: sinError, etiqueta: "whatsapp_reserva (reserva del RP de A)" });
  await rpc(G, "whatsapp_reserva", { p_reserva_id: ids.resOrgA }, puertaA, { autorizado: sinError, etiqueta: "whatsapp_reserva (orgánica: el RP no)" });
  await rpc(G, "clientes_noche", { p_club: cA, p_desfase: 0 }, puertaA);
  // 70 reportes PDF: admin, dueño, dueño de grupo y gerente activo.
  await rpc(G, "reporte_pdf_noche", { p_club_id: cA, p_fecha: HOY }, gerOGrupoA);
  await rpc(G, "reporte_pdf_semana", { p_club_id: cA, p_lunes: lunes }, gerOGrupoA);
  // 80 inventario: gerente o dueño (sin dueño de grupo). Sin permiso: «Producto no encontrado».
  const inv = (r) => !r.error || !/Producto no encontrado|permission denied|Solo el gerente/.test(msg(r));
  await rpc(G, "inventario_entrada", { p_producto_id: ids.productoA, p_cantidad: 0 }, gerA, { autorizado: inv, etiqueta: "inventario_entrada (cantidad 0)" });
  await rpc(G, "inventario_merma", { p_producto_id: ids.productoA, p_cantidad: 0, p_motivo: "prueba" }, gerA, { autorizado: inv, etiqueta: "inventario_merma (cantidad 0)" });
  await rpc(G, "inventario_conteo", { p_producto_id: ids.productoA, p_contado: -1 }, gerA, { autorizado: inv, etiqueta: "inventario_conteo (conteo inválido)" });
  await rpc(G, "inventario_historial", { p_producto_id: ids.productoA }, gerA, { autorizado: inv });
  await rpc(G, "inventario_reporte_noche", { p_club_id: cA, p_fecha: HOY }, gerA);
  // 81 propinas: registrar = «cobrar»; anular = «anular» (el staff no, por defecto y por el permiso del escenario); reparto y reporte = gerente o dueño.
  await rpc(G, "caja_registrar_propina", { p_noche_id: pj3.nocheA, p_sesion_id: null, p_cuenta_id: null, p_metodo: "no_existe", p_monto_centavos: 100 }, staffA, { etiqueta: "caja_registrar_propina (método inválido)" });
  await rpc(G, "caja_anular_propina", { p_propina_id: pj3.propinaA, p_motivo: "prueba t_rls" }, gerA, { etiqueta: "caja_anular_propina (noche ya repartida)" });
  await rpc(G, "propinas_anular_de_cobro", { p_pago_id: pj3.pagoA, p_motivo: "prueba t_rls" }, gerA, { etiqueta: "propinas_anular_de_cobro (noche ya repartida)" });
  await rpc(G, "propinas_config_leer", { p_club_id: cA }, cajaA, { autorizado: sinError });
  await rpc(G, "propinas_config_guardar", { p_club_id: cA, p_pct_personal: 80, p_pct_rp: 10, p_pct_casa: 10, p_incluye_gerente: false }, gerA);
  await rpc(G, "propinas_calcular", { p_noche_id: pj3.nocheA, p_participantes: [A.staffA.id] }, gerA);
  await rpc(G, "propinas_repartir", { p_noche_id: pj3.nocheA, p_participantes: [A.staffA.id], p_total_visto: 0, p_pct_personal: 80, p_pct_rp: 10, p_pct_casa: 10, p_incluye_gerente: false }, gerA, { etiqueta: "propinas_repartir (noche abierta)" });
  await rpc(G, "propinas_anular_reparto", { p_reparto_id: pj3.repartoA, p_motivo: "" }, gerA, { autorizado: (r) => !/Reparto no encontrado|permission denied/.test(msg(r)), etiqueta: "propinas_anular_reparto (sin motivo)" });
  await rpc(G, "propinas_reporte_noche", { p_club_id: cA, p_fecha: HOY }, gerA);
  // 30 antifraude: admin, dueño, dueño de grupo (solo de los antros de su grupo) y gerente activo.
  // El staff puro y los RPs no ven nada, ni sobre sí mismos. La búsqueda: una cada 2 minutos por antro
  // (el escenario ya buscó: quien tiene permiso recibe «hace menos de 2 minutos» sin buscar otra vez).
  const gerB = (a) => adm(a) || (es(a, ...GER) && a.club === "B");
  await rpc(G, "fraude_catalogo", {}, conSesion, { autorizado: (r) => !r.error && !!r.data?.rafaga });
  await rpc(G, "fraude_mis_antros", {}, gerOGrupoA, { autorizado: (r) => (r.data ?? []).some((x) => x.club_id === cA && x.activa === true), etiqueta: "fraude_mis_antros incluye A (encendida)" });
  await rpc(G, "fraude_mis_antros", {}, gerB, { autorizado: (r) => (r.data ?? []).some((x) => x.club_id === cB), etiqueta: "fraude_mis_antros incluye B (el dueño de grupo de G no)" });
  await rpc(G, "fraude_reglas_leer", { p_club_id: cA }, gerOGrupoA);
  await rpc(G, "fraude_reglas_leer", { p_club_id: cB }, gerB, { etiqueta: "fraude_reglas_leer de B" });
  await rpc(G, "fraude_regla_guardar", { p_club_id: cA, p_regla: "rafaga", p_activa: true, p_parametros: { min_reservas: 3, minutos: 240 } }, gerOGrupoA, { etiqueta: "fraude_regla_guardar (mismos valores: no cambia)" });
  await rpc(G, "fraude_regla_guardar", { p_club_id: cB, p_regla: "rafaga", p_activa: true, p_parametros: { min_reservas: 3, minutos: 240 } }, gerB, { etiqueta: "fraude_regla_guardar de B (mismos valores)" });
  await rpc(G, "fraude_reglas_cambios_leer", { p_club_id: cA }, gerOGrupoA);
  await rpc(G, "fraude_detectar", { p_club_id: cA, p_desde: HOY, p_hasta: HOY }, gerOGrupoA, { etiqueta: "fraude_detectar (como mucho una búsqueda; las demás «hace menos de 2 minutos»)" });
  await rpc(G, "fraude_detectar", { p_club_id: cB, p_desde: HOY, p_hasta: HOY }, gerB, { etiqueta: "fraude_detectar de B (una búsqueda o «hace menos de 2 minutos»)" });
  await rpc(G, "fraude_ultima_deteccion", { p_club_id: cA }, gerOGrupoA, { autorizado: (r) => !r.error && !!r.data?.hecho_en });
  await rpc(G, "fraude_alertas_listar", { p_club_id: cA }, gerOGrupoA, { autorizado: (r) => (r.data ?? []).some((x) => x.id === pj3.alertaA) });
  await rpc(G, "fraude_alertas_listar", { p_club_id: cB }, gerB, { autorizado: (r) => (r.data ?? []).some((x) => x.id === pj3.alertaB), etiqueta: "fraude_alertas_listar de B" });
  await rpc(G, "fraude_alertas_rps", { p_club_id: cA }, gerOGrupoA);
  await rpc(G, "fraude_alerta_detalle", { p_alerta_id: pj3.alertaA }, gerOGrupoA, { autorizado: (r) => !r.error && (r.data?.cambios ?? []).length === 2 });
  await rpc(G, "fraude_alerta_detalle", { p_alerta_id: pj3.alertaB }, gerB, { autorizado: sinError, etiqueta: "fraude_alerta_detalle de B (el dueño de grupo de G no)" });
  await rpc(G, "fraude_alerta_cambiar", { p_alerta_id: pj3.alertaA, p_estado: "descartada", p_nota: "" }, gerOGrupoA, { autorizado: (r) => /nota de al menos/.test(msg(r)), etiqueta: "fraude_alerta_cambiar (sin nota)" });
  await rpc(G, "fraude_alerta_cambiar", { p_alerta_id: pj3.alertaB, p_estado: "descartada", p_nota: "" }, gerB, { autorizado: (r) => /nota de al menos/.test(msg(r)), etiqueta: "fraude_alerta_cambiar de B (sin nota)" });
  // La clave del HMAC no la lee nadie, ni la service role.
  const sec = await svc.from("fraude_secreto").select("*");
  anotar(G, "fraude_secreto: la service role no la lee", "service_role", false, !sec.error && (sec.data ?? []).length > 0, sec.error?.code ?? "LA LEYÓ");
}

// Catálogo: qué funciones nuevas puede ejecutar cada rol de la API y que las
// SECURITY DEFINER tengan search_path fijo. Lo interno, solo service_role.
const FN_INTERNAS_PJ3 = ["funcion_activa", "pos_puede_usar", "pos_exigir", "pos_clave_mesa", "pos_leer_lineas", "pos_candidatos", "pos_resolver_lote",
  "ip_cliente", "_lista_negra_mascara", "_lista_negra_gestiona", "_lista_negra_ve_avisos", "_lista_negra_politica", "_lista_negra_noshows",
  "_lista_negra_auto", "_lista_negra_manual", "_lista_negra_exigir", "contacto_huella", "contacto_intentos_limpiar", "_whatsapp_trabaja",
  "_clientes_estado", "reporte_pdf_autorizar", "inventario_producto_para_escribir", "inventario_movimiento_previo", "propinas_detalle",
  "propinas_de_noche", "propinas_partes", "propinas_regla",
  "fraude_puede_revisar", "fraude_autorizar", "fraude_parametros", "fraude_regla_activa", "fraude_tel10", "fraude_enmascarar_tel",
  "fraude_enmascarar_texto", "fraude_nombre"];
const FN_TRIGGER_PJ3 = ["pos_ventas_caja_borrada", "reservations_antiabuso_anon", "lista_negra_sin_borrar", "reservations_lista_negra", "propinas_candado"];
const FN_ANON_PJ3 = ["lista_negra_tel", "boleto_muestra_codigo", "para_clubes_activa", "para_clubes_contacto_enviar"];
const FN_APP_PJ3 = ["mis_funciones", "funciones_estado", "funcion_cambiar", "grupo_funcion_cambiar",
  "pos_mis_antros", "pos_mapeos_lista", "pos_mapeo_guardar", "pos_mapeo_borrar", "pos_preparar", "pos_importar", "pos_importaciones_lista",
  "pos_importacion_deshacer", "pos_asignar", "pos_religar", "pos_conciliacion", "pos_tickets", "pos_cuentas_noche",
  "puerta_copia_noche", "puerta_escanear_codigo", "puerta_entrada_diferida",
  "lista_negra_politica", "lista_negra_politica_guardar", "lista_negra_bloquear", "lista_negra_desbloquear", "lista_negra_bloqueos",
  "lista_negra_ver_telefono", "lista_negra_noshows", "lista_negra_historial", "lista_negra_aviso", "lista_negra_tachar",
  "plataforma_bandera_cambiar", "plataforma_banderas_estado", "contactos_clubes_admin", "contactos_clubes_conteo", "contacto_club_marcar", "contacto_club_borrar",
  "whatsapp_plantillas", "whatsapp_plantilla_guardar", "whatsapp_reserva", "clientes_noche",
  "reporte_pdf_noche", "reporte_pdf_semana",
  "inventario_entrada", "inventario_merma", "inventario_conteo", "inventario_historial", "inventario_reporte_noche",
  "caja_registrar_propina", "caja_anular_propina", "propinas_anular_de_cobro", "propinas_config_leer", "propinas_config_guardar",
  "propinas_calcular", "propinas_repartir", "propinas_anular_reparto", "propinas_reporte_noche",
  "fraude_catalogo", "fraude_mis_antros", "fraude_reglas_leer", "fraude_regla_guardar", "fraude_reglas_cambios_leer", "fraude_detectar",
  "fraude_ultima_deteccion", "fraude_alertas_listar", "fraude_alertas_rps", "fraude_alerta_detalle", "fraude_alerta_cambiar"];
async function catalogoPj3(db) {
  const nombres = [...FN_INTERNAS_PJ3, ...FN_TRIGGER_PJ3, ...FN_ANON_PJ3, ...FN_APP_PJ3];
  const fs = await db.q(`select p.proname, p.oid::regprocedure::text as firma, p.prosecdef as definer,
      coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%' as con_ruta,
      has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [nombres]);
  for (const n of nombres) if (!fs.some((f) => f.proname === n)) anotar("RPC", `catálogo: existe ${n}`, "-", true, false, "no está en dev");
  for (const f of fs) {
    const firma = f.firma.replace(/^public\./, "");
    const n = f.proname;
    const [anon, auth] = FN_ANON_PJ3.includes(n) ? [true, true] : FN_APP_PJ3.includes(n) ? [false, true] : [false, false];
    if (!FN_TRIGGER_PJ3.includes(n)) {
      anotar("RPC", `catálogo: anon ejecuta ${firma}`, "anon", anon, f.anon);
      anotar("RPC", `catálogo: authenticated ejecuta ${firma}`, "authenticated", auth, f.auth);
    }
    if (f.definer) anotar("RPC", `catálogo: ${firma} (security definer) con search_path fijo`, "-", true, f.con_ruta);
  }
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

// Candados de post-junta-3: lista negra (40) con la bandera encendida y
// cruces entre antros en las funciones nuevas (pedir por A con datos de B).
async function candadosPj3() {
  const g = "candados";
  const cA = C("A"), cB = C("B"), manana = diaMenos(-1), ahora = new Date().toISOString();
  const res = (extra) => ({ cliente_nombre: `Ins ${TAG}`, personas: 2, fecha: manana, qr_code: `antro-${randomUUID()}`, status: "pendiente", ...extra });
  const neutro = /^No pudimos apartar tu lugar en este antro/;
  const casos = [
    ["el cliente reserva con un teléfono bloqueado", "cliente", res({ club_id: cA, cliente_telefono: pj3.telA, source: "organica", cliente_id: A.cliente.id }), neutro],
    ["el cliente reserva con el teléfono bloqueado escrito «+52 1 …»", "cliente", res({ club_id: cA, cliente_telefono: `+52 1 ${pj3.telA.slice(0, 2)} ${pj3.telA.slice(2, 6)} ${pj3.telA.slice(6)}`, source: "organica", cliente_id: A.cliente.id }), neutro],
    ["sin cuenta, con un teléfono bloqueado", "anon", res({ club_id: cA, cliente_telefono: pj3.telA, source: "organica" }), neutro],
    ["el RP reserva con un teléfono bloqueado", "rpA", res({ club_id: cA, cliente_telefono: pj3.telA, source: "rp", rp_id: A.rpA.id }), /habla con tu gerente/],
  ];
  for (const [texto, quien, filaRes, re] of casos) {
    const r = await A[quien].c.from("reservations").insert(filaRes);
    anotar(g, texto, quien, false, !r.error, msg(r).slice(0, 80));
    anotar(g, `${texto}: aviso P0001 propio de su rol, sin motivo`, quien, true, r.error?.code === "P0001" && re.test(msg(r)) && !msg(r).includes(TAG), msg(r).slice(0, 80));
  }
  const rb = await A.rpB.c.from("reservations").insert(res({ club_id: cB, cliente_telefono: pj3.telA, source: "rp", rp_id: A.rpB.id }));
  anotar(g, "un bloqueo de A no afecta a B (el RP de B reserva en B con ese teléfono)", "rpB", true, !rb.error, msg(rb).slice(0, 80));
  const antes = ok(await svc.from("reservations").select("cliente_telefono").eq("id", ids.resPuertaA).single(), "teléfono").cliente_telefono;
  const ru = await A.staffA.c.from("reservations").update({ cliente_telefono: pj3.telA }, { count: "exact" }).eq("id", ids.resPuertaA);
  const cambio = !ru.error && (ru.count ?? 0) > 0;
  anotar(g, "el staff cambia el teléfono de una reserva a uno bloqueado", "staffA", false, cambio, msg(ru).slice(0, 80));
  if (cambio) await svc.from("reservations").update({ cliente_telefono: antes }).eq("id", ids.resPuertaA);
  // Pedir por A con datos de B (el permiso se revisa contra A; los datos tienen que ser de A).
  const cruces = [
    ["el gerente de A bloquea en A desde una reserva de B", "gerenteA", (c) => c.rpc("lista_negra_bloquear", { p_club: cA, p_telefono: null, p_reserva_id: ids.resRpB, p_motivo: "prueba t_rls", p_dias: null })],
    ["el gerente de A ve el teléfono de un bloqueo de B (pidiendo por A)", "gerenteA", (c) => c.rpc("lista_negra_ver_telefono", { p_club: cA, p_bloqueo_id: pj3.bloqueoB })],
    ["el gerente de A desbloquea un bloqueo de B (pidiendo por A)", "gerenteA", (c) => c.rpc("lista_negra_desbloquear", { p_club: cA, p_bloqueo_id: pj3.bloqueoB, p_reserva_id: null, p_motivo: "prueba t_rls" })],
    ["el gerente de A liga una venta de A a una cuenta de B", "gerenteA", (c) => c.rpc("pos_asignar", { p_club_id: cA, p_venta_ids: [pj3.ventaA], p_cuenta_id: ids.cuenta2B })],
    ["el gerente de A deshace una importación de B", "gerenteA", (c) => c.rpc("pos_importacion_deshacer", { p_importacion_id: pj3.impB, p_motivo: "prueba t_rls" })],
    ["el staff de A registra una propina en la noche de B", "staffA", (c) => c.rpc("caja_registrar_propina", { p_noche_id: pj3.nocheB, p_sesion_id: null, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 100, p_clave: randomUUID() })],
    ["el staff de A registra una propina en su mesa con una cuenta de B", "staffA", (c) => c.rpc("caja_registrar_propina", { p_noche_id: pj3.nocheA, p_sesion_id: ids.sesion2A, p_cuenta_id: ids.cuenta2B, p_metodo: "efectivo", p_monto_centavos: 100, p_clave: randomUUID() })],
    ["el gerente de A anula el reparto de B", "gerenteA", (c) => c.rpc("propinas_anular_reparto", { p_reparto_id: pj3.repartoB, p_motivo: "prueba t_rls" })],
    ["el staff de A manda una entrada diferida de una reserva de B (pidiendo por A)", "staffA", (c) => c.rpc("puerta_entrada_diferida", { p_club_id: cA, p_reservation_id: ids.resPuertaB, p_clave: randomUUID(), p_escaneado_en: ahora })],
    ["el staff de A escanea por código una reserva de B (pidiendo por A)", "staffA", (c) => c.rpc("puerta_escanear_codigo", { p_club_id: cA, p_codigo: ids["qr-resPuertaB"].slice(-6) })],
    ["el gerente de A da merma a un producto de B", "gerenteA", (c) => c.rpc("inventario_merma", { p_producto_id: ids.productoB, p_cantidad: 1, p_motivo: "prueba t_rls" })],
    ["el staff de A arma el WhatsApp de una reserva de B", "staffA", (c) => c.rpc("whatsapp_reserva", { p_reserva_id: ids.resRpB })],
    ["el RP de A pide el aviso de no-shows de una reserva de otro RP (B)", "rpA", (c) => c.rpc("lista_negra_aviso", { p_reserva_id: ids.resRpB }).then((r) => (r.data?.activa ? r : { error: { message: "activa:false" } }))],
  ];
  for (const [texto, quien, fn] of cruces) {
    const r = await fn(A[quien].c);
    anotar(g, texto, quien, false, !r.error, r.error ? msg(r).slice(0, 80) : "PASÓ");
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
      // club-photos: listar la raíz, listar la carpeta del antro (list y
      // list-v2). Las carpetas de un antro no publicado (B) solo las listan el
      // admin, su dueño y su personal (67).
      const fotoVe = adm(a) || k === "A" || (N(a) && a.club === "B");
      const raiz = await a.c.storage.from("club-photos").list("", { limit: 1000, search: C(k) });
      anotar(g, `club-photos listar raíz (carpeta de ${k})`, a.key, fotoVe, (raiz.data ?? []).some((o) => o.name === C(k)), raiz.error?.message ?? "");
      const lf = await a.c.storage.from("club-photos").list(C(k));
      anotar(g, `club-photos listar ${k}`, a.key, fotoVe, (lf.data ?? []).some((o) => o.name.includes(TAG)), lf.error?.message ?? "");
      const token = (await a.c.auth.getSession()).data.session?.access_token ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const v2 = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/list-v2/club-photos`, {
        method: "POST", headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prefix: "", limit: 1000, with_delimiter: false }),
      }).then((r) => r.json()).catch(() => ({}));
      anotar(g, `club-photos list-v2 sin carpeta (archivos de ${k})`, a.key, fotoVe, (v2.objects ?? []).some((o) => o.name?.startsWith(`${C(k)}/${TAG}`)));
      // Por ruta EXACTA, Storage sirve los archivos de un bucket público sin
      // pasar por RLS (también por /object/authenticated/): es la limitación
      // conocida de club-photos. Lo que cierra el 67 es que la ruta (con su
      // uuid) ya no se descubre listando. Si esto cambia, la auditoría avisa.
      const df = await a.c.storage.from("club-photos").download(`${C(k)}/${TAG}-borrar.png`);
      anotar(g, `club-photos leer de ${k} por ruta exacta (bucket público)`, a.key, true, !df.error && !!df.data);
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
    let ultimoError = "";
    const borrar = async (sql, p) => {
      await db.q("savepoint s");
      try { const r = await db.cliente.query(sql, p); borradas += r.rowCount; await db.q("release savepoint s"); return true; } catch (e) { ultimoError = `${e.code} ${e.message}`; await db.q("rollback to savepoint s"); return false; }
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
    if (!(await borrar("delete from public.clubs where id = any($1::uuid[]) or nombre like $2", [clubIds, `T rls nuevo ${TAG}%`]))) {
      console.log("Limpieza: los antros no se borraron en la primera vuelta: " + ultimoError);
    }
    await borrar("delete from public.grupos where id = any($1::uuid[]) or nombre like $2", [creados.grupos, `${TAG}%`]);
    await borrar("delete from public.planes where clave like $1", [`${TAG}%`]);
    await borrar("delete from public.app_errores where mensaje like $1 or ruta like $2", [`%${TAG}%`, `%${TAG}%`]);
    for (const t of ["login_intentos", "registro_intentos"]) await borrar(`delete from public.${t} where ip_hash = any($1)`, [[TAG, IPH]]);
    await borrar("delete from public.alertas_enviadas where tipo like $1", [`${TAG}%`]);
    await borrar("delete from public.stripe_eventos where id = $1", [`evt_${TAGX}`]);
    await borrar("delete from public.alertas_enviadas where tipo = $1", [TAG]);
    await borrar("delete from public.reserva_intentos where club_id = any($1::uuid[]) or telefono_hash = $2", [clubIds, TAG]);
    await borrar("delete from public.invitacion_intentos where ip_hash = $1", [IPH]);
    await borrar("delete from public.correos_salida where destinatario like $1", [`${TAG}%`]);
    // Post-junta-3 sin FK a antros ni perfiles (lo demás se va por las FK de arriba).
    await borrar("delete from public.contactos_clubes where correo like $1", [`${TAG}%`]);
    await borrar("delete from public.contacto_intentos where correo_hash like $1", [`${TAG}%`]);
    await borrar("delete from public.profiles where id = any($1::uuid[])", [perfiles]);
    await db.q("commit");
    for (const b of ["club-photos", "verificacion-docs"]) for (const id of clubIds) {
      const l = await svc.storage.from(b).list(id, { limit: 1000 });
      const rutas = (l.data ?? []).map((o) => `${id}/${o.name}`);
      if (rutas.length) await svc.storage.from(b).remove(rutas);
    }
    for (const id of perfiles) await svc.auth.admin.deleteUser(id);
    // Segunda vuelta: lo que borró la cascada de auth.users pudo liberar a los antros.
    if ((await db.q("select count(*)::int as n from public.clubs where id = any($1::uuid[])", [clubIds]))[0].n) {
      await db.q("begin");
      await db.q("set local antroapp.borrado_pruebas = 'on'");
      for (const f of refs) if (f.ref === "clubs" && !(f.tabla === "clubs" && f.col === "dueno_id")) await borrar(`delete from ${f.tabla} where ${f.col} = any($1::uuid[])`, [clubIds]);
      if (!(await borrar("delete from public.clubs where id = any($1::uuid[])", [clubIds]))) console.log("Limpieza: segunda vuelta de antros falló: " + ultimoError);
      await db.q("commit");
    }
    const quedan = await db.q(`select (select count(*) from public.clubs where nombre like $1)::int as clubs, (select count(*) from auth.users where email like $2)::int as cuentas,
        (select count(*) from public.profiles where nombre like $3)::int as perfiles,
        (select count(*) from public.contactos_clubes where correo like $2)::int + (select count(*) from public.contacto_intentos where correo_hash like $2)::int
        + (select count(*) from public.club_funciones where club_id = any($4::uuid[]))::int + (select count(*) from public.grupo_funciones where grupo_id = any($5::uuid[]))::int as pj3`,
      [`T rls%${TAG}%`, `${TAG}%`, `%${TAG}%`, clubIds, creados.grupos]);
    console.log(`\nLimpieza: ${borradas} filas, ${perfiles.length} cuentas. Quedan: ${JSON.stringify(quedan[0])}`);
    if (quedan[0].clubs || quedan[0].cuentas || quedan[0].perfiles || quedan[0].pj3) avisos.push("la limpieza dejó restos: " + JSON.stringify(quedan[0]));
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
  md += `\n#### Ayudantes boolean (${(est.bool ?? []).length})\n\n| Función | En políticas | En «if not f(…)» de | Veredicto |\n|---|---|---|---|\n`;
  for (const b of est.bool ?? []) md += `| \`${b.firma}\` | ${b.enPoliticas} | ${b.enIfNot.join(", ") || "—"} | ${b.veredicto} |\n`;
  return md;
}

// ---------------------------------------------------------------- principal
if (LIMPIAR) {
  // Rearma lo creado a partir de la marca (antros, cuentas, grupos y planes) y limpia como al final de una corrida.
  const db = await conectarDevEscritura();
  try {
    creados.clubs = Object.fromEntries((await db.q("select id from public.clubs where nombre like $1", [`T rls%${TAG}%`])).map((x, i) => [i, x.id]));
    creados.usuarios = (await db.q("select id from auth.users where email like $1", [`${TAG}%`])).map((x) => x.id);
    creados.grupos = (await db.q("select id from public.grupos where nombre like $1", [`${TAG}%`])).map((x) => x.id);
    creados.planes = (await db.q("select id from public.planes where clave like $1", [`${TAG}%`])).map((x) => x.id);
  } finally { await db.fin(); }
  console.log(`Limpiando restos de ${TAG}: ${Object.keys(creados.clubs).length} antros, ${creados.usuarios.length} cuentas`);
  await limpiar();
  for (const a of avisos) console.log("AVISO  " + a);
  process.exit(0);
}
let est = { total: 0, filas: [] };
// ¿Sigue la política vieja «el RP lee sus reservas directo»? (b-cliente 41 la quita.)
let RP_LEE_RESERVAS = true;
try {
  {
    const db = await conectarDevEscritura();
    try {
      RP_LEE_RESERVAS = (await db.q("select 1 from pg_policies where schemaname = 'public' and tablename = 'reservations' and policyname = 'reservations_select_rp_own'")).length > 0;
    } finally { await db.fin(); }
  }
  console.log(`Auditoría RLS contra antroapp-dev (marca ${TAG}); el RP ${RP_LEE_RESERVAS ? "sí" : "ya no"} lee reservations directo`);
  await escenario();
  console.log(`Escenario listo: ${Object.keys(A).length} sesiones, ${Object.values(filas).flat().length} filas de prueba.`);
  // Tablas de public con RLS y si anon/authenticated tienen algún GRANT (de tabla o de columna).
  const tablas = (await (async () => { const db = await conectarDevEscritura(); try { return await db.q(`select c.relname as t, c.relrowsecurity as rls,
      (has_table_privilege('anon', c.oid, 'select,insert,update,delete') or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
       or has_any_column_privilege('anon', c.oid, 'select,insert,update') or has_any_column_privilege('authenticated', c.oid, 'select,insert,update')) as expuesta
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') order by 1`); } finally { await db.fin(); } })());
  const sinApi = SIN_API_PJ3();
  for (const { t, rls, expuesta } of tablas) {
    if (process.env.AUDITORIA_TRAZA) console.log(`… ${t}`);
    anotar("tablas", `${t} tiene RLS`, "-", true, rls);
    if (SPEC[t]) await correrTabla(t, SPEC[t]);
    else if (GLOBALES[t]) await correrGlobal(t, GLOBALES[t]);
    else if (sinApi[t]) {
      // Post-junta-3 sin acceso por la API: además de la fila sembrada, que no tenga GRANT.
      anotar("tablas", `${t} sin GRANT para anon ni authenticated`, "-", true, !expuesta);
      await correrSinApi(t, sinApi[t]);
    } else if (!expuesta) {
      // Tabla nueva sin GRANT para anon ni authenticated (solo service_role y funciones): se comprueba que nadie la toque.
      await correrGlobal(t, { ver: nadie, ins: {} });
      avisos.push(`tabla sin matriz y sin GRANT para la API: ${t} (comprobado: nadie la lee ni la escribe)${/^fraude_/.test(t) ? " — ANTIFRAUDE (30), pendiente a propósito" : ""}`);
    } else {
      // Tabla nueva sin matriz: nadie que no sea admin debería ver filas sin que alguien lo decida.
      const vistas = await Promise.all(ACTORES().map(async (a) => [a.key, (await a.c.from(t).select("*", { count: "exact", head: true })).count ?? 0]));
      avisos.push(`tabla sin matriz: ${t} (filas visibles: ${vistas.filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(", ") || "ninguna"})`);
      if (ESTRICTO) anotar("tablas", `${t} expuesta a la API sin matriz`, "-", true, false, "falta su especificación en SPEC");
    }
  }
  if (process.env.AUDITORIA_TRAZA) console.log("… funciones");
  await correrFunciones();
  if (process.env.AUDITORIA_TRAZA) console.log("… funciones pj3");
  await correrFuncionesPj3();
  await coherencia();
  if (process.env.AUDITORIA_TRAZA) console.log("… candados pj3");
  await candadosPj3();
  if (process.env.AUDITORIA_TRAZA) console.log("… storage");
  await storage();
  if (process.env.AUDITORIA_TRAZA) console.log("… rutas");
  await rutas();
  const db = await conectarDevEscritura();
  try { est = await escaneoEstatico(db); await catalogoPj3(db); } finally { await db.fin(); }
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
