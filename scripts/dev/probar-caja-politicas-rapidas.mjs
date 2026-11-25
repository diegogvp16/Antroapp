// SOLO DEV. Prueba de sql/post-junta-2/71-caja-politicas-rapidas.sql (C7 parte 2).
//
//   node scripts/dev/probar-caja-politicas-rapidas.mjs           # en una transacción que se deshace
//   node scripts/dev/probar-caja-politicas-rapidas.mjs --aplicado # compara contra lo ya aplicado (solo "después")
//
// Para cada identidad (admin, dueño, dueño de grupo, staff, gerente, RP,
// cliente, staff de otro antro, cuenta sin perfil) compara ANTES y DESPUÉS de
// aplicar el SQL, dentro de UNA transacción que al final se deshace (no
// cambia las políticas de dev mientras otros prueban):
//   - el conjunto de antros de caja_clubs_visibles() = los antros donde
//     caja_puede_ver() da true;
//   - cuántas filas ve de cada tabla de caja (idéntico antes y después);
//   - la firma de la noche de Club Demo Dev (idéntica para quien puede ver;
//     NULL para quien no);
//   - el tiempo de leer los consumos de la noche como staff.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLUB = "0de70000-0000-4000-8000-000000000001";
const TABLAS = ["caja_consumos", "caja_cuadres", "caja_eventos", "caja_noches", "caja_pagos", "caja_permisos", "mesa_cuentas", "mesa_sesiones"];
const db = await conectarDevEscritura();
const resultados = [];
const nota = (t, ok, d = "") => { resultados.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };

const ids = Object.fromEntries((await db.q(`
  select split_part(u.email, '@', 1) as clave, u.id
    from auth.users u join public.profiles p on p.id = u.id
   where u.email in ('dev_admin@example.com','dev_dueno@example.com','dev_dueno_tijuana@example.com','dev_staff@example.com',
                     'dev_gerente@example.com','dev_rp@example.com','dev_cliente@example.com','dev_staff_tijuana@example.com')`)).map((r) => [r.clave, r.id]));
ids.sin_perfil = "11111111-2222-4333-8444-555555555555";
const tieneProductos = (await db.q(`select to_regclass('public.productos') is not null as hay`))[0].hay;
if (tieneProductos) TABLAS.push("productos");

async function como(uid, fn) {
  await db.q("savepoint s");
  try {
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.q("set local role authenticated");
    return await fn();
  } finally {
    await db.q("rollback to savepoint s");
  }
}
async function foto() {
  const r = {};
  for (const [clave, uid] of Object.entries(ids)) {
    r[clave] = await como(uid, async () => {
      const visibles = (await db.q(`select c.id from public.clubs c where coalesce(public.caja_puede_ver(c.id), false) order by 1`)).map((x) => x.id).join(",");
      const filas = {};
      for (const t of TABLAS) filas[t] = Number((await db.q(`select count(*) from public.${t}`))[0].count);
      const firma = (await db.q(`select public.caja_firma_noche($1) as f`, [CLUB]))[0].f;
      let conjunto = null;
      try { conjunto = (await db.q(`select v from public.caja_clubs_visibles() v order by 1`)).map((x) => x.v).join(","); } catch { conjunto = null; }
      return { visibles, filas, firma, conjunto };
    });
  }
  return r;
}
async function tiempo() {
  return como(ids.dev_staff, async () => {
    const [noche] = await db.q(`select n.id from public.caja_noches n where n.club_id = $1 order by n.fecha_operacion desc limit 1`, [CLUB]);
    if (!noche) return null;
    const plan = await db.q(`explain (analyze, format json) select * from public.caja_consumos where noche_id = $1`, [noche.id]);
    return plan[0]["QUERY PLAN"][0]["Execution Time"];
  });
}

const aplicado = process.argv.includes("--aplicado");
try {
  // Una sola foto de los datos para el antes y el después: otros agentes
  // escriben en dev al mismo tiempo.
  await db.q("begin isolation level repeatable read");
  const antes = aplicado ? null : await foto();
  const tAntes = aplicado ? null : await tiempo();
  if (!aplicado) {
    const sql = readFileSync(path.join(RAIZ, "sql/post-junta-2/71-caja-politicas-rapidas.sql"), "utf8").replace(/\r/g, "").replace(/^\s*(begin|commit);\s*$/gim, "");
    await db.q(sql);
  }
  const despues = await foto();
  const tDespues = await tiempo();
  for (const clave of Object.keys(ids)) {
    const d = despues[clave];
    nota(`${clave}: caja_clubs_visibles = antros donde caja_puede_ver`, d.conjunto === d.visibles, `${d.conjunto?.split(",").filter(Boolean).length ?? "error"} vs ${d.visibles.split(",").filter(Boolean).length}`);
    if (antes) {
      const a = antes[clave];
      const distintas = TABLAS.filter((t) => a.filas[t] !== d.filas[t]);
      nota(`${clave}: ve las mismas filas de caja antes y después`, distintas.length === 0, distintas.map((t) => `${t} ${a.filas[t]}→${d.filas[t]}`).join(", ") || TABLAS.map((t) => d.filas[t]).reduce((x, y) => x + y, 0) + " filas");
      const puede = d.visibles.split(",").includes(CLUB);
      nota(`${clave}: firma de la noche ${puede ? "igual" : "NULL (sin permiso)"}`, puede ? a.firma === d.firma && d.firma !== null : d.firma === null, `antes ${a.firma ? "md5" : a.firma} después ${d.firma ? "md5" : d.firma}`);
    }
  }
  console.log(`\nTiempo de leer los consumos de la noche como staff: ${tAntes != null ? tAntes.toFixed(2) + " ms antes, " : ""}${tDespues?.toFixed(2)} ms después`);
  if (tAntes != null && tDespues != null) nota("más rápido después", tDespues <= tAntes, `${tAntes.toFixed(2)} → ${tDespues.toFixed(2)} ms`);
} finally {
  await db.q("rollback").catch(() => {});
  await db.fin();
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}${aplicado ? "" : " (todo se deshizo: las políticas de dev no cambiaron)"}`);
process.exit(pasan === resultados.length ? 0 : 1);
