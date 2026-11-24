// Ensayo del pase en antroapp-dev (SOLO DEV: conectarDevEscritura y
// aplicar-dev se niegan contra producción). Sigue docs/pase-produccion.md.
//
//   node scripts/dev/ensayo-pase.mjs a-prod        # rollbacks en orden inverso: dev queda como el catálogo de producción
//   node scripts/dev/ensayo-pase.mjs comparar      # extrae dev y prod (prod en solo lectura) y los compara
//   node scripts/dev/ensayo-pase.mjs diagnosticos  # paso 2 (solo lectura en dev)
//   node scripts/dev/ensayo-pase.mjs paso <n>      # aplica el paso n (2b,3,4,5,6,7,7b,7c,7d,9) y lo verifica
//   node scripts/dev/ensayo-pase.mjs rollback <n>  # revierte el paso n y verifica que quedó revertido
//
// Cada paso imprime cuánto tardó (aplicar + verificar) para el reporte.

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SQL = (f) => path.join(RAIZ, "sql", f);

// Paso → archivos a aplicar, rollback (en orden) y verificación.
const PASOS = {
  "2b": {
    nombre: "el anónimo ya no ejecuta registrar_* (hueco crítico de producción)",
    aplicar: ["2026-11-24-registrar-sin-anon.sql"],
    revertir: ["2026-11-24-registrar-sin-anon-rollback.sql"],
    verificar: `select not has_function_privilege('anon', 'public.registrar_comision_reserva(uuid,uuid,uuid,numeric,timestamptz,timestamptz)', 'execute')
                  and not has_function_privilege('anon', 'public.registrar_pago_dia(uuid,uuid,uuid,date,timestamptz,timestamptz)', 'execute') as ok`,
  },
  3: {
    nombre: "cover",
    aplicar: ["2026-11-20-cover.sql"],
    revertir: ["2026-11-20-cover-rollback.sql"],
    verificar: `select count(*)::int = 2 as ok from information_schema.columns where table_schema = 'public' and table_name = 'clubs' and column_name like 'cover_%'`,
  },
  4: {
    nombre: "caja por mesa",
    aplicar: ["2026-11-20-caja-por-mesa.sql"],
    revertir: ["2026-11-20-caja-por-mesa-rollback.sql"],
    verificar: `select (select count(*) from pg_tables where schemaname = 'public' and tablename in ('caja_noches','mesa_sesiones','mesa_cuentas','caja_consumos','caja_pagos','caja_cuadres','caja_permisos','caja_eventos','grupos','grupo_clubs','grupo_miembros')) = 11
                  and (select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false) = 0 as ok`,
  },
  5: {
    nombre: "estabilidad",
    aplicar: ["2026-11-20-estabilidad.sql"],
    revertir: ["2026-11-20-estabilidad-rollback.sql"],
    verificar: `select (select count(*) from pg_indexes where indexname in ('reservations_una_por_cliente_dia', 'rp_pagos_dia_una_por_asistencia')) = 2
                  and to_regclass('public.login_intentos') is not null and to_regclass('public.app_errores') is not null as ok`,
  },
  6: {
    nombre: "nómina y grupo",
    aplicar: ["2026-11-20-nomina-y-grupo.sql"],
    revertir: ["2026-11-20-nomina-y-grupo-rollback.sql"],
    verificar: `select count(*) = 5 as ok from pg_proc where proname in ('nomina_semana', 'nomina_semana_mia', 'nomina_marcar_pagada', 'nomina_cambiar_estado', 'grupo_resumen')`,
  },
  7: {
    nombre: "panel del RP y permisos de caja",
    aplicar: ["2026-11-21-rp-panel.sql", "2026-11-21-caja-permisos.sql"],
    revertir: ["@drop function if exists public.caja_mis_permisos(uuid);", "2026-11-21-rp-panel-rollback.sql"],
    verificar: `select (select count(*) from pg_proc where proname in ('rp_mis_reservas', 'rp_progreso_cuota', 'rp_nivel_visibilidad', 'soy_rp_dado_de_baja', 'caja_mis_permisos')) = 5
                  and (select count(*) from pg_policies where policyname like '%rp_dado_de_baja') = 2 as ok`,
  },
  "7b": {
    nombre: "caja en condiciones reales y conversión de /grupo",
    aplicar: ["2026-11-21-caja-idempotencia.sql", "2026-11-21-grupo-conversion.sql"],
    revertir: ["2026-11-21-grupo-conversion-rollback.sql", "2026-11-21-caja-idempotencia-rollback.sql"],
    verificar: `select (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'clave_cliente' and table_name in ('caja_consumos', 'caja_pagos')) = 2
                  and (select count(*) from pg_proc where proname in ('caja_firma_noche', 'grupo_rendimiento_rp')) = 2
                  and exists (select 1 from pg_proc where proname = 'grupo_resumen' and pg_get_function_result(oid) like '%reservas_noches_cerradas%') as ok`,
  },
  "7c": {
    nombre: "autorización sin NULL en funciones del pase 1 (10a)",
    aplicar: ["post-junta/10a-pase1-autorizacion-sin-nulos.sql"],
    revertir: ["post-junta/10a-pase1-autorizacion-sin-nulos-rollback.sql"],
    verificar: `select count(*) = 6 as ok from pg_proc where proname in ('caja_tiene_permiso', 'caja_configurar_permiso', 'grupo_rendimiento_rp', 'es_gerente_o_dueno', 'caja_puede_ver', 'puede_ver_club')
                  and (pg_get_functiondef(oid) like '%, false)%' or pg_get_functiondef(oid) like '%v_rol is null or%')`,
  },
  "7d": {
    nombre: "registrar_* con autorización sin NULL",
    aplicar: ["2026-11-24-registrar-sin-nulos.sql"],
    revertir: ["2026-11-24-registrar-sin-nulos-rollback.sql"],
    verificar: `select count(*) = 2 as ok from pg_proc where proname in ('registrar_comision_reserva', 'registrar_pago_dia') and pg_get_functiondef(oid) like '%if not coalesce(public.es_gerente_o_dueno%'`,
  },
  9: {
    nombre: "candado de puerta",
    aplicar: ["2026-11-20-caja-candado-puerta.sql"],
    revertir: ["2026-11-20-caja-candado-puerta-rollback.sql"],
    verificar: `select exists (select 1 from pg_trigger where tgname like '%candado_puerta%') as ok`,
  },
};
const ORDEN = ["2b", "3", "4", "5", "6", "7", "7b", "7c", "7d", "9"];

