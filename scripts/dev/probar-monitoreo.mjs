// Pruebas del monitoreo (bloque 6) contra el servidor local de dev (3001):
//   node scripts/dev/probar-monitoreo.mjs [--base=http://localhost:3001]
// - /api/salud responde 200 con la base, sin datos personales y sin caché.
// - /api/errores guarda el error SIN correos, teléfonos ni tokens, y la ruta
//   sin parámetros.
// - Con las alertas apagadas no se manda nada (alertas_enviadas vacía).
// - lib/domain/sanitizar.ts (reglas puras).
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";
import { sinDatosPersonales, rutaSinParametros } from "../../lib/domain/sanitizar.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3001").replace(/\/$/, "");
let pasan = 0, fallan = 0;
const revisar = (c, t, d = "") => { if (c) pasan++; else fallan++; console.log((c ? "OK     " : "FALLA  ") + t + (c || !d ? "" : "  — " + d)); };
const marca = "prueba-monitoreo-" + randomUUID().slice(0, 8);
try {
  const s = sinDatosPersonales("Falló para ana.perez@gmail.com tel 33 1234 5678 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc sk_test_abc123 Bearer abcdefghijkl123");
  revisar(!/@|1234 5678|eyJ|sk_test|abcdefghijkl/.test(s), "quita correo, teléfono, JWT, llave y Bearer", s);
  revisar(rutaSinParametros("/cliente/login?email=a@b.com#x") === "/cliente/login", "ruta sin parámetros");
  revisar(sinDatosPersonales("Reserva 2026-11-24 mesa 12") === "Reserva 2026-11-24 mesa 12", "no toca fechas ni números cortos");

  const r = await fetch(BASE + "/api/salud");
  const c = await r.json();
  revisar(r.status === 200 && c.estado === "ok" && c.base.ok && typeof c.base.ms === "number", `salud: 200 con la base (${c.base?.ms} ms)`);
  revisar(r.headers.get("cache-control")?.includes("no-store") && !/@|key|token|secret/i.test(JSON.stringify(c)), "salud: sin caché ni datos sensibles");

  const e = await fetch(BASE + "/api/errores", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.18.77." + Math.floor(Math.random() * 250) }, body: JSON.stringify({ mensaje: `${marca} falló con luis@example.com 3312345678`, ruta: "/cliente/reservar?tel=3312345678&email=luis@example.com" }) });
  revisar(e.status === 200, "errores: se guarda el aviso");
  const { data: g } = await svc.from("app_errores").select("mensaje, ruta").like("mensaje", `${marca}%`).maybeSingle();
  revisar(g && !g.mensaje.includes("@") && !g.mensaje.includes("3312345678") && g.ruta === "/cliente/reservar", "errores: guardado sin correo, teléfono ni parámetros", JSON.stringify(g));
  const { count } = await svc.from("alertas_enviadas").select("id", { count: "exact", head: true });
  revisar(count === 0, "alertas apagadas: no se registró ningún envío");
} catch (err) {
  revisar(false, "error inesperado: " + err.message);
} finally {
  await svc.from("app_errores").delete().like("mensaje", `${marca}%`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
