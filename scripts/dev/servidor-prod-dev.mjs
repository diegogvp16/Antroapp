// Build de producción contra antroapp-dev, para medir como en el teléfono
// real (React de producción, JS minificado) sin tocar producción.
//
//   node scripts/dev/servidor-prod-dev.mjs            -> build + http://localhost:3002
//   node scripts/dev/servidor-prod-dev.mjs --sin-build  (reusa el último build)
//
// Construye en .next-build (NEXT_DIST_DIR) para no pisar la .next del
// servidor de desarrollo. Las NEXT_PUBLIC_* se fijan en el build: por eso se
// construye con las llaves de .env.dev, y se niega si apuntan a producción.
// No imprime ninguna llave.

import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUERTO = process.env.PUERTO ?? "3002";
const entorno = {
  ...process.env,
  NEXT_DIST_DIR: ".next-build",
  NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
};
const opciones = { cwd: RAIZ, stdio: "inherit", shell: process.platform === "win32", env: entorno };

if (!process.argv.includes("--sin-build")) {
  console.log("Build de producción contra antroapp-dev en .next-build ...");
  const r = spawnSync("npx", ["next", "build"], opciones);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(`App de producción contra antroapp-dev en http://localhost:${PUERTO}`);
const hijo = spawn("npx", ["next", "start", "-p", PUERTO], opciones);
hijo.on("exit", (codigo) => process.exit(codigo ?? 0));
