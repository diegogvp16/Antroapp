// Pruebas de la importación del catálogo por CSV (fase 2):
// lib/domain/catalogo-csv.ts (sin base) y producto_importar
// (sql/post-junta/09-catalogo-csv.sql) contra antroapp-dev.
//
//   node scripts/dev/probar-catalogo-csv.mjs
//
// Crea su propio antro con gerente, staff y dueño, y lo borra al final.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";
import { leerCatalogoCsv, partirLinea, pesosACentavos } from "../../lib/domain/catalogo-csv.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const TAG = "csv" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const ids = [];
let clubId = null;
async function cuenta(clave, role, club) {
  const email = `${TAG}_${clave}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  ids.push(u.data.user.id);
  await svc.from("profiles").insert({ id: u.data.user.id, nombre: `${clave} ${TAG}`, role, club_id: club });
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  await c.auth.signInWithPassword({ email, password: PASS });
  return { id: u.data.user.id, c };
}

try {
  // ---------- Lector de CSV ----------
  revisar(pesosACentavos("350") === 35000 && pesosACentavos("1,250.50") === 125050 && pesosACentavos("$90") === 9000 && pesosACentavos("12,5") === null, "precios en pesos a centavos");
  revisar(partirLinea('"Whisky, 750 ml",Botellas,"1,250.50"', ",").join("|") === "Whisky, 750 ml|Botellas|1,250.50", "campos entre comillas con comas");
  const a = leerCatalogoCsv("nombre,categoría,precio,mínimo,existencias\nTequila Reposado,Botellas,1800,3,12\nCerveza,Cervezas,90\n\n");
  revisar(a.errores.length === 0 && a.filas.length === 2 && a.filas[1].existencias === 0 && a.filas[0].precio_centavos === 180000, "encabezado opcional y columnas opcionales");
  const b = leerCatalogoCsv("Ron;Botellas;12,5;2\nVodka;Botellas;950.5;1;4");
  revisar(b.filas.length === 1 && b.errores[0]?.startsWith("Línea 1"), "punto y coma; precio con coma decimal se rechaza en su línea", JSON.stringify(b.errores));
  const t = leerCatalogoCsv("Mezcal\tBotellas\t1500\nmezcal\tBotellas\t1600");
  revisar(t.filas.length === 1 && /ya viene en la línea 1/.test(t.errores[0] ?? ""), "tabulador (hoja de cálculo) y nombres repetidos");
  const m = leerCatalogoCsv("Agua,Sin alcohol,0\n,X,10\nPapas,Botanas,50,-1");
  revisar(m.errores.length === 3 && m.filas.length === 0, "precio 0, nombre vacío y mínimo negativo se rechazan");
  revisar(leerCatalogoCsv(Array.from({ length: 501 }, (_, i) => `P${i},C,10`).join("\n")).errores.some((e) => /Máximo 500/.test(e)), "máximo 500 productos");

  // ---------- producto_importar ----------
  const dueno = await cuenta("dueno", "dueno", null);
  const { data: club } = await svc.from("clubs").insert({ nombre: `Antro ${TAG}`, direccion: "Calle 1", horario: "Vie", dueno_id: dueno.id }).select("id").single();
  clubId = club.id;
  const gerente = await cuenta("gerente", "gerente", clubId);
  const staff = await cuenta("staff", "staff", clubId);
  const otro = await cuenta("gerente_otro", "gerente", null);
  const imp = (s, filas) => s.c.rpc("producto_importar", { p_club_id: clubId, p_filas: filas });
  revisar(/Solo el gerente o el dueño/.test((await imp(staff, a.filas)).error?.message ?? ""), "el staff no importa");
  revisar(!!(await imp(otro, a.filas)).error, "un gerente sin este antro no importa");
  const r1 = await imp(gerente, a.filas);
  revisar(!r1.error && r1.data.creados === 2 && r1.data.actualizados === 0, "el gerente importa 2 productos nuevos", JSON.stringify(r1.error ?? r1.data));
  const { data: teq } = await svc.from("productos").select("id, existencias, precio_centavos").eq("club_id", clubId).eq("nombre", "Tequila Reposado").maybeSingle();
  const { data: mov } = await svc.from("producto_movimientos").select("tipo, cantidad").eq("producto_id", teq?.id);
  revisar(teq?.existencias === 12 && mov?.length === 1 && mov[0].tipo === "alta" && mov[0].cantidad === 12, "existencias iniciales con su movimiento «alta»");
  const r2 = await imp(dueno, leerCatalogoCsv("TEQUILA REPOSADO,Botellas premium,1950,5,999\nMezcal,Botellas,1500,2,6").filas);
  const { data: teq2 } = await svc.from("productos").select("existencias, precio_centavos, categoria, existencias_minimas").eq("id", teq?.id).maybeSingle();
  revisar(!r2.error && r2.data.creados === 1 && r2.data.actualizados === 1, "el dueño importa: 1 nuevo y 1 actualizado (mismo nombre, sin importar mayúsculas)");
  revisar(teq2?.precio_centavos === 195000 && teq2.categoria === "Botellas premium" && teq2.existencias_minimas === 5 && teq2.existencias === 12, "actualizar cambia precio, categoría y mínimo, NO las existencias");
  const antes = (await svc.from("productos").select("id").eq("club_id", clubId)).data.length;
  const malo = await imp(gerente, [{ nombre: "Nuevo Bueno", categoria: "X", precio_centavos: 1000 }, { nombre: "Malo", categoria: "X", precio_centavos: 0 }]);
  const despues = (await svc.from("productos").select("id").eq("club_id", clubId)).data.length;
  revisar(/Fila 2/.test(malo.error?.message ?? "") && antes === despues, "una fila mala: no entra ninguna y el error dice cuál", malo.error?.message);
  revisar(!!(await imp(gerente, Array.from({ length: 501 }, (_, i) => ({ nombre: "P" + i, categoria: "C", precio_centavos: 100 })))).error, "la base también limita a 500");
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  revisar(!!(await anon.rpc("producto_importar", { p_club_id: clubId, p_filas: a.filas })).error, "anónimo no importa");
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    if (clubId) {
      await db.q("delete from public.producto_movimientos where club_id = $1", [clubId]);
      await db.q("delete from public.productos where club_id = $1", [clubId]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = $1", [clubId]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza falló: " + e.message);
  } finally {
    await db.fin();
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  console.log(`\nLimpieza: antro y ${ids.length} cuentas de prueba borrados.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
