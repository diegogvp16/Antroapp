// Datos propios de la suite e2e en antroapp-dev, todos con la marca
// "t_e2e_": un antro publicado ("T e2e <fecha> t_e2e_xxxx", zona
// America/Mexico_City, comisión fija por reserva sin cuota), 3 mesas y
// cuentas de staff, gerente, RP y cliente con una contraseña aleatoria que
// solo vive en memoria. Se borran al final (limpiarEscenario), incluida la
// caja, con el permiso de pruebas antroapp.borrado_pruebas (solo postgres en
// dev), igual que limpiarCajaDev de scripts/dev/sembrar-historia-dev.mjs.
//
// Nunca toca datos que no sean suyos: todo se filtra por los ids que creó
// esta corrida. La marca lleva la hora de creación (Date.now en base 36), así
// que --limpiar-restos puede distinguir una corrida vieja de una que va a la
// mitad en otro worktree. Mientras la corrida vive deja un "testigo"
// (screenshots-e2e/en-curso/<marca>.json, sin contraseña) con sus ids, para
// poder borrarla si el proceso muere sin pasar por el finally.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { conectarDevEscritura } from "../../db/conexion.mjs";

export const MARCA = "t_e2e_";
export const ZONA = "America/Mexico_City";
// Regla del antro de prueba: fijo por reserva, sin cuota (desbloqueo 0).
export const COMISION_FIJA = 175;
// Una corrida dura 3–6 min: lo de más de 1 h ya no es de una corrida viva.
export const EDAD_RESTO_MS = 60 * 60 * 1000;

const sha = (t) => createHash("sha256").update(t).digest("hex");

// Hora de creación de una marca nueva (t_e2e_<ms base36><4 hex>), o null si
// es del formato viejo (sin hora).
export function horaDeMarca(tag) {
  const m = String(tag).match(/^t_e2e_([0-9a-z]{8})[0-9a-f]{4}$/);
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return ms > 1.7e12 && ms < 2.2e12 ? ms : null;
}

// ---------- Testigos ----------
export function escribirTestigo(carpeta, esc) {
  mkdirSync(carpeta, { recursive: true });
  const datos = { tag: esc.tag, pid: process.pid, creado: new Date().toISOString(), club: esc.club?.id ?? null, usuarios: Object.fromEntries(Object.entries(esc.usuarios).map(([k, x]) => [k, { id: x.id, email: x.email }])) };
  writeFileSync(path.join(carpeta, `${esc.tag}.json`), JSON.stringify(datos, null, 2));
}
export const borrarTestigo = (carpeta, tag) => rmSync(path.join(carpeta, `${tag}.json`), { force: true });

