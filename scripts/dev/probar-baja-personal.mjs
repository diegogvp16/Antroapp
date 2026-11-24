// Pruebas de la baja y reactivación de staff y gerentes, y del registro de
// actividad (sql/post-junta/02-baja-personal.sql y 03-actividad.sql), contra
// antroapp-dev y el servidor local (node scripts/dev/servidor-dev.mjs, 3001).
//
//   node scripts/dev/probar-baja-personal.mjs [--base=http://localhost:3001]
//
// Crea su propio staff y gerentes en Club Demo Dev y los borra al final.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const BASE = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3001").replace(/\/$/, "");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const sufijo = randomUUID().slice(0, 8);
const PASS = "Prueba-" + randomUUID();
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function login(email, password) {
  const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ email, password }) });
  return { status: r.status, galletas: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), cuerpo: await r.json().catch(() => ({})) };
}
async function cliente(email, password = cred.password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error("login " + email + ": " + error.message);
  return c;
}
const ids = {};
async function crear(clave, role) {
  const email = `baja_${clave}_${sufijo}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (u.error) throw new Error(u.error.message);
  const p = await svc.from("profiles").insert({ id: u.data.user.id, nombre: `Baja ${clave} ${sufijo}`, role, club_id: CLUB, activo: true });
  if (p.error) throw new Error(p.error.message);
  ids[clave] = { id: u.data.user.id, email };
}
const cambiar = (c, clave, activo, motivo = "Prueba de baja") => c.rpc("personal_cambiar_estado", { p_profile_id: ids[clave].id, p_activo: activo, p_motivo: motivo });
const msg = (r) => r.error?.message ?? "(sin error)";

try {
  await crear("staffA", "staff");
  await crear("staffB", "staff");
  await crear("gerente", "gerente");
  await crear("gerente2", "gerente");
  await crear("rp", "rp");

  const staffA = await cliente(ids.staffA.email, PASS);
  const webA = await login(ids.staffA.email, PASS);
  const antes = await staffA.from("reservations").select("id", { count: "exact", head: true }).eq("club_id", CLUB);
  const permisosAntes = await staffA.rpc("caja_mis_permisos", { p_club_id: CLUB });
  revisar(webA.status === 200 && (antes.count ?? 0) > 0 && permisosAntes.data?.abrir_mesa === true, `staff activo entra, ve ${antes.count} reservas y puede abrir mesas`);

  const staffB = await cliente(ids.staffB.email, PASS);
  const gerente = await cliente(ids.gerente.email, PASS);
  const dueno = await cliente(cred.usuarios.dueno);
  const gerenteTj = await cliente(cred.usuarios.gerente_tijuana);
  const admin = await cliente(cred.usuarios.admin);

  // ---------- Permisos ----------
  revisar(/permiso/.test(msg(await cambiar(staffB, "staffA", false))), "staff no da de baja a otro staff");
  revisar(/permiso/.test(msg(await cambiar(gerenteTj, "staffA", false))), "gerente de otro antro no puede");
  revisar(/permiso/.test(msg(await cambiar(gerente, "gerente2", false))), "gerente no da de baja a otro gerente");
  revisar(/propio estado/.test(msg(await gerente.rpc("personal_cambiar_estado", { p_profile_id: ids.gerente.id, p_activo: false, p_motivo: "yo mismo" }))), "nadie se da de baja a sí mismo");
  revisar(/motivo/.test(msg(await cambiar(gerente, "staffA", false, "  x "))), "sin motivo no se puede");
  revisar(/staff y gerentes/.test(msg(await cambiar(gerente, "rp", false))), "la función no toca RPs (siguen con su flujo)");
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  revisar(!!(await anon.rpc("personal_cambiar_estado", { p_profile_id: ids.staffA.id, p_activo: false, p_motivo: "anónimo" })).error, "anónimo no puede");
  const directo = await gerente.from("profiles").update({ activo: false }).eq("id", ids.staffA.id).select("id");
  revisar(!!directo.error && /pantalla de Equipo/.test(directo.error.message), "UPDATE directo de activo sobre staff → rechazado (sin motivo no hay baja)", msg(directo));
  const rpDirecto = await staffB.from("profiles").update({ activo: false }).eq("id", ids.rp.id).select("id");
  revisar(!rpDirecto.error && rpDirecto.data?.length === 1, "la baja de RPs por el staff sigue igual que hoy", msg(rpDirecto));

  // ---------- Baja por el gerente ----------
  const baja = await cambiar(gerente, "staffA", false, "Faltó tres noches seguidas");
  revisar(!baja.error, "gerente da de baja al staff con motivo", msg(baja));
  revisar(/ya está dado de baja/.test(msg(await cambiar(gerente, "staffA", false))), "dar de baja dos veces avisa que ya está");

  // La sesión que staff A ya tenía abierta:
  const despues = await staffA.from("reservations").select("id").eq("club_id", CLUB).limit(5);
  revisar(!despues.error && despues.data.length === 0, "con la sesión abierta ya no ve reservas", msg(despues));
  const mesas = await staffA.from("club_tables").select("id").eq("club_id", CLUB).limit(5);
  revisar((mesas.data ?? []).length === 0, "ni mesas");
  const perfiles = await staffA.from("profiles").select("id").eq("club_id", CLUB).neq("id", ids.staffA.id).limit(5);
  revisar((perfiles.data ?? []).length === 0, "ni al personal del antro");
  const permisos = await staffA.rpc("caja_mis_permisos", { p_club_id: CLUB });
  revisar(permisos.data && Object.values(permisos.data).every((v) => v === false), "ningún permiso de caja");
  const abrir = await staffA.rpc("caja_noche_actual", { p_club_id: CLUB });
  revisar(!!abrir.error || abrir.data == null, "no puede abrir ni leer la noche de caja", JSON.stringify(abrir.data));
  const propio = await staffA.from("profiles").select("activo").eq("id", ids.staffA.id).maybeSingle();
  revisar(propio.data?.activo === false, "sí lee su propio perfil (para que la app le avise)");
  const refrescar = await staffA.auth.refreshSession();
  revisar(!!refrescar.error, "ya no puede renovar su sesión (se cerraron sus sesiones)", refrescar.error?.message ?? "renovó");
  const crearRp = await fetch(BASE + "/api/admin/create-staff", { method: "POST", headers: { "content-type": "application/json", cookie: webA.galletas }, body: JSON.stringify({ email: `baja_x_${sufijo}@example.com`, password: PASS, nombre: "X", role: "rp", club_id: CLUB }) });
  revisar(crearRp.status === 401 || crearRp.status === 403, `con su cookie vieja no crea RPs (${crearRp.status})`);
  const loginA = await login(ids.staffA.email, PASS);
  revisar(loginA.status === 403 && /desactivada/.test(loginA.cuerpo.error ?? ""), "ya no puede iniciar sesión (403 con aviso)");

  // ---------- Dueño y admin ----------
  revisar(!(await cambiar(dueno, "gerente2", false, "Cambio de turno")).error, "el dueño da de baja a un gerente");
  revisar(!(await cambiar(admin, "gerente2", true, "Regresa en diciembre")).error, "el admin lo reactiva");

  // ---------- Bitácora e historial ----------
  const { data: movs } = await svc.from("personal_movimientos").select("accion, motivo, hecho_por, profile_id").in("profile_id", [ids.staffA.id, ids.gerente2.id]).order("hecho_en");
  revisar(movs?.length === 3 && movs[0].hecho_por === ids.gerente.id && movs[0].motivo === "Faltó tres noches seguidas", "bitácora: 3 movimientos con quién y motivo");
  const hist = await dueno.rpc("personal_historial", { p_club_id: CLUB });
  revisar(!hist.error && hist.data.some((h) => h.persona === `Baja staffA ${sufijo}` && h.hecho_por === `Baja gerente ${sufijo}`), "el dueño ve el historial con nombres");
  revisar(!!(await staffB.rpc("personal_historial", { p_club_id: CLUB })).error, "el staff no ve el historial");
  revisar(((await staffB.from("personal_movimientos").select("id")).data ?? []).length === 0, "el staff no lee la bitácora directo");
  revisar(!!(await gerenteTj.rpc("personal_historial", { p_club_id: CLUB })).error, "gerente de otro antro no ve el historial");

  // ---------- Registro de actividad ----------
  const noche = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
  const desde = new Date(Date.parse(noche) - 6 * 86400e3).toISOString().slice(0, 10);
  const act = await gerente.rpc("actividad_club", { p_club_id: CLUB, p_desde: desde, p_hasta: noche });
  revisar(!act.error && act.data.some((f) => f.tipo === "personal_baja" && f.persona === `Baja staffA ${sufijo}` && f.motivo === "Faltó tres noches seguidas"), "el gerente ve la baja en la actividad", msg(act));
  const tipos = [...new Set((act.data ?? []).map((f) => f.tipo))].sort();
  revisar(tipos.every((t) => !["abrir_mesa", "sentar_cliente", "puerta_escanear", "puerta_confirmar_entrada"].includes(t)), `solo movimientos de interés (${tipos.join(", ")})`);
  const { data: cuadres } = await svc.from("caja_eventos").select("id").eq("club_id", CLUB).in("tipo", ["cuadrar_mesa", "anular_consumo", "reabrir_mesa"]).gte("hecho_en", new Date(Date.parse(desde) + 8 * 3600e3).toISOString());
  const deCaja = (act.data ?? []).filter((f) => ["cuadrar_mesa", "anular_consumo", "reabrir_mesa"].includes(f.tipo));
  revisar(deCaja.length === (cuadres ?? []).length && deCaja.every((f) => f.quien && f.quien !== "Sistema"), `los ${deCaja.length} cuadres, anulaciones y reaperturas de la semana, con nombre`);
  revisar(deCaja.filter((f) => f.tipo !== "cuadrar_mesa").every((f) => f.motivo), "anulaciones y reaperturas traen su motivo");
  revisar(!(await dueno.rpc("actividad_club", { p_club_id: CLUB, p_desde: desde, p_hasta: noche })).error, "el dueño ve la actividad");
  revisar(!!(await staffB.rpc("actividad_club", { p_club_id: CLUB, p_desde: desde, p_hasta: noche })).error, "el staff no ve la actividad");
  revisar(!!(await gerenteTj.rpc("actividad_club", { p_club_id: CLUB, p_desde: desde, p_hasta: noche })).error, "gerente de otro antro no la ve");
  revisar(!!(await gerente.rpc("actividad_club", { p_club_id: CLUB, p_desde: "2026-01-01", p_hasta: noche })).error, "rango de más de 3 meses se rechaza");

  // ---------- Reactivación ----------
  revisar(!(await cambiar(gerente, "staffA", true, "Ya regresó")).error, "el gerente lo reactiva");
  const loginOtraVez = await login(ids.staffA.email, PASS);
  const staffA2 = await cliente(ids.staffA.email, PASS);
  const otraVez = await staffA2.from("reservations").select("id", { count: "exact", head: true }).eq("club_id", CLUB);
  revisar(loginOtraVez.status === 200 && otraVez.count === antes.count, "reactivado: entra y vuelve a ver todo");

  // ---------- Pantallas ----------
  const pantallas = await Promise.all(["/staff/equipo", "/dueno/equipo"].map((r) => fetch(BASE + r).then((x) => x.status)));
  revisar(pantallas.every((s) => s === 200), "las pantallas /staff/equipo y /dueno/equipo responden");
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  const todos = Object.values(ids).map((x) => x.id);
  if (todos.length) {
    await svc.from("personal_movimientos").delete().in("profile_id", todos);
    await svc.from("personal_movimientos").delete().in("hecho_por", todos);
    await svc.from("profiles").delete().in("id", todos);
    for (const id of todos) await svc.auth.admin.deleteUser(id);
  }
  console.log(`\nLimpieza: ${todos.length} cuentas de prueba borradas.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
