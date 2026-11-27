// SOLO DEV. Ensayo del pase 3 PASO A PASO, en el orden de docs/pase-3.md,
// con el rollback de CADA paso probado.
//
//   node scripts/dev/ensayo-pase3-paso-a-paso.mjs [--solo=P3-10,P3-20]
//
// 1. Revierte toda la cadena de sql/post-junta-3/ (rollbacks en orden
//    inverso): dev queda como al final del pase 2. Lo compara con la foto del
//    final del ensayo del pase 2 (backups/ensayo-pase2-paso-a-paso/esquema-R1-2.sql).
// 2. Para cada paso: foto → aplicar → foto → rollback → foto (IGUAL a la de
//    antes) → aplicar otra vez → foto (IGUAL a la del primer aplicar).
// Al final dev queda con todo el pase 3 aplicado. Requiere dev con el pase 2
// completo, fase 2 incluida (el 80 y el 81 la necesitan).
// Ojo: revertir borra los datos de las tablas nuevas de dev (banderas,
// ventas del POS, alertas, bloqueos, contactos, propinas…).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const conFase2 = !process.argv.includes("--sin-fase2");
// --solo=P3-10,P3-20: repite solo esos pasos sobre el estado actual de dev (sin
// revertir la cadena); sirve para volver a probar un paso corregido.
const SOLO = process.argv.find((a) => a.startsWith("--solo="))?.slice(7).split(",") ?? null;
const DIR = path.join(RAIZ, "backups", "ensayo-pase3-paso-a-paso");
const FINAL_PASE2 = path.join(RAIZ, "backups", "ensayo-pase2-paso-a-paso", "esquema-R1-2.sql");
mkdirSync(DIR, { recursive: true });

// Orden de docs/pase-3.md. [clave, archivo(s) sin .sql]
const PASOS = [
  ["P3-00", "post-junta-3/00-funciones-club"],
  ["P3-01", "post-junta-3/01-largos-texto"],
  ["P3-02", "post-junta-3/02-ip-cliente"],
  ["P3-10", "post-junta-3/10-pos-ventas"],
  ["P3-20", "post-junta-3/20-escaner-respaldo"],
  ["P3-30", "post-junta-3/30-antifraude-rps"],
  ["P3-40", "post-junta-3/40-lista-negra"],
  ["P3-50", "post-junta-3/50-para-clubes"], // después del 02 (usa ip_cliente)
  ["P3-60", "post-junta-3/60-whatsapp-plantillas"], // después del 40
  ["P3-70", "post-junta-3/70-reportes-pdf"],
  ...(conFase2 ? [["P3-80", "post-junta-3/80-inventario"], ["P3-81", "post-junta-3/81-propinas"]] : []),
];

