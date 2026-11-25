// Pruebas de las invitaciones de personal por correo (B12) contra
// antroapp-dev. Requiere sql/post-junta-2/20-correos-salida.sql y
// 21-invitaciones.sql en dev.
//
//   node scripts/dev/probar-invitaciones.mjs
//       reglas puras y la base: matriz por rol (crear, reenviar, revocar),
//       lectura por RLS, escritura directa, límites, aceptar por la función.
//   node scripts/dev/probar-invitaciones.mjs --base=http://localhost:3022
//       además las rutas /api/equipo/invitar e /api/invitacion de punta a
//       punta: token reutilizado, vencido, revocado, reenviado, rol y club
//       manipulados, correo con cuenta (incluida una cuenta sin perfil),
//       dos aceptaciones a la vez, límite por IP y create-staff con
//       contraseña temporal. El servidor debe correr con CORREO_MODO sin
//       definir (archivo): el enlace se toma de la bandeja.
//   ... --pantalla   (con PLAYWRIGHT_DESDE)
//       además /dueno/equipo, /staff/equipo e /invitacion/<token> con
//       Playwright a 390×844 y 360×740 (capturas en screenshots-b-equipo/).
//
// Crea sus propios antros ("T equipo …") y cuentas t_equipo_…@example.com y
// los borra al final aunque algo falle. De dev solo LEE Club Demo Dev y usa
// dev_<rol>@example.com sin cambiarles nada.

import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";
import {
  rolesQuePuedeInvitar,
  estadoInvitacion,
  accionesDe,
  urlPublica,
  enlaceInvitacion,
  textoCorreoInvitacion,
  esquemaAceptar,
  esquemaInvitar,
  avisoEnvio,
} from "../../lib/domain/invitaciones.ts";
import { valorRol, porDefecto } from "../../lib/domain/permisos-caja.ts";
import { leerConfigCorreo, procesarCorreo } from "../../lib/domain/correo.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const BASE = arg("base")?.replace(/\/$/, "") ?? null;
const PANTALLA = process.argv.includes("--pantalla");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const DEMO = cred.clubs.demo;

let pasan = 0, fallan = 0;
const revisar = (c, t, d = "") => { if (c) pasan++; else fallan++; console.log((c ? "OK     " : "FALLA  ") + t + (c || !d ? "" : "  — " + d)); };
const msg = (r) => r?.error?.message ?? "(sin error)";
const sufijo = randomUUID().slice(0, 8);
const PASS = "Prueba-" + randomUUID();
const correoDe = (n) => `t_equipo_${n}_${sufijo}@example.com`;
const IPS = [];
const nuevaIp = () => { const ip = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; IPS.push(ip); return ip; };
const hashIp = (ip) => createHash("sha256").update(ip).digest("hex");

const ids = {};
const clubes = {};
async function crearCuenta(clave, { role = null, club = null, activo = true, meta = null } = {}) {
  const email = correoDe(clave);
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, ...(meta ? { app_metadata: meta } : {}) });
  if (u.error) throw new Error(`crear ${clave}: ${u.error.message}`);
  if (role) {
    const p = await svc.from("profiles").insert({ id: u.data.user.id, nombre: `T equipo ${clave} ${sufijo}`, role, club_id: club, activo });
    if (p.error) throw new Error(`perfil ${clave}: ${p.error.message}`);
  }
  ids[clave] = { id: u.data.user.id, email };
  return ids[clave];
}
// Supabase Auth limita los inicios de sesión por IP y la base de dev la
// comparten varias pruebas: si topa, espera y reintenta (hasta ~3 min).
async function sesion(email, password = PASS) {
  for (let intento = 0; ; intento++) {
    const c = anon();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (!error) return c;
    if (!/rate limit/i.test(error.message) || intento >= 6) throw new Error("login " + email + ": " + error.message);
    console.log(`(límite de Supabase Auth al iniciar sesión; espero 30 s)`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
const crearInv = (c, club, rol, nombreCorto) =>
  c.rpc("invitacion_crear", { p_club_id: club, p_rol: rol, p_correo: correoDe(nombreCorto), p_nombre: `Invitado ${nombreCorto}` });
const rechazado = (r) => !!r.error || r.data == null;

// ---------- HTTP ----------
async function login(email, password = PASS) {
  for (let intento = 0; ; intento++) {
    const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nuevaIp() }, body: JSON.stringify({ email, password }) });
    const galletas = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    // Un 401 con la contraseña correcta es el límite de Supabase Auth: espera.
    if (r.status !== 401 || intento >= 6) return { status: r.status, galletas };
    console.log("(login " + r.status + "; espero 30 s por el límite de Supabase Auth)");
    await new Promise((res) => setTimeout(res, 30_000));
  }
}
async function post(ruta, cuerpo, { galletas = "", ip = null } = {}) {
  const r = await fetch(BASE + ruta, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip ?? nuevaIp(), ...(galletas ? { cookie: galletas } : {}) },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})), cache: r.headers.get("cache-control") };
}
// El enlace más reciente archivado en la bandeja para ese correo.
async function tokenDeBandeja(correo) {
  const { data } = await svc.from("correos_salida").select("cuerpo, estado, plantilla").eq("destinatario", correo).order("creado_en", { ascending: false }).limit(1);
  const m = data?.[0]?.cuerpo?.match(/\/invitacion\/([0-9a-f]{64})/);
  return { token: m?.[1] ?? null, fila: data?.[0] ?? null };
}
const cuentasCon = async (correo) => {
  const db = await conectarDevEscritura();
  try {
    return (await db.q("select id from auth.users where lower(email) = $1", [correo])).length;
  } finally {
    await db.fin();
  }
};

