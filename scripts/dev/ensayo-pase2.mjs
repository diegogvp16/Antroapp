// Ensayo del "pase 2" (SQL de sql/post-junta/) en antroapp-dev. SOLO DEV.
//
//   node scripts/dev/ensayo-pase2.mjs revertir   # rollbacks en orden inverso (dev queda como el pase 1)
//   node scripts/dev/ensayo-pase2.mjs aplicar    # aplica en el orden del pase 2, cronometrado
//   node scripts/dev/ensayo-pase2.mjs completo   # foto del esquema, revertir, aplicar, foto y comparar
//
// --sin-fase2: deja fuera el SQL de la fase 2 (sql/fase2/… y 09).
// Ojo: revertir borra los datos de las tablas nuevas de dev (bitácoras,
// catálogo, suscripciones de prueba).

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const conFase2 = !process.argv.includes("--sin-fase2");
// Orden del pase 2 (docs/pase-produccion.md, «Pase 2»).
const PASOS = [
  "post-junta/01-alta-club",
  "post-junta/02-baja-personal",
  "post-junta/03-actividad",
  "post-junta/04-antiabuso",
  "post-junta/05-legales",
  "post-junta/06-mensualidad",
  "post-junta/07-config-rp",
  "post-junta/08-revision-seguridad",
  "post-junta/10-autorizacion-sin-nulos",
  "post-junta/11-alertas",
  ...(conFase2 ? ["fase2/2026-11-21-inventario-propinas", "post-junta/09-catalogo-csv"] : []),
  "post-junta/12-higiene-permisos",
];

function aplicar(archivo) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [path.join(RAIZ, "scripts/db/aplicar-dev.mjs"), path.join(RAIZ, "sql", archivo + ".sql")], { encoding: "utf8" });
  const s = ((performance.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) throw new Error(`${archivo}: ${(r.stdout + r.stderr).trim().split("\n").slice(-2).join(" | ")}`);
  console.log(`OK    ${archivo.padEnd(48)} ${s} s`);
}
function foto(nombre) {
  const dir = path.join(RAIZ, "backups", "ensayo-pase2");
  mkdirSync(dir, { recursive: true });
  const salida = path.join(dir, `esquema-${nombre}.sql`);
  const r = spawnSync(process.execPath, [path.join(RAIZ, "scripts/db/extraer-esquema.mjs"), "--origen=dev", `--salida=${salida}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("extraer: " + r.stderr.slice(0, 200));
  return readFileSync(salida, "utf8").replace(/\r/g, "").split("\n").filter((l) => !/^-- (Esquema de AntroApp|Extraído|Fecha|Origen|Generado)/i.test(l));
}
const revertir = () => [...PASOS].reverse().forEach((p) => aplicar(p.replace(/^post-junta\/(\d+[a-z]?-.*)$/, "post-junta/$1-rollback").replace(/^fase2\/(.*)$/, "fase2/$1-rollback")));

const accion = process.argv[2];
try {
  if (accion === "revertir") revertir();
  else if (accion === "aplicar") PASOS.forEach(aplicar);
  else if (accion === "completo") {
    const antes = foto("antes");
    console.log("-- revertir (orden inverso)");
    revertir();
    const base = foto("base");
    const quedan = base.filter((l) => /club_altas|personal_movimientos|actividad_club|registro_intentos|aceptaciones_legales|suscripciones|reglas_comision|alertas_enviadas|producto_importar|versiones_legales/.test(l));
    console.log(`Esquema base: ${base.length} líneas; restos de post-junta: ${quedan.length}`);
    console.log("-- aplicar (orden del pase 2)");
    PASOS.forEach(aplicar);
    const despues = foto("despues");
    const solo1 = antes.filter((l) => !despues.includes(l));
    const solo2 = despues.filter((l) => !antes.includes(l));
    const identico = antes.join("\n") === despues.join("\n");
    console.log(identico ? "IDÉNTICO: el esquema después de revertir y reaplicar es el mismo." : `DIFERENTE: ${solo1.length} líneas solo antes, ${solo2.length} solo después`);
    for (const l of [...solo1.slice(0, 8).map((x) => "- " + x), ...solo2.slice(0, 8).map((x) => "+ " + x)]) console.log("   " + l.slice(0, 150));
    if (!identico || quedan.length) process.exitCode = 1;
  } else console.log("Uso: node scripts/dev/ensayo-pase2.mjs revertir | aplicar | completo [--sin-fase2]");
} catch (e) {
  console.log("FALLA: " + e.message);
  process.exitCode = 1;
}