function aplicarArchivo(archivo) {
  const r = spawnSync(process.execPath, [path.join(RAIZ, "scripts/db/aplicar-dev.mjs"), SQL(archivo)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${archivo}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
}
async function sentencia(db, sql) {
  await db.q("begin");
  try {
    await db.q(sql);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    throw e;
  }
}
async function verificar(db, paso) {
  const [f] = await db.q(PASOS[paso].verificar);
  return f.ok === true;
}

const [accion, arg] = process.argv.slice(2);
const db = await conectarDevEscritura();
try {
  if (accion === "paso" || accion === "rollback") {
    const p = PASOS[arg];
    if (!p) throw new Error(`Paso desconocido: ${arg}`);
    const t0 = performance.now();
    for (const a of accion === "paso" ? p.aplicar : p.revertir) {
      if (a.startsWith("@")) await sentencia(db, a.slice(1));
      else aplicarArchivo(a);
    }
    const t1 = performance.now();
    const ok = await verificar(db, arg);
    const t2 = performance.now();
    const esperado = accion === "paso";
    console.log(`${ok === esperado ? "OK   " : "FALLA"}  ${accion} ${arg} (${p.nombre}): aplicar ${((t1 - t0) / 1000).toFixed(1)} s, verificar ${((t2 - t1) / 1000).toFixed(1)} s — verificación ${ok ? "presente" : "ausente"}`);
    if (ok !== esperado) process.exitCode = 1;
  } else if (accion === "a-prod") {
    for (const paso of [...ORDEN].reverse()) {
      const p = PASOS[paso];
      if (!(await verificar(db, paso))) {
        console.log(`--     paso ${paso} (${p.nombre}) no está aplicado; se salta`);
        continue;
      }
      const t0 = performance.now();
      for (const a of p.revertir) {
        if (a.startsWith("@")) await sentencia(db, a.slice(1));
        else aplicarArchivo(a);
      }
      const ok = !(await verificar(db, paso));
      console.log(`${ok ? "OK   " : "FALLA"}  rollback ${paso} (${p.nombre}) en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      if (!ok) throw new Error(`El rollback del paso ${paso} no quedó`);
    }
  } else if (accion === "comparar") {
    const dir = path.join(RAIZ, "backups", "ensayo-pase");
    mkdirSync(dir, { recursive: true });
    for (const origen of ["dev", "prod"]) {
      const r = spawnSync(process.execPath, [path.join(RAIZ, "scripts/db/extraer-esquema.mjs"), `--origen=${origen}`, `--salida=${path.join(dir, `esquema-${origen}.sql`)}`], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`extraer ${origen}: ${r.stderr.slice(0, 200)}`);
    }
    const limpiar = (t) => t.replace(/\r/g, "").split("\n").filter((l) => !/^-- (Esquema de AntroApp|Extraído|Fecha|Origen|Generado)/i.test(l));
    const a = limpiar(readFileSync(path.join(dir, "esquema-dev.sql"), "utf8"));
    const b = limpiar(readFileSync(path.join(dir, "esquema-prod.sql"), "utf8"));
    const soloDev = a.filter((l) => !b.includes(l));
    const soloProd = b.filter((l) => !a.includes(l));
    console.log(`dev: ${a.length} líneas · prod: ${b.length} líneas · solo en dev: ${soloDev.length} · solo en prod: ${soloProd.length}`);
    for (const l of soloDev.slice(0, 15)) console.log("  + dev  " + l.slice(0, 150));
    for (const l of soloProd.slice(0, 15)) console.log("  - prod " + l.slice(0, 150));
    const identico = a.join("\n") === b.join("\n");
    console.log(identico ? "IDÉNTICO al catálogo de producción" : soloDev.length + soloProd.length === 0 ? "Mismas líneas, distinto orden" : "DIFERENTE");
    if (!identico && soloDev.length + soloProd.length > 0) process.exitCode = 1;
  } else if (accion === "diagnosticos") {
    const consultas = {
      "a) reservas duplicadas por cliente, antro y noche": `select count(*)::int n from (select cliente_id, club_id, fecha from public.reservations where cliente_id is not null and status in ('pendiente','confirmada','usada') group by 1,2,3 having count(*) > 1) x`,
      "b) pagos por día duplicados por asistencia": `select count(*)::int n from (select rp_attendance_id from public.rp_pagos_dia group by 1 having count(*) > 1) x`,
      "c) estados de pagos por día fuera de la lista": `select count(*)::int n from public.rp_pagos_dia where status not in ('pendiente','en_revision','validada','pagada','anulada')`,
      "d) dueños con más de un antro": `select count(*)::int n from (select dueno_id from public.clubs where dueno_id is not null group by 1 having count(*) > 1) x`,
    };
    for (const [que, sql] of Object.entries(consultas)) {
      const [f] = await db.q(sql);
      console.log(`${f.n === 0 ? "OK   " : "FALLA"}  ${que}: ${f.n}`);
      if (f.n !== 0) process.exitCode = 1;
    }
  } else {
    console.log("Uso: node scripts/dev/ensayo-pase.mjs a-prod | comparar | diagnosticos | paso <n> | rollback <n>");
  }
} finally {
  await db.fin();
}