try {
  // =========================================================================
  // 1. Reglas puras
  // =========================================================================
  revisar(rolesQuePuedeInvitar("dueno").join() === "gerente,staff,rp" && rolesQuePuedeInvitar("admin").length === 3, "dueño y admin: gerente, staff y RP");
  revisar(rolesQuePuedeInvitar("gerente").join() === "rp" && rolesQuePuedeInvitar("staff").join() === "rp", "gerente y staff: solo RP");
  revisar(["rp", "cliente", null, undefined, "dueno_grupo"].every((r) => rolesQuePuedeInvitar(r).length === 0), "RP, cliente y sin rol: nada");
  const ahora = new Date("2026-11-24T12:00:00Z");
  revisar(
    estadoInvitacion({ aceptada_en: null, revocada_en: null, expira_en: "2026-11-25T00:00:00Z" }, ahora) === "pendiente" &&
      estadoInvitacion({ aceptada_en: null, revocada_en: null, expira_en: "2026-11-24T12:00:00Z" }, ahora) === "vencida" &&
      estadoInvitacion({ aceptada_en: "x", revocada_en: null, expira_en: "2026-11-20T00:00:00Z" }, ahora) === "aceptada" &&
      estadoInvitacion({ aceptada_en: null, revocada_en: "x", expira_en: "2026-11-25T00:00:00Z" }, ahora) === "revocada",
    "estados: pendiente, vencida (justo al vencer), aceptada y revocada",
  );
  revisar(accionesDe("aceptada").reenviar === false && accionesDe("revocada").revocar === false && accionesDe("vencida").reenviar === true, "acciones: solo sobre pendientes y vencidas");
  revisar(urlPublica({ URL_PUBLICA: "https://antro.mx/" }, "http://evil") === "https://antro.mx", "URL pública: la variable explícita gana");
  revisar(urlPublica({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "antroapp.vercel.app" }, "https://evil.com") === "https://antroapp.vercel.app", "URL pública en producción: la del proyecto, no el Host");
  revisar(urlPublica({ VERCEL_ENV: "preview", VERCEL_URL: "x-git.vercel.app" }, "https://evil.com") === "https://x-git.vercel.app", "URL pública en vista previa: la del despliegue");
  revisar(urlPublica({}, "http://localhost:3022") === "http://localhost:3022", "URL pública en local: el origen");
  const tk = "a".repeat(64);
  const txt = textoCorreoInvitacion({ nombre: "Ana", rol: "rp", club: "Club X", invita: "Lalo", enlace: enlaceInvitacion("https://a.mx", tk), expiraEn: "2026-11-27T12:00:00Z" });
  revisar(txt.texto.includes(`https://a.mx/invitacion/${tk}`) && txt.asunto.includes("Club X") && !/[\r\n]/.test(txt.asunto), "correo: trae el enlace y el asunto va en una línea");
  revisar(!esquemaAceptar.safeParse({ accion: "aceptar", token: "abc", password: "12345678" }).success, "aceptar: token mal formado se rechaza");
  revisar(!esquemaAceptar.safeParse({ accion: "aceptar", token: tk, password: "1234567" }).success, "aceptar: contraseña de 7 se rechaza");
  const extra = esquemaAceptar.safeParse({ accion: "aceptar", token: tk, password: "12345678", rol: "admin", club_id: DEMO });
  revisar(extra.success && !("rol" in extra.data) && !("club_id" in extra.data), "aceptar: rol y club del cuerpo se descartan");
  revisar(!esquemaInvitar.safeParse({ accion: "crear", club_id: DEMO, rol: "dueno", correo: "a@b.mx", nombre: "Ana" }).success, "invitar: rol dueño se rechaza antes de la base");
  revisar(avisoEnvio("archivado").includes("bandeja") && avisoEnvio("enviado", true).includes("anterior"), "avisos de envío");
  revisar(valorRol([], "staff", "anular").permitido === false && valorRol([], "gerente", "anular").permitido === true && porDefecto("staff", "puerta"), "permisos de caja: valores por defecto como la base");
  revisar(valorRol([{ permiso: "anular", rol: "staff", profile_id: null, permitido: true }], "staff", "anular").propio === true, "permisos de caja: la casilla guardada gana");

  // Bandeja: el enlace se guarda completo SOLO si el correo no sale.
  const cfgArchivo = leerConfigCorreo({});
  const cfgProd = leerConfigCorreo({ CORREO_MODO: "enviar", VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://otra.supabase.co", RESEND_API_KEY: "re_x", CORREO_DE: "a@b.mx" });
  const fetchFalso = async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  const enlaceSecreto = `https://a.mx/invitacion/${"b".repeat(64)}`;
  const datosCorreo = (n) => ({ plantilla: "invitacion", para: correoDe(n), asunto: "Prueba", texto: `Abre ${enlaceSecreto}`, ocultar: [enlaceSecreto], mostrarSiSeArchiva: true });
  const ra = await procesarCorreo({ svc, cfg: cfgArchivo, fetch: fetchFalso, registrarError: () => {} }, datosCorreo("bandeja1"));
  const rb = await procesarCorreo({ svc, cfg: cfgProd, fetch: fetchFalso, registrarError: () => {} }, datosCorreo("bandeja2"));
  const { data: b1 } = await svc.from("correos_salida").select("cuerpo").eq("id", ra.id ?? "").maybeSingle();
  const { data: b2 } = await svc.from("correos_salida").select("cuerpo").eq("id", rb.id ?? "").maybeSingle();
  revisar(ra.estado === "archivado" && b1?.cuerpo.includes(enlaceSecreto), "bandeja: archivado conserva el enlace para que el admin lo haga llegar");
  revisar(rb.estado === "enviado" && b2?.cuerpo.includes("[oculto]") && !b2.cuerpo.includes(enlaceSecreto), "bandeja: enviado guarda «[oculto]»");

  // =========================================================================
  // 2. Datos de prueba
  // =========================================================================
  const dueno = await crearCuenta("dueno", { role: "dueno" });
  const duenoTemp = await crearCuenta("duenotemp", { role: "dueno", meta: { debe_cambiar: true } });
  for (const [clave, d] of [["A", dueno], ["B", duenoTemp]]) {
    const { data, error } = await svc.from("clubs").insert({ nombre: `T equipo ${clave} ${sufijo}`, direccion: "Calle 1", horario: "Vie", dueno_id: d.id }).select("id").single();
    if (error) throw new Error("club: " + error.message);
    clubes[clave] = data.id;
  }
  const A = clubes.A, B = clubes.B;
  await crearCuenta("gerente", { role: "gerente", club: A });
  await crearCuenta("staff", { role: "staff", club: A });
  await crearCuenta("rp", { role: "rp", club: A });
  await crearCuenta("cliente", { role: "cliente" });
  await crearCuenta("sinperfil");
  await crearCuenta("baja", { role: "gerente", club: A, activo: false });
  await crearCuenta("gerentetemp", { role: "gerente", club: A, meta: { debe_cambiar: true } });

  const s = {
    dueno: await sesion(dueno.email),
    duenoTemp: await sesion(duenoTemp.email),
    gerente: await sesion(ids.gerente.email),
    staff: await sesion(ids.staff.email),
    rp: await sesion(ids.rp.email),
    cliente: await sesion(ids.cliente.email),
    sinperfil: await sesion(ids.sinperfil.email),
    baja: await sesion(ids.baja.email),
    gerenteTemp: await sesion(ids.gerentetemp.email),
    admin: await sesion(cred.usuarios.admin, cred.password),
    duenoDemo: await sesion(cred.usuarios.dueno, cred.password),
    gerenteDemo: await sesion(cred.usuarios.gerente, cred.password),
    anon: anon(),
  };

  // =========================================================================
  // 3. Matriz de crear (en la base, con la sesión de cada quien)
  // =========================================================================
  const invG = await crearInv(s.dueno, A, "gerente", "invgerente");
  const invS = await crearInv(s.dueno, A, "staff", "invstaff");
  const invR = await crearInv(s.dueno, A, "rp", "invrp");
  revisar(!invG.error && !invS.error && !invR.error, "dueño invita gerente, staff y RP en su antro", msg(invG) + msg(invS));
  revisar(rechazado(await crearInv(s.dueno, DEMO, "rp", "x1")), "dueño NO invita en un antro ajeno (Club Demo Dev)");
  revisar(rechazado(await crearInv(s.dueno, A, "dueno", "x2")) && rechazado(await crearInv(s.dueno, A, "admin", "x3")), "nadie invita dueño ni admin");
  revisar(!(await crearInv(s.gerente, A, "rp", "gerrp")).error, "gerente invita RP en su antro");
  revisar(rechazado(await crearInv(s.gerente, A, "staff", "x4")) && rechazado(await crearInv(s.gerente, A, "gerente", "x5")), "gerente NO invita staff ni gerente (rol igual o mayor)");
  revisar(rechazado(await crearInv(s.gerente, DEMO, "rp", "x6")), "gerente NO invita en otro antro");
  revisar(rechazado(await crearInv(s.gerenteDemo, A, "rp", "x7")), "gerente de Club Demo Dev NO invita en el antro de prueba");
  revisar(!(await crearInv(s.staff, A, "rp", "staffrp")).error, "staff invita RP en su antro");
  revisar(rechazado(await crearInv(s.staff, A, "staff", "x8")), "staff NO invita staff");
  for (const [k, t] of [["rp", "RP"], ["cliente", "cliente"], ["sinperfil", "cuenta de Auth sin perfil"], ["baja", "gerente dado de baja"], ["gerenteTemp", "gerente con contraseña temporal"], ["anon", "anónimo"]]) {
    revisar(rechazado(await crearInv(s[k], A, "rp", `x_${k}`)), `${t} NO invita`, msg(await crearInv(s[k], A, "rp", `x_${k}`)));
  }
  revisar(rechazado(await crearInv(s.duenoTemp, B, "rp", "x9")), "dueño con contraseña temporal NO invita ni en su antro");
  revisar(!(await crearInv(s.admin, A, "staff", "adminstaff")).error, "admin invita en cualquier antro");
  revisar(rechazado(await s.admin.rpc("invitacion_crear", { p_club_id: null, p_rol: "rp", p_correo: correoDe("x10"), p_nombre: "X" })), "club nulo se rechaza (aunque sea admin)");
  revisar(rechazado(await s.admin.rpc("invitacion_crear", { p_club_id: A, p_rol: null, p_correo: correoDe("x11"), p_nombre: "X" })), "rol nulo se rechaza");
  revisar(rechazado(await s.admin.rpc("invitacion_crear", { p_club_id: randomUUID(), p_rol: "rp", p_correo: correoDe("x12"), p_nombre: "Equis" })), "antro inexistente se rechaza");
  revisar(/pendiente/.test(msg(await crearInv(s.dueno, A, "rp", "invrp"))), "mismo correo con pendiente en el mismo antro → «Ya hay una invitación pendiente»");
  revisar(/correo/.test(msg(await s.dueno.rpc("invitacion_crear", { p_club_id: A, p_rol: "rp", p_correo: "no-es-correo", p_nombre: "X" }))), "correo inválido se rechaza en la base");
  const { count: colados } = await svc.from("invitaciones").select("id", { count: "exact", head: true }).like("correo", `t_equipo_x%_${sufijo}@example.com`);
  revisar(colados === 0, "ninguna invitación rechazada quedó guardada", String(colados));
  const fila = (await svc.from("invitaciones").select("rol, club_id, invitado_por, token_hash, expira_en, creada_en").eq("id", invR.data).single()).data;
  revisar(fila.rol === "rp" && fila.club_id === A && fila.invitado_por === dueno.id && fila.token_hash === null, "la fila guarda rol, club y quién invitó; sin token hasta que el servidor lo emite");
  const horas = (Date.parse(fila.expira_en) - Date.parse(fila.creada_en)) / 3.6e6;
  revisar(Math.abs(horas - 72) < 0.01, `vence en 72 h (${horas.toFixed(2)})`);

  // =========================================================================
  // 4. Lectura (RLS) y escritura directa
  // =========================================================================
  const lee = async (c) => (await c.from("invitaciones").select("id, rol").eq("club_id", A)).data ?? [];
  const deDueno = await lee(s.dueno);
  const deGerente = await lee(s.gerente);
  revisar(deDueno.length >= 6 && deDueno.some((f) => f.rol === "gerente"), `el dueño ve todas las de su antro (${deDueno.length})`);
  revisar(deGerente.length >= 3 && deGerente.every((f) => f.rol === "rp"), `el gerente solo ve las de RP (${deGerente.length})`);
  revisar((await lee(s.staff)).every((f) => f.rol === "rp"), "el staff solo ve las de RP");
  for (const k of ["rp", "cliente", "sinperfil", "baja", "gerenteTemp", "duenoDemo", "gerenteDemo"]) revisar((await lee(s[k])).length === 0, `${k} no ve invitaciones del antro`);
  const anonLee = await s.anon.from("invitaciones").select("id").limit(1);
  revisar(!!anonLee.error || (anonLee.data ?? []).length === 0, "anónimo no lee invitaciones");
  revisar(!!(await s.dueno.from("invitaciones").select("token_hash").limit(1)).error, "nadie lee token_hash desde el navegador (ni el dueño)");
  const ins = await s.dueno.from("invitaciones").insert({ club_id: A, rol: "gerente", correo: correoDe("directo"), nombre: "Directo" });
  revisar(!!ins.error, "INSERT directo rechazado");
  const upd = await s.dueno.from("invitaciones").update({ rol: "gerente" }).eq("id", invR.data).select("id");
  revisar(!!upd.error || (upd.data ?? []).length === 0, "UPDATE directo (cambiar el rol) rechazado");
  revisar((await svc.from("invitaciones").select("rol").eq("id", invR.data).single()).data.rol === "rp", "…y el rol sigue siendo RP");
  const del = await s.dueno.from("invitaciones").delete().eq("id", invR.data).select("id");
  revisar(!!del.error || (del.data ?? []).length === 0, "DELETE directo rechazado");
  for (const f of ["invitacion_emitir_token", "invitacion_consultar", "invitacion_aceptar"]) {
    const args = f === "invitacion_emitir_token" ? { p_id: invR.data } : f === "invitacion_consultar" ? { p_token: tk } : { p_token: tk, p_user_id: dueno.id };
    revisar(!!(await s.dueno.rpc(f, args)).error && !!(await s.anon.rpc(f, args)).error, `${f}: solo el servidor (dueño y anónimo sin permiso)`);
  }
  revisar(!!(await s.anon.rpc("invitacion_puede", { p_club_id: A, p_rol: "rp" })).error, "anónimo no ejecuta invitacion_puede");
  revisar((await s.sinperfil.rpc("invitacion_puede", { p_club_id: A, p_rol: "rp" })).data === false, "invitacion_puede da false (no NULL) a la cuenta sin perfil");

  // =========================================================================
  // 5. Revocar y reenviar en la base
  // =========================================================================
  revisar(rechazado(await s.gerente.rpc("invitacion_revocar", { p_id: invS.data })) && /encontramos/.test(msg(await s.gerente.rpc("invitacion_revocar", { p_id: invS.data }))), "el gerente NO revoca la de staff del dueño (ni sabe si existe)");
  revisar(!!(await s.duenoDemo.rpc("invitacion_revocar", { p_id: invR.data })).error, "dueño ajeno NO revoca");
  revisar(!!(await s.sinperfil.rpc("invitacion_reenviar", { p_id: invR.data })).error, "cuenta sin perfil NO reenvía");
  revisar(!(await s.dueno.rpc("invitacion_revocar", { p_id: invS.data })).error, "el dueño revoca");
  revisar(/ya estaba revocada/.test(msg(await s.dueno.rpc("invitacion_revocar", { p_id: invS.data }))), "revocar dos veces avisa");
  revisar(/revocada/.test(msg(await s.dueno.rpc("invitacion_reenviar", { p_id: invS.data }))), "una revocada no se reenvía");
  revisar(/Espera/.test(msg(await s.dueno.rpc("invitacion_reenviar", { p_id: invG.data }))), "reenviar justo después de crearla: espera 2 minutos");
  const tok1 = await svc.rpc("invitacion_emitir_token", { p_id: invG.data });
  revisar(/^[0-9a-f]{64}$/.test(tok1.data ?? ""), "el servidor emite un token de 64 hex");
  revisar(!!(await svc.rpc("invitacion_emitir_token", { p_id: invG.data })).error, "no se emite un segundo token sin reenviar");
  const { data: hashGuardado } = await svc.from("invitaciones").select("token_hash").eq("id", invG.data).single();
  const hashEsperado = "\\x" + createHash("sha256").update(tok1.data).digest("hex");
  revisar(hashGuardado.token_hash === hashEsperado, "en la base solo queda el sha256 del token");

  // Límites
  await svc.from("invitacion_envios").insert(Array.from({ length: 30 }, () => ({ invitacion_id: invR.data, hecho_por: ids.staff.id, tipo: "crear" })));
  revisar(/límite/.test(msg(await crearInv(s.staff, A, "rp", "x13"))), "límite: 30 envíos por persona por hora");
  const masa = Array.from({ length: 400 }, (_, i) => ({ club_id: B, rol: "rp", correo: correoDe(`masa${i}`), nombre: "Masa", invitado_por: duenoTemp.id }));
  const insMasa = await svc.from("invitaciones").insert(masa);
  const r400 = await s.admin.rpc("invitacion_crear", { p_club_id: B, p_rol: "rp", p_correo: correoDe("x14"), p_nombre: "Equis" });
  revisar(!insMasa.error && /400/.test(msg(r400)), "límite: 400 pendientes por antro", msg(insMasa) + " / " + msg(r400));

  // Aceptar por la función con cuentas que no corresponden.
  const tokRp = (await svc.rpc("invitacion_emitir_token", { p_id: invR.data })).data;
  revisar(/no corresponde/.test(msg(await svc.rpc("invitacion_aceptar", { p_token: tokRp, p_user_id: ids.cliente.id }))), "aceptar con una cuenta que ya existía (cliente) → rechazado, nunca se liga");
  revisar(/no corresponde/.test(msg(await svc.rpc("invitacion_aceptar", { p_token: tokRp, p_user_id: ids.sinperfil.id }))), "aceptar con una cuenta sin perfil que ya existía → rechazado");
  const otro = await svc.auth.admin.createUser({ email: correoDe("invrp_otro"), password: PASS, email_confirm: true, app_metadata: { invitacion_id: invR.data } });
  ids.invrp_otro = { id: otro.data.user.id, email: correoDe("invrp_otro") };
  revisar(/no corresponde/.test(msg(await svc.rpc("invitacion_aceptar", { p_token: tokRp, p_user_id: otro.data.user.id }))), "aceptar con una cuenta nueva de OTRO correo → rechazado");
  revisar((await svc.from("profiles").select("role").eq("id", ids.cliente.id).single()).data.role === "cliente", "el cliente sigue siendo cliente");
  revisar(!(await svc.from("profiles").select("id").eq("id", ids.sinperfil.id).maybeSingle()).data, "la cuenta sin perfil sigue sin perfil");

  // =========================================================================
  // 6. Rutas (punta a punta)
  // =========================================================================
  if (BASE) {
    const web = {};
    for (const [k, e, p] of [["dueno", dueno.email], ["gerente", ids.gerente.email], ["gerenteTemp", ids.gerentetemp.email], ["sinperfil", ids.sinperfil.email], ["cliente", ids.cliente.email]]) {
      const l = await login(e, p);
      revisar(l.status === 200 && l.galletas.length > 0, `inicia sesión en la app: ${k} (${l.status})`);
      web[k] = l.galletas;
    }
    const cuerpoInv = (n, rol = "rp", club = A) => ({ accion: "crear", club_id: club, rol, correo: correoDe(n), nombre: `Invitado ${n}` });
    revisar((await post("/api/equipo/invitar", cuerpoInv("h0"))).status === 401, "invitar sin sesión → 401");
    const h1 = await post("/api/equipo/invitar", cuerpoInv("h1"), { galletas: web.dueno });
    revisar(h1.status === 200 && h1.cuerpo.correo === "archivado" && /bandeja/.test(h1.cuerpo.aviso ?? "") && h1.cache === "no-store", `el dueño invita por la ruta (${h1.status}, ${h1.cuerpo.correo}, no-store)`, JSON.stringify(h1.cuerpo));
    revisar(!("token" in h1.cuerpo) && !JSON.stringify(h1.cuerpo).match(/[0-9a-f]{64}/), "la respuesta NO trae el token (quien invita no lo ve)");
    const g1 = await post("/api/equipo/invitar", cuerpoInv("h2", "staff"), { galletas: web.gerente });
    revisar(g1.status === 403 && /No puedes invitar/.test(g1.cuerpo.error ?? ""), "gerente invita staff por la ruta → 403 de la base");
    revisar((await post("/api/equipo/invitar", cuerpoInv("h3", "rp", DEMO), { galletas: web.gerente })).status === 403, "gerente con club_id ajeno en el cuerpo → 403");
    revisar((await post("/api/equipo/invitar", cuerpoInv("h4", "admin"), { galletas: web.dueno })).status === 400, "rol admin en el cuerpo → 400");
    revisar((await post("/api/equipo/invitar", cuerpoInv("h5"), { galletas: web.gerenteTemp })).status === 403, "con contraseña temporal → 403");
    revisar((await post("/api/equipo/invitar", cuerpoInv("h6"), { galletas: web.sinperfil })).status === 403, "cuenta sin perfil → 403");
    revisar((await post("/api/equipo/invitar", cuerpoInv("h7"), { galletas: web.cliente })).status === 403, "cliente → 403");

    const { token: t1, fila: f1 } = await tokenDeBandeja(correoDe("h1"));
    revisar(!!t1 && f1.estado === "archivado" && f1.plantilla === "invitacion", "el enlace quedó completo en la bandeja (modo archivo) para el admin");

    const c1 = await post("/api/invitacion", { accion: "consultar", token: t1 });
    revisar(c1.status === 200 && c1.cuerpo.invitacion?.estado === "pendiente" && c1.cuerpo.invitacion.rol === "rp" && c1.cuerpo.invitacion.club === `T equipo A ${sufijo}`, "consultar: pendiente, RP, antro correcto");
    revisar(!JSON.stringify(c1.cuerpo).includes("club_id") && !("id" in (c1.cuerpo.invitacion ?? {})), "consultar no devuelve ids");
    revisar((await post("/api/invitacion", { accion: "consultar", token: "c".repeat(64) })).status === 404, "token inexistente → 404");
    revisar((await post("/api/invitacion", { accion: "consultar", token: "../x" })).status === 400, "token mal formado → 400");

    // Rol y club manipulados en el cuerpo: se ignoran.
    const a1 = await post("/api/invitacion", { accion: "aceptar", token: t1, password: PASS, rol: "gerente", role: "admin", club_id: DEMO, correo: correoDe("otro"), email: correoDe("otro") });
    revisar(a1.status === 200 && a1.cuerpo.rol === "rp", `aceptar con rol/club/correo manipulados → 200 como RP (${a1.status})`, JSON.stringify(a1.cuerpo));
    const nuevo = (await svc.from("invitaciones").select("aceptada_por, aceptada_en").eq("correo", correoDe("h1")).single()).data;
    ids.h1 = { id: nuevo.aceptada_por, email: correoDe("h1") };
    const perfilNuevo = (await svc.from("profiles").select("role, club_id, nombre, activo").eq("id", nuevo.aceptada_por).single()).data;
    revisar(perfilNuevo.role === "rp" && perfilNuevo.club_id === A && perfilNuevo.activo === true && perfilNuevo.nombre === "Invitado h1", "perfil con rol y club DE LA INVITACIÓN");
    revisar((await cuentasCon(correoDe("otro"))) === 0, "no se creó cuenta con el correo del cuerpo");
    const entra = { error: await sesion(correoDe("h1")).then(() => null, (e) => e) };
    revisar(!entra.error, "la persona invitada entra con su contraseña");

    // Reutilizado
    const a2 = await post("/api/invitacion", { accion: "aceptar", token: t1, password: PASS });
    revisar(a2.status === 410 && /ya se usó/.test(a2.cuerpo.error ?? ""), "token reutilizado → 410 «ya se usó»");
    revisar((await cuentasCon(correoDe("h1"))) === 1, "sigue habiendo UNA cuenta con ese correo");
    revisar((await post("/api/invitacion", { accion: "consultar", token: t1 })).cuerpo.invitacion?.estado === "aceptada", "consultar la usada: «aceptada»");

    // Vencido
    const h8 = await post("/api/equipo/invitar", cuerpoInv("h8"), { galletas: web.dueno });
    const { token: t8 } = await tokenDeBandeja(correoDe("h8"));
    await svc.from("invitaciones").update({ expira_en: new Date(Date.now() - 60_000).toISOString() }).eq("correo", correoDe("h8"));
    const a8 = await post("/api/invitacion", { accion: "aceptar", token: t8, password: PASS });
    revisar(h8.status === 200 && a8.status === 410 && /venció/.test(a8.cuerpo.error ?? ""), "token vencido → 410 «venció»");
    revisar((await cuentasCon(correoDe("h8"))) === 0, "con el vencido no se creó cuenta");
    // Vencida → reenviar (pasado el cooldown) revive con token nuevo.
    await svc.from("invitacion_envios").update({ hecho_en: new Date(Date.now() - 600_000).toISOString() }).in("invitacion_id", [h8.cuerpo.id]);
    const r8 = await post("/api/equipo/invitar", { accion: "reenviar", id: h8.cuerpo.id }, { galletas: web.dueno });
    const { token: t8b } = await tokenDeBandeja(correoDe("h8"));
    revisar(r8.status === 200 && t8b && t8b !== t8 && /anterior/.test(r8.cuerpo.aviso ?? ""), "reenviar la vencida: token nuevo", JSON.stringify(r8.cuerpo));
    revisar((await post("/api/invitacion", { accion: "consultar", token: t8 })).status === 404, "el token anterior ya no existe (404)");
    const a8b = await post("/api/invitacion", { accion: "aceptar", token: t8b, password: PASS });
    revisar(a8b.status === 200, "con el token reenviado sí entra");
    ids.h8 = { id: (await svc.from("invitaciones").select("aceptada_por").eq("id", h8.cuerpo.id).single()).data.aceptada_por, email: correoDe("h8") };
    revisar(/2 minutos|Espera|aceptó/.test((await post("/api/equipo/invitar", { accion: "reenviar", id: h8.cuerpo.id }, { galletas: web.dueno })).cuerpo.error ?? ""), "reenviar una aceptada se rechaza");

    // Revocado
    const h9 = await post("/api/equipo/invitar", cuerpoInv("h9"), { galletas: web.gerente });
    const { token: t9 } = await tokenDeBandeja(correoDe("h9"));
    revisar(h9.status === 200, "el gerente invita un RP por la ruta");
    revisar(!(await s.gerente.rpc("invitacion_revocar", { p_id: h9.cuerpo.id })).error, "el gerente revoca su invitación de RP");
    const a9 = await post("/api/invitacion", { accion: "aceptar", token: t9, password: PASS });
    revisar(a9.status === 410 && /cancelada/.test(a9.cuerpo.error ?? ""), "token revocado → 410 «cancelada»");
    revisar((await cuentasCon(correoDe("h9"))) === 0, "con el revocado no se creó cuenta");

    // Correo que ya tiene cuenta: sin perfil y cliente.
    for (const [k, t] of [["sinperfil", "cuenta sin perfil"], ["cliente", "cliente"]]) {
      const inv = await s.dueno.rpc("invitacion_crear", { p_club_id: A, p_rol: "gerente", p_correo: ids[k].email, p_nombre: "Ya existe" });
      const tok = (await svc.rpc("invitacion_emitir_token", { p_id: inv.data })).data;
      const r = await post("/api/invitacion", { accion: "aceptar", token: tok, password: "Otra-" + randomUUID() });
      revisar(r.status === 409 && r.cuerpo.yaExiste === true, `correo de una ${t} → 409 sin ligarla`, JSON.stringify(r.cuerpo));
      const sigue = { error: await sesion(ids[k].email).then(() => null, (e) => e) };
      revisar(!sigue.error, `la ${t} conserva su contraseña`);
      const p = (await svc.from("profiles").select("role, club_id").eq("id", ids[k].id).maybeSingle()).data;
      revisar(k === "sinperfil" ? p === null : p.role === "cliente" && p.club_id === null, `la ${t} no ganó rol ni antro`);
      revisar((await svc.from("invitaciones").select("aceptada_en").eq("id", inv.data).single()).data.aceptada_en === null, "la invitación sigue pendiente");
    }

    // Dos aceptaciones al mismo tiempo: gana una.
    const h10 = await post("/api/equipo/invitar", cuerpoInv("h10"), { galletas: web.dueno });
    const { token: t10 } = await tokenDeBandeja(correoDe("h10"));
    const dos = await Promise.all([1, 2, 3].map(() => post("/api/invitacion", { accion: "aceptar", token: t10, password: PASS })));
    const ok10 = dos.filter((r) => r.status === 200).length;
    revisar(h10.status === 200 && ok10 === 1, `3 aceptaciones a la vez: gana 1 (${dos.map((r) => r.status).join(", ")})`);
    revisar((await cuentasCon(correoDe("h10"))) === 1, "…y queda una sola cuenta");
    ids.h10 = { id: (await svc.from("invitaciones").select("aceptada_por").eq("id", h10.cuerpo.id).single()).data.aceptada_por, email: correoDe("h10") };

    // Límite por IP
    const ipFija = nuevaIp();
    let ultimo = 0;
    for (let i = 0; i < 31; i++) ultimo = (await post("/api/invitacion", { accion: "consultar", token: "d".repeat(64) }, { ip: ipFija })).status;
    revisar(ultimo === 429, `consultar: la 31.ª desde la misma IP → 429 (${ultimo})`);
    const ipFija2 = nuevaIp();
    for (let i = 0; i < 11; i++) ultimo = (await post("/api/invitacion", { accion: "aceptar", token: "d".repeat(64), password: PASS }, { ip: ipFija2 })).status;
    revisar(ultimo === 429, `aceptar: el 11.º desde la misma IP → 429 (${ultimo})`);

    // create-staff con contraseña temporal (hueco menor que se cerró).
    const cs = await post("/api/admin/create-staff", { email: correoDe("cs"), password: PASS, nombre: "CS", role: "rp", club_id: A }, { galletas: web.gerenteTemp });
    revisar(cs.status === 403 && (await cuentasCon(correoDe("cs"))) === 0, `create-staff con contraseña temporal → 403 (${cs.status})`);
  } else {
    console.log("(sin --base: no se prueban las rutas)");
  }

  // =========================================================================
  // 7. Permisos de caja (la matriz que muestra la pantalla)
  // =========================================================================
  const cfgDueno = await s.dueno.rpc("caja_configurar_permiso", { p_club_id: A, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: true });
  revisar(!cfgDueno.error, "el dueño cambia una casilla de la matriz", msg(cfgDueno));
  const cfgGer = await s.gerente.rpc("caja_configurar_permiso", { p_club_id: A, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: false });
  revisar(!!cfgGer.error, "el gerente NO (la base lo rechaza)");
  const vistaGer = (await s.gerente.from("caja_permisos").select("permiso, rol, profile_id, permitido").eq("club_id", A)).data ?? [];
  revisar(valorRol(vistaGer, "staff", "anular").permitido === true, "el gerente sí ve la matriz (solo lectura)");
  revisar(!!(await s.staff.rpc("caja_configurar_permiso", { p_club_id: A, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: false })).error, "el staff tampoco la cambia");
  revisar(!!(await s.duenoDemo.rpc("caja_configurar_permiso", { p_club_id: A, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: false })).error, "dueño ajeno no la cambia");

  // =========================================================================
  // 8. Pantallas
  // =========================================================================
  if (BASE && PANTALLA) await pantallas();
} catch (e) {
  fallan++;
  console.log("FALLA  inesperada: " + (e?.stack ?? e));
} finally {
  await limpiar();
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}

async function pantallas() {
  if (!process.env.PLAYWRIGHT_DESDE) {
    console.log("Falta PLAYWRIGHT_DESDE: no se revisan pantallas.");
    return;
  }
  const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
  const carpeta = path.join(RAIZ, "screenshots-b-equipo");
  mkdirSync(carpeta, { recursive: true });
  const navegador = await chromium.launch();
  // Invitación fresca para la página pública.
  const inv = await crearInvSvc("pant", "rp");
  try {
    for (const [ancho, alto] of [[390, 844], [360, 740]]) {
      for (const [quien, email, ruta] of [["dueno", ids.dueno.email, "/dueno/equipo"], ["gerente", ids.gerente.email, "/staff/equipo"]]) {
        const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, extraHTTPHeaders: { "x-forwarded-for": nuevaIp() } });
        const page = await ctx.newPage();
        const errores = [];
        page.on("pageerror", (e) => errores.push(e.message));
        await page.goto(BASE + "/cliente/login");
        await page.fill("#email", email);
        await page.fill("#password", PASS);
        await page.click("button[type=submit]");
        await page.waitForURL(/panel/, { timeout: 20000 });
        await page.goto(BASE + ruta);
        await page.getByRole("heading", { name: "Invitar por correo" }).waitFor({ timeout: 15000 });
        await page.getByText("Cargando permisos…").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
        await page.getByText("Cargando invitaciones…").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
        const botonesRol = await page.locator("fieldset button").count();
        const togglesMatriz = await page.locator("table button").count();
        if (quien === "dueno") {
          revisar(botonesRol === 3 && togglesMatriz === 18, `${ancho}px dueño: 3 roles para invitar y la matriz editable (${botonesRol}, ${togglesMatriz})`);
        } else {
          revisar(botonesRol === 0 && togglesMatriz === 0 && (await page.getByText("Solo el dueño cambia estos permisos").count()) === 1, `${ancho}px gerente: solo RP y matriz de solo lectura (${botonesRol}, ${togglesMatriz})`);
        }
        const lista = await page.getByText(/Invitado (invrp|gerrp)/).count();
        revisar(lista > 0, `${ancho}px ${quien}: ve sus invitaciones en la lista`);
        await revisarPagina(page, `${ancho}px ${quien} ${ruta}`, errores);
        await page.screenshot({ path: path.join(carpeta, `b12-equipo-${quien}-${ancho}.png`), fullPage: true });
        await ctx.close();
      }
      // Página pública (sin sesión)
      const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, extraHTTPHeaders: { "x-forwarded-for": nuevaIp() } });
      const page = await ctx.newPage();
      const errores = [];
      page.on("pageerror", (e) => errores.push(e.message));
      await page.goto(`${BASE}/invitacion/${ancho === 390 ? inv.token : "e".repeat(64)}`);
      if (ancho === 390) {
        await page.getByText(/Únete a T equipo A/).waitFor({ timeout: 15000 });
        await revisarPagina(page, `${ancho}px /invitacion (formulario)`, errores);
        await page.screenshot({ path: path.join(carpeta, `b12-invitacion-formulario-${ancho}.png`), fullPage: true });
        await page.fill("#password", PASS);
        await page.fill("#confirmar", PASS);
        await page.click("button[type=submit]");
        await page.getByText("Tu cuenta está lista").waitFor({ timeout: 20000 });
        revisar(true, `${ancho}px /invitacion: aceptar desde la pantalla deja la cuenta lista`);
        await page.screenshot({ path: path.join(carpeta, `b12-invitacion-lista-${ancho}.png`), fullPage: true });
        const p = (await svc.from("invitaciones").select("aceptada_por").eq("id", inv.id).single()).data;
        ids.pant = { id: p.aceptada_por, email: correoDe("pant") };
        const meta = await page.locator('meta[name="referrer"]').getAttribute("content");
        revisar(meta === "no-referrer", "la página de invitación no manda Referer");
      } else {
        await page.getByText("No pudimos abrir la invitación").waitFor({ timeout: 15000 });
        await revisarPagina(page, `${ancho}px /invitacion (inexistente)`, errores);
        await page.screenshot({ path: path.join(carpeta, `b12-invitacion-inexistente-${ancho}.png`), fullPage: true });
        await page.goto(`${BASE}/invitacion/${inv.token}`);
        await page.getByText("Esta invitación ya se usó").waitFor({ timeout: 15000 });
        await revisarPagina(page, `${ancho}px /invitacion (usada)`, errores);
        await page.screenshot({ path: path.join(carpeta, `b12-invitacion-usada-${ancho}.png`), fullPage: true });
      }
      await ctx.close();
    }
  } finally {
    await navegador.close();
  }
}

