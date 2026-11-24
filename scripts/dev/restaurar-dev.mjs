// Restaura los DATOS de antroapp-dev desde un respaldo de respaldar-dev.mjs.
// SOLO DEV (conectarDevEscritura se niega contra producción).
//
//   node scripts/dev/restaurar-dev.mjs backups/dev-<fecha>-<nombre>          # simula: dice qué haría
//   node scripts/dev/restaurar-dev.mjs backups/dev-<fecha>-<nombre> --si     # restaura
//
// Qué hace, en UNA transacción (si algo falla, dev queda como estaba):
//   1. Apaga los triggers de usuario de las tablas (candados de caja, fechas
//      que pone la base…) para que los datos queden EXACTAMENTE como en el
//      respaldo. Los de llaves foráneas siguen activos.
//   2. Borra cada tabla de public en orden inverso de dependencias y la vuelve
//      a llenar con las filas del respaldo en orden directo. Una llave que
//      cierra un ciclo (profiles.club_id ↔ clubs.dueno_id) se inserta en NULL
//      y se completa al final.
//   3. Vuelve a encender los triggers y compara tabla por tabla (contenido)
//      contra el respaldo ANTES de confirmar.
// Límites: NO restaura auth.users (no hay contraseñas en el respaldo): los
// usuarios deben seguir existiendo; un perfil cuyo usuario ya no existe hace
// fallar la restauración (y no se cambia nada). Tampoco el esquema: para eso,
// aplicar-dev.mjs --reiniciar con el esquema.sql del respaldo. Las tablas que
// no estaban en el respaldo (nuevas) no se tocan.
// En PRODUCCIÓN no se usa esto: se restaura desde los respaldos de Supabase
// (docs/operacion.md, «Restaurar un respaldo»).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = process.argv[2] ? path.resolve(RAIZ, process.argv[2]) : null;
const si = process.argv.includes("--si");
if (!dir || !existsSync(path.join(dir, "datos"))) {
  console.log("Uso: node scripts/dev/restaurar-dev.mjs backups/dev-<fecha>-<nombre> [--si]");
  process.exit(1);
}
const enRespaldo = new Set(readdirSync(path.join(dir, "datos")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
const ident = (t) => {
  if (!/^[a-z0-9_]+$/.test(t)) throw new Error("nombre de tabla inesperado: " + t);
  return `public.${t}`;
};
const col = (c) => {
  if (!/^[a-z0-9_]+$/.test(c)) throw new Error("nombre de columna inesperado: " + c);
  return `"${c}"`;
};
// Forma canónica para comparar: filas ordenadas por su JSON.
const canonico = (filas) =>
  filas
    .map((f) => JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k]])))
    .sort()
    .join("\n");

