// Conexiones a Postgres para las herramientas de desarrollo, con candados:
//
//  - PRODUCCIÓN: solo lectura del catálogo. La sesión se abre con
//    default_transaction_read_only = on y además cada sentencia pasa por
//    `validarLecturaCatalogo`, que rechaza todo lo que no sea un SELECT/WITH
//    sobre pg_catalog, information_schema, pg_policies, storage.buckets y
//    similares. Nunca lee datos de usuarios.
//  - DEV: lectura y escritura, pero solo si la URL apunta al ref de dev y NO
//    al de producción.
//
// Las cadenas de conexión viven en .env.dev (gitignored) y nunca se imprimen.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REF_PROD = "kigltjvakwuuulvzbyri";
export const REF_DEV = "ygumrpckbtlngzspqdvo";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(RAIZ, "package.json"));
const { Client } = require("pg");

export function leerEnv(archivo) {
  const texto = readFileSync(path.join(RAIZ, archivo), "utf8");
  return Object.fromEntries(
    texto
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

export const envDev = () => leerEnv(".env.dev");

// Ref del payload de una llave JWT de Supabase (sin exponer la llave).
export function refDeLlave(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).ref ?? null;
  } catch {
    return null;
  }
}

// Falla si algo de .env.dev apunta a producción donde debe apuntar a dev.
export function verificarEnvDev() {
  const env = envDev();
  const problemas = [];
  if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(REF_DEV) || env.NEXT_PUBLIC_SUPABASE_URL.includes(REF_PROD))
    problemas.push("NEXT_PUBLIC_SUPABASE_URL no es la de dev");
  for (const k of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"])
    if (refDeLlave(env[k] ?? "") !== REF_DEV) problemas.push(`${k} no es de dev`);
  if (!env.DATABASE_URL_DEV?.includes(REF_DEV) || env.DATABASE_URL_DEV.includes(REF_PROD))
    problemas.push("DATABASE_URL_DEV no es la de dev");
  if (problemas.length) throw new Error("ABORTO, .env.dev no apunta a dev: " + problemas.join("; "));
  return env;
}

// ---------- Candado de lectura del catálogo de producción ----------
const ESQUEMAS_PERMITIDOS = /\b(pg_catalog|information_schema|pg_policies|pg_\w+|storage\.buckets|pg_get_\w+|format_type|obj_description|col_description|has_\w+_privilege|current_setting|quote_ident|array_to_string|unnest|aclexplode)\b/i;
const PROHIBIDAS = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do|execute|vacuum|analyze|cluster|reindex|lock|listen|notify|set\s+(?!local\s+statement_timeout)|reset|comment|security\s+label|refresh|import|prepare|deallocate|discard|savepoint|release|begin|commit|rollback)\b/i;
// Tablas con datos de usuarios: prohibido leerlas aunque el SELECT sea "de lectura".
const TABLAS_DE_DATOS = /\b(public\.\w+|auth\.users|auth\.\w+|storage\.objects)\b/i;

export function validarLecturaCatalogo(sql) {
  const limpio = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/'(?:[^']|'')*'/g, "''").trim();
  if (!/^(select|with)\b/i.test(limpio)) throw new Error("PROD: solo se permite SELECT/WITH");
  if (limpio.includes(";")) throw new Error("PROD: una sola sentencia por consulta");
  if (PROHIBIDAS.test(limpio)) throw new Error("PROD: palabra prohibida en consulta de lectura");
  if (TABLAS_DE_DATOS.test(limpio)) throw new Error("PROD: no se leen tablas de datos, solo el catálogo");
  if (!ESQUEMAS_PERMITIDOS.test(limpio)) throw new Error("PROD: la consulta no es del catálogo");
}

export async function conectarProdLectura() {
  const env = envDev();
  const url = env.DATABASE_URL_PROD;
  if (!url?.includes(REF_PROD)) throw new Error("DATABASE_URL_PROD no apunta a producción; no se usa");
  const cliente = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: "antroapp-lectura-catalogo" });
  await cliente.connect();
  await cliente.query("set session characteristics as transaction read only");
  await cliente.query("set default_transaction_read_only = on");
  const { rows } = await cliente.query("show default_transaction_read_only");
  if (rows[0].default_transaction_read_only !== "on") {
    await cliente.end();
    throw new Error("PROD: no se pudo poner la sesión en solo lectura");
  }
  return {
    async q(sql, params = []) {
      validarLecturaCatalogo(sql);
      return (await cliente.query(sql, params)).rows;
    },
    fin: () => cliente.end(),
  };
}

export async function conectarDevEscritura() {
  const env = verificarEnvDev();
  const url = env.DATABASE_URL_DEV;
  const cliente = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: "antroapp-dev-herramientas" });
  await cliente.connect();
  // Doble candado: el servidor al que llegamos debe ser el de dev.
  const { rows } = await cliente.query("select current_database() as db, current_user as usuario");
  if (url.includes(REF_PROD) || !rows.length) {
    await cliente.end();
    throw new Error("ABORTO: la conexión de escritura no es dev");
  }
  return {
    q: async (sql, params = []) => (await cliente.query(sql, params)).rows,
    cliente,
    fin: () => cliente.end(),
  };
}
