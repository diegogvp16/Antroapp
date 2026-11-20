// Siembra datos FICTICIOS en antroapp-dev. Se niega a correr fuera de dev.
//
//   node scripts/dev/sembrar-dev.mjs
//
// Crea (o reemplaza) un usuario por rol (dev_<rol>@example.com), "Club Demo
// Dev" publicado con mesas, fotos generadas (sin caras), turnos y reservas
// de hoy y de días anteriores, un antro borrador con dueño y un borrador sin
// dueño (con el mismo id que Panic Room en producción, para que
// scripts/probar-clubs-visibilidad.mjs tenga el mismo escenario).
//
// La contraseña se guarda en backups/dev-credenciales.json (gitignored) y no
// se imprime.

import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";
import { sembrarHistoria, limpiarCajaDev } from "./sembrar-historia-dev.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

export const CLUB_DEMO_DEV = "0de70000-0000-4000-8000-000000000001";
export const CLUB_BORRADOR_DEV = "0de70000-0000-4000-8000-000000000002";
export const CLUB_SIN_DUENO = "8e433d37-ac56-407e-82a6-4e405d6d9fdc"; // mismo id que Panic Room en prod
export const CLUB_TIJUANA_DEV = "0de70000-0000-4000-8000-000000000004";
const GRUPO_DEV = "Grupo Demo Dev";
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
const hoyMx = (desfase = 0) => {
  const d = new Date(Date.now() - 8 * 3600e3 + desfase * 86400e3); // noche operativa (corte 08:00)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(d);
};

// ---------- Limpieza de una siembra anterior ----------
const { data: lista } = await svc.auth.admin.listUsers({ perPage: 1000 });
// dev_* y las demo_* de la noche demo (todas ficticias, solo dev): si
// quedaran, su perfil seguiría ligado al antro y no se podría recrear.
const previos = (lista?.users ?? []).filter((u) => /^(dev|demo)_[a-z0-9_]+@example\.com$/.test(u.email ?? ""));
const clubs = [CLUB_DEMO_DEV, CLUB_BORRADOR_DEV, CLUB_SIN_DUENO, CLUB_TIJUANA_DEV];
// La caja no se borra por la API (bloque 6B): se limpia con el permiso de pruebas.
await limpiarCajaDev(clubs, GRUPO_DEV);
for (const t of ["commissions", "rp_pagos_dia"]) {
  const { data: res } = await svc.from("reservations").select("id").in("club_id", clubs);
  if (t === "commissions" && res?.length) await svc.from(t).delete().in("reservation_id", res.map((r) => r.id));
}
const { data: resPrev } = await svc.from("reservations").select("id").in("club_id", clubs);
if (resPrev?.length) await svc.from("consumption_entries").delete().in("reservation_id", resPrev.map((r) => r.id));
for (const t of ["reservations", "rp_schedule", "rp_attendance", "rp_pagos_dia", "rp_comision_overrides", "rp_dia_tarifa_overrides", "club_dia_tarifas", "club_tables", "club_photos", "verificacion_documentos"])
  await svc.from(t).delete().in("club_id", clubs);
for (const c of clubs) {
  const { data: archivos } = await svc.storage.from("club-photos").list(c, { limit: 1000 });
  if (archivos?.length) await svc.storage.from("club-photos").remove(archivos.map((a) => `${c}/${a.name}`));
}
if (previos.length) await svc.from("profiles").delete().in("id", previos.map((u) => u.id));
await svc.from("clubs").delete().in("id", clubs);
for (const u of previos) await svc.auth.admin.deleteUser(u.id);