async function crearInvSvc(n, rol) {
  const c = await sesion(ids.dueno.email);
  const r = await c.rpc("invitacion_crear", { p_club_id: clubes.A, p_rol: rol, p_correo: correoDe(n), p_nombre: `Invitado ${n}` });
  const token = (await svc.rpc("invitacion_emitir_token", { p_id: r.data })).data;
  return { id: r.data, token };
}

async function revisarPagina(page, etiqueta, errores) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  revisar(scroll <= 0, `${etiqueta}: sin scroll horizontal`, String(scroll));
  const chicos = await page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, select, textarea")]
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ t: (e.textContent || e.id || e.tagName).trim().slice(0, 30), h: e.getBoundingClientRect().height }))
      .filter((x) => x.h < 40),
  );
  revisar(chicos.length === 0, `${etiqueta}: controles de 40 px o más`, JSON.stringify(chicos.slice(0, 5)));
  revisar(errores.length === 0, `${etiqueta}: sin errores de página`, errores.join(" | "));
}

async function limpiar() {
  const db = await conectarDevEscritura();
  let cuentas = [];
  try {
    const patron = `t_equipo_%_${sufijo}@example.com`;
    cuentas = (await db.q("select id from auth.users where email like $1", [patron])).map((r) => r.id);
    await db.q("begin");
    const clubIds = Object.values(clubes);
    // Invitaciones de prueba en CUALQUIER antro (por si alguna se coló).
    await db.q("delete from public.invitaciones where correo like $1 or club_id = any($2::uuid[])", [patron, clubIds]);
    if (IPS.length) await db.q("delete from public.invitacion_intentos where ip_hash = any($1::text[])", [IPS.map(hashIp)]);
    await db.q("delete from public.correos_salida where destinatario like $1", [patron]);
    await db.q("delete from public.caja_permisos where club_id = any($1::uuid[])", [clubIds]);
    await db.q("delete from public.profiles where id = any($1::uuid[])", [cuentas]);
    await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    fallan++;
    console.log("FALLA  limpieza: " + e.message);
  } finally {
    await db.fin();
  }
  for (const id of cuentas) {
    const r = await svc.auth.admin.deleteUser(id);
    if (r.error) console.log("No se pudo borrar una cuenta de prueba: " + r.error.message);
  }
  const db2 = await conectarDevEscritura();
  try {
    const [{ n }] = await db2.q("select count(*)::int as n from auth.users where email like $1", [`t_equipo_%_${sufijo}@example.com`]);
    const [{ m }] = await db2.q("select count(*)::int as m from public.invitaciones where correo like $1", [`t_equipo_%_${sufijo}@example.com`]);
    console.log(`\nLimpieza: ${cuentas.length} cuentas y ${Object.keys(clubes).length} antros borrados; quedan ${n} cuentas y ${m} invitaciones de esta corrida.`);
    if (n || m) fallan++;
  } finally {
    await db2.fin();
  }
}
