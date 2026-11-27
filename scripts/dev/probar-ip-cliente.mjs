// SOLO DEV. Prueba de sql/post-junta-3/02-ip-cliente.sql: la IP de los topes
// anti-abuso ya no la decide quien llama.
//
//   node scripts/dev/probar-ip-cliente.mjs
//
// 1. ip_cliente() con encabezados simulados (en una transacción que se deshace).
// 2. Por el gateway REAL de Supabase con la anon key: 21 reservas sin cuenta,
//    cada una con un "X-Forwarded-For" inventado distinto. Antes del 02 todas
//    pasaban (cada una parecía de otra IP); con el 02 la 21ª se rechaza por el
//    tope de 20 por IP por hora. Al final borra lo que creó (reservas, sus
//    intentos) con postgres y revisa que no queden restos.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = Object.fromEntries(readFileSync(path.join(RAIZ, ".env.dev"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes("ygumrpckbtlngzspqdvo")) throw new Error("solo dev");
const DEMO = "0de70000-0000-4000-8000-000000000001";
const telefonos = [];
const MARCA = "T ip " + randomUUID().slice(0, 8);
const db = await conectarDevEscritura();
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };

async function ipCon(headers) {
  await db.q("begin");
  try {
    await db.q(`select set_config('request.headers', $1, true)`, [headers === null ? "" : JSON.stringify(headers)]);
    return (await db.q(`select public.ip_cliente() as ip`))[0].ip;
  } finally {
    await db.q("rollback");
  }
}

const soloGateway = process.argv.includes("--solo-gateway");
try {
  // 1. Encabezados simulados.
  if (!soloGateway) {
  nota("cf-connecting-ip manda", (await ipCon({ "cf-connecting-ip": "201.1.2.3", "x-forwarded-for": "1.2.3.4, 201.1.2.3" })) === "201.1.2.3");
  nota("sin cf: el ÚLTIMO de x-forwarded-for, no el primero", (await ipCon({ "x-forwarded-for": "1.2.3.4, 9.9.9.9,201.1.2.3" })) === "201.1.2.3");
  nota("solo x-real-ip", (await ipCon({ "x-real-ip": "201.1.2.3" })) === "201.1.2.3");
  nota("IPv6 en minúsculas", (await ipCon({ "cf-connecting-ip": "2806:2F0:1::ABCD" })) === "2806:2f0:1::abcd");
  nota("basura en el encabezado → NULL", (await ipCon({ "cf-connecting-ip": "201.1.2.3; drop table x" })) === null);
  nota("demasiado largo → NULL", (await ipCon({ "cf-connecting-ip": "1".repeat(60) })) === null);
  nota("sin encabezados → NULL", (await ipCon(null)) === null);
  const ip = await db.q(`select has_function_privilege('anon', 'public.ip_cliente()', 'EXECUTE') a, has_function_privilege('authenticated', 'public.ip_cliente()', 'EXECUTE') u`);
  nota("ip_cliente no se llama desde la API", !ip[0].a && !ip[0].u);
  }

  // 2. Por el gateway real: 21 reservas anónimas con XFF inventado distinto.
  const fecha = (await db.q(`select public.club_fecha_operacion($1)::text as f`, [DEMO]))[0].f;
  const previas = Number((await db.q(`select count(*) from public.reserva_intentos where creado_en > now() - interval '1 hour'`))[0].count);
  let pasaron = 0, rechazo = null;
  for (let i = 0; i < 21; i++) telefonos.push(`33${String(10000000 + i * 7919).slice(0, 8)}`);
  for (let i = 0; i < 21; i++) {
    const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/reservations`, {
      method: "POST",
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
        "X-Forwarded-For": `10.${i}.${i}.${i}`,
      },
      body: JSON.stringify({
        club_id: DEMO, cliente_nombre: MARCA, cliente_telefono: telefonos[i],
        fecha, personas: 2, status: "pendiente", source: "organica", qr_code: `antro-${randomUUID()}`,
      }),
    });
    if (r.ok) pasaron++;
    else { rechazo = await r.json().catch(() => ({})); break; }
  }
  // Si esta IP ya tenía intentos de otras pruebas en la última hora, el tope llega antes.
  const esperadas = Math.max(0, 20 - previas);
  nota("con XFF inventado distinto en cada una, el tope por IP SÍ aplica", rechazo !== null && pasaron <= 20,
    `pasaron ${pasaron} (esperadas ≤ ${esperadas + 0} si todo es de esta IP), rechazo ${rechazo?.code ?? "ninguno"}: ${rechazo?.message ?? ""}`);
  nota("…con el aviso del tope (P0001)", rechazo?.code === "P0001");
} finally {
  // Limpieza: las reservas de esta prueba y sus intentos.
  const borr = await db.q(`delete from public.reservations where cliente_nombre = $1 returning id`, [MARCA]);
  const hashes = telefonos.map((x) => createHash("sha256").update(x.slice(-10)).digest("hex"));
  const bi = hashes.length ? await db.q(`delete from public.reserva_intentos where club_id = $1 and telefono_hash = any($2) returning 1`, [DEMO, hashes]) : [];
  console.log(`Intentos borrados: ${bi.length}`);
  const quedan = Number((await db.q(`select count(*) from public.reservations where cliente_nombre = $1`, [MARCA]))[0].count);
  console.log(`Limpieza: ${borr.length} reservas borradas; quedan ${quedan}`);
  await db.fin();
}
const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length}`);
process.exit(ok === res.length ? 0 : 1);
