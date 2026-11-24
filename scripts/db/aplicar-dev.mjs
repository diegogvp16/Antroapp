// Aplica un archivo SQL en antroapp-dev, en UNA transacción (todo o nada).
// Se niega a correr si la conexión apunta a producción.
//
//   node scripts/db/aplicar-dev.mjs sql/esquema/esquema-prod.sql
//   node scripts/db/aplicar-dev.mjs --reiniciar sql/esquema/esquema-prod.sql
//
// --reiniciar borra antes TODO lo de public en dev (tablas, vistas,
// secuencias, funciones, tipos), sus buckets y usuarios de auth. Solo dev.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura, verificarEnvDev } from "./conexion.mjs";

// Vacía todos los buckets de dev con la API de Storage (service role de dev).
async function vaciarStorageDev() {
  const env = verificarEnvDev();
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { createClient } = createRequire(path.join(raiz, "package.json"))("@supabase/supabase-js");
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: buckets } = await svc.storage.listBuckets();
  let borrados = 0;
  for (const b of buckets ?? []) {
    const { data: carpetas } = await svc.storage.from(b.id).list("", { limit: 1000 });
    for (const c of carpetas ?? []) {
      const { data: archivos } = await svc.storage.from(b.id).list(c.name, { limit: 1000 });
      const rutas = (archivos ?? []).map((a) => `${c.name}/${a.name}`);
      if (rutas.length) {
        await svc.storage.from(b.id).remove(rutas);
        borrados += rutas.length;
      }
    }
  }
  console.log(`Storage de dev vaciado (${borrados} archivos)`);
}

const args = process.argv.slice(2);
const reiniciar = args.includes("--reiniciar");
const archivos = args.filter((a) => !a.startsWith("--"));
if (!archivos.length) throw new Error("Uso: node scripts/db/aplicar-dev.mjs [--reiniciar] <archivo.sql> ...");

if (reiniciar) await vaciarStorageDev();

const db = await conectarDevEscritura();
try {
  await db.q("begin");
  if (reiniciar) {
    await db.q(`do $$
      declare r record;
      begin
        for r in select evtname from pg_event_trigger e join pg_proc f on f.oid = e.evtfoid
                 join pg_namespace n on n.oid = f.pronamespace where n.nspname = 'public' loop
          execute format('drop event trigger if exists %I', r.evtname);
        end loop;
        for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('v','m') loop
          execute format('drop view if exists public.%I cascade', r.relname);
        end loop;
        for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r','p') loop
          execute format('drop table if exists public.%I cascade', r.relname);
        end loop;
        for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'S' loop
          execute format('drop sequence if exists public.%I cascade', r.relname);
        end loop;
        for r in select p.oid::regprocedure::text as firma from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
          execute 'drop function if exists ' || r.firma || ' cascade';
        end loop;
        for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typtype in ('e','d','c') and not exists (select 1 from pg_class c where c.reltype = t.oid) loop
          execute format('drop type if exists public.%I cascade', r.typname);
        end loop;
      end $$;`);
    // Usuarios de prueba de dev. (Los archivos de Storage ya se vaciaron con
    // la API antes de la transacción: Supabase no deja borrarlos por SQL.)
    await db.q("delete from auth.users");
    console.log("dev reiniciado (public y auth vacíos; Storage vaciado por API)");
  }
  for (const archivo of archivos) {
    // Sin retornos de carro: un CRLF dentro del cuerpo de una función queda
    // guardado en la base y deja de ser idéntica al archivo.
    const sql = readFileSync(archivo, "utf8").replace(/\r\n/g, "\n");
    try {
      await db.q(sql);
      console.log(`aplicado: ${archivo}`);
    } catch (e) {
      const pos = Number(e.position) || 0;
      const linea = pos ? sql.slice(0, pos).split("\n").length : "?";
      throw new Error(`${archivo}, línea ${linea}: ${e.message}`);
    }
  }
  await db.q("commit");
  console.log("transacción confirmada en dev");
} catch (e) {
  await db.q("rollback").catch(() => {});
  console.error("ERROR (rollback, dev quedó como estaba):", e.message);
  process.exitCode = 1;
} finally {
  await db.fin();
}