const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// Testigos de corridas cuyo proceso ya no existe (murió sin limpiar).
export function testigosHuerfanos(carpeta) {
  if (!existsSync(carpeta)) return [];
  return readdirSync(carpeta)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(carpeta, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((t) => t && t.pid !== process.pid && !vivo(t.pid));
}

// ---------- Escenario ----------
export async function crearEscenario(svc, { alCrear } = {}) {
  const sufijo = Date.now().toString(36) + randomBytes(2).toString("hex");
  const tag = `${MARCA}${sufijo}`;
  const password = randomBytes(15).toString("base64url") + "a1A";
  const esc = { tag, password, usuarios: {}, club: null, mesas: [], noche: null };
  const db = await conectarDevEscritura();
  try {
    const [{ noche }] = await db.q(`select ((now() at time zone $1) - interval '8 hours')::date::text as noche`, [ZONA]);
    esc.noche = noche;

    const clubId = randomUUID();
    esc.club = { id: clubId, nombre: `T e2e ${noche} ${tag}` };
    alCrear?.(esc);
    const ins = await svc.from("clubs").insert({ id: clubId, nombre: esc.club.nombre, direccion: "Calle Prueba e2e 1", horario: "22:00-03:00", suscripcion_activa: false });
    if (ins.error) throw new Error("club: " + ins.error.message);
    const pub = await svc.from("clubs").update({
      estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, zona_horaria: ZONA,
      pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: COMISION_FIJA, comision_desbloqueo_reservas: 0,
      ciudad: "Pruebas", ambiente: "Prueba e2e", tipo_musica: "Prueba", edad_minima: 18, deposito_monto: 0,
    }).eq("id", clubId);
    if (pub.error) throw new Error("publicar club: " + pub.error.message);

    const mesas = await svc.from("club_tables").insert([1, 2, 3].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero");
    if (mesas.error) throw new Error("mesas: " + mesas.error.message);
    esc.mesas = mesas.data.sort((a, b) => Number(a.numero) - Number(b.numero));

    const cuentas = [
      ["staff", "staff", clubId, `${MARCA}staff ${sufijo}`],
      ["gerente", "gerente", clubId, `${MARCA}gerente ${sufijo}`],
      ["rp", "rp", clubId, `${MARCA}rp ${sufijo}`],
      ["cliente", "cliente", null, `${MARCA}cliente ${sufijo}`],
      // Admin de la corrida: solo para ver el contacto de /para-clubes en
      // /admin/contactos (flujo 16). Se borra al final como las demás.
      ["admin", "admin", null, `${MARCA}admin ${sufijo}`],
    ];
    let tel = 0;
    for (const [clave, role, club_id, nombre] of cuentas) {
      const email = `${MARCA}${clave}_${sufijo}@example.com`;
      const u = await svc.auth.admin.createUser({ email, password, email_confirm: true });
      if (u.error) throw new Error(`usuario ${clave}: ${u.error.message}`);
      const id = u.data.user.id;
      esc.usuarios[clave] = { id, email, nombre, role };
      alCrear?.(esc);
      const telefono = `55${String(Date.now()).slice(-6)}${String(++tel).padStart(2, "0")}`;
      const p = await svc.from("profiles").upsert({ id, nombre, role, club_id, activo: true, telefono });
      if (p.error) throw new Error(`perfil ${clave}: ${p.error.message}`);
      esc.usuarios[clave].telefono = telefono;
    }

    // La regla debe salir de clubs (sin reglas_comision ni override).
    const [{ reglas, overrides }] = await db.q(
      `select (select count(*) from public.reglas_comision where club_id = $1)::int reglas,
              (select count(*) from public.rp_comision_overrides where club_id = $1)::int overrides`, [clubId]);
    if (reglas || overrides) throw new Error(`el antro de prueba nació con reglas (${reglas}) u overrides (${overrides})`);
    return esc;
  } catch (e) {
    e.escenario = esc;
    throw e;
  } finally {
    await db.fin().catch(() => {});
  }
}

// Correo del formulario de /para-clubes de una corrida (flujo 16).
export const correoContacto = (tag) => `${tag}_contacto@example.com`;

const existe = async (db, tabla) => (await db.q("select to_regclass($1) is not null as hay", [`public.${tabla}`]))[0].hay;
async function borrarDelAntro(db, tabla, clubIds) {
  if (await existe(db, tabla)) await db.q(`delete from public.${tabla} where club_id = any($1::uuid[])`, [clubIds]);
}

// ---------- Banderas (sql/post-junta-3/00 y 50) ----------
// Solo las del antro de la corrida: se escriben como postgres
// (funcion_cambiar exige una sesión de admin) y se quitan al terminar cada
// flujo; al final se borra el antro de todos modos. activa = null quita el
// valor propio (apagada, como nace el antro).
export async function banderaClub(db, clubId, funcion, activa) {
  if (activa === null) await db.q("delete from public.club_funciones where club_id = $1 and funcion = $2", [clubId, funcion]);
  else
    await db.q(
      `insert into public.club_funciones (club_id, funcion, activa) values ($1, $2, $3)
       on conflict (club_id, funcion) do update set activa = excluded.activa, cambiado_en = now()`,
      [clubId, funcion, activa]);
}
export async function banderasDelAntro(db, clubId) {
  return (await db.q("select funcion, activa from public.club_funciones where club_id = $1 order by funcion", [clubId]));
}
// Bandera de plataforma (/para-clubes). Es GLOBAL en dev: se cambia solo
// mientras dura el flujo 16 y se deja como estaba.
export async function banderaPlataforma(db, clave) {
  return (await db.q("select activa from public.plataforma_banderas where clave = $1", [clave]))[0]?.activa ?? null;
}
export async function ponerBanderaPlataforma(db, clave, activa) {
  await db.q("update public.plataforma_banderas set activa = $2, cambiado_en = now() where clave = $1", [clave, activa]);
}

// Borra todo lo de una corrida aunque esté a medias. Abre su PROPIA conexión
// (no la de los flujos, que pudo caerse) y la reintenta hasta 3 veces.
export async function limpiarEscenario(svc, esc) {
  const clubIds = esc.club?.id ? [esc.club.id] : [];
  const usuarios = Object.values(esc.usuarios ?? {});
  const ids = usuarios.map((u) => u.id);
  const correos = [...new Set(usuarios.flatMap((u) => [u.email, u.email.toLowerCase()]))];
  const errores = [];
  let okBase = false;
  for (let intento = 1; intento <= 3 && !okBase; intento++) {
    let db = null;
    try {
      db = await conectarDevEscritura();
      await db.q("begin");
      await db.q("set local antroapp.borrado_pruebas = 'on'");
      if (clubIds.length) {
        // Post-junta-3 (flujos 9–17). Las tablas existen en dev; si alguna
        // faltara (SQL deshecho por otro carril), se salta.
        // POS: sus ventas apuntan a la caja (on delete set null + trigger).
        for (const t of ["pos_ventas", "pos_importacion_lineas", "pos_importaciones", "pos_mapeos"]) await borrarDelAntro(db, t, clubIds);
        // Propinas (fase 2): sin cascada y con candado (lo abre borrado_pruebas).
        for (const t of ["propinas_reparto_lineas", "propinas_repartos", "propinas_cobro_anuladas", "caja_propinas", "propinas_config"])
          await borrarDelAntro(db, t, clubIds);
        // Lista negra y WhatsApp (también se irían en cascada con el antro).
        for (const t of ["lista_negra_eventos", "club_bloqueos", "club_noshow_politica", "whatsapp_plantillas_cambios", "club_whatsapp_plantillas"])
          await borrarDelAntro(db, t, clubIds);
        // Banderas del antro y su bitácora.
        for (const t of ["club_funciones", "funciones_cambios"]) await borrarDelAntro(db, t, clubIds);
        // Antifraude (flujo 17): alertas, su bitácora, búsquedas y reglas (también irían en cascada).
        for (const t of ["fraude_alertas_cambios", "fraude_alertas", "fraude_detecciones", "fraude_reglas_cambios", "fraude_reglas"]) await borrarDelAntro(db, t, clubIds);
        // Inventario (fase 2): sus movimientos apuntan a los consumos.
        await db.q("delete from public.producto_movimientos where club_id = any($1::uuid[])", [clubIds]);
        for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
          await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
        await db.q("delete from public.grupo_clubs where club_id = any($1::uuid[])", [clubIds]);
        await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
        for (const t of ["productos", "rp_pagos_dia", "rp_attendance", "rp_schedule", "rp_comision_overrides", "rp_dia_tarifa_overrides", "club_dia_tarifas", "reserva_intentos", "personal_movimientos", "config_rp_cambios", "reglas_comision", "club_config_rp", "club_altas", "correos_salida", "invitaciones", "club_photos", "suscripciones", "pagos_mensualidad", "verificacion_documentos"])
          await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
        await db.q("delete from public.reservations where club_id = any($1::uuid[])", [clubIds]);
      }
      // Contacto de /para-clubes (flujo 16): por el correo de la corrida.
      if (esc.tag && (await existe(db, "contactos_clubes"))) {
        const correo = correoContacto(esc.tag);
        await db.q("delete from public.contactos_clubes where correo = $1", [correo]);
        await db.q("delete from public.contacto_intentos where correo_hash = public.contacto_huella('correo:' || $1)", [correo]);
      }
      if (ids.length) {
        if (await existe(db, "para_clubes_bitacora")) await db.q("delete from public.para_clubes_bitacora where hecho_por = any($1::uuid[])", [ids]);
        await db.q("delete from public.commissions where rp_id = any($1::uuid[])", [ids]);
        await db.q("delete from public.reservations where cliente_id = any($1::uuid[]) or rp_id = any($1::uuid[])", [ids]);
        await db.q("delete from public.aceptaciones_legales where profile_id = any($1::uuid[])", [ids]);
        await db.q("delete from public.app_errores where usuario_id = any($1::uuid[])", [ids]);
        await db.q("delete from public.login_intentos where email_hash = any($1::text[])", [correos.map(sha)]);
        await db.q("update public.clubs set dueno_id = null where dueno_id = any($1::uuid[])", [ids]);
      }
      if (clubIds.length) {
        await db.q("update public.profiles set club_id = null where club_id = any($1::uuid[])", [clubIds]);
        await db.q("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
      }
      if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
      if (clubIds.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
      await db.q("commit");
      okBase = true;
    } catch (e) {
      await db?.q("rollback").catch(() => {});
      if (intento === 3) errores.push(`base (3 intentos): ${e.message}`);
    } finally {
      await db?.fin().catch(() => {});
    }
  }
  for (const id of ids) {
    const r = await svc.auth.admin.deleteUser(id);
    if (r.error && !/not found/i.test(r.error.message)) errores.push(`auth ${id.slice(0, 8)}: ${r.error.message}`);
  }
  return { errores };
}

// Filas que dejó ESTA corrida (por su marca, sus ids, su antro y los hash de
// sus correos), incluidas las tablas sin marca: reserva_intentos,
// login_intentos, app_errores y aceptaciones_legales.
export async function contarDeCorrida(db, esc) {
  const ids = Object.values(esc?.usuarios ?? {}).map((u) => u.id);
  const hashes = Object.values(esc?.usuarios ?? {}).flatMap((u) => [sha(u.email), sha(u.email.toLowerCase())]);
  const clubIds = esc?.club?.id ? [esc.club.id] : [];
  const marca = esc?.tag ? `%${esc.tag.replace(/_/g, "\\_")}%` : "%sin-marca%";
  const [r] = await db.q(
    `select (select count(*) from auth.users where id = any($1::uuid[]) or email like $4)::int usuarios,
            (select count(*) from public.profiles where id = any($1::uuid[]) or nombre like $4)::int perfiles,
            (select count(*) from public.clubs where id = any($2::uuid[]) or nombre like $4)::int antros,
            (select count(*) from public.reservations where club_id = any($2::uuid[]) or cliente_nombre like $4 or rp_id = any($1::uuid[]) or cliente_id = any($1::uuid[]))::int reservas,
            (select count(*) from public.club_tables where club_id = any($2::uuid[]))::int mesas,
            (select count(*) from public.caja_noches where club_id = any($2::uuid[]))::int noches,
            (select count(*) from public.mesa_sesiones where club_id = any($2::uuid[]))::int sesiones,
            (select count(*) from public.caja_consumos where club_id = any($2::uuid[]))::int consumos,
            (select count(*) from public.caja_pagos where club_id = any($2::uuid[]))::int pagos,
            (select count(*) from public.commissions where rp_id = any($1::uuid[]))::int comisiones,
            (select count(*) from public.reserva_intentos where club_id = any($2::uuid[]))::int intentos_reserva,
            (select count(*) from public.login_intentos where email_hash = any($3::text[]))::int intentos_login,
            (select count(*) from public.app_errores where usuario_id = any($1::uuid[]))::int errores_app,
            (select count(*) from public.aceptaciones_legales where profile_id = any($1::uuid[]))::int aceptaciones`,
    [ids, clubIds, hashes, marca],
  );
  // Post-junta-3 (flujos 9–17), solo las tablas que existan en dev.
  const porAntro = ["pos_ventas", "pos_importaciones", "club_funciones", "club_bloqueos", "productos", "caja_propinas", "propinas_repartos", "caja_eventos",
    "fraude_alertas", "fraude_alertas_cambios", "fraude_detecciones"];
  for (const t of porAntro) {
    if (await existe(db, t)) r[t] = (await db.q(`select count(*)::int n from public.${t} where club_id = any($1::uuid[])`, [clubIds]))[0].n;
  }
  if (esc?.tag && (await existe(db, "contactos_clubes"))) {
    const correo = correoContacto(esc.tag);
    const [x] = await db.q(
      `select (select count(*) from public.contactos_clubes where correo = $1)::int contactos,
              (select count(*) from public.contacto_intentos where correo_hash = public.contacto_huella('correo:' || $1))::int intentos_contacto`, [correo]);
    Object.assign(r, x);
  }
  return r;
}

// Todo lo que tenga la marca t_e2e_ en dev (de esta u otras corridas, otros
// worktrees incluidos): informativo.
export async function contarMarcaGlobal(db) {
  const [r] = await db.q(
    `select (select count(*) from auth.users where email like 't\\_e2e\\_%')::int usuarios,
            (select count(*) from public.profiles where nombre like 't\\_e2e\\_%')::int perfiles,
            (select count(*) from public.clubs where nombre like '%t\\_e2e\\_%')::int antros,
            (select count(*) from public.reservations where cliente_nombre like '%t\\_e2e\\_%')::int reservas`,
  );
  return r;
}

export const totalRestos = (r) => Object.values(r ?? {}).reduce((s, n) => s + n, 0);

// Restos de corridas viejas (más de 1 h, o del formato viejo sin hora en la
// marca y con cuentas de más de 1 h). Nunca toca una corrida reciente: puede
// ir a la mitad en otro worktree.
export async function restosViejos() {
  const db = await conectarDevEscritura();
  try {
    const usuarios = await db.q(`select id, email, created_at from auth.users where email like 't\\_e2e\\_%'`);
    const clubs = await db.q(`select id, nombre from public.clubs where nombre like 'T e2e %t\\_e2e\\_%'`);
    const ahora = Date.now();
    const sufijoDe = (s) => (String(s).match(/t_e2e_(?:[a-z]+_)?([0-9a-z]+)(?:@|$|\s)/) ?? [])[1] ?? null;
    const tags = new Map();
    for (const u of usuarios) {
      const suf = (u.email.match(/^t_e2e_[a-z]+_([0-9a-z]+)@/) ?? [])[1];
      if (!suf) continue;
      const t = tags.get(suf) ?? { tag: MARCA + suf, usuarios: {}, club: null, creado: null };
      t.usuarios[u.email] = { id: u.id, email: u.email };
      t.creado = Math.min(t.creado ?? Infinity, new Date(u.created_at).getTime());
      tags.set(suf, t);
    }
    for (const c of clubs) {
      const suf = sufijoDe(c.nombre);
      if (!suf) continue;
      const t = tags.get(suf) ?? { tag: MARCA + suf, usuarios: {}, club: null, creado: null };
      t.club = { id: c.id };
      tags.set(suf, t);
    }
    return [...tags.values()].filter((t) => {
      const hora = horaDeMarca(t.tag) ?? t.creado;
      return hora != null && ahora - hora > EDAD_RESTO_MS;
    });
  } finally {
    await db.fin();
  }
}