// ---------- Usuarios ----------
const PASS = "Dev-" + randomBytes(12).toString("base64url");
const usuarios = {};
async function usuario(clave, role, nombre, club_id = null) {
  const email = `dev_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + email);
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre, role, club_id, telefono: "0000000999", activo: true }), "perfil " + email);
  usuarios[clave] = { id: u.user.id, email, role };
  return u.user.id;
}
await usuario("admin", "admin", "Admin Dev");
const dueno = await usuario("dueno", "dueno", "Dueña Dev");
const dueno2 = await usuario("dueno_borrador", "dueno", "Dueño Borrador Dev");
await usuario("cliente", "cliente", "Cliente Dev");

// ---------- Clubs ----------
async function club(id, datos, publicado) {
  ok(await svc.from("clubs").insert({ id, direccion: "Calle Ficticia 123, Guadalajara", horario: "Mié a Sáb 9pm a 3am", deposito_monto: 0, suscripcion_activa: false, ...datos }), "club " + datos.nombre);
  if (publicado)
    ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, suscripcion_activada_en: new Date().toISOString() }).eq("id", id), "publicar " + datos.nombre);
}
await club(CLUB_DEMO_DEV, { nombre: "Club Demo Dev", ciudad: "Guadalajara", dueno_id: dueno, ambiente: "Antro de prueba en dev", tipo_musica: "Reggaetón y house", codigo_vestimenta: "Casual elegante", edad_minima: 18 }, true);
// Segundo antro del grupo, en otra ciudad y otra zona horaria, con su propio
// dueño (un dueño con dos antros rompe /dueno/panel).
const duenoTj = await usuario("dueno_tijuana", "dueno", "Dueño Tijuana Dev");
await club(CLUB_TIJUANA_DEV, { nombre: "Club Demo Dev Tijuana", ciudad: "Tijuana", direccion: "Av. Ficticia 456, Tijuana", dueno_id: duenoTj }, true);
ok(await svc.from("clubs").update({ zona_horaria: "America/Tijuana" }).eq("id", CLUB_TIJUANA_DEV), "zona Tijuana");
await club(CLUB_BORRADOR_DEV, { nombre: "Antro Borrador Dev", dueno_id: dueno2 }, false);
await club(CLUB_SIN_DUENO, { nombre: "Borrador sin dueño Dev", dueno_id: null }, false);

const staff = await usuario("staff", "staff", "Staff Dev", CLUB_DEMO_DEV);
await usuario("gerente", "gerente", "Gerente Dev", CLUB_DEMO_DEV);
const rp = await usuario("rp", "rp", "RP Dev", CLUB_DEMO_DEV);
const staffTj = await usuario("staff_tijuana", "staff", "Staff Tijuana Dev", CLUB_TIJUANA_DEV);
const gerenteTj = await usuario("gerente_tijuana", "gerente", "Gerente Tijuana Dev", CLUB_TIJUANA_DEV);
const rpTj = await usuario("rp_tijuana", "rp", "RP Tijuana Dev", CLUB_TIJUANA_DEV);

// Grupo: dev_dueno (dueña de Club Demo Dev) es además dueña del grupo.
const grupo = ok(await svc.from("grupos").insert({ nombre: GRUPO_DEV }).select("id").single(), "grupo");
ok(await svc.from("grupo_clubs").insert([{ grupo_id: grupo.id, club_id: CLUB_DEMO_DEV }, { grupo_id: grupo.id, club_id: CLUB_TIJUANA_DEV }]), "grupo_clubs");
ok(await svc.from("grupo_miembros").insert({ grupo_id: grupo.id, profile_id: dueno, rol_grupo: "dueno_grupo" }), "grupo_miembros");

// ---------- Mesas, fotos, turnos, reservas ----------
const mesasDemo = ok(await svc.from("club_tables").insert(
  [...Array.from({ length: 10 }, (_, i) => ({ numero: String(i + 1), capacidad: 8 + (i % 3) * 2 })), { numero: "VIP 1", capacidad: 15 }, { numero: "VIP 2", capacidad: 15 }]
    .map((m) => ({ ...m, club_id: CLUB_DEMO_DEV })), ).select("id"), "mesas");

const tonos = [["#1a0f0f", "#c9a227"], ["#0b0a0a", "#4a0e0e"], ["#14110d", "#8a6d1c"]];
for (const [i, [a, b]] of tonos.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><defs><radialGradient id="g" cx="${30 + i * 20}%" cy="40%" r="70%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient></defs><rect width="1600" height="1200" fill="url(#g)"/></svg>`;
  const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  const ruta = `${CLUB_DEMO_DEV}/${randomUUID()}-dev-${i + 1}.jpg`;
  ok(await svc.storage.from("club-photos").upload(ruta, jpg, { contentType: "image/jpeg" }), "foto " + i);
  const { data: { publicUrl } } = svc.storage.from("club-photos").getPublicUrl(ruta);
  ok(await svc.from("club_photos").insert({ club_id: CLUB_DEMO_DEV, url: publicUrl, storage_path: ruta, orden: i }), "fila foto " + i);
  // Los borradores también tienen una foto (como en producción), para probar
  // que solo la ven admin, su dueño y su personal.
  if (i === 0)
    for (const c of [CLUB_BORRADOR_DEV, CLUB_SIN_DUENO, CLUB_TIJUANA_DEV]) {
      const r2 = `${c}/${randomUUID()}-dev-borrador.jpg`;
      ok(await svc.storage.from("club-photos").upload(r2, jpg, { contentType: "image/jpeg" }), "foto borrador");
      const { data: { publicUrl: u2 } } = svc.storage.from("club-photos").getPublicUrl(r2);
      ok(await svc.from("club_photos").insert({ club_id: c, url: u2, storage_path: r2, orden: 0 }), "fila foto borrador");
    }
}

