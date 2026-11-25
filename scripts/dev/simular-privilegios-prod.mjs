// SOLO DEV. ¿El SQL del pase 2 deja en PRODUCCIÓN algo abierto al anónimo
// que en dev no se ve?
//
//   node scripts/dev/simular-privilegios-prod.mjs
//
// Por qué: en producción, todo lo que crea `postgres` en el esquema public
// nace con permisos para anon, authenticated y service_role (privilegios por
// defecto de Supabase: EXECUTE en funciones; todo en tablas y secuencias). En
// antroapp-dev esos privilegios por defecto están apagados ("Automatically
// expose new tables" desactivado), así que una función nueva que olvidó su
// `revoke ... from anon` pasa todas las pruebas en dev y en producción queda
// abierta a cualquiera con la anon key. Ojo: `revoke ... from public` NO
// quita ese permiso, porque es un GRANT directo a anon.
//
// Qué hace, en UNA transacción que al final se deshace (dev no cambia):
//   1. Foto de lo que anon y authenticated pueden hacer hoy en dev (lo probado).
//   2. Copia en esa transacción los privilegios por defecto de producción.
//   3. Revierte toda la cadena del pase 2 (rollbacks en orden inverso) y la
//      vuelve a aplicar (orden de scripts/dev/ensayo-pase2.mjs), así cada
//      función y tabla nueva nace como nacería en producción.
//   4. Foto otra vez y lista lo que anon/authenticated ganan respecto a lo
//      probado: funciones con EXECUTE y tablas con permisos (y si tienen RLS).
//   5. rollback.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fuenteEnsayo = readFileSync(path.join(RAIZ, "scripts/dev/ensayo-pase2.mjs"), "utf8");
const PASOS = [...fuenteEnsayo.matchAll(/"((?:post-junta|post-junta-2|fase2)\/[^"]+)"/g)].map((m) => m[1]);
const leer = (p) => readFileSync(path.join(RAIZ, "sql", p + ".sql"), "utf8").replace(/\r/g, "").replace(/^\s*(begin|commit);\s*$/gim, "");

const FOTO = `
  select 'funcion' as tipo, p.oid::regprocedure::text as objeto,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
         null::boolean as rls, p.prokind = 'f' and p.prorettype = 'trigger'::regtype as es_trigger,
         p.prosecdef as definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
  union all
  select 'tabla', c.oid::regclass::text,
         has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
           or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'),
         has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
           or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE'),
         c.relrowsecurity, false, false
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')`;

const db = await conectarDevEscritura();
let salida = 0;
try {
  await db.q("begin");
  const probado = new Map((await db.q(FOTO)).map((r) => [r.tipo + " " + r.objeto, r]));
  await db.q(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role`);
  await db.q(`alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role`);
  await db.q(`alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role`);
  // Control: si la simulación sirve, una función nueva con solo "revoke from
  // public" queda ejecutable por anon, igual que pasaría en producción.
  await db.q(`create function public.zz_control_simulacion() returns int language sql as 'select 1'; revoke all on function public.zz_control_simulacion() from public; create table public.zz_control_tabla (id int)`);
  const [ctl] = await db.q(`select has_function_privilege('anon', 'public.zz_control_simulacion()', 'EXECUTE') as f, has_table_privilege('anon', 'public.zz_control_tabla', 'SELECT') as t`);
  console.log(`Control de la simulación: función nueva ejecutable por anon = ${ctl.f}, tabla nueva legible por anon = ${ctl.t} (deben ser true)`);
  if (!ctl.f || !ctl.t) throw new Error("la simulación no reproduce los privilegios por defecto de producción");
  await db.q(`drop function public.zz_control_simulacion(); drop table public.zz_control_tabla`);
  for (const p of [...PASOS].reverse()) { await db.q(leer(p + "-rollback")); await db.q("reset role"); }
  for (const p of PASOS) { await db.q(leer(p)); await db.q("reset role"); }
  const simulado = await db.q(FOTO);

  const ganan = [];
  for (const r of simulado) {
    const antes = probado.get(r.tipo + " " + r.objeto);
    const anonNuevo = r.anon && !(antes?.anon);
    const authNuevo = r.auth && !(antes?.auth);
    if (anonNuevo || authNuevo) ganan.push({ ...r, anonNuevo, authNuevo, existia: !!antes });
  }
  const faltan = [...probado.keys()].filter((k) => !simulado.some((r) => r.tipo + " " + r.objeto === k));
  console.log(`Pasos de la cadena: ${PASOS.length}. Objetos: ${simulado.length} (en dev probado: ${probado.size}; ${faltan.length} ya no existen tras reaplicar).`);
  // Grave: una función (no trigger) que el anónimo podría llamar, o una
  // SECURITY DEFINER que authenticated podría llamar sin haberse probado así
  // (ayudantes internos), o una tabla SIN RLS con permisos nuevos.
  const graves = ganan.filter((g) => g.tipo === "funcion"
    ? !g.es_trigger && (g.anonNuevo || (g.authNuevo && g.definer))
    : !g.rls);
  const leves = ganan.filter((g) => !graves.includes(g));
  console.log(`\nEn producción quedaría abierto sin haberse probado en dev: ${graves.length}`);
  for (const g of graves) console.log(`  ${g.tipo === "funcion" ? (g.definer ? "función SECURITY DEFINER" : "función") : "tabla SIN RLS"}  ${g.objeto}  anon:${g.anonNuevo ? "sí" : "no"} authenticated:${g.authNuevo ? "sí" : "no"}`);
  console.log(`\nOtros permisos que solo existirían en producción (trigger, tabla con RLS o solo authenticated): ${leves.length}`);
  for (const g of leves) console.log(`  ${g.tipo}${g.es_trigger ? " (trigger)" : ""}${g.tipo === "tabla" ? (g.rls ? " (con RLS)" : " (SIN RLS)") : ""}  ${g.objeto}  anon:${g.anonNuevo ? "sí" : "no"} authenticated:${g.authNuevo ? "sí" : "no"}`);
  if (faltan.length) console.log("\nYa no existen tras reaplicar: " + faltan.join(", "));
  salida = graves.length ? 1 : 0;
} finally {
  await db.q("rollback").catch(() => {});
  await db.fin();
}
console.log("\n(todo se deshizo: dev no cambió)");
process.exit(salida);
