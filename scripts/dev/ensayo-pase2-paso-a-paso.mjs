// SOLO DEV. Ensayo del pase 2 PASO A PASO, en el orden de docs/pase-2.md,
// con el rollback de CADA paso probado.
//
//   node scripts/dev/ensayo-pase2-paso-a-paso.mjs [--sin-fase2]
//
// 1. Revierte toda la cadena (scripts/dev/ensayo-pase2.mjs revertir): dev
//    queda con el esquema de producción. Lo compara con el catálogo de
//    producción (solo lectura).
// 2. Para cada paso: foto del esquema → aplicar → foto → rollback → foto
//    (debe ser IGUAL a la de antes del paso) → aplicar otra vez → foto (debe
//    ser IGUAL a la del primer aplicar). Cronometra cada aplicación.
// 3. Q23 usa la versión de PRODUCCIÓN de los índices
//    (70-indices-prod.sql, CONCURRENTLY): una sentencia a la vez, fuera de
//    transacción, igual que se pegaría en el SQL Editor; su rollback también.
// 4. Q10b (sql/post-junta-3/02-ip-cliente.sql) va justo después del Q10 y
//    además se verifica por catálogo (la consulta de docs/pase-2.md, «Q10b»):
//    aplicado, revertido (huella del 66) y reaplicado, y otra vez al final.
// Al final dev queda con todo el pase 2 aplicado (como antes de correrlo).
// Ojo: revertir borra los datos de las tablas nuevas de dev.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const conFase2 = !process.argv.includes("--sin-fase2");
// --solo=Q1,Q2: repite solo esos pasos sobre el estado actual de dev (sin
// revertir la cadena); sirve para volver a probar un paso corregido.
const SOLO = process.argv.find((a) => a.startsWith("--solo="))?.slice(7).split(",") ?? null;
const DIR = path.join(RAIZ, "backups", "ensayo-pase2-paso-a-paso");
mkdirSync(DIR, { recursive: true });