const seg = (t0) => (performance.now() - t0) / 1000;
function correr(args) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: RAIZ });
  if (r.status !== 0) throw new Error((r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | "));
  return r.stdout;
}
function foto(nombre, origen = "dev") {
  const salida = path.join(DIR, `esquema-${nombre}.sql`);
  correr([path.join(RAIZ, "scripts/db/extraer-esquema.mjs"), `--origen=${origen}`, `--salida=${salida}`]);
  return readFileSync(salida, "utf8").replace(/\r/g, "").split("\n").filter((l) => !/^-- (Esquema de AntroApp|Extraído|Fecha|Origen|Generado)/i.test(l));
}
const igual = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
const dif = (a, b) => {
  const sa = new Set(a), sb = new Set(b);
  return [...a.filter((l) => !sb.has(l)).slice(0, 4).map((l) => "- " + l), ...b.filter((l) => !sa.has(l)).slice(0, 4).map((l) => "+ " + l)].map((l) => l.slice(0, 150));
};
// Sentencias sueltas de un archivo sin transacción (los de CONCURRENTLY).
const sentencias = (archivo) => readFileSync(path.join(RAIZ, "sql", archivo + ".sql"), "utf8").replace(/\r/g, "")
  .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

async function aplicar(archivo) {
  const t0 = performance.now();
  if (archivo.endsWith("70-indices-prod") || archivo.endsWith("70-indices-prod-rollback")) {
    const db = await conectarDevEscritura();
    try { for (const s of sentencias(archivo)) await db.q(s); } finally { await db.fin(); }
  } else {
    correr([path.join(RAIZ, "scripts/db/aplicar-dev.mjs"), path.join(RAIZ, "sql", archivo + ".sql")]);
  }
  return seg(t0);
}

const resultados = [];
const tInicio = performance.now();
try {
  let antes;
  if (SOLO) {
    console.log(`-- Solo ${SOLO.join(", ")}, sobre el estado actual de dev`);
    antes = foto("solo-base");
  } else {
    console.log("-- 1. Revertir la cadena del pase 3 (dev queda como al final del pase 2)");
    for (const [, archivo] of [...PASOS].reverse()) await aplicar(archivo + "-rollback");
    const base = foto("base");
    const final2 = readFileSync(FINAL_PASE2, "utf8").replace(/\r/g, "").split("\n").filter((l) => !/^-- (Esquema de AntroApp|Extraído|Fecha|Origen|Generado)/i.test(l));
    const d = dif(final2, base);
    console.log(igual(base, final2) ? "Base = final del pase 2 (idéntico)." : `Base vs final del pase 2: diferencias`);
    for (const l of d) console.log("   " + l);
    antes = base;
  }

  console.log("\n-- 2. Paso a paso");
  for (const [clave, archivo] of PASOS.filter(([c]) => !SOLO || SOLO.includes(c))) {
    const r = { clave, archivo, ok: false };
    try {
      // Con --solo, dev ya trae el paso: primero su rollback para partir del "antes".
      if (SOLO) { await aplicar(archivo + "-rollback"); antes = foto(clave + "-antes"); }
      r.aplicar = await aplicar(archivo);
      const despues = foto(clave + "-1");
      r.cambia = !igual(antes, despues);
      r.rollback = await aplicar(archivo + "-rollback");
      const tras = foto(clave + "-rb");
      r.rollbackExacto = igual(antes, tras);
      if (!r.rollbackExacto) r.difRollback = dif(antes, tras);
      r.reaplicar = await aplicar(archivo);
      const final = foto(clave + "-2");
      r.reaplicaIgual = igual(despues, final);
      if (!r.reaplicaIgual) r.difReaplicar = dif(despues, final);
      r.ok = r.cambia && r.rollbackExacto && r.reaplicaIgual;
      antes = final;
    } catch (e) {
      r.error = e.message.slice(0, 300);
      resultados.push(r);
      console.log(`FALLA ${clave.padEnd(5)} ${archivo}: ${r.error}`);
      break; // no seguir sobre un paso roto
    }
    resultados.push(r);
    console.log(`${r.ok ? "OK   " : "REVISAR"} ${clave.padEnd(5)} ${archivo.padEnd(50)} aplicar ${r.aplicar.toFixed(1)} s · rollback ${r.rollback.toFixed(1)} s ${r.rollbackExacto ? "exacto" : "NO EXACTO"} · reaplicar ${r.reaplicaIgual ? "igual" : "DISTINTO"}${r.cambia ? "" : " · NO CAMBIÓ NADA"}`);
    for (const l of [...(r.difRollback ?? []), ...(r.difReaplicar ?? [])]) console.log("        " + l);
  }
  // Q22 (40) se probó con el 41 ya revertido; el estado final es el de siempre.
} finally {
  writeFileSync(path.join(DIR, "resultados.json"), JSON.stringify(resultados, null, 1));
}
const ok = resultados.filter((r) => r.ok).length;
const total = SOLO ? SOLO.length : PASOS.length;
console.log(`\nResultado: ${ok}/${total} pasos con rollback exacto y reaplicación igual. Tiempo total del ensayo: ${(seg(tInicio) / 60).toFixed(1)} min.`);
console.log(`Suma de las primeras aplicaciones (dev, por script): ${resultados.reduce((s, r) => s + (r.aplicar ?? 0), 0).toFixed(1)} s. Detalle: backups/ensayo-pase2-paso-a-paso/resultados.json`);
process.exit(ok === total ? 0 : 1);
