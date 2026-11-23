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

// ---------- Conteos agregados de producción (sin datos personales) ----------
// Solo estas consultas FIJAS: no se acepta SQL de fuera. Devuelven conteos,
// estados y "tiene / no tiene", nunca nombres, correos ni teléfonos. Corren en
// la misma sesión de solo lectura. Sirven para revisar Club Demo antes de una
// junta o de un pase (scripts/db/conteos-prod.mjs).
const CLUB_DEMO_PROD = "d2f531df-8116-442e-b967-4a1004fcd02e";
const CONSULTAS_CONTEO = Object.freeze({
  club_demo: `select count(*)::int as existe,
      bool_or(estado_verificacion = 'verificado') as verificado, bool_or(suscripcion_activa) as suscripcion,
      max(horario) as horario, max(deposito_monto)::text as deposito, max(pago_rp_modo) as pago_rp_modo,
      max(comision_tipo) as comision_tipo, max(comision_monto)::text as comision_monto,
      max(comision_desbloqueo_reservas)::int as desbloqueo, max(edad_minima)::int as edad_minima,
      max(ciudad) as ciudad, bool_or(coalesce(codigo_vestimenta, '') <> '') as tiene_vestimenta,
      bool_or(coalesce(ambiente, '') <> '') as tiene_ambiente, bool_or(coalesce(tipo_musica, '') <> '') as tiene_musica,
      bool_or(lat is not null and lng is not null) as tiene_ubicacion, bool_or(dueno_id is not null) as tiene_dueno
    from public.clubs where id = '${CLUB_DEMO_PROD}'`,
  club_demo_mesas: `select count(*)::int as mesas, coalesce(sum(capacidad), 0)::int as capacidad from public.club_tables where club_id = '${CLUB_DEMO_PROD}'`,
  club_demo_fotos: `select count(*)::int as fotos from public.club_photos where club_id = '${CLUB_DEMO_PROD}'`,
  club_demo_personal: `select role, count(*)::int as total, count(*) filter (where activo is not false)::int as activos
    from public.profiles where club_id = '${CLUB_DEMO_PROD}' group by role order by role`,
  club_demo_cuentas_demo: `select substring(u.email from '^demo_([a-z]+)@') as clave, (p.club_id = '${CLUB_DEMO_PROD}') as en_club_demo, p.role, coalesce(p.activo, true) as activo
    from auth.users u join public.profiles p on p.id = u.id
    where u.email ~ '^demo_[a-z]+@example\.com$' order by 1`,
  club_demo_reglas: `select (select count(*) from public.rp_comision_overrides where club_id = '${CLUB_DEMO_PROD}')::int as overrides_comision,
      (select count(*) from public.rp_schedule where club_id = '${CLUB_DEMO_PROD}' and es_fijo)::int as turnos_fijos,
      (select count(*) from public.rp_schedule where club_id = '${CLUB_DEMO_PROD}' and not coalesce(es_fijo, false))::int as turnos_sueltos`,
  club_demo_reservas: `select count(*)::int as total, count(*) filter (where fecha >= current_date - 7)::int as ultima_semana,
      count(*) filter (where cliente_telefono like '0000000%')::int as demo, min(fecha)::text as primera, max(fecha)::text as ultima
    from public.reservations where club_id = '${CLUB_DEMO_PROD}'`,
  antros: `select count(*)::int as total, count(*) filter (where estado_verificacion = 'verificado' and suscripcion_activa)::int as publicados,
      count(distinct ciudad) filter (where estado_verificacion = 'verificado' and suscripcion_activa)::int as ciudades_publicadas
    from public.clubs`,
});

export async function conectarProdConteos() {
  const env = envDev();
  const url = env.DATABASE_URL_PROD;
  if (!url?.includes(REF_PROD)) throw new Error("DATABASE_URL_PROD no apunta a producción; no se usa");
  const cliente = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: "antroapp-conteos" });
  await cliente.connect();
  await cliente.query("set session characteristics as transaction read only");
  await cliente.query("set default_transaction_read_only = on");
  const { rows } = await cliente.query("show default_transaction_read_only");
  if (rows[0].default_transaction_read_only !== "on") {
    await cliente.end();
    throw new Error("PROD: no se pudo poner la sesión en solo lectura");
  }
  return {
    nombres: Object.keys(CONSULTAS_CONTEO),
    async consultar(nombre) {
      if (!Object.hasOwn(CONSULTAS_CONTEO, nombre)) throw new Error(`PROD: consulta de conteo desconocida: ${nombre}`);
      return (await cliente.query(CONSULTAS_CONTEO[nombre])).rows;
    },
    fin: () => cliente.end(),
  };
}
