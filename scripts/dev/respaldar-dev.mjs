// Respaldo completo de antroapp-dev en backups/ (carpeta ignorada por Git).
//
//   node scripts/dev/respaldar-dev.mjs [nombre]
//
// Guarda en backups/dev-<fecha>-<nombre>/:
//   esquema.sql            catálogo completo (scripts/db/extraer-esquema.mjs)
//   datos/<tabla>.json     todas las filas de cada tabla de public
//   auth-usuarios.json     id, correo y fechas de auth.users (sin contraseñas)
//   resumen.json           conteo por tabla
// Todo en una transacción de solo lectura: una foto consistente. Se niega a
// correr contra producción (conectarDevEscritura revisa el ref). No imprime
// datos, solo conteos. Restaurar: scripts/dev/restaurar-dev.mjs.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fecha = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const DIR = path.join(RAIZ, "backups", `dev-${fecha}${process.argv[2] ? "-" + process.argv[2] : ""}`);
mkdirSync(path.join(DIR, "datos"), { recursive: true });

const esq = spawnSync(process.execPath, [path.join(RAIZ, "scripts/db/extraer-esquema.mjs"), "--origen=dev", `--salida=${path.join(DIR, "esquema.sql")}`], { encoding: "utf8" });
if (esq.status !== 0) {
  console.log("No se pudo extraer el esquema:", esq.stderr.slice(0, 300));
  process.exit(1);
}

const db = await conectarDevEscritura();
const resumen = {};
try {
  await db.q("begin transaction isolation level repeatable read read only");
  const tablas = (await db.q(`select tablename from pg_tables where schemaname = 'public' order by 1`)).map((t) => t.tablename);
  for (const t of tablas) {
    const filas = await db.q(`select * from public.${JSON.stringify(t).slice(1, -1).replace(/[^a-z0-9_]/gi, "")}`);
    writeFileSync(path.join(DIR, "datos", `${t}.json`), JSON.stringify(filas));
    resumen[t] = filas.length;
  }
  const usuarios = await db.q(`select id, email, created_at, email_confirmed_at from auth.users order by created_at`);
  writeFileSync(path.join(DIR, "auth-usuarios.json"), JSON.stringify(usuarios));
  resumen["auth.users"] = usuarios.length;
  await db.q("rollback");
} finally {
  await db.fin();
}
writeFileSync(path.join(DIR, "resumen.json"), JSON.stringify({ fecha: new Date().toISOString(), tablas: resumen }, null, 2));
console.log(`Respaldo en ${path.relative(RAIZ, DIR)}: ${Object.keys(resumen).length} tablas, ${Object.values(resumen).reduce((a, b) => a + b, 0)} filas.`);
