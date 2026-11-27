// SOLO DEV. Carga de las ventas del POS como GERENTE, por la API (PostgREST),
// con el statement_timeout real del rol authenticated (8 s en Supabase).
//
//   node scripts/dev/probar-pos-carga.mjs
//
// Escenario propio (scripts/dev/pos-escenario-prueba.mjs) llevado a 50 mesas
// con dos grupos por mesa y dos cuentas por grupo en la noche 07/10/2026.
// Archivo de 5,000 líneas (1,000 tickets de 5 líneas, «Mesa N»: usa la llave
// tolerante) y otro de 5,000 que comparte la mitad. Mide preparar, importar,
// volver a ligar, conciliar, tickets, historial y deshacer. Todo se borra al final.
import { importarTs } from "./cargar-ts.mjs";
import { crearEscenario, NOCHE } from "./pos-escenario-prueba.mjs";

const { leerArchivoPos, huellaArchivo } = await importarTs("../../lib/pos/adaptadores.ts", import.meta.url);
const { normalizarVentas, sugerirMapeo, lineasParaBase } = await importarTs("../../lib/pos/mapeo.ts", import.meta.url);

let pasan = 0, fallan = 0;
function ok(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK   " : "FALLA"}  ${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}
const LIMITE_MS = 8000;
const HOLGURA_MS = 4000; // «con holgura»: la mitad del límite

const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
const dos = (n) => String(n).padStart(2, "0");
function archivo(desde, hasta, mesas) {
  const filas = [["Folio", "Fecha", "Hora", "Mesa", "Producto", "Cant", "Importe"]];
  for (let i = desde; i < hasta; i++) {
    const k = Math.floor(i / 5);
    const mesa = mesas[k % mesas.length];
    const min = 21 * 60 + 30 + (k % 360) + (i % 5); // 21:30 a 03:34
    const dia = min >= 24 * 60 ? "08/10/2026" : "07/10/2026";
    const m = min % (24 * 60);
    filas.push([`C${k}`, dia, `${dos(Math.floor(m / 60))}:${dos(m % 60)}`, /^\d+$/.test(mesa) ? `Mesa ${mesa}` : mesa, `Producto ${i % 37}`, "1", `$${10 + (i % 7)}.50`]);
  }
  return filas.map((f) => f.map(q).join(",")).join("\r\n");
}
async function preparar(texto) {
  const bytes = new TextEncoder().encode(texto);
  const leido = await leerArchivoPos(bytes, "carga.csv");
  if (!leido.ok) throw new Error(leido.error);
  const r = normalizarVentas(leido.tabla, { columnas: sugerirMapeo(leido.tabla.encabezados) });
  return { ventas: r.ventas, conError: r.conError, hash: await huellaArchivo(bytes) };
}
async function medir(nombre, fn) {
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  const error = r?.error ? `${r.error.code} ${r.error.message}` : "";
  ok(!r?.error && ms < LIMITE_MS, `${nombre}: ${ms.toLocaleString("es-MX")} ms (límite 8,000)`, error);
  ok(ms < HOLGURA_MS, `${nombre}: con holgura (< ${HOLGURA_MS.toLocaleString("es-MX")} ms)`, `${ms} ms`);
  return r;
}

const e = await crearEscenario();
const A = e.clubs.A;
try {
  const [cfg] = await e.db.q("select rolconfig from pg_roles where rolname = 'authenticated'");
  ok((cfg.rolconfig ?? []).includes("statement_timeout=8s"), "el rol authenticated de dev tiene statement_timeout=8s", JSON.stringify(cfg.rolconfig));

  // 50 mesas: 1, 2, 3, VIP 1 (del escenario) + 4..49. Dos grupos por mesa y dos cuentas por grupo.
  await e.db.q(`insert into public.club_tables (club_id, numero, capacidad) select $1, g::text, 8 from generate_series(4, 49) g`, [A]);
  const mesas = (await e.db.q("select numero from public.club_tables where club_id = $1 order by numero", [A])).map((x) => x.numero);
  const g = e.usuarios.gerente.id;
  await e.db.q(
    `with t as (select id from public.club_tables where club_id = $1),
          s as (
            insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado, abierta_por, abierta_en, cerrada_por, cerrada_en)
            select $1, $2, t.id, 'cerrada', $3, x.abre, $3, x.cierra
              from t cross join (values (timestamptz '2026-10-07 21:00-06', timestamptz '2026-10-08 00:30-06'),
                                        (timestamptz '2026-10-08 00:40-06', timestamptz '2026-10-08 04:00-06')) x(abre, cierra)
            returning id, abierta_en)
     insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, creada_por, creada_en)
     select $1, s.id, 'walk_in', 'Carga ' || n || ' t_n4_pos', $3, s.abierta_en + (n || ' minutes')::interval
       from s cross join lateral generate_series(1, case when extract(hour from s.abierta_en at time zone 'America/Mexico_City') = 21 then 1 else 2 end) n`,
    [A, e.noches.A, g],
  );
  const [cuentas] = await e.db.q("select count(*)::int n, count(distinct s.mesa_id)::int mesas from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id where c.club_id = $1", [A]);
  ok(mesas.length === 50 && cuentas.mesas === 50, `escenario: 50 mesas, ${cuentas.n} cuentas en la noche`);

  await e.db.q("insert into public.club_funciones (club_id, funcion, activa) values ($1, 'pos_ventas', true)", [A]);
  const ger = await e.sesion(e.usuarios.gerente.email);

  const f1 = await preparar(archivo(0, 5000, mesas));
  ok(f1.ventas.length === 5000 && f1.conError === 0, "archivo 1: 5,000 líneas válidas");
  const lineas1 = lineasParaBase(f1.ventas);
  const kb = Math.round(JSON.stringify(lineas1).length / 1024);

  const prev = await medir(`pos_preparar 5,000 líneas (${kb} KB)`, () => ger.rpc("pos_preparar", { p_club_id: A, p_lineas: lineas1, p_archivo_hash: f1.hash }));
  const estados = {};
  for (const l of prev.data?.lineas ?? []) estados[l.estado] = (estados[l.estado] ?? 0) + 1;
  console.log("       estados de la vista previa:", JSON.stringify(estados));
  ok((prev.data?.lineas ?? []).length === 5000 && (estados.ligada ?? 0) > 0, "la vista previa liga ventas (llave tolerante «Mesa N»)");

  const imp1 = await medir("pos_importar 5,000 líneas", () =>
    ger.rpc("pos_importar", { p_club_id: A, p_archivo_nombre: "carga-1.csv", p_archivo_hash: f1.hash, p_formato: "csv", p_mapeo_id: null, p_lineas: lineas1 }));
  ok(imp1.data?.nuevas === 5000, "entran las 5,000", JSON.stringify(imp1.data));
  await medir("pos_preparar del mismo archivo (5,000 repetidas)", () => ger.rpc("pos_preparar", { p_club_id: A, p_lineas: lineas1, p_archivo_hash: f1.hash }));
  await medir("pos_religar de la noche (5,000 ventas)", () => ger.rpc("pos_religar", { p_club_id: A, p_fecha: NOCHE }));
  const conc = await medir("pos_conciliacion de la noche", () => ger.rpc("pos_conciliacion", { p_club_id: A, p_fecha: NOCHE }));
  ok((conc.data ?? []).length > 0, `conciliación: ${(conc.data ?? []).length} filas`);
  await medir("pos_tickets de la noche", () => ger.rpc("pos_tickets", { p_club_id: A, p_fecha: NOCHE }));

  // Archivo 2: comparte 2,500 líneas con el 1 y trae 2,500 nuevas.
  const f2 = await preparar(archivo(2500, 7500, mesas));
  const imp2 = await medir("pos_importar 5,000 líneas (2,500 repetidas)", () =>
    ger.rpc("pos_importar", { p_club_id: A, p_archivo_nombre: "carga-2.csv", p_archivo_hash: f2.hash, p_formato: "csv", p_mapeo_id: null, p_lineas: lineasParaBase(f2.ventas) }));
  ok(imp2.data?.nuevas === 2500 && imp2.data?.repetidas === 2500, "entran 2,500 nuevas y 2,500 repetidas", JSON.stringify(imp2.data));
  await medir("pos_importaciones_lista", () => ger.rpc("pos_importaciones_lista", { p_club_id: A }));
  const d = await medir("pos_importacion_deshacer del archivo 1 (2,500 se conservan)", () =>
    ger.rpc("pos_importacion_deshacer", { p_importacion_id: imp1.data.importacion_id, p_motivo: "prueba de carga" }));
  ok(d.data?.borradas === 2500 && d.data?.conservadas === 2500, "deshacer: 2,500 borradas y 2,500 conservadas", JSON.stringify(d.data));
  const [quedan] = await e.db.q("select count(*)::int n from public.pos_ventas where club_id = $1", [A]);
  ok(quedan.n === 5000, "quedan las 5,000 del archivo 2");
} catch (x) {
  ok(false, "la prueba terminó sin excepción", x.stack);
} finally {
  await e.db.q("delete from public.club_funciones where club_id = $1", [A]).catch(() => {});
  const { errores, resto } = await e.limpiar();
  ok(errores.length === 0, "limpieza sin errores", errores.join(" | "));
  ok(resto.usuarios === 0 && resto.clubs === 0 && resto.cuentas === 0 && resto.ventas === 0, "0 restos de prueba", JSON.stringify(resto));
}
console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exit(fallan ? 1 : 0);