ok(await svc.from("rp_schedule").insert({ rp_id: rp, club_id: CLUB_DEMO_DEV, fecha: hoyMx(-7), es_fijo: true, dias_semana: [3, 4, 5, 6], fecha_inicio: hoyMx(-7) }), "turno");
ok(await svc.from("rp_comision_overrides").insert({ club_id: CLUB_DEMO_DEV, rp_id: rp, comision_tipo: "fijo", comision_monto: 150, comision_desbloqueo_reservas: 0 }), "override");

const reservas = [];
const nueva = (fecha, n, extra = {}) => reservas.push({
  id: randomUUID(), cliente_nombre: `Cliente Ficticio ${reservas.length + 1}`, cliente_telefono: `0000000${String(100 + reservas.length).padStart(3, "0")}`,
  personas: 2 + (n % 5), status: "pendiente", source: "organica", rp_id: null, club_id: CLUB_DEMO_DEV, fecha, qr_code: `antro-${randomUUID()}`, ...extra,
});
for (let n = 0; n < 6; n++) nueva(hoyMx(), n, n % 2 ? { source: "rp", rp_id: rp, status: "confirmada" } : {});
for (let n = 0; n < 6; n++) nueva(hoyMx(-1), n, { status: "usada", ...(n % 2 ? { source: "rp", rp_id: rp } : {}) });
ok(await svc.from("reservations").insert(reservas), "reservas");
const usadas = reservas.filter((r) => r.status === "usada");
ok(await svc.from("consumption_entries").insert(usadas.map((r, i) => ({ reservation_id: r.id, monto: 1200 + i * 450 }))), "consumos");
ok(await svc.from("commissions").insert(usadas.filter((r) => r.rp_id).map((r) => ({ reservation_id: r.id, rp_id: rp, tipo: "rp", monto: 150, status: "pendiente" }))), "comisiones");

// ---------- Tijuana: mesas y comisión ----------
const mesasTj = ok(await svc.from("club_tables").insert(Array.from({ length: 6 }, (_, i) => ({ club_id: CLUB_TIJUANA_DEV, numero: String(i + 1), capacidad: 10 }))).select("id"), "mesas Tijuana");
ok(await svc.from("rp_comision_overrides").insert({ club_id: CLUB_TIJUANA_DEV, rp_id: rpTj, comision_tipo: "fijo", comision_monto: 150, comision_desbloqueo_reservas: 0 }), "override Tijuana");

// ---------- Historia de caja (noches cerradas) ----------
const historia = await sembrarHistoria({
  noches: 8,
  clubs: [
    { id: CLUB_DEMO_DEV, zona: "America/Mexico_City", rp, staff, gerente: usuarios.gerente.id, mesas: mesasDemo.map((m) => m.id) },
    { id: CLUB_TIJUANA_DEV, zona: "America/Tijuana", rp: rpTj, staff: staffTj, gerente: gerenteTj, mesas: mesasTj.map((m) => m.id) },
  ],
});
console.log(`Historia: ${historia.noches} noches cerradas, ${historia.sesiones} mesas cuadradas, ${historia.consumos} consumos, ${historia.comisiones} comisiones.`);

// ---------- Credenciales (solo local) ----------
mkdirSync(path.join(RAIZ, "backups"), { recursive: true });
writeFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), JSON.stringify({
  nota: "Usuarios FICTICIOS de antroapp-dev. Solo dev. No subir a Git.",
  password: PASS,
  usuarios: Object.fromEntries(Object.entries(usuarios).map(([k, u]) => [k, u.email])),
  clubs: { demo: CLUB_DEMO_DEV, tijuana: CLUB_TIJUANA_DEV, borrador_con_dueno: CLUB_BORRADOR_DEV, borrador_sin_dueno: CLUB_SIN_DUENO },
  grupo: GRUPO_DEV + " (dueña: dev_dueno)",
}, null, 2));
console.log(`Dev sembrado: ${Object.keys(usuarios).length} usuarios, 4 antros (2 publicados en Guadalajara y Tijuana, en un grupo), ${reservas.length} reservas de hoy y ayer.`);
console.log("Credenciales en backups/dev-credenciales.json (no se imprimen).");
void staff;
