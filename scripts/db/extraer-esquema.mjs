// Extrae el ESQUEMA (sin datos) de una base Supabase leyendo solo el catálogo,
// y lo escribe como SQL aplicable en una base vacía.
//
//   node scripts/db/extraer-esquema.mjs --origen=prod --salida=sql/esquema/esquema-prod.sql
//   node scripts/db/extraer-esquema.mjs --origen=dev  --salida=<ruta>
//
// Contra prod usa la conexión de solo lectura con candado de catálogo
// (scripts/db/conexion.mjs). No lee filas de tablas de usuarios.
//
// Incluye: extensiones, enums, secuencias, tablas y columnas, restricciones,
// índices, funciones de public (con sus permisos EXECUTE), vistas, triggers
// (de public y los de auth/storage que llaman funciones de public), RLS,
// políticas (public y storage), GRANT de tablas/secuencias/esquema para
// anon/authenticated/service_role, buckets de Storage, publicación de
// realtime y event triggers.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { conectarProdLectura, conectarDevEscritura } from "./conexion.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const origen = args.origen;
if (!["prod", "dev"].includes(origen)) throw new Error("--origen=prod|dev");
const salida = args.salida;
if (!salida) throw new Error("--salida=<archivo.sql>");

const db = origen === "prod" ? await conectarProdLectura() : await conectarDevEscritura();
const q = (sql, p) => db.q(sql, p);
const ROLES_API = ["anon", "authenticated", "service_role"];
const id = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const lit = (s) => (s === null || s === undefined ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const out = [];
const seccion = (t) => out.push("", `-- ============================================================`, `-- ${t}`, `-- ============================================================`);

out.push(
  `-- Esquema de AntroApp extraído del catálogo (${origen}). Solo estructura, sin datos.`,
  `-- Generado por scripts/db/extraer-esquema.mjs. No editar a mano: regenerar.`,
  `set check_function_bodies = off;`,
);

// ---------- Extensiones ----------
seccion("Extensiones");
const ext = await q(`select e.extname, n.nspname from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace order by 1`);
for (const e of ext) if (e.extname !== "plpgsql") out.push(`create extension if not exists ${id(e.extname)} with schema ${id(e.nspname)};`);

// ---------- Enums ----------
seccion("Tipos enum");
const enums = await q(`select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
  from pg_catalog.pg_type t join pg_catalog.pg_enum e on e.enumtypid = t.oid
  join pg_catalog.pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' group by t.typname order by 1`);
for (const t of enums) out.push(`create type public.${id(t.typname)} as enum (${t.labels.map(lit).join(", ")});`);

// ---------- Secuencias (las no identity) ----------
seccion("Secuencias");
const seqs = await q(`select c.relname, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
    format_type(s.seqtypid, null) as tipo,
    (select d.deptype from pg_catalog.pg_depend d where d.objid = c.oid and d.classid = 'pg_catalog.pg_class'::regclass and d.deptype = 'i' limit 1) as interna
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_sequence s on s.seqrelid = c.oid where n.nspname = 'public' and c.relkind = 'S' order by 1`);
for (const s of seqs.filter((s) => !s.interna))
  out.push(`create sequence if not exists public.${id(s.relname)} as ${s.tipo} increment ${s.seqincrement} minvalue ${s.seqmin} maxvalue ${s.seqmax} start ${s.seqstart} cache ${s.seqcache}${s.seqcycle ? " cycle" : ""};`);

// ---------- Funciones (antes de tablas: los defaults y políticas las usan) ----------
seccion("Funciones de public");
const funcs = await q(`select p.oid::int as oid, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
    pg_catalog.pg_get_functiondef(p.oid) as def, p.proacl::text[] as acl
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f','p')
    and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
  order by p.proname, 2`);
for (const f of funcs) out.push(f.def.trim() + ";", "");

// ---------- Tablas ----------
seccion("Tablas");
const tablas = await q(`select c.oid::int as oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') order by 2`);
const cols = await q(`select c.relname, a.attname, format_type(a.atttypid, a.atttypmod) as tipo, a.attnotnull,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as def, a.attidentity, a.attgenerated, a.attnum
  from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`);
for (const t of tablas) {
  const defs = cols.filter((c) => c.relname === t.relname).map((c) => {
    let l = `  ${id(c.attname)} ${c.tipo}`;
    if (c.attgenerated === "s") l += ` generated always as (${c.def}) stored`;
    else if (c.attidentity === "a") l += " generated always as identity";
    else if (c.attidentity === "d") l += " generated by default as identity";
    else if (c.def !== null) l += ` default ${c.def}`;
    if (c.attnotnull) l += " not null";
    return l;
  });
  out.push(`create table public.${id(t.relname)} (`, defs.join(",\n"), `);`);
}
// Secuencias ligadas a columnas (serial).
const owned = await q(`select s.relname as seq, t.relname as tabla, a.attname as col
  from pg_catalog.pg_depend d join pg_catalog.pg_class s on s.oid = d.objid and s.relkind = 'S'
  join pg_catalog.pg_class t on t.oid = d.refobjid join pg_catalog.pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
  join pg_catalog.pg_namespace n on n.oid = s.relnamespace
  where n.nspname = 'public' and d.deptype = 'a' order by 1`);
for (const o of owned) out.push(`alter sequence public.${id(o.seq)} owned by public.${id(o.tabla)}.${id(o.col)};`);

// ---------- Restricciones ----------
seccion("Restricciones (PK, UNIQUE, CHECK, EXCLUDE) y luego llaves foráneas");
const cons = await q(`select c.relname, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid) as def
  from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') and k.contype in ('p','u','c','x','f')
  order by (k.contype = 'f'), c.relname, k.conname`);
for (const k of cons) out.push(`alter table public.${id(k.relname)} add constraint ${id(k.conname)} ${k.def};`);

// ---------- Índices (los que no respaldan una restricción) ----------
seccion("Índices");
const idx = await q(`select i.indexrelid::regclass::text as nombre, pg_catalog.pg_get_indexdef(i.indexrelid) as def
  from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not exists (select 1 from pg_catalog.pg_constraint k where k.conindid = i.indexrelid)
  order by 1`);
for (const i of idx) out.push(i.def + ";");

// ---------- Vistas ----------
seccion("Vistas");
const vistas = await q(`select c.relname, c.relkind, pg_catalog.pg_get_viewdef(c.oid, true) as def, c.reloptions::text[] as opciones
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v','m') order by 1`);
for (const v of vistas) {
  const con = v.opciones?.length ? ` with (${v.opciones.join(", ")})` : "";
  out.push(`create ${v.relkind === "m" ? "materialized view" : "view"} public.${id(v.relname)}${con} as\n${v.def.trim().replace(/;$/, "")};`);
}

// ---------- RLS ----------
seccion("Row Level Security");
for (const t of tablas) {
  if (t.relrowsecurity) out.push(`alter table public.${id(t.relname)} enable row level security;`);
  if (t.relforcerowsecurity) out.push(`alter table public.${id(t.relname)} force row level security;`);
}

// ---------- Políticas (public y storage) ----------
seccion("Políticas (public y storage.objects/buckets)");
const pols = await q(`select n.nspname, c.relname, p.polname, p.polpermissive, p.polcmd,
    coalesce((select array_agg(r.rolname::text order by r.rolname) from pg_catalog.pg_roles r where r.oid = any(p.polroles)), '{}'::text[]) as roles,
    pg_catalog.pg_get_expr(p.polqual, p.polrelid) as usar, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as chequeo
  from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','storage') order by 1, 2, 3`);
const CMD = { r: "select", a: "insert", w: "update", d: "delete", "*": "all" };
for (const p of pols) {
  const roles = p.roles.length ? p.roles.map(id).join(", ") : "public";
  const tabla = `${p.nspname}.${id(p.relname)}`;
  if (p.nspname === "storage") out.push(`drop policy if exists ${id(p.polname)} on ${tabla};`);
  out.push(
    `create policy ${id(p.polname)} on ${tabla} as ${p.polpermissive ? "permissive" : "restrictive"} for ${CMD[p.polcmd]} to ${roles}` +
      (p.usar !== null ? `\n  using (${p.usar})` : "") +
      (p.chequeo !== null ? `\n  with check (${p.chequeo})` : "") +
      ";",
  );
}

// ---------- Triggers ----------
seccion("Triggers (public, y los de auth/storage que llaman funciones de public)");
const trigs = await q(`select n.nspname, c.relname, t.tgname, pg_catalog.pg_get_triggerdef(t.oid) as def
  from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_proc f on f.oid = t.tgfoid join pg_catalog.pg_namespace fn on fn.oid = f.pronamespace
  where not t.tgisinternal and (n.nspname = 'public' or (n.nspname in ('auth','storage') and fn.nspname = 'public'))
  order by 1, 2, 3`);
for (const t of trigs) {
  if (t.nspname !== "public") out.push(`drop trigger if exists ${id(t.tgname)} on ${t.nspname}.${id(t.relname)};`);
  out.push(t.def + ";");
}

// ---------- GRANT ----------
seccion("Permisos (GRANT explícitos; en dev no hay exposición automática)");
const schemaAcl = await q(`select distinct n.nspname, a.grantee::regrole::text as rol, a.privilege_type as priv
  from pg_catalog.pg_namespace n, aclexplode(n.nspacl) a where n.nspname in ('public','storage') and a.grantee <> 0 order by 1, 2, 3`);
for (const g of schemaAcl.filter((g) => ROLES_API.includes(g.rol))) out.push(`grant ${g.priv.toLowerCase()} on schema ${g.nspname} to ${g.rol};`);

const relAcl = await q(`select distinct c.relname, c.relkind,
    case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as rol, a.privilege_type as priv
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
  where n.nspname = 'public' and c.relkind in ('r','p','v','m','S') order by 1, 3, 4`);
const relaciones = await q(`select c.relname, c.relkind from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p','v','m','S') order by 1`);
for (const r of relaciones) {
  const tipo = r.relkind === "S" ? "sequence" : "table";
  out.push(`revoke all on ${tipo} public.${id(r.relname)} from public, ${ROLES_API.join(", ")};`);
  const porRol = {};
  for (const g of relAcl.filter((g) => g.relname === r.relname && (g.rol === "public" || ROLES_API.includes(g.rol))))
    (porRol[g.rol] ??= []).push(g.priv.toLowerCase());
  for (const [rol, privs] of Object.entries(porRol)) out.push(`grant ${privs.join(", ")} on ${tipo} public.${id(r.relname)} to ${rol};`);
}
// Permisos por columna, si los hay.
const colAcl = await q(`select distinct c.relname, a2.attname, case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as rol, a.privilege_type as priv
  from pg_catalog.pg_attribute a2 join pg_catalog.pg_class c on c.oid = a2.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace, aclexplode(a2.attacl) a
  where n.nspname = 'public' and a2.attacl is not null order by 1, 2, 3, 4`);
for (const g of colAcl.filter((g) => g.rol === "public" || ROLES_API.includes(g.rol)))
  out.push(`grant ${g.priv.toLowerCase()} (${id(g.attname)}) on table public.${id(g.relname)} to ${g.rol};`);

// EXECUTE de funciones: proacl nulo = el default de Postgres (PUBLIC puede ejecutar).
const funcAcl = await q(`select distinct p.oid::int as oid, case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as rol, a.privilege_type as priv
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
  where n.nspname = 'public' and p.proacl is not null order by 1, 2`);
for (const f of funcs) {
  const firma = `public.${id(f.proname)}(${f.args})`;
  out.push(`revoke all on function ${firma} from public, ${ROLES_API.join(", ")};`);
  const roles = f.acl === null ? ["public"] : funcAcl.filter((g) => g.oid === f.oid && (g.rol === "public" || ROLES_API.includes(g.rol))).map((g) => g.rol);
  for (const rol of [...new Set(roles)]) out.push(`grant execute on function ${firma} to ${rol};`);
}

// ---------- Storage ----------
seccion("Buckets de Storage");
const buckets = await q(`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id`);
for (const b of buckets)
  out.push(
    `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (${lit(b.id)}, ${lit(b.name)}, ${b.public}, ${b.file_size_limit ?? "null"}, ${b.allowed_mime_types ? `array[${b.allowed_mime_types.map(lit).join(", ")}]` : "null"})` +
      ` on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;`,
  );

// ---------- Realtime ----------
seccion("Publicación de realtime");
const pub = await q(`select p.pubname, c.relname from pg_catalog.pg_publication p join pg_catalog.pg_publication_rel pr on pr.prpubid = p.oid
  join pg_catalog.pg_class c on c.oid = pr.prrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' order by 1, 2`);
for (const p of pub) out.push(`alter publication ${id(p.pubname)} add table public.${id(p.relname)};`);

// ---------- Event triggers ----------
seccion("Event triggers (que llaman funciones de public)");
const evt = await q(`select e.evtname, e.evtevent, f.proname, e.evttags, e.evtenabled
  from pg_catalog.pg_event_trigger e join pg_catalog.pg_proc f on f.oid = e.evtfoid
  join pg_catalog.pg_namespace n on n.oid = f.pronamespace where n.nspname = 'public' order by 1`);
for (const e of evt) {
  out.push(`drop event trigger if exists ${id(e.evtname)};`);
  out.push(`create event trigger ${id(e.evtname)} on ${e.evtevent}${e.evttags?.length ? ` when tag in (${e.evttags.map(lit).join(", ")})` : ""} execute function public.${id(e.proname)}();`);
}

// Resumen (para comparar prod contra dev).
const resumen = {
  extensiones: ext.length, enums: enums.length, funciones: funcs.length, tablas: tablas.length, columnas: cols.length,
  restricciones: cons.length, indices: idx.length, vistas: vistas.length, politicas: pols.length,
  triggers: trigs.length, buckets: buckets.length, event_triggers: evt.length,
  tablas_con_rls: tablas.filter((t) => t.relrowsecurity).length,
};
out.push("", `-- Resumen: ${JSON.stringify(resumen)}`);
mkdirSync(path.dirname(path.resolve(salida)), { recursive: true });
writeFileSync(salida, out.join("\n") + "\n");
console.log(`Esquema de ${origen} -> ${salida}`);
console.log(resumen);
await db.fin();
