// Agrega mesas a Club Demo Dev hasta llegar a 50 (para probar el mapa de la
// caja a escala) y ocupa algunas esta noche con walk-ins y consumo.
// Solo dev: se niega si la URL o la llave son de producción.
//
//   node scripts/dev/mesas-extra.mjs              -> hasta 50 mesas, 12 nuevas ocupadas
//   node scripts/dev/mesas-extra.mjs --total=40 --ocupadas=8
//
// Para volver a 12 mesas: node scripts/dev/sembrar-dev.mjs (y luego la demo).

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLUB = "0de70000-0000-4000-8000-000000000001";
const arg = (n, d) => Number((process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=")[1]);
const TOTAL = Math.min(50, arg("total", 50));
const OCUPADAS = arg("ocupadas", 12);
const ok = (r, que) => { if (r.error) throw new Error(`${que}: ${r.error.message}`); return r.data; };

const { data: club } = await svc.from("clubs").select("nombre").eq("id", CLUB).maybeSingle();
if (club?.nombre !== "Club Demo Dev") throw new Error("No encuentro Club Demo Dev (corre scripts/dev/sembrar-dev.mjs)");

const actuales = ok(await svc.from("club_tables").select("id, numero").eq("club_id", CLUB), "mesas");
const usados = new Set(actuales.map((m) => m.numero));
const nuevas = [];
for (let n = 1; actuales.length + nuevas.length < TOTAL; n++) {
  if (!usados.has(String(n))) nuevas.push({ club_id: CLUB, numero: String(n), capacidad: [6, 8, 10, 12][n % 4] });
}
const creadas = nuevas.length ? ok(await svc.from("club_tables").insert(nuevas).select("id, numero"), "crear mesas") : [];
console.log(`Mesas: ${actuales.length} + ${creadas.length} nuevas = ${actuales.length + creadas.length}`);

// Ocupar algunas de las nuevas en la noche en curso (corte 08:00).
const noche = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const personal = ok(await svc.from("profiles").select("id, role").eq("club_id", CLUB).in("role", ["staff", "gerente"]), "personal");
const staff = personal.find((p) => p.role === "staff")?.id;
if (!staff) throw new Error("Club Demo Dev no tiene staff");
let n = ok(await svc.from("caja_noches").select("id, estado").eq("club_id", CLUB).eq("fecha_operacion", noche).maybeSingle(), "noche");
if (!n) n = ok(await svc.from("caja_noches").insert({ club_id: CLUB, fecha_operacion: noche, estado: "abierta", abierta_por: staff }).select("id, estado").single(), "crear noche");
if (n.estado !== "abierta") throw new Error(`La noche ${noche} está cerrada: no se pueden ocupar mesas`);

const PRODUCTOS = [["Cubeta de cerveza", 55000], ["Botella de tequila", 240000], ["Botella de vodka", 220000], ["Agua mineral", 4500], ["Refresco", 4000]];
let ocupadas = 0;
for (const m of creadas.slice(0, OCUPADAS)) {
  const sesion = randomUUID(), cuenta = randomUUID();
  ok(await svc.from("mesa_sesiones").insert({ id: sesion, club_id: CLUB, noche_id: n.id, mesa_id: m.id, estado: "abierta", abierta_por: staff }), "abrir mesa");
  ok(await svc.from("mesa_cuentas").insert({ id: cuenta, club_id: CLUB, sesion_id: sesion, origen: "walk_in", cliente_nombre: `Mesa ${m.numero} walk-in`, personas: 2 + (Number(m.numero) % 5), creada_por: staff }), "cuenta");
  const [prod, precio] = PRODUCTOS[Number(m.numero) % PRODUCTOS.length];
  const cantidad = 1 + (Number(m.numero) % 3);
  ok(await svc.from("caja_consumos").insert({ club_id: CLUB, noche_id: n.id, sesion_id: sesion, mesa_id: m.id, cuenta_id: cuenta, monto_centavos: precio * cantidad, concepto: cantidad > 1 ? `${cantidad} × ${prod}` : prod, registrado_por: staff }), "consumo");
  ocupadas++;
}
console.log(`Ocupadas esta noche (${noche}): ${ocupadas} mesas nuevas con un walk-in y consumo.`);
