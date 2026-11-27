// SOLO DEV. Prueba de sql/post-junta-3/01-largos-texto.sql, en UNA transacción
// que se deshace. Sesiones simuladas (rol authenticated + claims) de un RP y
// un cliente, y el anónimo.
//
//   node scripts/dev/probar-largos-texto.mjs
import { conectarDevEscritura } from "../db/conexion.mjs";

const DEMO = "0de70000-0000-4000-8000-000000000001";
const db = await conectarDevEscritura();
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };
const ids = Object.fromEntries((await db.q(`select split_part(email, '@', 1) c, id from auth.users where email in ('dev_rp@example.com','dev_cliente@example.com')`)).map((r) => [r.c, r.id]));

async function como(uid, sql, args) {
  await db.q("savepoint s");
  try {
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
    await db.q(uid ? "set local role authenticated" : "set local role anon");
    const r = await db.q(sql, args);
    return { ok: true, filas: r.length };
  } catch (e) {
    return { ok: false, code: e.code, mensaje: e.message };
  } finally {
    await db.q("rollback to savepoint s");
  }
}
const largo = (n) => "A".repeat(n);
const fecha = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());

try {
  await db.q("begin");
  const cons = await db.q(`select conname, convalidated from pg_constraint where conname in
    ('profiles_nombre_largo','profiles_telefono_largo','reservations_cliente_nombre_largo','reservations_cliente_telefono_largo')`);
  nota("los 4 límites existen", cons.length === 4, cons.map((c) => c.conname).join(", "));
  nota("…como NOT VALID (no revisan filas viejas)", cons.every((c) => c.convalidated === false));

  let r = await como(ids.dev_rp, `update public.profiles set nombre = $1 where id = $2 returning id`, [largo(20000), ids.dev_rp]);
  nota("RP no se pone un nombre de 20,000 letras", !r.ok && r.code === "23514", r.code);
  r = await como(ids.dev_rp, `update public.profiles set nombre = $1 where id = $2 returning id`, [largo(121), ids.dev_rp]);
  nota("…ni de 121", !r.ok && r.code === "23514", r.code);
  r = await como(ids.dev_rp, `update public.profiles set nombre = $1 where id = $2 returning id`, [largo(120), ids.dev_rp]);
  nota("…120 sí", r.ok && r.filas === 1, r.code ?? "");
  r = await como(ids.dev_rp, `update public.profiles set telefono = $1 where id = $2 returning id`, [largo(31), ids.dev_rp]);
  nota("teléfono de 31 caracteres: rechazado", !r.ok && r.code === "23514", r.code);

  r = await como(ids.dev_cliente, `insert into public.reservations (club_id, cliente_id, cliente_nombre, cliente_telefono, fecha, personas, status, source, qr_code)
    values ($1, $2, $3, '3312345678', $4, 2, 'pendiente', 'organica', 'antro-' || gen_random_uuid()) returning id`, [DEMO, ids.dev_cliente, largo(500), fecha]);
  nota("cliente: reserva con nombre de 500: rechazada", !r.ok && r.code === "23514", r.code);
  r = await como(ids.dev_cliente, `insert into public.reservations (club_id, cliente_id, cliente_nombre, cliente_telefono, fecha, personas, status, source, qr_code)
    values ($1, $2, 'Nombre normal', '3312345678', $3, 2, 'pendiente', 'organica', 'antro-' || gen_random_uuid()) returning id`, [DEMO, ids.dev_cliente, fecha]);
  nota("cliente: reserva normal sigue pasando", r.ok, r.code ? `${r.code} ${r.mensaje}` : "");

  // Filas viejas: NOT VALID no las toca; una edición de otra columna en una
  // fila ya larga sí se rechaza (el check se evalúa en cada UPDATE).
  await db.q(`alter table public.profiles drop constraint profiles_nombre_largo`);
  await db.q(`update public.profiles set nombre = $1 where id = $2`, [largo(300), ids.dev_cliente]);
  await db.q(`alter table public.profiles add constraint profiles_nombre_largo check (nombre is null or char_length(nombre) <= 120) not valid`);
  nota("una fila vieja larga no impide agregar el límite (NOT VALID)", true);
  r = await como(ids.dev_cliente, `update public.profiles set telefono = '3311112222' where id = $1 returning id`, [ids.dev_cliente]);
  nota("…pero al editarla hay que acortar el nombre (aviso para la validación)", !r.ok && r.code === "23514", r.code);
} finally {
  await db.q("rollback").catch(() => {});
  await db.fin();
}
const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length} (todo se deshizo)`);
process.exit(ok === res.length ? 0 : 1);
