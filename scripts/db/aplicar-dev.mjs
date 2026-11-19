// Aplica un archivo SQL en antroapp-dev, en UNA transacción (todo o nada).
// Se niega a correr si la conexión apunta a producción.
//
//   node scripts/db/aplicar-dev.mjs sql/esquema/esquema-prod.sql
//   node scripts/db/aplicar-dev.mjs --reiniciar sql/esquema/esquema-prod.sql
//
// --reiniciar borra antes TODO lo de public en dev (tablas, vistas,
// secuencias, funciones, tipos), sus buckets y usuarios de auth. Solo dev.

import { readFileSync } from "node:fs";
import { conectarDevEscritura } from "./conexion.mjs";

const args = process.argv.slice(2);
const reiniciar = args.includes("--reiniciar");
const archivos = args.filter((a) => !a.startsWith("--"));
if (!archivos.length) throw new Error("Uso: node scripts/db/aplicar-dev.mjs [--reiniciar] <archivo.sql> ...");

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
    // Storage y auth de dev: objetos y usuarios de prueba.
    await db.q("delete from storage.objects");
    await db.q("delete from storage.buckets");
    await db.q("delete from auth.users");
    console.log("dev reiniciado (public, storage y auth vacíos)");
  }
  for (const archivo of archivos) {
    const sql = readFileSync(archivo, "utf8");
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
