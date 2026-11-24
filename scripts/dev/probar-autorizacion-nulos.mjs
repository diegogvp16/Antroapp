// Prueba de regresión del hueco "autorización en NULL" (sql/post-junta/10):
// una cuenta de Auth SIN perfil, un staff DADO DE BAJA y un staff con
// CONTRASEÑA TEMPORAL no deben pasar ninguna función de gerente o dueño.
//
//   node scripts/dev/probar-autorizacion-nulos.mjs
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const o = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, o);
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;
let pasan = 0, fallan = 0;
const revisar = (c, t, d = "") => { if (c) pasan++; else fallan++; console.log((c ? "OK     " : "FALLA  ") + t + (c || !d ? "" : "  — " + d)); };
const ids = [];
const P = "Prueba-" + randomUUID();
async function cuenta(clave, perfil, meta) {
  const email = `nulos_${clave}_${randomUUID().slice(0, 6)}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: P, email_confirm: true, ...(meta ? { app_metadata: meta } : {}) });
  ids.push(u.data.user.id);
  if (perfil) await svc.from("profiles").insert({ id: u.data.user.id, nombre: "Nulos " + clave, ...perfil });
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, o);
  await c.auth.signInWithPassword({ email, password: P });
  return c;
}
const nadaOError = (r) => !!r.error || (Array.isArray(r.data) && r.data.length === 0);
try {
  const casos = {
    "sin perfil": await cuenta("sinperfil", null),
    "gerente dado de baja": await cuenta("baja", { role: "gerente", club_id: CLUB, activo: false }),
    "gerente con contraseña temporal": await cuenta("temporal", { role: "gerente", club_id: CLUB }, { debe_cambiar: true }),
    "gerente sin antro": await cuenta("sinantro", { role: "gerente", club_id: null }),
  };
  for (const [quien, c] of Object.entries(casos)) {
    revisar(nadaOError(await c.rpc("nomina_semana", { p_club_id: CLUB, p_anio: 2026, p_semana: 47 })), `${quien}: no lee la nómina`);
    revisar(nadaOError(await c.rpc("grupo_rendimiento_rp", { p_club_id: CLUB, p_desde: "2026-11-01", p_hasta: "2026-11-30" })), `${quien}: no lee el rendimiento por RP`);
    revisar(nadaOError(await c.rpc("actividad_club", { p_club_id: CLUB, p_desde: "2026-11-17", p_hasta: "2026-11-23" })), `${quien}: no lee la actividad`);
    revisar(nadaOError(await c.rpc("personal_historial", { p_club_id: CLUB })), `${quien}: no lee el historial de personal`);
    revisar(!!(await c.rpc("caja_configurar_permiso", { p_club_id: CLUB, p_permiso: "anular", p_rol: "staff", p_profile_id: null, p_permitido: true })).error, `${quien}: no configura permisos de caja`);
    revisar(!!(await c.rpc("producto_importar", { p_club_id: CLUB, p_filas: [{ nombre: "Nulos", categoria: "X", precio_centavos: 100 }] })).error, `${quien}: no importa catálogo`);
    revisar(!!(await c.rpc("config_rp_cambiar_visibilidad", { p_club: CLUB, p_nivel: "estado" })).error, `${quien}: no cambia lo que ven los RPs`);
    const perm = await c.rpc("caja_mis_permisos", { p_club_id: CLUB });
    revisar(!!perm.error || Object.values(perm.data ?? {}).every((v) => v === false), `${quien}: sin permisos de caja`);
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  // Si algo SÍ pasó (por ejemplo, corriendo sin el arreglo), se deshace aquí
  // para no dejar Club Demo Dev cambiado.
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    await db.q("delete from public.caja_permisos where actualizado_por = any($1::uuid[])", [ids]);
    await db.q("delete from public.club_config_rp where actualizado_por = any($1::uuid[])", [ids]);
    await db.q("delete from public.config_rp_cambios where hecho_por = any($1::uuid[])", [ids]);
    await db.q("delete from public.producto_movimientos where producto_id in (select id from public.productos where club_id = $1 and nombre = 'Nulos')", [CLUB]);
    await db.q("delete from public.productos where club_id = $1 and nombre = 'Nulos'", [CLUB]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza: " + e.message);
  } finally {
    await db.fin();
  }
  if (ids.length) await svc.from("profiles").delete().in("id", ids);
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
