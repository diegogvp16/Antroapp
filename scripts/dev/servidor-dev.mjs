// Levanta la app local contra antroapp-dev (no contra producción).
//
//   node scripts/dev/servidor-dev.mjs          -> http://localhost:3001
//
// Next.js da prioridad a las variables del proceso sobre .env.local, así que
// basta con pasarle las de .env.dev. Se niega a arrancar si .env.dev apunta
// a producción. No imprime ninguna llave.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUERTO = process.env.PUERTO ?? "3001";

console.log(`App local contra antroapp-dev en http://localhost:${PUERTO}`);
const hijo = spawn("npx", ["next", "dev", "--turbopack", "-p", PUERTO], {
  cwd: RAIZ,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  },
});
hijo.on("exit", (codigo) => process.exit(codigo ?? 0));