const db = await conectarDevEscritura();
let confirmado = false;
try {
  const tablas = (await db.q(`select tablename from pg_tables where schemaname = 'public' order by 1`)).map((t) => t.tablename).filter((t) => enRespaldo.has(t));
  const fks = await db.q(`
    select c.conrelid::regclass::text as hijo, c.confrelid::regclass::text as padre,
           array_agg(a.attname::text order by a.attnum) as cols
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and n.nspname = 'public' and c.confrelid <> c.conrelid
    group by c.oid, c.conrelid, c.confrelid`);
  const nombre = (r) => r.replace(/^public\./, "");
  const deps = new Map(tablas.map((t) => [t, []]));
  for (const f of fks) {
    if (deps.has(nombre(f.hijo)) && deps.has(nombre(f.padre))) deps.get(nombre(f.hijo)).push({ padre: nombre(f.padre), cols: f.cols });
  }
  const orden = [];
  const aplazadas = []; // { tabla, cols }: llaves que cierran un ciclo
  const visto = new Set();
  const visitar = (t, pila = new Set()) => {
    if (visto.has(t)) return;
    pila.add(t);
    for (const d of deps.get(t)) {
      if (pila.has(d.padre)) aplazadas.push({ tabla: t, cols: d.cols });
      else visitar(d.padre, pila);
    }
    pila.delete(t);
    visto.add(t);
    orden.push(t);
  };
  tablas.forEach((t) => visitar(t));
  const llavePrimaria = async (t) =>
    (
      await db.q(
        `select a.attname::text c from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
         where i.indrelid = $1::regclass and i.indisprimary`,
        [ident(t)],
      )
    ).map((x) => x.c);

  const respaldo = Object.fromEntries(orden.map((t) => [t, JSON.parse(readFileSync(path.join(dir, "datos", `${t}.json`), "utf8"))]));
  const actuales = {};
  for (const t of orden) actuales[t] = (await db.q(`select count(*)::int n from ${ident(t)}`))[0].n;
  const cambian = orden.filter((t) => actuales[t] !== respaldo[t].length);
  console.log(
    `${orden.length} tablas en el respaldo; con distinto número de filas hoy: ${
      cambian.length ? cambian.map((t) => `${t} (${actuales[t]} → ${respaldo[t].length})`).join(", ") : "ninguna"
    }`,
  );
  if (aplazadas.length) console.log(`Llaves en ciclo (se completan al final): ${aplazadas.map((a) => `${a.tabla}.${a.cols.join(",")}`).join(", ")}`);

  if (!si) {
    console.log("\nSimulación: no se cambió nada. Para restaurar agrega --si.");
  } else {
    const t0 = performance.now();
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    for (const t of orden) await db.q(`alter table ${ident(t)} disable trigger user`);
    for (const ap of aplazadas) await db.q(`update ${ident(ap.tabla)} set ${ap.cols.map((c) => `${col(c)} = null`).join(", ")}`);
    for (const t of [...orden].reverse()) await db.q(`delete from ${ident(t)}`);
    for (const t of orden) {
      const nulas = aplazadas.filter((a) => a.tabla === t).flatMap((a) => a.cols);
      const filas = nulas.length ? respaldo[t].map((f) => ({ ...f, ...Object.fromEntries(nulas.map((c) => [c, null])) })) : respaldo[t];
      for (let i = 0; i < filas.length; i += 500) {
        await db.q(`insert into ${ident(t)} overriding system value select * from json_populate_recordset(null::${ident(t)}, $1::json)`, [
          JSON.stringify(filas.slice(i, i + 500)),
        ]);
      }
    }
    for (const ap of aplazadas) {
      const pk = await llavePrimaria(ap.tabla);
      await db.q(
        `update ${ident(ap.tabla)} x set ${ap.cols.map((c) => `${col(c)} = j.${col(c)}`).join(", ")}
         from json_populate_recordset(null::${ident(ap.tabla)}, $1::json) j
         where ${pk.map((c) => `x.${col(c)} = j.${col(c)}`).join(" and ")}`,
        [JSON.stringify(respaldo[ap.tabla])],
      );
    }
    for (const t of orden) await db.q(`alter table ${ident(t)} enable trigger user`);
    // Verificación antes de confirmar: se lee igual que respaldar-dev (select *
    // por el mismo driver) para comparar en el mismo formato.
    const distintas = [];
    for (const t of orden) {
      const hoy = await db.q(`select * from ${ident(t)}`);
      if (canonico(JSON.parse(JSON.stringify(hoy))) !== canonico(respaldo[t])) distintas.push(t);
    }
    if (distintas.length) throw new Error("después de restaurar no coinciden: " + distintas.join(", "));
    await db.q("commit");
    confirmado = true;
    console.log(`\nRestaurado y verificado: ${orden.length} tablas idénticas al respaldo en ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  }
} catch (e) {
  if (si && !confirmado) await db.q("rollback").catch(() => {});
  console.log("FALLA: " + e.message + (si ? " (no se cambió nada)" : ""));
  process.exitCode = 1;
} finally {
  await db.fin();
}
