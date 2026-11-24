// Apunta el entorno Preview de Vercel a antroapp-dev usando .env.dev.
// Nunca imprime los valores: se pasan al CLI por stdin. No toca Production.
//
//   node scripts/dev/vercel-preview-a-dev.mjs

import { execFileSync } from "node:child_process";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev(); // aborta si algo de .env.dev apunta a producción
const VARIABLES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const tapar = (t) => String(t ?? "").replace(/eyJ[\w.-]+/g, "<llave>");

function correr(args, input) {
  try {
    return execFileSync(npx, ["vercel", ...args, "--scope", "antroapp"], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    }).toString();
  } catch (e) {
    const detalle = tapar(e.stderr?.toString())
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/claude-code-hint|^Vercel CLI/.test(l))
      .join(" | ");
    throw new Error(`vercel ${args.slice(0, 3).join(" ")}: ${detalle || "falló"}`);
  }
}

const enPreview = (nombre) =>
  correr(["env", "ls", "preview"])
    .split(/\r?\n/)
    .some((l) => l.trim().startsWith(nombre + " ") && /Preview/.test(l));

for (const nombre of VARIABLES) {
  if (enPreview(nombre)) correr(["env", "rm", nombre, "preview", "--yes"]);
  // NEXT_PUBLIC_ se expone en el navegador: Vercel exige tipo config. La service role va como Secret.
  const tipo = nombre.startsWith("NEXT_PUBLIC_") ? ["--type", "config"] : ["--sensitive"];
  correr(["env", "add", nombre, "preview", ...tipo, "--yes"], env[nombre]);
  console.log(`Preview: ${nombre} -> antroapp-dev`);
}
