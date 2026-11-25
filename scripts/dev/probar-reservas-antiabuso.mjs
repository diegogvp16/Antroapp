// SOLO DEV. Prueba de sql/post-junta-2/72-reservas-antiabuso.sql (C3, noche 3).
//
//   node scripts/dev/probar-reservas-antiabuso.mjs
//
// Casi todo corre en SQL, como el rol anon de la API con IPs simuladas, dentro
// de transacciones que se deshacen: no deja datos ni bloquea la IP real de
// nadie. Una sola prueba va por la API de verdad (anon key) para confirmar que
// Supabase pasa la IP a la base; esa reserva y su intento se borran al final.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const PUBLICADO = "0de70000-0000-4000-8000-000000000001"; // Club Demo Dev
const BORRADOR = "0de70000-0000-4000-8000-000000000002"; // Antro Borrador Dev

const db = await conectarDevEscritura();
const resultados = [];
const nota = (t, ok, d = "") => { resultados.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };

// Noche operativa del antro (corte 08:00), igual que la política.
const [{ hoy }] = await db.q(`select ((now() at time zone c.zona_horaria) - interval '8 hours')::date::text as hoy from public.clubs c where c.id = $1`, [PUBLICADO]);
const masDias = (n) => { const d = new Date(hoy + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Corre inserts como anon con una IP simulada, en una transacción que se deshace.
async function comoAnon(ip, filas) {
  await db.q("begin");
  try {
    await db.q(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await db.q(`select set_config('request.headers', $1, true)`, [JSON.stringify(ip ? { "x-forwarded-for": `${ip}, 10.0.0.1` } : {})]);
    await db.q("set local role anon");
    let i = 0;
    for (const f of filas) {
      i++;
      try {
        await db.q(
          `insert into public.reservations (club_id, cliente_nombre, cliente_telefono, fecha, personas, status, source, qr_code)
           values ($1, $2, $3, $4, 2, 'pendiente', 'organica', 'antro-' || gen_random_uuid())`,
          [f.club ?? PUBLICADO, f.nombre ?? "Prueba Antiabuso", f.tel ?? "3300000001", f.fecha ?? hoy],
        );
      } catch (e) {
        return { ok: false, en: i, mensaje: e.message, codigo: e.code };
      }
    }
    return { ok: true, en: i };
  } finally {
    await db.q("rollback");
  }
}

try {
  let r = await comoAnon("203.0.113.10", [{}]);
  nota("reserva válida sin cuenta en antro publicado pasa", r.ok, r.mensaje ?? "");
  r = await comoAnon("203.0.113.11", [{ club: BORRADOR }]);
  nota("antro no publicado: rechazada", !r.ok && /no está recibiendo/.test(r.mensaje ?? ""), r.mensaje ?? "pasó");
  r = await comoAnon("203.0.113.12", [{ fecha: masDias(61) }]);
  nota("a 61 días: rechazada", !r.ok && /60 días/.test(r.mensaje ?? ""), r.mensaje ?? "pasó");
  r = await comoAnon("203.0.113.12", [{ fecha: masDias(60) }]);
  nota("a 60 días: pasa", r.ok, r.mensaje ?? "");
  r = await comoAnon("203.0.113.13", [{ nombre: "A" }]);
  nota("nombre de 1 letra: rechazada", !r.ok && /nombre/.test(r.mensaje ?? ""), r.mensaje ?? "pasó");
  r = await comoAnon("203.0.113.13", [{ tel: "12345" }]);
  nota("teléfono corto: rechazada", !r.ok && /teléfono/.test(r.mensaje ?? ""), r.mensaje ?? "pasó");
  r = await comoAnon("203.0.113.14", [{ tel: "33 0000 0002" }, { tel: "+52 3300000002" }, { tel: "3300000002" }, { tel: "3300000002" }]);
  nota("4ª reserva del mismo teléfono (con y sin lada/espacios) misma noche: rechazada", !r.ok && r.en === 4 && /este teléfono/.test(r.mensaje ?? ""), `falló en la ${r.en}: ${r.mensaje ?? "pasó"}`);
  r = await comoAnon("203.0.113.15", [{ tel: "3300000003" }, { tel: "3300000003" }, { tel: "3300000003" }, { tel: "3300000003", fecha: masDias(1) }]);
  nota("mismo teléfono otra noche: pasa", r.ok, r.mensaje ?? "");
  const veinte = Array.from({ length: 20 }, (_, i) => ({ tel: `33100000${String(i).padStart(2, "0")}` }));
  r = await comoAnon("203.0.113.16", veinte);
  nota("20 reservas desde una IP en una hora: pasan", r.ok, r.mensaje ?? "");
  r = await comoAnon("203.0.113.16", [...veinte, { tel: "3310000099" }]);
  nota("la 21ª desde la misma IP: rechazada", !r.ok && r.en === 21 && /conexión/.test(r.mensaje ?? ""), `falló en la ${r.en}: ${r.mensaje ?? "pasó"}`);
  r = await comoAnon(null, [{ tel: "3320000001" }]);
  nota("sin IP en los encabezados: pasa (solo aplican los otros límites)", r.ok, r.mensaje ?? "");

  // Con sesión o service role el trigger no interviene (postgres sin claims).
  await db.q("begin");
  try {
    await db.q(`insert into public.reservations (club_id, cliente_nombre, cliente_telefono, fecha, personas, status, source, qr_code)
                values ($1, 'X', '1', $2, 2, 'pendiente', 'organica', 'antro-' || gen_random_uuid())`, [BORRADOR, hoy]);
    nota("service role / postgres: el trigger no aplica", true);
  } catch (e) {
    nota("service role / postgres: el trigger no aplica", false, e.message);
  } finally {
    await db.q("rollback");
  }

  // Por la API de verdad: Supabase debe pasar la IP a la base.
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const tel = "33" + String(Date.now()).slice(-8);
  const ins = await anon.from("reservations").insert({ club_id: PUBLICADO, cliente_nombre: "Prueba Antiabuso API", cliente_telefono: tel, fecha: masDias(2), personas: 2, status: "pendiente", source: "organica", qr_code: "antro-" + crypto.randomUUID() });
  const [fila] = await db.q(`select (ip_hash is not null) as con_ip from public.reserva_intentos where club_id = $1 and fecha = $2 and telefono_hash = encode(sha256(convert_to(right($3, 10), 'UTF8')), 'hex') order by creado_en desc limit 1`, [PUBLICADO, masDias(2), tel]);
  nota("por la API: la reserva entra y el intento guarda la IP (en hash)", !ins.error && fila?.con_ip === true, ins.error?.message ?? (fila ? `con_ip=${fila.con_ip}` : "sin intento"));
  const msg = await anon.from("reservations").insert({ club_id: BORRADOR, cliente_nombre: "Prueba", cliente_telefono: tel, fecha: hoy, personas: 2, status: "pendiente", source: "organica", qr_code: "antro-" + crypto.randomUUID() });
  nota("por la API: el error llega como P0001 con el mensaje en español", msg.error?.code === "P0001" && /no está recibiendo/.test(msg.error?.message ?? ""), msg.error ? `${msg.error.code} ${msg.error.message}` : "pasó");
  await db.q(`delete from public.reservations where cliente_telefono = $1 and cliente_nombre like 'Prueba Antiabuso%'`, [tel]);
  await db.q(`delete from public.reserva_intentos where telefono_hash = encode(sha256(convert_to(right($1, 10), 'UTF8')), 'hex')`, [tel]);
} finally {
  await db.fin();
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exit(pasan === resultados.length ? 0 : 1);
