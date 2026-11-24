// Cuentas de Auth que creó el alta de antros (app_metadata.alta_club) y que
// se quedaron SIN perfil: pasa si el proceso de POST /api/admin/alta-club
// muere entre crear las cuentas y guardar en la base, o si al deshacer una
// cuenta no se pudo borrar. No entran a ningún panel, pero ocupan el correo.
//
//   node scripts/limpiar-altas-huerfanas.mjs                 # dev, solo lista
//   node scripts/limpiar-altas-huerfanas.mjs --borrar        # dev, las borra
//   node scripts/limpiar-altas-huerfanas.mjs --env=.env.local --produccion [--borrar]
//
// Solo toca cuentas con alta_club = true, sin fila en profiles y de hace más
// de 30 minutos (un alta en curso nunca tarda tanto). No imprime correos
// completos ni llaves. Contra producción exige --produccion de forma explícita.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leerEnv, refDeLlave, REF_PROD } from "./db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const archivo = arg("env") ?? ".env.dev";
const env = leerEnv(archivo);
const esProd = env.NEXT_PUBLIC_SUPABASE_URL?.includes(REF_PROD) || refDeLlave(env.SUPABASE_SERVICE_ROLE_KEY) === REF_PROD;
if (esProd && !process.argv.includes("--produccion")) {
  console.log(`${archivo} apunta a PRODUCCIÓN. Si de verdad quieres revisarla, agrega --produccion.`);
  process.exitCode = 1;
} else {
  await limpiar();
}

async function limpiar() {
  const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const borrar = process.argv.includes("--borrar");
  const limite = Date.now() - 30 * 60_000;
  const candidatas = [];
  for (let pagina = 1; ; pagina++) {
    const { data, error } = await svc.auth.admin.listUsers({ page: pagina, perPage: 1000 });
    if (error) throw new Error("listUsers: " + error.message);
    for (const u of data.users) {
      if (u.app_metadata?.alta_club === true && Date.parse(u.created_at) < limite) candidatas.push(u);
    }
    if (data.users.length < 1000) break;
  }
  const conPerfil = new Set();
  for (let i = 0; i < candidatas.length; i += 200) {
    const { data } = await svc.from("profiles").select("id").in("id", candidatas.slice(i, i + 200).map((u) => u.id));
    for (const p of data ?? []) conPerfil.add(p.id);
  }
  const huerfanas = candidatas.filter((u) => !conPerfil.has(u.id));
  const ocultar = (e) => (e ?? "").replace(/^(.{2}).*(@.*)$/, "$1…$2");
  console.log(`${esProd ? "PRODUCCIÓN" : "dev"}: ${candidatas.length} cuentas del alta, ${huerfanas.length} sin perfil.`);
  for (const u of huerfanas) console.log(`  ${u.id}  ${ocultar(u.email)}  creada ${u.created_at}`);
  if (!borrar) {
    if (huerfanas.length) console.log("\nSolo lista. Para borrarlas: agrega --borrar.");
    return;
  }
  let borradas = 0;
  for (const u of huerfanas) {
    const { error } = await svc.auth.admin.deleteUser(u.id);
  if (error) console.log(`  no se pudo borrar ${u.id}: ${error.message}`);
  else borradas++;
}
console.log(`Borradas: ${borradas} de ${huerfanas.length}.`);
}