// Orden de docs/pase-2.md. [clave, archivo(s) sin .sql]
const PASOS = [
  ["P1", "post-junta/01-alta-club"],
  ["P2", "post-junta/02-baja-personal"],
  ["P3", "post-junta/03-actividad"],
  ["P4", "post-junta/04-antiabuso"],
  ["P5", "post-junta/05-legales"],
  ["P6", "post-junta/06-mensualidad"],
  ["P7", "post-junta/07-config-rp"],
  ["P8", "post-junta/08-revision-seguridad"],
  ["P9", "post-junta/10-autorizacion-sin-nulos"],
  ["P10", "post-junta/11-alertas"],
  ...(conFase2 ? [["P11a", "fase2/2026-11-21-inventario-propinas"], ["P11b", "post-junta/09-catalogo-csv"]] : []),
  ["P12", "post-junta/12-higiene-permisos"],
  ["Q1", "post-junta-2/60-autorizacion-nulos-c"],
  ["Q2", "post-junta-2/61-sesion-sin-acceso"],
  ["Q3", "post-junta-2/62-clubs-dueno-valido"],
  ["Q4", "post-junta-2/63-bucket-fotos-limites"],
  ["Q5", "post-junta-2/64-rp-del-club"],
  ["Q6", "post-junta-2/65-concurrencia-puerta-cobro"],
  ["Q7", "post-junta-2/67-club-photos-listar"],
  ["Q8", "post-junta-2/68-un-antro-por-dueno-candado"],
  ["Q9", "post-junta-2/72-reservas-antiabuso"],
  ["Q10", "post-junta-2/66-reservas-antiabuso-concurrencia"],
  ["Q10b", "post-junta-3/02-ip-cliente"], // IP real en los topes del 72/66 (verificación abajo)
  ["Q11", "post-junta-2/10-alta-club-reglas"],
  ["Q12", "post-junta-2/11-clonar-club"],
  ["Q13", "post-junta-2/12-config-grupo"],
  ["Q14", "post-junta-2/20-correos-salida"],
  ["Q15", "post-junta-2/21-invitaciones"],
  ["Q16", "post-junta-2/22-importar-mesas"],
  ["Q17", "post-junta-2/23-importar-personal"],
  ["Q18", "post-junta-2/24-invitaciones-cupos"],
  ["Q19", "post-junta-2/30-cierre-noche"],
  ["Q20", "post-junta-2/31-exportes"],
  ["Q21", "post-junta-2/32-salud"],
  ["Q22", "post-junta-2/40-boleto-estado"],
  ["Q23", "post-junta-2/70-indices-prod"], // una sentencia a la vez
  ["Q24", "post-junta-2/71-caja-politicas-rapidas"],
  // (P13: merge del código; en dev el código ya es el de post-junta-2)
  ["R1", "post-junta-2/41-rp-visibilidad"],
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

// Verificación por catálogo de pasos puntuales (la misma consulta que
// docs/pase-2.md pide correr en producción). Cada una devuelve una lista de
// fallas (vacía = bien) para el estado "aplicado" o "revertido".
const VERIFICAR_Q10B = `
  select p.proname as funcion,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
         position('public.ip_cliente()' in pg_get_functiondef(p.oid)) > 0 as usa_ip_cliente,
         (select count(*)::int from pg_trigger t
           where t.tgfoid = p.oid and t.tgrelid = 'public.reservations'::regclass and not t.tgisinternal) as triggers_en_reservations,
         md5(pg_get_functiondef(p.oid)) as huella
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('ip_cliente', 'reservations_antiabuso_anon')
   order by 1`;
// Huellas de docs/pase-2.md («Q10b»).
const HUELLA = { ip_cliente: "336e7ed649f30e72f38c40ca18d71408", antiabusoCon02: "00ffb63bcff2c6b029ebe90938268614", antiabuso66: "9aba03eb4e1be96e8f3c9c548ec47fe3" };
const VERIFICAR = {
  async Q10b(estado) {
    const db = await conectarDevEscritura();
    let filas;
    try { filas = await db.q(VERIFICAR_Q10B); } finally { await db.fin(); }
    const f = Object.fromEntries(filas.map((x) => [x.funcion, x]));
    const fallas = [];
    const anti = f.reservations_antiabuso_anon;
    if (!anti) return ["no existe reservations_antiabuso_anon"];
    if (anti.anon || anti.authenticated) fallas.push("anon o authenticated ejecutan reservations_antiabuso_anon");
    if (anti.triggers_en_reservations !== 1) fallas.push(`reservations_antiabuso_anon con ${anti.triggers_en_reservations} triggers (debe ser 1)`);
    if (estado === "aplicado") {
      if (!f.ip_cliente) fallas.push("no existe ip_cliente");
      else {
        if (f.ip_cliente.anon || f.ip_cliente.authenticated) fallas.push("anon o authenticated ejecutan ip_cliente");
        if (f.ip_cliente.huella !== HUELLA.ip_cliente) fallas.push(`huella de ip_cliente ${f.ip_cliente.huella}`);
      }
      if (!anti.usa_ip_cliente) fallas.push("reservations_antiabuso_anon no usa ip_cliente");
      if (anti.huella !== HUELLA.antiabusoCon02) fallas.push(`huella de reservations_antiabuso_anon ${anti.huella}`);
    } else {
      if (f.ip_cliente) fallas.push("ip_cliente sigue existiendo");
      if (anti.usa_ip_cliente) fallas.push("reservations_antiabuso_anon sigue usando ip_cliente");
      if (anti.huella !== HUELLA.antiabuso66) fallas.push(`huella de reservations_antiabuso_anon ${anti.huella} (debe ser la del 66)`);
    }
    return fallas;
  },
};

const resultados = [];
const tInicio = performance.now();
try {
  let antes;
  if (SOLO) {
    console.log(`-- Solo ${SOLO.join(", ")}, sobre el estado actual de dev`);
    antes = foto("solo-base");
  } else {
    console.log("-- 1. Revertir toda la cadena (dev queda como producción)");
    correr([path.join(RAIZ, "scripts/dev/ensayo-pase2.mjs"), "revertir"]);
    const base = foto("base");
    const prod = foto("prod", "prod");
    const d = dif(base, prod);
    const soloGrants = d.every((l) => /grant .* to service_role;|clubs_candado_zona_horaria|-- Resumen/.test(l));
    console.log(igual(base, prod) ? "Base = producción." : `Base vs producción: ${d.length ? "diferencias" : ""}${soloGrants ? " (solo GRANT a service_role / función de trigger: privilegios por defecto de cada proyecto)" : ""}`);
    if (!soloGrants) for (const l of d) console.log("   " + l);
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
      if (VERIFICAR[clave]) {
        // Se repite el ciclo para verificar cada estado por catálogo.
        r.verificacion = [];
        r.verificacion.push(...(await VERIFICAR[clave]("aplicado")).map((x) => "aplicado: " + x));
        await aplicar(archivo + "-rollback");
        r.verificacion.push(...(await VERIFICAR[clave]("revertido")).map((x) => "revertido: " + x));
        await aplicar(archivo);
        r.verificacion.push(...(await VERIFICAR[clave]("aplicado")).map((x) => "reaplicado: " + x));
        if (!igual(final, foto(clave + "-3"))) r.verificacion.push("el esquema no quedó igual tras la verificación");
      }
      r.ok = r.cambia && r.rollbackExacto && r.reaplicaIgual && !(r.verificacion?.length);
      antes = final;
    } catch (e) {
      r.error = e.message.slice(0, 300);
      resultados.push(r);
      console.log(`FALLA ${clave.padEnd(5)} ${archivo}: ${r.error}`);
      break; // no seguir sobre un paso roto
    }
    resultados.push(r);
    console.log(`${r.ok ? "OK   " : "REVISAR"} ${clave.padEnd(5)} ${archivo.padEnd(50)} aplicar ${r.aplicar.toFixed(1)} s · rollback ${r.rollback.toFixed(1)} s ${r.rollbackExacto ? "exacto" : "NO EXACTO"} · reaplicar ${r.reaplicaIgual ? "igual" : "DISTINTO"}${r.cambia ? "" : " · NO CAMBIÓ NADA"}`);
    if (r.verificacion) console.log(`        verificación por catálogo: ${r.verificacion.length ? r.verificacion.join("; ") : "aplicado, revertido y reaplicado bien (huellas de docs/pase-2.md)"}`);
    for (const l of [...(r.difRollback ?? []), ...(r.difReaplicar ?? [])]) console.log("        " + l);
  }
  // Q10b al final: nada de lo que va después del Q10b lo cambia.
  if (!SOLO || SOLO.includes("Q10b")) {
    const fallas = resultados.length === PASOS.length || SOLO ? await VERIFICAR.Q10b("aplicado") : ["el ensayo no llegó al final"];
    console.log(`\nQ10b al final del pase 2: ${fallas.length ? "FALLA " + fallas.join("; ") : "intacto (mismas huellas)"}`);
    if (fallas.length) process.exitCode = 1;
  }
  // Q22 (40) se probó con el 41 ya revertido; el estado final es el de siempre.
} finally {
  writeFileSync(path.join(DIR, "resultados.json"), JSON.stringify(resultados, null, 1));
}
const ok = resultados.filter((r) => r.ok).length;
const total = SOLO ? SOLO.length : PASOS.length;
console.log(`\nResultado: ${ok}/${total} pasos con rollback exacto y reaplicación igual. Tiempo total del ensayo: ${(seg(tInicio) / 60).toFixed(1)} min.`);
console.log(`Suma de las primeras aplicaciones (dev, por script): ${resultados.reduce((s, r) => s + (r.aplicar ?? 0), 0).toFixed(1)} s. Detalle: backups/ensayo-pase2-paso-a-paso/resultados.json`);
process.exit(ok === total && !process.exitCode ? 0 : 1);
