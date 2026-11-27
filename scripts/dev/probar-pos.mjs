// SOLO DEV. Prueba de sql/post-junta-3/10-pos-ventas.sql con sesiones reales
// de Supabase Auth: autorización por rol, aislamiento entre antros, bandera
// apagada, mapeos, vista previa, importación todo-o-nada e idempotente,
// liga a mesa/cuenta, asignación a mano, volver a ligar, deshacer y
// conciliación; y que la caja, comisiones y nómina NO cambian.
//
//   node scripts/dev/probar-pos.mjs
//
// Usa su propio escenario (scripts/dev/pos-escenario-prueba.mjs: antros,
// cuentas t_n4_pos_* y una noche de caja del 2026-10-07) y lo borra al
// final aunque algo falle. El admin es dev_admin (backups/dev-credenciales.json).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importarTs } from "./cargar-ts.mjs";
import { crearEscenario, NOCHE } from "./pos-escenario-prueba.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const { leerArchivoPos, huellaArchivo } = await importarTs("../../lib/pos/adaptadores.ts", import.meta.url);
const { normalizarVentas, sugerirMapeo, lineasParaBase } = await importarTs("../../lib/pos/mapeo.ts", import.meta.url);

let pasan = 0, fallan = 0;
function ok(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK   " : "FALLA"}  ${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}
const NO_AUTORIZADO = /Solo el gerente, el dueño o el admin/;
const APAGADA = /no está activa para este antro/;

const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
const csvDe = (filas) => filas.map((f) => f.map(q).join(",")).join("\r\n") + "\r\n";
const ENCABEZADO = ["Folio", "Fecha", "Hora", "Mesa", "Comensal", "Producto", "Cant", "Precio", "Importe", "Forma de pago", "Mesero"];
const FILAS = [
  ["T1", "07/10/2026", "23:15", "1", "", "Botella", "1", "$1,500.00", "$1,500.00", "Tarjeta", "Ana"],
  ["T2", "08/10/2026", "01:30", "Mesa 1", "", "Cerveza", "4", "$100.00", "$400.00", "Efectivo", "Ana"],
  ["T2", "08/10/2026", "01:30", "Mesa 1", "", "Shots", "4", "$100.00", "$400.00", "Efectivo", "Ana"],
  ["T3", "08/10/2026", "02:00", "01", "Caro t_n4_pos", "Copa", "3", "$150", "$450.00", "", ""],
  ["T4", "08/10/2026", "00:10", "02", "", "Botella", "1", "$1000", "$1,000.00", "", ""],
  ["T4", "08/10/2026", "00:40", "02", "", "Refresco", "2", "$100", "$200.00", "", ""],
  ["T5", "07/10/2026", "23:50", "99", "", "Agua", "1", "$50", "$50.00", "", ""],
  ["T6", "08/10/2026", "05:00", "1", "", "Café", "1", "$40", "$40.00", "", ""],
  ["T7", "07/10/2026", "22:30", "", "", "Barra", "2", "$90", "$180.00", "", ""],
  ["T8", "09/10/2026", "23:00", "1", "", "Shot", "1", "$100", "$100.00", "", ""],
  ["T9", "07/10/2026", "23:59", "Mesa VIP 1", "", "Agua", "1", "$60", "$60.00", "", ""],
  ["", "", "", "", "", "TOTAL", "", "", "$4,380.00", "", ""],
];

async function prepararArchivo(texto, nombre = "ventas.csv") {
  const bytes = new TextEncoder().encode(texto);
  const leido = await leerArchivoPos(bytes, nombre);
  if (!leido.ok) throw new Error(leido.error);
  const mapeo = { columnas: sugerirMapeo(leido.tabla.encabezados), formato_fecha: "dmy" };
  const r = normalizarVentas(leido.tabla, mapeo);
  return { r, mapeo, hash: await huellaArchivo(bytes), formato: leido.formato, ventas: r.ventas };
}
const err = (r) => r.error?.message ?? "";
const cod = (r) => r.error?.code ?? "";

const e = await crearEscenario();
const A = e.clubs.A, B = e.clubs.B;
try {
  // ---------- Sesiones ----------
  const s = {};
  for (const [clave, u] of Object.entries(e.usuarios)) s[clave] = await e.sesion(u.email);
  s.admin = await e.sesion(cred.usuarios.admin, cred.password);
  const anon = e.anon();
  const roles = ["admin", "dueno", "gerente"];
  const sinPermiso = ["staff", "rp", "cliente", "gerente_b", "sin_perfil", "gerente_baja"];

  // Caja antes (para probar que el POS no la toca).
  const fotoCaja = async () => (await e.db.q(
    `select (select count(*) || ':' || coalesce(sum(monto_centavos), 0) from public.caja_consumos where club_id = $1) as consumos,
            (select count(*) from public.caja_pagos where club_id = $1) as pagos,
            (select count(*) from public.caja_cuadres where club_id = $1) as cuadres,
            (select count(*) from public.caja_eventos where club_id = $1) as eventos,
            (select count(*) filter (where liquidada_en is not null) || '/' || count(*) from public.mesa_cuentas where club_id = $1) as cuentas,
            (select string_agg(s.id::text || '=' || (public.caja_totales_sesion(s.id)).registrado, ',' order by s.id) from public.mesa_sesiones s where s.club_id = $1) as totales,
            (select count(*) from public.commissions c join public.reservations r on r.id = c.reservation_id where r.club_id = $1) as comisiones,
            (select count(*) from public.rp_pagos_dia where club_id = $1) as pagos_dia`, [A]))[0];
  const cajaAntes = await fotoCaja();

  // ---------- Bandera apagada ----------
  {
    const r = await s.gerente.rpc("pos_mapeos_lista", { p_club_id: A });
    ok(APAGADA.test(err(r)) && cod(r) === "P0001", "bandera apagada: el gerente recibe «no está activa»", err(r));
    const m = await s.gerente.rpc("pos_mis_antros");
    ok(Array.isArray(m.data) && m.data.length === 0, "bandera apagada: pos_mis_antros vacío", JSON.stringify(m));
    const d = await s.dueno.rpc("pos_importar", { p_club_id: A, p_archivo_nombre: "x.csv", p_archivo_hash: "0".repeat(64), p_formato: "csv", p_mapeo_id: null, p_lineas: [] });
    ok(APAGADA.test(err(d)), "bandera apagada: el dueño no importa", err(d));
  }
  // El admin la enciende para A (B queda apagada).
  {
    const r = await s.admin.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "pos_ventas", p_activa: true });
    ok(!r.error, "admin enciende pos_ventas en el antro A", err(r));
  }

  // ---------- Quién puede ----------
  for (const rol of roles) {
    const r = await s[rol].rpc("pos_mapeos_lista", { p_club_id: A });
    ok(!r.error && Array.isArray(r.data), `${rol}: puede usar las ventas del POS de A`, err(r));
    const m = await s[rol].rpc("pos_mis_antros");
    ok((m.data ?? []).some((x) => x.club_id === A), `${rol}: A sale en pos_mis_antros`, JSON.stringify(m.data ?? m.error));
  }
  {
    // La noche en curso es la del antro, en SU zona horaria (Tijuana ≠ centro).
    const m = await s.gerente.rpc("pos_mis_antros");
    const [esperada] = await e.db.q("select public.club_fecha_operacion($1)::text as f", [A]);
    ok(m.data?.[0]?.noche_en_curso === esperada.f, "pos_mis_antros trae la noche en curso del antro (club_fecha_operacion)", JSON.stringify(m.data));
    await e.db.q("begin");
    await e.db.q("update public.clubs set zona_horaria = 'America/Tijuana' where id = $1", [A]);
    const [tj] = await e.db.q("select public.club_fecha_operacion($1)::text as f, ((now() at time zone 'America/Tijuana') - interval '8 hours')::date::text as g", [A]);
    await e.db.q("rollback");
    ok(tj.f === tj.g, "…y con zona de Tijuana usa la hora de Tijuana (club_fecha_operacion)", JSON.stringify(tj));
  }
  for (const rol of sinPermiso) {
    const r = await s[rol].rpc("pos_mapeos_lista", { p_club_id: A });
    ok(NO_AUTORIZADO.test(err(r)) && cod(r) === "P0001", `${rol}: rechazado (P0001)`, `${cod(r)} ${err(r)}`);
    const c = await s[rol].rpc("pos_conciliacion", { p_club_id: A, p_fecha: NOCHE });
    ok(NO_AUTORIZADO.test(err(c)), `${rol}: no ve la conciliación`, err(c));
    const m = await s[rol].rpc("pos_mis_antros");
    ok(!(m.data ?? []).some((x) => x.club_id === A), `${rol}: A no sale en pos_mis_antros`);
  }
  {
    const r = await anon.rpc("pos_mapeos_lista", { p_club_id: A });
    ok(cod(r) === "42501", "anónimo: sin permiso de ejecutar (42501)", `${cod(r)} ${err(r)}`);
    const m = await anon.rpc("pos_mis_antros");
    ok(cod(m) === "42501", "anónimo: pos_mis_antros tampoco", cod(m));
    for (const t of ["pos_ventas", "pos_importaciones", "pos_importacion_lineas", "pos_mapeos"]) {
      const g = await s.gerente.from(t).select("club_id").limit(1);
      const a = await anon.from(t).select("club_id").limit(1);
      ok(cod(g) === "42501" && cod(a) === "42501", `${t}: ni el gerente ni el anónimo la leen directo`, `${cod(g)} / ${cod(a)}`);
    }
    for (const f of ["pos_resolver_lote", "pos_exigir", "pos_puede_usar", "pos_leer_lineas", "funcion_activa"]) {
      const args = { pos_resolver_lote: { p_club_id: A, p_items: [] }, pos_exigir: { p_club_id: A },
        pos_puede_usar: { p_club_id: A }, pos_leer_lineas: { p_club_id: A, p_lineas: [] }, funcion_activa: { p_club_id: A, p_funcion: "pos_ventas" } }[f];
      const r = await s.gerente.rpc(f, args);
      ok(cod(r) === "42501" || cod(r) === "PGRST202", `${f}: interno, el gerente no lo llama`, `${cod(r)} ${err(r)}`);
    }
  }

  // ---------- Mapeos ----------
  let mapeoId = null;
  {
    const config = { columnas: { ticket: "Folio", fecha: "Fecha", hora: "Hora", mesa: "Mesa", total: "Importe" }, formato_fecha: "dmy" };
    const g = await s.gerente.rpc("pos_mapeo_guardar", { p_club_id: A, p_nombre: "Mi POS", p_config: config });
    ok(!g.error && typeof g.data === "string", "gerente guarda un mapeo", err(g));
    mapeoId = g.data;
    const g2 = await s.dueno.rpc("pos_mapeo_guardar", { p_club_id: A, p_nombre: " mi pos ", p_config: { ...config, formato_fecha: "mdy" } });
    ok(g2.data === mapeoId, "mismo nombre (sin mayúsculas ni orillas): se reemplaza, no se duplica");
    const l = await s.admin.rpc("pos_mapeos_lista", { p_club_id: A });
    ok(l.data?.length === 1 && l.data[0].config.formato_fecha === "mdy", "la lista trae el mapeo actualizado", JSON.stringify(l.data));
    for (const [malo, desc] of [[{ columnas: { inventado: "X" } }, "dato que no existe"], [{ columnas: { ticket: "" } }, "columna vacía"], [{ otra: 1, columnas: {} }, "llave extra"],
      [{ columnas: { ticket: "A" }, formato_fecha: "ymd" }, "formato de fecha raro"], [{ columnas: "x" }, "columnas no es objeto"]]) {
      const r = await s.gerente.rpc("pos_mapeo_guardar", { p_club_id: A, p_nombre: "Malo", p_config: malo });
      ok(cod(r) === "P0001", `mapeo inválido rechazado: ${desc}`, err(r));
    }
    const sn = await s.gerente.rpc("pos_mapeo_guardar", { p_club_id: A, p_nombre: "  ", p_config: config });
    ok(cod(sn) === "P0001", "mapeo sin nombre: rechazado");
    const st = await s.staff.rpc("pos_mapeo_guardar", { p_club_id: A, p_nombre: "Del staff", p_config: config });
    ok(NO_AUTORIZADO.test(err(st)), "el staff no guarda mapeos");
    const otro = await s.gerente_b.rpc("pos_mapeo_borrar", { p_mapeo_id: mapeoId });
    ok(NO_AUTORIZADO.test(err(otro)), "gerente de otro antro no borra el mapeo de A", err(otro));
    const tmp = await s.gerente.rpc("pos_mapeo_guardar", { p_club_id: A, p_nombre: "Temporal", p_config: config });
    const bo = await s.gerente.rpc("pos_mapeo_borrar", { p_mapeo_id: tmp.data });
    const l2 = await s.gerente.rpc("pos_mapeos_lista", { p_club_id: A });
    ok(!bo.error && l2.data?.length === 1, "el gerente borra un mapeo de su antro");
  }

  // ---------- Vista previa ----------
  const archivo = csvDe([ENCABEZADO, ...FILAS]);
  const p1 = await prepararArchivo(archivo);
  ok(p1.ventas.length === 11 && p1.r.ignoradas === 1, "dominio: 11 ventas y la fila TOTAL ignorada", `${p1.ventas.length}/${p1.r.ignoradas}`);
  const lineas = lineasParaBase(p1.ventas);
  const prev = await s.gerente.rpc("pos_preparar", { p_club_id: A, p_lineas: lineas, p_archivo_hash: p1.hash });
  ok(!prev.error, "pos_preparar responde", err(prev));
  const porLinea = new Map((prev.data?.lineas ?? []).map((x) => [x.linea, { ...x, candidatos: x.grupo ? prev.data.grupos?.[x.grupo] : undefined }]));
  const L = (ticket, k = 0) => porLinea.get(p1.ventas.filter((v) => v.ticket === ticket)[k]?.linea) ?? {};
  ok(L("T1").estado === "ligada" && L("T1").cuenta_id === e.cuentas.C1 && L("T1").fecha_operacion === NOCHE, "T1 (mesa «1», 23:15) → cuenta de Ana", JSON.stringify(L("T1")));
  ok(L("T2").estado === "varias_sesiones" && !L("T2").sesion_id && L("T2").candidatos?.length === 3,
    "T2 («Mesa 1», 01:30): cae en la tolerancia de dos grupos → no se adivina; candidatas de los dos (3 cuentas)", JSON.stringify(L("T2")));
  ok(L("T3").estado === "ligada" && L("T3").cuenta_id === e.cuentas.C3, "T3 («01», comensal = nombre de la cuenta) → Caro");
  ok(L("T4").cuenta_id === e.cuentas.C4 && L("T4", 1).cuenta_id === e.cuentas.C4, "T4 («02») → Dani, las dos líneas");
  ok(L("T5").estado === "mesa_desconocida", "T5 (mesa 99): mesa desconocida");
  ok(L("T6").estado === "sin_sesion" && L("T6").mesa_id === e.mesas["A:1"] && L("T6").candidatos?.length === 3, "T6 (05:00): la mesa no estaba abierta; candidatas de esa mesa", JSON.stringify(L("T6")));
  ok(L("T7").estado === "sin_mesa", "T7 (sin mesa)");
  ok(L("T8").estado === "sin_noche" && L("T8").fecha_operacion === "2026-10-09", "T8 (otra noche sin caja): sin noche");
  ok(L("T9").estado === "sin_sesion" && L("T9").mesa_numero === "VIP 1", "T9 («Mesa VIP 1») → mesa «VIP 1» (llave tolerante)");
  ok((prev.data?.lineas ?? []).every((x) => x.repetida === false) && prev.data?.archivo_importado_en === null, "nada repetido todavía");
  {
    const r = await s.staff.rpc("pos_preparar", { p_club_id: A, p_lineas: lineas });
    ok(NO_AUTORIZADO.test(err(r)), "staff: no ve la vista previa");
  }

  // ---------- Validación de la base (todo o nada) ----------
  const importar = (sesion, lin, hash, extra = {}) =>
    sesion.rpc("pos_importar", { p_club_id: A, p_archivo_nombre: "ventas.csv", p_archivo_hash: hash, p_formato: "csv", p_mapeo_id: null, p_lineas: lin, ...extra });
  const cuenta = async () => Number((await e.db.q("select count(*) from public.pos_ventas where club_id = $1", [A]))[0].count);
  {
    const casos = [
      [{ ...lineas[0], total_centavos: 12.5 }, /total/],
      [{ ...lineas[0], total_centavos: null }, /total/],
      [{ ...lineas[0], ticket: "" }, /ticket/],
      [{ ...lineas[0], fecha_hora: "2026-02-30T23:00:00" }, /no existe/],
      [{ ...lineas[0], fecha_hora: "2099-01-01T23:00:00" }, /fuera de rango/],
      [{ ...lineas[0], fecha_hora: "25/11/2026" }, /formato/],
      [{ ...lineas[0], cantidad: 0 }, /cantidad/],
      [{ ...lineas[0], producto: "x".repeat(121) }, /más de 120/],
      [{ ...lineas[0], mesa: 5 }, /texto/],
      [{ ...lineas[0], cuenta_id: "no-uuid" }, /cuenta elegida/],
    ];
    for (const [mala, re] of casos) {
      const r = await importar(s.gerente, [...lineas.slice(1), mala], "a".repeat(64));
      ok(cod(r) === "P0001" && re.test(err(r)), `línea mala rechazada (${re.source}) con su número`, err(r));
    }
    const dup = await importar(s.gerente, [lineas[0], { ...lineas[1], linea: lineas[0].linea }], "a".repeat(64));
    ok(/repetidos/.test(err(dup)), "números de línea repetidos: rechazado");
    const vacio = await importar(s.gerente, [], "a".repeat(64));
    ok(/no trae ventas/.test(err(vacio)), "sin líneas: rechazado");
    const hashMalo = await importar(s.gerente, lineas, "xyz");
    ok(/huella/.test(err(hashMalo)), "huella inválida: rechazada");
    const ajena = await importar(s.gerente, lineas.map((x, i) => (i === 1 ? { ...x, cuenta_id: e.cuentas.CB } : x)), "a".repeat(64));
    ok(/Línea \d+: la cuenta elegida no es de esa noche de este antro/.test(err(ajena)), "cuenta de OTRO antro elegida a mano: rechazada", err(ajena));
    const mapeoAjeno = await e.db.q("insert into public.pos_mapeos (club_id, nombre, config) values ($1, 'de B', '{\"columnas\":{}}') returning id", [B]);
    const ma = await importar(s.gerente, lineas, "a".repeat(64), { p_mapeo_id: mapeoAjeno[0].id });
    ok(/no es de este antro/.test(err(ma)), "mapeo de otro antro: rechazado");
    ok((await cuenta()) === 0, "nada de lo rechazado dejó ventas (todo o nada)");
  }

  // ---------- Importar ----------
  const t2 = p1.ventas.filter((v) => v.ticket === "T2").map((v) => v.linea);
  const asignadas = new Map(t2.map((l) => [l, e.cuentas.C2]));
  const lineasConMano = lineasParaBase(p1.ventas, asignadas);
  let impId = null;
  {
    const r = await importar(s.gerente, lineasConMano, p1.hash, { p_mapeo_id: mapeoId });
    ok(!r.error && r.data?.nuevas === 11 && r.data?.repetidas === 0, "importa 11 líneas", err(r) || JSON.stringify(r.data));
    ok(r.data?.ligadas === 6 && r.data?.sin_ligar === 5, "6 ligadas (2 a mano) y 5 sin ligar", JSON.stringify(r.data));
    ok(r.data?.total_centavos === 438000, "total importado = $4,380.00", String(r.data?.total_centavos));
    impId = r.data?.importacion_id;
    const filas = await e.db.q("select linea, liga, estado_liga, cuenta_id from public.pos_ventas where importacion_id = $1 order by linea", [impId]);
    const manual = filas.filter((x) => x.liga === "manual");
    ok(manual.length === 2 && manual.every((x) => x.cuenta_id === e.cuentas.C2 && x.estado_liga === "ligada"), "las de T2 quedan ligadas a mano a Beto");
  }
  {
    const r = await importar(s.dueno, lineasConMano, p1.hash);
    ok(/ya se importó/.test(err(r)), "el MISMO archivo otra vez: rechazado («ya se importó»)", err(r));
    const prev2 = await s.gerente.rpc("pos_preparar", { p_club_id: A, p_lineas: lineas, p_archivo_hash: p1.hash });
    ok(prev2.data?.archivo_importado_en && prev2.data.lineas.every((x) => x.repetida), "la vista previa ya dice «importado» y todas repetidas");
    // Mismo contenido + una línea nueva (otro archivo, otra huella).
    const p2 = await prepararArchivo(csvDe([ENCABEZADO, ...FILAS, ["T10", "08/10/2026", "01:10", "3", "", "Hielo", "1", "$25", "$25.00", "", ""]]));
    const r2 = await importar(s.dueno, lineasParaBase(p2.ventas), p2.hash);
    ok(!r2.error && r2.data?.nuevas === 1 && r2.data?.repetidas === 11, "otro archivo con las mismas líneas + 1: entra solo la nueva", err(r2) || JSON.stringify(r2.data));
    const p3 = await prepararArchivo(csvDe([ENCABEZADO, ...FILAS.slice(0, 4)]));
    const r3 = await importar(s.admin, lineasParaBase(p3.ventas), p3.hash);
    ok(/Todas las líneas/.test(err(r3)), "archivo con puras líneas ya importadas: rechazado, nada nuevo", err(r3));
    // Reordenar las columnas y cambiar el formato: misma venta, misma llave.
    const p4 = await prepararArchivo(["Mesa;Folio;Fecha;Importe;Producto;Cant", "1;T1;07/10/2026 23:15;1500;Botella;1"].join("\n"));
    const r4 = await importar(s.gerente, lineasParaBase(p4.ventas), p4.hash);
    ok(/Todas las líneas/.test(err(r4)), "la misma venta con otro orden de columnas y otro formato de monto: repetida");
    ok((await cuenta()) === 12, "en total 12 ventas en A", String(await cuenta()));
  }
  // Dos importaciones del mismo archivo a la vez: solo una entra.
  {
    const p5 = await prepararArchivo(csvDe([ENCABEZADO, ["T20", "07/10/2026", "23:20", "2", "", "Shot", "1", "$10", "$10.00", "", ""]]));
    const [x, y] = await Promise.all([importar(s.gerente, lineasParaBase(p5.ventas), p5.hash), importar(s.dueno, lineasParaBase(p5.ventas), p5.hash)]);
    const buenas = [x, y].filter((r) => !r.error).length;
    ok(buenas === 1 && [x, y].some((r) => /ya se importó|acaban de importar/.test(err(r))), "dos sesiones importan el mismo archivo a la vez: entra una sola vez", `${err(x)} | ${err(y)}`);
    ok((await cuenta()) === 13, "13 ventas (no 14)");
  }

  // ---------- Conciliación ----------
  const conciliacion = async (sesion = s.gerente) => {
    const r = await sesion.rpc("pos_conciliacion", { p_club_id: A, p_fecha: NOCHE });
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  {
    const c = await conciliacion();
    const de = (cuentaId) => c.find((x) => x.cuenta_id === cuentaId) ?? {};
    ok(de(e.cuentas.C1).estado === "coincide" && Number(de(e.cuentas.C1).caja_centavos) === 150000 && Number(de(e.cuentas.C1).pos_centavos) === 150000, "Ana: caja $1,500 = POS $1,500 → coincide", JSON.stringify(de(e.cuentas.C1)));
    ok(de(e.cuentas.C2).estado === "coincide" && Number(de(e.cuentas.C2).pos_centavos) === 80000 && de(e.cuentas.C2).pos_tickets === 1, "Beto (ligada a mano): coincide, 1 ticket");
    ok(de(e.cuentas.C3).estado === "diferencia" && Number(de(e.cuentas.C3).pos_centavos) === 45000, "Caro: caja $500 vs POS $450 → diferencia");
    ok(de(e.cuentas.C4).estado === "diferencia" && Number(de(e.cuentas.C4).caja_centavos) === 100000 && Number(de(e.cuentas.C4).pos_centavos) === 121000, "Dani: el consumo anulado no cuenta; caja $1,000 vs POS $1,210 (T4 + T20)", JSON.stringify(de(e.cuentas.C4)));
    ok(de(e.cuentas.C5).estado === "diferencia" && Number(de(e.cuentas.C5).pos_centavos) === 2500, "Eli: la línea nueva (T10, mesa 3) se ligó: $700 vs $25", JSON.stringify(de(e.cuentas.C5)));
    const sinMesa = c.filter((x) => x.nivel === "sin_mesa");
    ok(sinMesa.length === 4 && sinMesa.every((x) => x.estado === "solo_pos"), "4 grupos sin cuenta (mesa 1 a las 05:00, VIP 1, «99», sin mesa): solo POS", JSON.stringify(sinMesa));
    ok(!c.some((x) => Number(x.pos_centavos) === 10000 && x.mesa_numero === "1" && x.nivel === "sin_mesa"), "T8 es de otra noche: no sale en esta");
    const ajena = await s.gerente_b.rpc("pos_conciliacion", { p_club_id: A, p_fecha: NOCHE });
    ok(NO_AUTORIZADO.test(err(ajena)), "gerente de B no ve la conciliación de A");
  }

  // ---------- Tickets: asignar, reasignar, quitar ----------
  {
    const p = await s.gerente.rpc("pos_tickets", { p_club_id: A, p_fecha: NOCHE });
    const tickets = (p.data ?? []).filter((x) => !x.cuenta_id).map((x) => x.ticket).sort();
    ok(JSON.stringify(tickets) === JSON.stringify(["T5", "T6", "T7", "T9"]), "tickets sin cuenta de la noche: T5, T6, T7, T9", JSON.stringify(tickets));
    const t3 = p.data.find((x) => x.ticket === "T3");
    ok(t3?.cuenta_id === e.cuentas.C3 && t3?.cliente_nombre === "Caro t_n4_pos" && t3?.liga === "auto", "pos_tickets también trae los ligados, con su cuenta");
    // Reasignar un ticket ligado solo (Caro → Beto) y luego quitarle la cuenta.
    const re = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t3.venta_ids, p_cuenta_id: e.cuentas.C2 });
    let c0 = await conciliacion();
    ok(re.data === 1 && Number(c0.find((x) => x.cuenta_id === e.cuentas.C2)?.pos_centavos) === 125000 && c0.find((x) => x.cuenta_id === e.cuentas.C3)?.estado === "solo_caja",
      "reasignar T3 de Caro a Beto: Beto $1,250 en POS, Caro queda «solo caja»");
    const quita = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t3.venta_ids, p_cuenta_id: null });
    c0 = await conciliacion();
    const [t3b] = await e.db.q("select estado_liga, liga, cuenta_id from public.pos_ventas where club_id = $1 and ticket = 'T3'", [A]);
    ok(quita.data === 1 && t3b.estado_liga === "desligada" && t3b.cuenta_id === null && Number(c0.find((x) => x.cuenta_id === e.cuentas.C2)?.pos_centavos) === 80000,
      "quitar la cuenta: T3 queda «desligada»");
    const vuelve = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t3.venta_ids, p_cuenta_id: e.cuentas.C3 });
    ok(vuelve.data === 1, "y se le vuelve a poner a Caro (a mano)");
    const t6 = p.data.find((x) => x.ticket === "T6");
    const cu = await s.gerente.rpc("pos_cuentas_noche", { p_club_id: A, p_fecha: NOCHE });
    ok(cu.data?.length === 5, "cuentas de la noche para elegir: 5", String(cu.data?.length));
    const a1 = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t6.venta_ids, p_cuenta_id: e.cuentas.C1 });
    ok(a1.data === 1, "asignar T6 a Ana", err(a1));
    let c = await conciliacion();
    ok(c.find((x) => x.cuenta_id === e.cuentas.C1)?.estado === "diferencia", "Ana ahora tiene diferencia ($1,500 vs $1,540)");
    const a2 = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t6.venta_ids, p_cuenta_id: null });
    c = await conciliacion();
    ok(a2.data === 1 && c.find((x) => x.cuenta_id === e.cuentas.C1)?.estado === "coincide", "desligar T6: Ana vuelve a coincidir");
    const ajena = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t6.venta_ids, p_cuenta_id: e.cuentas.CB });
    ok(/no es de esa noche de este antro/.test(err(ajena)), "asignar a una cuenta de OTRO antro: rechazado");
    const [t8] = await e.db.q("select id from public.pos_ventas where club_id = $1 and ticket = 'T8'", [A]);
    const otraNoche = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: [t8.id], p_cuenta_id: e.cuentas.C1 });
    ok(/no es de esa noche/.test(err(otraNoche)), "asignar una venta de otra noche: rechazado");
    const mezcla = await s.gerente.rpc("pos_asignar", { p_club_id: A, p_venta_ids: [t8.id, ...t6.venta_ids], p_cuenta_id: e.cuentas.C1 });
    ok(/noches distintas/.test(err(mezcla)), "ventas de dos noches juntas: rechazado");
    const deB = await s.gerente_b.rpc("pos_asignar", { p_club_id: A, p_venta_ids: t6.venta_ids, p_cuenta_id: e.cuentas.C1 });
    ok(NO_AUTORIZADO.test(err(deB)), "gerente de B no asigna ventas de A");
    const comoB = await s.admin.rpc("pos_asignar", { p_club_id: B, p_venta_ids: t6.venta_ids, p_cuenta_id: e.cuentas.CB });
    ok(APAGADA.test(err(comoB)), "con el club B (bandera apagada) ni el admin");
  }

  // ---------- Volver a ligar ----------
  {
    // Una cuenta nueva en la sesión de Ana (creada antes de T1): T1 deja de ser única.
    const [s1] = await e.db.q("select noche_id from public.mesa_sesiones where id = $1", [e.sesiones.S1]);
    void s1;
    await e.db.q(
      `insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, personas, creada_por, creada_en)
       values ($1, $2, 'walk_in', 'Ana2 t_n4_pos', 2, $3, $4)`,
      [A, e.sesiones.S1, e.usuarios.gerente.id, new Date("2026-10-07T22:30:00-06:00").toISOString()],
    );
    const r = await s.dueno.rpc("pos_religar", { p_club_id: A, p_fecha: NOCHE });
    ok(r.data >= 1, "volver a ligar: cambia al menos una venta", err(r) || String(r.data));
    const [t1] = await e.db.q("select estado_liga, cuenta_id from public.pos_ventas where club_id = $1 and ticket = 'T1'", [A]);
    ok(t1.estado_liga === "varias_cuentas" && t1.cuenta_id === null, "T1 ya no se liga sola (dos cuentas creadas antes de las 23:15)");
    const manual = await e.db.q("select count(*)::int n from public.pos_ventas where club_id = $1 and ticket = 'T2' and liga = 'manual' and cuenta_id = $2", [A, e.cuentas.C2]);
    ok(manual[0].n === 2, "las ligadas a mano no se tocan");
    const [t6] = await e.db.q("select estado_liga from public.pos_ventas where club_id = $1 and ticket = 'T6'", [A]);
    ok(t6.estado_liga === "desligada", "la desligada a mano se queda desligada");
    const r2 = await s.dueno.rpc("pos_religar", { p_club_id: A, p_fecha: NOCHE });
    ok(r2.data === 0, "volver a ligar otra vez: ya no cambia nada (idempotente)", String(r2.data));
  }

  // ---------- La caja no cambió ----------
  {
    const despues = await fotoCaja();
    for (const k of Object.keys(cajaAntes)) {
      // La cuenta nueva de «volver a ligar» la creó la prueba, no el POS.
      if (k === "cuentas") continue;
      ok(String(cajaAntes[k]) === String(despues[k]), `el POS no tocó la caja: ${k}`, `${cajaAntes[k]} → ${despues[k]}`);
    }
  }

  // ---------- Historial y deshacer ----------
  {
    const l = await s.gerente.rpc("pos_importaciones_lista", { p_club_id: A });
    const primera = (l.data ?? []).find((x) => x.id === impId);
    const segunda = (l.data ?? []).find((x) => x.lineas_repetidas === 11);
    ok(l.data?.length === 3 && primera?.lineas_nuevas === 11 && JSON.stringify(primera?.noches) === JSON.stringify(["2026-10-07", "2026-10-09"]) && primera?.importado_por_nombre,
      "historial: 3 importaciones, con noches y quién", JSON.stringify(l.data));
    ok(primera?.lineas_propias === 0 && segunda?.lineas_propias === 1, "lineas_propias: la 1.ª no tiene propias (el 2.º archivo trae las mismas 11); la 2.ª solo T10");
    const st = await s.staff.rpc("pos_importacion_deshacer", { p_importacion_id: impId, p_motivo: "error de mapeo" });
    ok(NO_AUTORIZADO.test(err(st)), "el staff no deshace");
    const gb = await s.gerente_b.rpc("pos_importacion_deshacer", { p_importacion_id: impId, p_motivo: "error de mapeo" });
    ok(NO_AUTORIZADO.test(err(gb)), "gerente de otro antro no deshace");
    const corto = await s.gerente.rpc("pos_importacion_deshacer", { p_importacion_id: impId, p_motivo: "x" });
    ok(/motivo/.test(err(corto)), "sin motivo: rechazado");
    const d = await s.gerente.rpc("pos_importacion_deshacer", { p_importacion_id: impId, p_motivo: "Mapeé mal el total" });
    ok(d.data?.borradas === 0 && d.data?.conservadas === 11, "deshacer la 1.ª: sus 11 líneas también vienen en el 2.º archivo → se conservan (0 borradas)", err(d) || JSON.stringify(d.data));
    const [dueno2] = await e.db.q("select count(*)::int n from public.pos_ventas where club_id = $1 and importacion_id = $2", [A, segunda.id]);
    ok(dueno2.n === 12 && (await cuenta()) === 13, "…y quedan a nombre del 2.º archivo (12 ventas); siguen 13 en total");
    const otraVez = await s.gerente.rpc("pos_importacion_deshacer", { p_importacion_id: impId, p_motivo: "otra vez" });
    ok(/ya se deshizo/.test(err(otraVez)), "deshacer dos veces: rechazado");
    const re0 = await importar(s.gerente, lineasConMano, p1.hash);
    ok(/Todas las líneas/.test(err(re0)), "el 1.er archivo se puede volver a subir, pero sus líneas ya están: nada nuevo");
    const d2 = await s.dueno.rpc("pos_importacion_deshacer", { p_importacion_id: segunda.id, p_motivo: "Deshacer el segundo" });
    ok(d2.data?.borradas === 12 && d2.data?.conservadas === 0 && (await cuenta()) === 1, "deshacer el 2.º: ahora sí se borran sus 12 (nadie más las trae)", JSON.stringify(d2.data));
    const re = await importar(s.gerente, lineasConMano, p1.hash);
    ok(!re.error && re.data?.nuevas === 11, "después de deshacer, el mismo archivo se puede volver a importar", err(re));
    const despues = await fotoCaja();
    ok(despues.consumos === cajaAntes.consumos && despues.totales === cajaAntes.totales, "deshacer e importar de nuevo tampoco tocó la caja");
  }

  // ---------- Deshacer con líneas compartidas (archivo 1 = A,B; archivo 2 = A,B,C) ----------
  {
    const fila = (t, prod) => [t, "07/10/2026", "23:40", "3", "", prod, "1", "$100.00", "$100.00", "", ""];
    const sumaDe = async (pref) => Number((await e.db.q("select coalesce(sum(total_centavos), 0) s from public.pos_ventas where club_id = $1 and ticket like $2", [A, pref + "%"]))[0].s);
    const ab = await prepararArchivo(csvDe([ENCABEZADO, fila("U1", "A"), fila("U2", "B")]));
    const abc = await prepararArchivo(csvDe([ENCABEZADO, fila("U1", "A"), fila("U2", "B"), fila("U3", "C")]));
    const r1 = await importar(s.gerente, lineasParaBase(ab.ventas), ab.hash);
    const r2 = await importar(s.gerente, lineasParaBase(abc.ventas), abc.hash);
    ok(r1.data?.nuevas === 2 && r2.data?.nuevas === 1 && r2.data?.repetidas === 2, "archivo 1 (A,B) y archivo 2 (A,B,C): entran 2 y 1");
    const d = await s.gerente.rpc("pos_importacion_deshacer", { p_importacion_id: r1.data.importacion_id, p_motivo: "prueba de compartidas" });
    ok(d.data?.borradas === 0 && d.data?.conservadas === 2 && (await sumaDe("U")) === 30000,
      "deshacer el archivo 1: A y B pasan al archivo 2; el POS sigue en $300 (antes quedaba en $100)", JSON.stringify(d.data));
    const c = await conciliacion();
    ok(Number(c.find((x) => x.cuenta_id === e.cuentas.C5)?.pos_centavos) === 30000, "…y la conciliación de Eli (mesa 3) dice $300");
    const otra = await importar(s.gerente, lineasParaBase(abc.ventas), abc.hash);
    ok(/ya se importó/.test(err(otra)), "el archivo 2 sigue importado completo: no se vuelve a subir");
    // Al revés: deshacer el archivo grande borra solo lo que nadie más trae.
    const filaW = (t, prod) => [t, "07/10/2026", "23:45", "3", "", prod, "1", "$100.00", "$100.00", "", ""];
    const w12 = await prepararArchivo(csvDe([ENCABEZADO, filaW("W1", "A"), filaW("W2", "B")]));
    const w123 = await prepararArchivo(csvDe([ENCABEZADO, filaW("W1", "A"), filaW("W2", "B"), filaW("W3", "C")]));
    await importar(s.gerente, lineasParaBase(w12.ventas), w12.hash);
    const rw = await importar(s.gerente, lineasParaBase(w123.ventas), w123.hash);
    const dw = await s.gerente.rpc("pos_importacion_deshacer", { p_importacion_id: rw.data.importacion_id, p_motivo: "prueba al revés" });
    ok(dw.data?.borradas === 1 && (await sumaDe("W")) === 20000, "deshacer el archivo grande (A,B,C): solo se borra C; A y B siguen del archivo 1");
    // Deshacer e importar a la vez (mismo candado): sin errores y sin perder ventas.
    const x1 = await prepararArchivo(csvDe([ENCABEZADO, fila("X1", "A")]));
    const x12 = await prepararArchivo(csvDe([ENCABEZADO, fila("X1", "A"), fila("X2", "B")]));
    const rx = await importar(s.gerente, lineasParaBase(x1.ventas), x1.hash);
    const [u, v] = await Promise.all([
      s.dueno.rpc("pos_importacion_deshacer", { p_importacion_id: rx.data.importacion_id, p_motivo: "a la vez" }),
      importar(s.gerente, lineasParaBase(x12.ventas), x12.hash),
    ]);
    ok(!u.error && !v.error && (await sumaDe("X")) === 20000, "deshacer e importar al mismo tiempo: los dos terminan y quedan X1 y X2", `${err(u)} | ${err(v)}`);
  }

  // ---------- Liga por ticket (mesa reutilizada) ----------
  {
    const fila = (t, fecha, hora, mesa, prod) => [t, fecha, hora, mesa, "", prod, "1", "$10.00", "$10.00", "", ""];
    // Escenario de la revisión: VIP 1, grupo 1 de 22:00 a 23:25 (cuadrado 23:30), grupo 2 desde 23:35.
    const g = e.usuarios.gerente.id;
    const local = (x) => new Date(`${x}-06:00`).toISOString();
    const [g1] = await e.db.q(
      `insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado, abierta_por, abierta_en, cerrada_por, cerrada_en, cuadrada_por, cuadrada_en)
       values ($1, $2, $3, 'cuadrada', $4, $5, $4, $6, $4, $7) returning id`,
      [A, e.noches.A, e.mesas["A:VIP 1"], g, local("2026-10-07T22:00:00"), local("2026-10-07T23:25:00"), local("2026-10-07T23:30:00")]);
    const [g2] = await e.db.q(
      `insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado, abierta_por, abierta_en, cerrada_por, cerrada_en)
       values ($1, $2, $3, 'cerrada', $4, $5, $4, $6) returning id`,
      [A, e.noches.A, e.mesas["A:VIP 1"], g, local("2026-10-07T23:35:00"), local("2026-10-08T01:00:00")]);
    const cuenta1 = await e.db.q(`insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, creada_por, creada_en) values ($1, $2, 'walk_in', 'Gina t_n4_pos', $3, $4) returning id`, [A, g1.id, g, local("2026-10-07T22:00:00")]);
    const cuenta2 = await e.db.q(`insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, creada_por, creada_en) values ($1, $2, 'walk_in', 'Hugo t_n4_pos', $3, $4) returning id`, [A, g2.id, g, local("2026-10-07T23:35:00")]);
    const b = await prepararArchivo(csvDe([
      ENCABEZADO,
      fila("T11", "07/10/2026", "23:00", "1", "x1"), fila("T11", "08/10/2026", "02:30", "1", "x2"),
      fila("T12", "08/10/2026", "00:50", "1", "y"),
      fila("T13", "07/10/2026", "23:30", "2", "z1"), fila("T13", "08/10/2026", "01:00", "2", "z2"),
      fila("V1", "07/10/2026", "23:40", "VIP 1", "cierre"),
      fila("V2", "07/10/2026", "22:30", "VIP 1", "v2a"), fila("V2", "07/10/2026", "23:40", "VIP 1", "v2b"),
      fila("V3", "08/10/2026", "01:30", "VIP 1", "tarde"),
      fila("V4", "07/10/2026", "22:30", "VIP 1", "temprano"),
    ]));
    const prev = await s.gerente.rpc("pos_preparar", { p_club_id: A, p_lineas: lineasParaBase(b.ventas) });
    const est = (t) => b.ventas.filter((v) => v.ticket === t).map((v) => ((x) => (x ? { ...x, candidatos: x.grupo ? prev.data.grupos?.[x.grupo] : undefined } : {}))(prev.data?.lineas.find((x) => x.linea === v.linea)));
    ok(est("T11").every((x) => x.estado === "varias_sesiones" && !x.cuenta_id) && est("T11")[0].candidatos?.length === 4,
      "T11: una línea en el grupo 1 y otra en el grupo 2 de la mesa → no se parte el ticket; se elige a mano", JSON.stringify(est("T11")));
    ok(est("T12").every((x) => x.estado === "varias_sesiones"), "T12 (00:50, entre dos grupos dentro de la tolerancia): se elige a mano");
    ok(est("T13").every((x) => x.estado === "ligada" && x.cuenta_id === e.cuentas.C4), "T13: sus dos líneas en el mismo grupo → ligadas juntas a Dani");
    ok(est("V1")[0].estado === "varias_sesiones", "revisión: venta a las 23:40 con grupo 1 recién cuadrado y grupo 2 sentado a las 23:35 → NO se liga sola al grupo 2");
    ok(est("V2").every((x) => x.estado === "varias_sesiones"), "ticket con líneas de las 22:30 y 23:40: no se reparte entre dos grupos");
    ok(est("V3")[0].cuenta_id === cuenta2[0].id && est("V4")[0].cuenta_id === cuenta1[0].id, "lejos del cambio de grupo sí se liga: 01:30 → Hugo, 22:30 → Gina");
  }

  // ---------- La limpieza de la caja no choca con las ventas del POS ----------
  {
    const [antes] = await e.db.q("select count(*)::int total, count(*) filter (where cuenta_id is not null)::int ligadas from public.pos_ventas where club_id = $1", [A]);
    ok(antes.ligadas > 0, `hay ventas ligadas a la caja (${antes.ligadas})`);
    const texto = readFileSync(path.join(RAIZ, "sql/limpiar-demo-caja.sql"), "utf8").replace(/\r\n/g, "\n");
    const sentencias = texto.split("\n").map((l) => l.trim()).filter((l) => /^delete from public\./.test(l))
      .map((l) => l.replace("d2f531df-8116-442e-b967-4a1004fcd02e", A));
    const correr = async (lista) => {
      await e.db.q("begin");
      await e.db.q("set local antroapp.borrado_pruebas = 'on'");
      let fallo = null, fila = null;
      try {
        for (const [sql, args] of lista) await e.db.q(sql, args);
        [fila] = await e.db.q(`select count(*)::int total, count(*) filter (where cuenta_id is not null)::int ligadas,
                                      count(*) filter (where estado_liga = 'caja_borrada')::int borradas,
                                      count(*) filter (where noche_id is not null or sesion_id is not null)::int con_caja
                                 from public.pos_ventas where club_id = $1`, [A]);
      } catch (x) {
        fallo = x.message;
      } finally {
        await e.db.q("rollback");
      }
      return { fallo, fila };
    };
    const r1 = await correr(sentencias.map((q) => [q, []]));
    ok(sentencias.length === 7 && !r1.fallo, "sql/limpiar-demo-caja.sql (con el antro de prueba) corre con ventas ligadas", r1.fallo ?? String(sentencias.length));
    ok(r1.fila?.total === antes.total && r1.fila?.ligadas === 0 && r1.fila?.borradas === antes.ligadas && r1.fila?.con_caja === 0,
      "…las ventas del POS se quedan, sin liga y marcadas «caja_borrada»", JSON.stringify(r1.fila));
    const tablas = ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"];
    const r2 = await correr(tablas.map((t) => [`delete from public.${t} where club_id = any($1::uuid[])`, [[A]]]));
    ok(!r2.fallo && r2.fila?.ligadas === 0, "la limpieza de limpiarCajaDev (scripts/dev/sembrar-historia-dev.mjs) también corre", r2.fallo ?? "");
    const [despues] = await e.db.q("select count(*) filter (where cuenta_id is not null)::int ligadas from public.pos_ventas where club_id = $1", [A]);
    ok(despues.ligadas === antes.ligadas, "(todo dentro de transacciones deshechas: la caja de prueba sigue igual)");
  }

  // ---------- Bandera apagada otra vez ----------
  {
    await s.admin.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "pos_ventas", p_activa: false });
    const r = await importar(s.gerente, lineas, "b".repeat(64));
    const c = await s.dueno.rpc("pos_conciliacion", { p_club_id: A, p_fecha: NOCHE });
    ok(APAGADA.test(err(r)) && APAGADA.test(err(c)), "al apagarla: importar y conciliar rechazados aunque haya datos");
    const m = await s.admin.rpc("pos_mis_antros");
    ok(!(m.data ?? []).some((x) => x.club_id === A), "al apagarla: A ya no sale ni para el admin");
    const v = await s.admin.rpc("funcion_cambiar", { p_club_id: A, p_funcion: "pos_ventas", p_activa: null });
    ok(!v.error, "se quita el valor propio (vuelve a apagada por defecto)");
  }
} catch (x) {
  ok(false, "la prueba terminó sin excepción", x.stack);
} finally {
  const { errores, resto } = await e.limpiar();
  ok(errores.length === 0, "limpieza sin errores", errores.join(" | "));
  ok(resto.usuarios === 0 && resto.clubs === 0 && resto.cuentas === 0 && resto.ventas === 0, "0 restos de prueba (usuarios, antros, cuentas, ventas)", JSON.stringify(resto));
}
console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exit(fallan ? 1 : 0);
