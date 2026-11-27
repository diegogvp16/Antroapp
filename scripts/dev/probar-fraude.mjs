// SOLO DEV. Prueba de sql/post-junta-3/30-antifraude-rps.sql (revisión de
// RPs). Dos partes:
//
//  1) Base, en UNA transacción que al final se deshace (no deja nada):
//     datos armados a mano en octubre de 2026 (sin datos demo), sesiones
//     simuladas como las de la app (rol authenticated + claims del JWT) de
//     admin, dueño, dueño de grupo, gerente, staff, RP, cliente,
//     gerente/staff/dueño de otro antro, cuenta sin perfil, gerente y staff
//     dados de baja, contraseña temporal y anónimo. Cubre cada regla, no
//     duplicar, "ya no se cumple", el límite de una búsqueda cada 2 minutos,
//     estados, notas enmascaradas y foto de la evidencia, paginación,
//     aislamiento entre antros y bandera apagada.
//  2) Sesiones REALES (login con correo y contraseña contra la API de dev)
//     para la matriz de permisos. Enciende la bandera de Club Demo Dev solo
//     mientras corre y la regresa como estaba; crea cuentas temporales
//     t_n4_fraude_* (sin perfil, staff y gerente dados de baja) y las borra.
//
//   node scripts/dev/probar-fraude.mjs [--solo-base]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";
import { importarTs } from "./cargar-ts.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dom = await importarTs("../../lib/domain/fraude.ts", import.meta.url);
const DEMO = "0de70000-0000-4000-8000-000000000001";
const TIJUANA = "0de70000-0000-4000-8000-000000000004";
const LUNES = "2026-10-05", DOMINGO = "2026-10-11";
const db = await conectarDevEscritura();
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${!ok && d ? "  — " + d : ""}`); };

const ids = Object.fromEntries((await db.q(`
  select split_part(u.email, '@', 1) as clave, u.id from auth.users u join public.profiles p on p.id = u.id
   where u.email in ('dev_admin@example.com','dev_dueno@example.com','dev_gerente@example.com','dev_staff@example.com',
                     'dev_rp@example.com','dev_cliente@example.com','dev_gerente_tijuana@example.com',
                     'dev_staff_tijuana@example.com','dev_dueno_tijuana@example.com','dev_rp_tijuana@example.com',
                     'demo_mariana@example.com','demo_diego@example.com')`)).map((r) => [r.clave, r.id]));
ids.sin_perfil = "11111111-2222-4333-8444-555555555555";
const RP1 = ids.dev_rp, RP2 = ids.demo_mariana, RP3 = ids.demo_diego, RPT = ids.dev_rp_tijuana;
for (const k of ["dev_admin", "dev_dueno", "dev_gerente", "dev_staff", "dev_rp", "dev_cliente", "dev_gerente_tijuana",
                 "dev_staff_tijuana", "dev_dueno_tijuana", "dev_rp_tijuana", "demo_mariana", "demo_diego"]) {
  if (!ids[k]) { console.log(`Falta la cuenta ${k} en dev (correr sembrar-dev / demo-datos).`); process.exit(1); }
}

const claims = (uid, extra = {}) => JSON.stringify({ sub: uid, role: "authenticated", ...extra });
async function ponerSesion(uid, extra) {
  if (uid === "anon") {
    await db.q(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await db.q("set local role anon");
  } else {
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [claims(uid, extra)]);
    await db.q("set local role authenticated");
  }
}
// Llamada que se deshace (savepoint).
async function como(uid, sql, args = [], extra) {
  await db.q("savepoint s");
  try {
    await ponerSesion(uid, extra);
    return await db.q(sql, args);
  } catch (e) {
    return { error: e.code ?? "?", mensaje: e.message };
  } finally {
    await db.q("rollback to savepoint s");
  }
}
// Llamada que se queda (hasta el rollback final).
async function comoFijo(uid, sql, args = []) {
  await db.q("savepoint f");
  try {
    await ponerSesion(uid);
    const r = await db.q(sql, args);
    await db.q("reset role");
    await db.q(`select set_config('request.jwt.claims', '', true)`);
    await db.q("release savepoint f");
    return r;
  } catch (e) {
    await db.q("rollback to savepoint f");
    return { error: e.code ?? "?", mensaje: e.message };
  }
}
// La base deja una búsqueda cada 2 minutos por antro: la prueba borra la
// marca antes de cada búsqueda (salvo donde prueba el límite).
const permitir = (club = DEMO) => db.q(`delete from public.fraude_detecciones where club_id = $1`, [club]);
const detectar = async (uid, club = DEMO, desde = LUNES, hasta = DOMINGO) => {
  await permitir(club);
  const r = await comoFijo(uid, `select public.fraude_detectar($1, $2, $3) as d`, [club, desde, hasta]);
  return Array.isArray(r) ? r[0].d : r;
};
const alertas = (club = DEMO) => db.q(`select * from public.fraude_alertas where club_id = $1 order by regla, sujeto`, [club]);
const err = (r) => (r && !Array.isArray(r) ? r.error : "sin error");
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)); // fechas de pg en hora local (UTC-6)

// ---------- Datos armados ----------
async function reserva({ club = DEMO, rp = null, tel, fecha, creada, nombre = "t_n4_fraude_cliente", status = "confirmada" }) {
  const [r] = await db.q(
    `insert into public.reservations (cliente_nombre, cliente_telefono, rp_id, source, fecha, personas, status, qr_code, club_id, created_at)
     values ($1, $2, $3, $4, $5, 2, $6, 't_n4_fraude_' || gen_random_uuid(), $7, coalesce($8::timestamptz, now())) returning id`,
    [nombre, tel, rp, rp ? "rp" : "organica", fecha, status, club, creada ?? null]);
  return r.id;
}

try {
  await db.q("begin");
  await db.q(`select set_config('antroapp.borrado_pruebas', 'on', true)`); // insertar caja a mano (solo postgres)
  await db.q(`delete from public.club_funciones where club_id in ($1, $2) and funcion = 'antifraude'`, [DEMO, TIJUANA]);
  await db.q(`delete from public.grupo_funciones where funcion = 'antifraude'`);
  await db.q(`delete from public.fraude_reglas where club_id in ($1, $2)`, [DEMO, TIJUANA]);
  const previas = (await db.q(`select count(*)::int n from public.fraude_alertas where ventana_inicio between '2026-08-01' and '2026-11-30'`))[0].n;
  nota("no hay alertas previas en la ventana de prueba", previas === 0, `${previas}`);

  // ===== Bandera apagada =====
  for (const [quien, uid] of [["admin", ids.dev_admin], ["dueño", ids.dev_dueno], ["gerente", ids.dev_gerente]]) {
    const r = await como(uid, `select public.fraude_detectar($1, $2, $3)`, [DEMO, LUNES, DOMINGO]);
    nota(`bandera apagada: ${quien} no puede detectar`, r.error === "P0001" && /no está activa/.test(r.mensaje), r.mensaje);
    const l = await como(uid, `select * from public.fraude_alertas_listar($1)`, [DEMO]);
    nota(`bandera apagada: ${quien} no puede listar`, l.error === "P0001" && /no está activa/.test(l.mensaje), l.mensaje);
    const m = await como(uid, `select * from public.fraude_mis_antros()`);
    nota(`bandera apagada: ${quien} ve Demo en fraude_mis_antros con activa = false`, Array.isArray(m) && m.some((x) => x.club_id === DEMO && x.activa === false));
  }
  nota("bandera apagada: no se leen las reglas", (await como(ids.dev_gerente, `select * from public.fraude_reglas_leer($1)`, [DEMO])).error === "P0001");
  nota("bandera apagada: no se guardan reglas", (await como(ids.dev_gerente, `select public.fraude_regla_guardar($1, 'rafaga', false, '{}')`, [DEMO])).error === "P0001");

  await db.q(`insert into public.club_funciones (club_id, funcion, activa) values ($1, 'antifraude', true)`, [DEMO]);

  // ===== Catálogo =====
  const [{ c: catBase }] = await db.q(`select public.fraude_catalogo() as c`);
  const catIgual = dom.REGLAS_FRAUDE.every((r) => Object.entries(dom.CATALOGO_FRAUDE[r]).every(([k, v]) =>
    catBase[r]?.[k] && catBase[r][k].defecto === v.defecto && catBase[r][k].min === v.min && catBase[r][k].max === v.max && catBase[r][k].etiqueta === v.etiqueta))
    && Object.keys(catBase).length === 3 && dom.REGLAS_FRAUDE.every((r) => Object.keys(catBase[r]).length === Object.keys(dom.CATALOGO_FRAUDE[r]).length);
  nota("catálogo de la base = catálogo de lib/domain/fraude.ts (3 reglas, sin escaneos)", catIgual);

  // ===== Teléfonos =====
  const casos = [["55 1234 5678/", "5512345678"], ["5512345678 x", "5512345678"], ["55_1234_5678", "5512345678"], ["044 55 1234 5678", "5512345678"],
    ["045 55 1234 5678", "5512345678"], ["01 55 1234 5678", "5512345678"], ["1 55 1234 5678", "15512345678"], ["+52 1 55 1234 5678", "5512345678"],
    ["52 (55) 1234.5678", "5512345678"], ["12345", null], ["95512345678", "95512345678"], ["+1 212 555 1234", "12125551234"], [null, null]];
  const tels = await db.q(`select x.t, public.fraude_tel10(x.t) as n from unnest($1::text[]) x(t)`, [casos.map((c) => c[0])]);
  nota("fraude_tel10 = normalizarTelefonoMx en 12 formatos (/, x, _, 044, 045, 01, 1, +52 1…)",
    casos.every(([t, e], i) => tels[i].n === e && dom.normalizarTelefonoMx(t) === e), JSON.stringify(tels));
  const textos = ["Le marqué al 55 1234-5678 y al +52 1 (33) 9876 5432", "Mesa 12, 3 personas, $1,500"];
  const mt = await db.q(`select public.fraude_enmascarar_texto(x) m from unnest($1::text[]) x`, [textos]);
  nota("fraude_enmascarar_texto = enmascararTexto", mt.every((r, i) => r.m === dom.enmascararTexto(textos[i])) && mt[0].m === "Le marqué al ******5678 y al ******5432");

  // ===== Datos: cliente repetido =====
  const r1a = await reserva({ rp: RP1, tel: "+52 1 55 1234 0001", fecha: "2026-10-01" });
  const r1b = await reserva({ rp: RP2, tel: "044 55-1234-0001", fecha: "2026-10-07" });
  const r1t = await reserva({ club: TIJUANA, rp: RPT, tel: "5512340001", fecha: "2026-10-07" }); // otro antro
  await reserva({ rp: RP1, tel: "5512340002", fecha: "2026-10-06" });
  await reserva({ rp: RP1, tel: "5512340002", fecha: "2026-10-08" });
  await reserva({ rp: RP1, tel: "5512340003", fecha: "2026-08-20" });
  await reserva({ rp: RP2, tel: "5512340003", fecha: "2026-10-08" });
  await reserva({ tel: "5512340004", fecha: "2026-10-07" }); // orgánica: no cuenta
  await reserva({ rp: RP2, tel: "5512340004", fecha: "2026-10-08" });
  await reserva({ rp: RP3, tel: "tel 12", fecha: "2026-10-08" }); // ilegible
  await reserva({ rp: RP3, tel: "  ", fecha: "2026-10-08" }); // sin teléfono

  // ===== Datos: ráfaga =====
  const rafagaIds = [];
  for (let i = 0; i < 8; i++) {
    rafagaIds.push(await reserva({ rp: RP3, tel: `55123410${String(i).padStart(2, "0")}`, fecha: "2026-10-10",
      creada: new Date(Date.UTC(2026, 9, 10, 5, 0, 0) + i * 30_000).toISOString() }));
  }
  for (let i = 0; i < 7; i++) {
    await reserva({ rp: RP1, tel: `55123420${String(i).padStart(2, "0")}`, fecha: "2026-10-09",
      creada: new Date(Date.UTC(2026, 9, 9, 4, 0, 0) + i * 90_000).toISOString() });
  }

  // ===== Datos: consumo (caja de la noche del 8/10) =====
  const [{ id: noche }] = await db.q(`insert into public.caja_noches (club_id, fecha_operacion, estado) values ($1, '2026-10-08', 'abierta') returning id`, [DEMO]);
  const mesas = await db.q(`select id from public.club_tables where club_id = $1 order by numero limit 1`, [DEMO]);
  const [{ id: sesion }] = await db.q(`insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado) values ($1, $2, $3, 'cuadrada') returning id`, [DEMO, noche, mesas[0].id]);
  const valores = [];
  async function cuenta(rp, centavos, { anulado = null } = {}) {
    const resId = rp ? await reserva({ rp, tel: `55123450${String(valores.length).padStart(2, "0")}`, fecha: "2026-10-08" }) : null;
    const [{ id }] = await db.q(
      `insert into public.mesa_cuentas (club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, liquidada_en)
       values ($1, $2, $3, $4, $5, 't_n4_fraude_cuenta', 2, now()) returning id`, [DEMO, sesion, resId, rp, resId ? "reserva" : "walk_in"]);
    await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, monto_centavos, registrado_por)
                values ($1, $2, $3, $4, $5, $6, $7)`, [DEMO, noche, sesion, mesas[0].id, id, centavos, ids.dev_staff]);
    if (anulado) {
      await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, monto_centavos, registrado_por, anulado, anulado_por, motivo_anulacion)
                  values ($1, $2, $3, $4, $5, $6, $7, true, $7, 't_n4_fraude')`, [DEMO, noche, sesion, mesas[0].id, id, anulado, ids.dev_staff]);
    }
    valores.push(centavos);
    return id;
  }
  for (let i = 0; i < 20; i++) await cuenta(null, 100000);
  const bajas = [await cuenta(RP1, 5000), await cuenta(RP1, 5000), await cuenta(RP1, 5000)];
  const alta = await cuenta(RP2, 600000, { anulado: 900000 });
  await cuenta(RP3, 5000); await cuenta(RP3, 5000); // solo 2: no llega a 3
  await cuenta(RP2, 100000); // normal
  const medianaEsperada = dom.mediana(valores.filter((v) => v > 0));

  // ===== Primera detección (gerente) =====
  const d1 = await detectar(ids.dev_gerente);
  nota("gerente detecta sin error", d1 && !d1.error, d1?.mensaje);
  const a1 = await alertas();
  const porRegla = (r) => a1.filter((a) => a.regla === r);

  const cr = porRegla("cliente_repetido");
  nota("cliente repetido: 1 alerta (RP2 llega al teléfono de RP1 en 6 días)", cr.length === 1, JSON.stringify(cr.map((a) => a.resumen)));
  const crA = cr[0];
  nota("…ventana = noche de la llegada (7/10) y RP = el que llega", dia(crA?.ventana_inicio) === "2026-10-07" && crA?.rp_id === RP2);
  nota("…con los dos RPs", crA && [...crA.rp_ids].sort().join() === [RP1, RP2].sort().join());
  nota("…teléfono «044 55-…» normalizado y enmascarado ******0001", crA?.evidencia?.telefono === "******0001");
  const ev1 = JSON.stringify(crA?.evidencia ?? {});
  nota("…la evidencia no trae el teléfono completo", !/5512340001|55-1234|1234 0001/.test(ev1));
  nota("…ni la reserva del otro antro", !ev1.includes(r1t) && ev1.includes(r1a) && ev1.includes(r1b));
  nota("…ni nombres de clientes", !ev1.includes("t_n4_fraude_cliente"));
  const [{ md5 }] = await db.q(`select 'tel:' || md5($1 || ':' || '5512340001') as md5`, [DEMO]);
  nota("sujeto: HMAC (no md5 recalculable) + RP, sin teléfono en claro",
    /^tel:[0-9a-f]{64}:/.test(crA?.sujeto ?? "") && crA.sujeto.endsWith(":" + RP2) && !crA.sujeto.startsWith(md5) && !/5512340001/.test(crA.sujeto));
  nota("resumen: teléfonos ilegibles y sin teléfono contados", d1?.telefonos?.ilegibles === 1 && d1?.telefonos?.sin_telefono === 1, JSON.stringify(d1?.telefonos));

  const ra = porRegla("rafaga");
  nota("ráfaga: 1 alerta (RP3 con 8 en 3.5 min; RP1 con 7 no)", ra.length === 1 && ra[0].rp_id === RP3, JSON.stringify(ra.map((a) => a.resumen)));
  nota("…noche del 9/10 (por created_at, corte 08:00)", dia(ra[0]?.ventana_inicio) === "2026-10-09");
  nota("…evidencia con las 8 reservas", ra[0]?.evidencia?.reservas === 8 && rafagaIds.every((id) => ra[0].evidencia.reservation_ids.includes(id)));
  nota("…resumen dice 8 reservas en 4 min", /8 reservas creadas en 4 min \(de 23:00 a 23:03\)/.test(ra[0]?.resumen ?? ""), ra[0]?.resumen);
  nota("…coincide con maximoEnVentana del dominio", dom.maximoEnVentana(rafagaIds.map((_, i) => Date.UTC(2026, 9, 10, 5) + i * 30_000), 10) === ra[0]?.evidencia?.reservas);

  const ca = porRegla("consumo_atipico");
  const caB = ca.find((a) => a.sujeto.endsWith(":bajo")), caA = ca.find((a) => a.sujeto.endsWith(":alto"));
  nota("consumo: 2 alertas (bajo de RP1, alto de RP2; RP3 con 2 bajas no)", ca.length === 2 && caB?.rp_id === RP1 && caA?.rp_id === RP2, JSON.stringify(ca.map((a) => a.sujeto)));
  nota(`…mediana de la base = mediana del dominio (${medianaEsperada})`, caB?.evidencia?.mediana_centavos === medianaEsperada && caA?.evidencia?.mediana_centavos === medianaEsperada);
  nota("…muestra = cuentas cuadradas con consumo > 0 (27)", caB?.evidencia?.muestra === 27, `${caB?.evidencia?.muestra}`);
  nota("…umbral bajo = umbralBajo del dominio", caB?.evidencia?.umbral_centavos === dom.umbralBajo(medianaEsperada, 20));
  nota("…bajo: las 3 cuentas", caB?.evidencia?.cuentas?.length === 3 && bajas.every((id) => JSON.stringify(caB.evidencia.cuentas).includes(id)));
  nota("…alto: sin contar lo anulado ($6,000, no $15,000)", caA?.evidencia?.cuentas?.[0]?.consumo_centavos === 600000 && caA.evidencia.cuentas[0].cuenta_id === alta);
  nota("…clasificación igual al dominio", dom.clasificarConsumo(5000, medianaEsperada, { pct_bajo: 20, factor_alto: 5 }) === "bajo"
    && dom.clasificarConsumo(600000, medianaEsperada, { pct_bajo: 20, factor_alto: 5 }) === "alto");
  nota("resumen de la detección: nuevas por regla", d1?.reglas?.cliente_repetido?.nuevas === 1 && d1?.reglas?.rafaga?.nuevas === 1
    && d1?.reglas?.consumo_atipico?.nuevas === 2 && !("escaneo_duplicado" in (d1?.reglas ?? {})), JSON.stringify(d1?.reglas));
  nota("todas nacen en «revisar» y vigentes", a1.length === 4 && a1.every((a) => a.estado === "revisar" && a.ya_no_aplica_en === null));

  // ===== Límite: una búsqueda cada 2 minutos =====
  const otra = await comoFijo(ids.dev_dueno, `select public.fraude_detectar($1, $2, $3)`, [DEMO, LUNES, DOMINGO]);
  nota("otra búsqueda enseguida (otra persona): rechazada", otra.error === "P0001" && /2 minutos/.test(otra.mensaje), otra.mensaje);
  const ult = await como(ids.dev_dueno, `select public.fraude_ultima_deteccion($1) as u`, [DEMO]);
  nota("fraude_ultima_deteccion: quién, rango y resumen", Array.isArray(ult) && ult[0].u?.hecho_por_nombre === "Gerente Dev"
    && ult[0].u?.desde === LUNES && ult[0].u?.resumen?.reglas?.rafaga?.nuevas === 1, JSON.stringify(ult[0]?.u ?? ult));

  // ===== Volver a correr: no duplica =====
  const d2 = await detectar(ids.dev_dueno);
  const a2 = await alertas();
  nota("re-correr (dueño): mismas 4 alertas, 0 nuevas, 0 actualizadas", a2.length === 4 && Object.values(d2.reglas).every((r) => r.nuevas === 0 && r.actualizadas === 0), JSON.stringify(d2.reglas));
  nota("…mismos ids", a2.map((a) => a.id).sort().join() === a1.map((a) => a.id).sort().join());
  const d2b = await detectar(ids.dev_admin, DEMO, "2026-10-07", "2026-10-09");
  nota("re-correr con otro rango dentro de la semana: 0 nuevas, ninguna «ya no aplica»", Object.values(d2b.reglas).every((r) => !r.nuevas && !r.ya_no_aplican), JSON.stringify(d2b.reglas));

  // ===== Cliente que cambia de RP una vez y sigue con él =====
  await reserva({ rp: RP1, tel: "5512349999", fecha: "2026-10-05" });
  await reserva({ rp: RP2, tel: "5512349999", fecha: "2026-10-06" });
  for (const f of ["2026-10-14", "2026-10-21", "2026-10-28"]) await reserva({ rp: RP2, tel: "5512349999", fecha: f });
  const dS = await detectar(ids.dev_gerente, DEMO, "2026-10-01", "2026-10-31");
  const mes = (await alertas()).filter((a) => a.regla === "cliente_repetido" && a.evidencia.telefono === "******9999");
  nota("cliente que cambia de RP una vez y sigue 4 semanas: 1 alerta, no 4", mes.length === 1 && dia(mes[0].ventana_inicio) === "2026-10-06", JSON.stringify(dS.reglas.cliente_repetido));
  // Seguir reservando con RP2 dentro de los 30 días no cuenta como llegada: la evidencia no cambia.
  nota("…descartarla", Array.isArray(await comoFijo(ids.dev_gerente, `select public.fraude_alerta_cambiar($1, 'descartada', 'Cambió de RP, normal')`, [mes[0].id])));
  await reserva({ rp: RP2, tel: "5512349999", fecha: "2026-10-30" });
  await detectar(ids.dev_gerente, DEMO, "2026-10-01", "2026-10-31");
  const mes2 = (await alertas()).filter((a) => a.regla === "cliente_repetido" && a.evidencia.telefono === "******9999");
  nota("…descartada, el mismo par no vuelve a salir", mes2.length === 1 && mes2[0].estado === "descartada");
  await reserva({ rp: RP3, tel: "55 1234 9999", fecha: "2026-10-29" });
  await detectar(ids.dev_gerente, DEMO, "2026-10-01", "2026-10-31");
  const mes3 = (await alertas()).filter((a) => a.regla === "cliente_repetido" && a.evidencia.telefono === "******9999");
  nota("…un RP nuevo (RP3) sí hace otra alerta", mes3.length === 2 && mes3.some((a) => a.rp_id === RP3 && a.estado === "revisar"));

  // ===== Revisión: estados, notas, foto de evidencia =====
  const listar = (uid, extra = "", args = []) => como(uid, `select * from public.fraude_alertas_listar($1${extra})`, [DEMO, ...args]);
  const lg = await listar(ids.dev_gerente, ", null, null, null, '2026-10-05', '2026-10-11'");
  nota("gerente lista las alertas de la semana", Array.isArray(lg) && lg.length === 5, `${lg.length ?? err(lg)}`);
  nota("…con total y sin evidencia ni sujeto", Array.isArray(lg) && Number(lg[0].total) === 5 && !("evidencia" in lg[0]) && !("sujeto" in lg[0]));
  const pag = await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, null, null, null, null, null, 2, 0)`, [DEMO]);
  const pag2 = await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, null, null, null, null, null, 2, 2)`, [DEMO]);
  const totalTodas = (await alertas()).length;
  nota(`paginación: 2 + 2 de ${totalTodas}, sin repetir`, pag.length === 2 && pag2.length === 2 && Number(pag[0].total) === totalTodas
    && !pag.some((a) => pag2.some((b) => b.id === a.id)));
  nota("filtro por regla", (await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, null, 'consumo_atipico')`, [DEMO])).length === 2);
  const f2 = await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, null, null, $2)`, [DEMO, RP1]);
  nota("filtro por RP (incluye alertas con varios RPs)", Array.isArray(f2) && f2.some((a) => a.regla === "cliente_repetido") && f2.some((a) => a.regla === "consumo_atipico"));
  nota("filtro por estado (1 descartada)", (await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, 'descartada')`, [DEMO])).length === 1);
  nota("estado inválido en filtro: aviso", (await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, 'otra')`, [DEMO])).error === "P0001");
  nota("regla «escaneo_duplicado» ya no existe en filtros", (await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, null, 'escaneo_duplicado')`, [DEMO])).error === "P0001");

  const cambiar = (uid, id, estado, n) => comoFijo(uid, `select public.fraude_alerta_cambiar($1, $2, $3)`, [id, estado, n]);
  nota("descartar sin nota: rechazado", (await cambiar(ids.dev_gerente, crA.id, "descartada", null)).error === "P0001");
  nota("descartar con nota de 4 letras: rechazado", /al menos 5/.test((await cambiar(ids.dev_gerente, crA.id, "descartada", "  ok  ")).mensaje ?? ""));
  nota("nota de más de 1000: rechazada", (await cambiar(ids.dev_gerente, crA.id, "descartada", "x".repeat(1001))).error === "P0001");
  nota("estado inexistente: rechazado", (await cambiar(ids.dev_gerente, crA.id, "borrada", "nota valida")).error === "P0001");
  nota("gerente descarta con nota (con un teléfono)", Array.isArray(await cambiar(ids.dev_gerente, crA.id, "descartada", "Le marqué al 55 1234 0001, es su primo")));
  nota("descartada → confirmada directo: rechazado", /Primero vuelve/.test((await cambiar(ids.dev_gerente, crA.id, "confirmada", "nota valida")).mensaje ?? ""));
  nota("descartada → descartada: rechazado", /ya está/.test((await cambiar(ids.dev_gerente, crA.id, "descartada", "nota valida")).mensaje ?? ""));
  nota("dueño reabre (→ revisar) con nota", Array.isArray(await cambiar(ids.dev_dueno, crA.id, "revisar", "Lo vuelvo a ver")));
  nota("admin confirma con nota", Array.isArray(await cambiar(ids.dev_admin, crA.id, "confirmada", "Confirmado con el RP")));
  const det = await como(ids.dev_gerente, `select public.fraude_alerta_detalle($1) as d`, [crA.id]);
  const dd = Array.isArray(det) ? det[0].d : null;
  nota("detalle: confirmada; el admin sale sin nombre", dd?.estado === "confirmada" && dd?.revisada_en && dd?.revisada_por_nombre === null);
  nota("detalle: bitácora con 3 cambios (de, a, nota, quién, cuándo)", dd?.cambios?.length === 3
    && dd.cambios.map((c) => `${c.de}>${c.a}`).join() === "revisar>descartada,descartada>revisar,revisar>confirmada"
    && dd.cambios[1].hecho_por_nombre === "Dueña Dev" && dd.cambios[0].hecho_en, JSON.stringify(dd?.cambios?.map((c) => c.hecho_por_nombre)));
  nota("la nota se guarda con el teléfono enmascarado", dd?.cambios?.[0]?.nota === "Le marqué al ******0001, es su primo", dd?.cambios?.[0]?.nota);
  nota("cada cambio guarda la evidencia y el resumen de ese momento", dd?.cambios?.every((c) => c.evidencia?.telefono === "******0001" && c.resumen === crA.resumen));

  // Reabrir y que la evidencia cambie: la foto del cambio se conserva.
  const raA = ra[0];
  await cambiar(ids.dev_gerente, raA.id, "confirmada", "Lista inventada");
  await cambiar(ids.dev_gerente, raA.id, "revisar", "Revisar con más datos");
  await reserva({ rp: RP3, tel: "5512341099", fecha: "2026-10-10", creada: new Date(Date.UTC(2026, 9, 10, 5, 4, 0)).toISOString() });
  const d3 = await detectar(ids.dev_gerente);
  const raDet = (await como(ids.dev_gerente, `select public.fraude_alerta_detalle($1) as d`, [raA.id]))[0].d;
  nota("reabierta: la nueva búsqueda actualiza la evidencia (9 reservas)…", d3.reglas.rafaga.actualizadas === 1 && raDet.evidencia.reservas === 9);
  nota("…pero la confirmación conserva la evidencia con la que se decidió (8)", raDet.cambios[0].a === "confirmada" && raDet.cambios[0].evidencia.reservas === 8);

  // «Ya no se cumple»: subir el umbral de la ráfaga.
  const guardar = (uid, regla, activa, p) => comoFijo(uid, `select public.fraude_regla_guardar($1, $2, $3, $4)`, [DEMO, regla, activa, p === null ? null : JSON.stringify(p)]);
  await guardar(ids.dev_gerente, "rafaga", null, { min_reservas: 20 });
  const d4 = await detectar(ids.dev_gerente);
  const raYa = (await alertas()).find((a) => a.id === raA.id);
  nota("«Por revisar» que ya no se cumple: se marca (ya_no_aplica_en), no se borra", d4.reglas.rafaga.ya_no_aplican === 1 && raYa.ya_no_aplica_en !== null && raYa.estado === "revisar");
  const lYa = await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1, null, 'rafaga')`, [DEMO]);
  nota("…y la lista lo muestra", lYa[0]?.ya_no_aplica_en !== null);
  await guardar(ids.dev_gerente, "rafaga", null, { min_reservas: 8 });
  const d5 = await detectar(ids.dev_gerente);
  nota("…si vuelve a cumplirse, se quita la marca", d5.reglas.rafaga.actualizadas === 1 && (await alertas()).find((a) => a.id === raA.id).ya_no_aplica_en === null);
  const crC = (await alertas()).find((a) => a.id === crA.id);
  nota("las ya revisadas no se marcan ni se tocan", crC.estado === "confirmada" && crC.ya_no_aplica_en === null && JSON.stringify(crC.evidencia) === JSON.stringify(crA.evidencia));

  // ===== Reglas: configurar =====
  nota("umbral fuera de rango: rechazado", /entre 3 y 100/.test((await guardar(ids.dev_gerente, "rafaga", null, { min_reservas: 2 })).mensaje ?? ""));
  nota("umbral decimal: rechazado", /entero/.test((await guardar(ids.dev_gerente, "rafaga", null, { minutos: 2.5 })).mensaje ?? ""));
  nota("umbral como texto: rechazado", /entero/.test((await guardar(ids.dev_gerente, "rafaga", null, { minutos: "10" })).mensaje ?? ""));
  nota("umbral de otra regla: rechazado", (await guardar(ids.dev_gerente, "rafaga", null, { dias: 3 })).error === "P0001");
  nota("regla escaneo_duplicado: ya no existe", (await guardar(ids.dev_gerente, "escaneo_duplicado", true, {})).error === "P0001");
  nota("parámetros que no son objeto: rechazados", (await guardar(ids.dev_gerente, "rafaga", true, [1])).error === "P0001");
  const nCambios = async () => (await db.q(`select count(*)::int n from public.fraude_reglas_cambios where club_id = $1`, [DEMO]))[0].n;
  const antes = await nCambios();
  nota("guardar los mismos valores: no escribe", Array.isArray(await guardar(ids.dev_gerente, "rafaga", true, { min_reservas: 8 })) && (await nCambios()) === antes);
  nota("gerente cambia cliente_repetido a 60 días", Array.isArray(await guardar(ids.dev_gerente, "cliente_repetido", null, { dias: 60 })));
  const d6 = await detectar(ids.dev_gerente);
  nota("…con 60 días aparece el teléfono de 49 días entre RPs", d6.reglas.cliente_repetido.nuevas === 1, JSON.stringify(d6.reglas.cliente_repetido));
  nota("dueño apaga la ráfaga", Array.isArray(await guardar(ids.dev_dueno, "rafaga", false, null)));
  nota("…la detección la salta (activa: false)", (await detectar(ids.dev_gerente)).reglas.rafaga.activa === false);
  nota("admin sube muestra mínima a 30", Array.isArray(await guardar(ids.dev_admin, "consumo_atipico", null, { muestra_minima: 30 })));
  const d7 = await detectar(ids.dev_gerente);
  nota("…sin muestra suficiente: no inventa mediana, avisa la semana y marca las del consumo como «ya no se cumple»",
    d7.reglas.consumo_atipico.detectadas === 0 && d7.reglas.consumo_atipico.semanas_sin_muestra?.[0]?.muestra === 27 && d7.reglas.consumo_atipico.ya_no_aplican === 2,
    JSON.stringify(d7.reglas.consumo_atipico));
  const leer = await como(ids.dev_gerente, `select * from public.fraude_reglas_leer($1)`, [DEMO]);
  nota("leer reglas: 3, con efectivos y límites", Array.isArray(leer) && leer.length === 3
    && leer.find((r) => r.regla === "cliente_repetido").parametros.dias === 60 && leer.find((r) => r.regla === "rafaga").activa === false
    && leer[0].limites.dias.max === 180);
  const bit = await como(ids.dev_gerente, `select * from public.fraude_reglas_cambios_leer($1)`, [DEMO]);
  nota("bitácora de reglas con antes/después y quién", Array.isArray(bit) && bit.length >= 5
    && bit.some((b) => b.regla === "cliente_repetido" && b.despues.parametros.dias === 60 && b.hecho_por_nombre === "Gerente Dev")
    && bit.some((b) => b.regla === "rafaga" && b.despues.activa === false && b.hecho_por_nombre === "Dueña Dev"));

  // ===== Permisos (sesiones simuladas) =====
  const unaAlerta = crA.id;
  const pruebas = [
    ["staff del antro", ids.dev_staff], ["RP del antro (sobre sí mismo)", RP1], ["RP con alertas (RP2)", RP2], ["cliente", ids.dev_cliente],
    ["gerente de otro antro", ids.dev_gerente_tijuana], ["staff de otro antro", ids.dev_staff_tijuana],
    ["dueño de otro antro", ids.dev_dueno_tijuana], ["cuenta sin perfil", ids.sin_perfil],
  ];
  for (const [quien, uid] of pruebas) {
    await permitir();
    const r = [
      await como(uid, `select * from public.fraude_alertas_listar($1)`, [DEMO]),
      await como(uid, `select public.fraude_detectar($1, $2, $3)`, [DEMO, LUNES, DOMINGO]),
      await como(uid, `select public.fraude_alerta_detalle($1)`, [unaAlerta]),
      await como(uid, `select public.fraude_alerta_cambiar($1, 'revisar', 'intento de cambio')`, [unaAlerta]),
      await como(uid, `select public.fraude_regla_guardar($1, 'rafaga', true, '{}')`, [DEMO]),
      await como(uid, `select * from public.fraude_reglas_leer($1)`, [DEMO]),
      await como(uid, `select * from public.fraude_reglas_cambios_leer($1)`, [DEMO]),
      await como(uid, `select * from public.fraude_alertas_rps($1)`, [DEMO]),
      await como(uid, `select public.fraude_ultima_deteccion($1)`, [DEMO]),
    ];
    nota(`${quien}: rechazado en las 9 funciones (P0001)`, r.every((x) => x.error === "P0001"), r.map(err).join(","));
    const m = await como(uid, `select * from public.fraude_mis_antros()`);
    nota(`${quien}: fraude_mis_antros sin Club Demo Dev`, Array.isArray(m) && !m.some((x) => x.club_id === DEMO));
  }
  const anon = [
    await como("anon", `select * from public.fraude_alertas_listar($1)`, [DEMO]),
    await como("anon", `select public.fraude_detectar($1, $2, $3)`, [DEMO, LUNES, DOMINGO]),
    await como("anon", `select * from public.fraude_mis_antros()`),
    await como("anon", `select public.fraude_catalogo()`),
  ];
  nota("anónimo: sin permiso de ejecutar (42501)", anon.every((x) => x.error === "42501"), anon.map(err).join(","));

  await db.q("savepoint baja");
  await db.q(`update public.profiles set activo = false where id in ($1, $2)`, [ids.dev_gerente, ids.dev_staff]);
  const gb = await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1)`, [DEMO]);
  nota("gerente dado de baja: rechazado", gb.error === "P0001", err(gb));
  nota("gerente dado de baja: fraude_mis_antros vacío (la pantalla dice «sin permiso», no «no está activa»)",
    (await como(ids.dev_gerente, `select * from public.fraude_mis_antros()`)).length === 0);
  nota("staff dado de baja: rechazado", (await como(ids.dev_staff, `select * from public.fraude_alertas_listar($1)`, [DEMO])).error === "P0001");
  await db.q("rollback to savepoint baja");
  const tmp = await como(ids.dev_dueno, `select * from public.fraude_alertas_listar($1)`, [DEMO], { app_metadata: { debe_cambiar: true } });
  nota("dueño con contraseña temporal: rechazado", tmp.error === "P0001", err(tmp));
  nota("dueño con contraseña temporal: fraude_mis_antros vacío",
    (await como(ids.dev_dueno, `select * from public.fraude_mis_antros()`, [], { app_metadata: { debe_cambiar: true } })).length === 0);

  // Dueño de grupo y Tijuana.
  const tijAntes = await como(ids.dev_dueno, `select * from public.fraude_alertas_listar($1)`, [TIJUANA]);
  nota("dueño de grupo, Tijuana sin bandera: «no está activa»", /no está activa/.test(tijAntes.mensaje ?? ""), tijAntes.mensaje);
  await db.q(`insert into public.club_funciones (club_id, funcion, activa) values ($1, 'antifraude', true)`, [TIJUANA]);
  for (let i = 0; i < 8; i++) {
    await reserva({ club: TIJUANA, rp: RPT, tel: `66412300${String(i).padStart(2, "0")}`, fecha: "2026-10-10",
      creada: new Date(Date.UTC(2026, 9, 10, 6, 0, 0) + i * 20_000).toISOString() });
  }
  const dT = await detectar(ids.dev_dueno, TIJUANA);
  nota("dueño de grupo detecta en Tijuana (1 ráfaga)", dT?.reglas?.rafaga?.nuevas === 1, JSON.stringify(dT?.reglas ?? dT));
  const tij = await alertas(TIJUANA);
  nota("Tijuana: el teléfono compartido con Demo no hace alerta (sin mezclar antros)", tij.filter((a) => a.regla === "cliente_repetido").length === 0);
  const tRaf = tij.find((a) => a.regla === "rafaga");
  await cambiar(ids.dev_dueno, tRaf.id, "confirmada", "Revisado por la dueña del grupo");
  const tDet = (await como(ids.dev_gerente_tijuana, `select public.fraude_alerta_detalle($1) as d`, [tRaf.id]))[0]?.d;
  nota("acción del dueño de grupo: sale con su nombre (no «Administración»)", tDet?.cambios?.[0]?.hecho_por_nombre === "Dueña Dev" && tDet?.revisada_por_nombre === "Dueña Dev", JSON.stringify(tDet?.cambios?.[0]));
  const misD = await como(ids.dev_dueno, `select * from public.fraude_mis_antros()`);
  nota("dueño de grupo: fraude_mis_antros = Demo y Tijuana, activas", Array.isArray(misD) && misD.length === 2 && misD.every((x) => x.activa));
  const misG = await como(ids.dev_gerente, `select * from public.fraude_mis_antros()`);
  nota("gerente: fraude_mis_antros = solo su antro", Array.isArray(misG) && misG.length === 1 && misG[0].club_id === DEMO);
  nota("gerente de Demo no ve Tijuana", (await como(ids.dev_gerente, `select * from public.fraude_alertas_listar($1)`, [TIJUANA])).error === "P0001");
  nota("gerente de Tijuana ve Tijuana", Array.isArray(await como(ids.dev_gerente_tijuana, `select * from public.fraude_alertas_listar($1)`, [TIJUANA])));
  nota("gerente de Tijuana no abre una alerta de Demo (mismo aviso que inexistente)",
    /no existe o no es de tu antro/.test((await como(ids.dev_gerente_tijuana, `select public.fraude_alerta_detalle($1)`, [unaAlerta])).mensaje ?? ""));
  nota("alerta inexistente: mismo aviso", /no existe o no es de tu antro/.test((await como(ids.dev_gerente, `select public.fraude_alerta_detalle('00000000-0000-4000-8000-000000000000')`)).mensaje ?? ""));
  nota("antro inexistente: aviso de permiso (no revela si existe)", /permiso/.test((await como(ids.dev_admin, `select * from public.fraude_alertas_listar('00000000-0000-4000-8000-000000000000')`)).mensaje ?? ""));

  await db.q("savepoint apagar");
  await db.q(`update public.club_funciones set activa = false where club_id = $1 and funcion = 'antifraude'`, [DEMO]);
  const off = [
    await como(ids.dev_admin, `select public.fraude_alerta_detalle($1)`, [unaAlerta]),
    await como(ids.dev_gerente, `select public.fraude_alerta_cambiar($1, 'revisar', 'intento de cambio')`, [unaAlerta]),
    await como(ids.dev_dueno, `select * from public.fraude_reglas_leer($1)`, [DEMO]),
  ];
  nota("bandera apagada: detalle, cambio y reglas rechazados", off.every((x) => /no está activa/.test(x.mensaje ?? "")), off.map(err).join(","));
  await db.q("rollback to savepoint apagar");

  // Acceso directo a tablas y ayudantes: cerrado.
  for (const t of ["fraude_alertas", "fraude_alertas_cambios", "fraude_reglas", "fraude_reglas_cambios", "fraude_detecciones", "fraude_secreto"]) {
    const r = await como(ids.dev_admin, `select count(*) from public.${t}`);
    const w = await como(ids.dev_gerente, `insert into public.${t} default values`);
    nota(`${t}: ni el admin la lee directo; nadie escribe`, r.error === "42501" && w.error === "42501", `${err(r)} ${err(w)}`);
  }
  await db.q("savepoint srv");
  await db.q("set local role service_role");
  const srv = await db.q(`select count(*) from public.fraude_secreto`).catch((e) => ({ error: e.code, mensaje: e.message }));
  await db.q("rollback to savepoint srv");
  nota("fraude_secreto: ni service_role la lee (42501)", srv.error === "42501" && /fraude_secreto/.test(srv.mensaje ?? ""), JSON.stringify(srv));
  for (const fn of ["fraude_puede_revisar($1)", "fraude_autorizar($1)", "fraude_parametros($1, 'rafaga')", "fraude_regla_activa($1, 'rafaga')",
                    "fraude_nombre($1, $1)"]) {
    const r = await como(ids.dev_gerente, `select public.${fn}`, [DEMO]);
    nota(`ayudante ${fn.split("(")[0]} no se llama desde la API`, r.error === "42501", err(r));
  }
  for (const fn of ["fraude_enmascarar_tel('5512345678')", "fraude_tel10('5512345678')", "fraude_enmascarar_texto('x')"]) {
    nota(`ayudante ${fn.split("(")[0]} no se llama desde la API`, (await como(ids.dev_gerente, `select public.${fn}`)).error === "42501");
  }

  await permitir();
  nota("rango invertido: aviso", /rango de noches válido/.test((await como(ids.dev_gerente, `select public.fraude_detectar($1, $2, $3)`, [DEMO, DOMINGO, LUNES])).mensaje ?? ""));
  nota("rango de más de 63 noches: aviso", /63 noches/.test((await como(ids.dev_gerente, `select public.fraude_detectar($1, '2026-08-01', '2026-10-11')`, [DEMO])).mensaje ?? ""));
  nota("rango que termina pasado mañana: aviso", /después de mañana/.test((await como(ids.dev_gerente, `select public.fraude_detectar($1, current_date, current_date + 5)`, [DEMO])).mensaje ?? ""));
} finally {
  await db.q("rollback").catch(() => {});
}

const restos = await db.q(`select (select count(*)::int from public.reservations where cliente_nombre like 't_n4_fraude%' or qr_code like 't_n4_fraude%') r,
  (select count(*)::int from public.fraude_alertas) a, (select count(*)::int from public.fraude_detecciones) d,
  (select count(*)::int from public.mesa_cuentas where cliente_nombre like 't_n4_fraude%') c,
  (select count(*)::int from public.club_funciones where funcion = 'antifraude' and activa) f`);
nota("parte 1: nada quedó en dev (reservas, alertas, búsquedas, caja, bandera)", Object.values(restos[0]).every((n) => n === 0), JSON.stringify(restos[0]));

// =================== Parte 2: sesiones reales ===================
if (!process.argv.includes("--solo-base")) {
  const env = verificarEnvDev();
  const req = createRequire(path.join(RAIZ, "package.json"));
  const { createClient } = req("@supabase/supabase-js");
  const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  async function entrar(email, password = cred.password) {
    const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    for (let i = 0; i < 6; i++) {
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (!error) return c;
      if (!/rate|429|too many/i.test(error.message)) throw new Error(`login ${email.split("@")[0]}: ${error.message}`);
      await espera(2000 * (i + 1));
    }
    throw new Error(`login ${email.split("@")[0]}: límite de intentos`);
  }
  const temporales = [];
  const claveTmp = "T_n4_fraude_" + Math.random().toString(36).slice(2) + "A9!";
  const [flagAntes] = await db.q(`select activa from public.club_funciones where club_id = $1 and funcion = 'antifraude'`, [DEMO]);
  const [{ m: maxCambio }] = await db.q(`select coalesce(max(id), 0) m from public.funciones_cambios`);
  try {
    const admin = await entrar(cred.usuarios.admin);
    const { error: eFlag } = await admin.rpc("funcion_cambiar", { p_club_id: DEMO, p_funcion: "antifraude", p_activa: true });
    nota("real: admin enciende la bandera de Demo (solo mientras corre esta parte)", !eFlag, eFlag?.message);

    for (const [clave, perfil] of [["sinperfil", null], ["staffbaja", { role: "staff", activo: false }], ["gerentebaja", { role: "gerente", activo: false }]]) {
      const email = `t_n4_fraude_${clave}@example.com`;
      const { data, error } = await svc.auth.admin.createUser({ email, password: claveTmp, email_confirm: true });
      if (error) throw new Error(`crear ${clave}: ${error.message}`);
      temporales.push(data.user.id);
      if (perfil) {
        const { error: ep } = await svc.from("profiles").upsert({ id: data.user.id, nombre: `t_n4_fraude_${clave}`, club_id: DEMO, ...perfil });
        if (ep) throw new Error(`perfil ${clave}: ${ep.message}`);
      } else {
        await svc.from("profiles").delete().eq("id", data.user.id);
      }
    }

    const sesiones = [
      ["admin", await entrar(cred.usuarios.admin), true],
      ["dueño (y de grupo)", await entrar(cred.usuarios.dueno), true],
      ["gerente", await entrar(cred.usuarios.gerente), true],
      ["staff", await entrar(cred.usuarios.staff), false],
      ["RP", await entrar(cred.usuarios.rp), false],
      ["cliente", await entrar(cred.usuarios.cliente), false],
      ["gerente de otro antro", await entrar(cred.usuarios.gerente_tijuana), false],
      ["staff de otro antro", await entrar(cred.usuarios.staff_tijuana), false],
      ["cuenta sin perfil", await entrar("t_n4_fraude_sinperfil@example.com", claveTmp), false],
      ["staff dado de baja", await entrar("t_n4_fraude_staffbaja@example.com", claveTmp), false],
      ["gerente dado de baja", await entrar("t_n4_fraude_gerentebaja@example.com", claveTmp), false],
      ["anónimo", createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } }), false],
    ];
    for (const [quien, c, puede] of sesiones) {
      await db.q(`delete from public.fraude_detecciones where club_id = $1`, [DEMO]);
      const l = await c.rpc("fraude_alertas_listar", { p_club_id: DEMO, p_desde: LUNES, p_hasta: DOMINGO });
      const r = await c.rpc("fraude_reglas_leer", { p_club_id: DEMO });
      const d = await c.rpc("fraude_detectar", { p_club_id: DEMO, p_desde: LUNES, p_hasta: DOMINGO });
      const m = await c.rpc("fraude_mis_antros");
      const t = await c.from("fraude_alertas").select("id").limit(1);
      const esperado = quien === "anónimo" ? "42501" : "P0001";
      if (puede) {
        nota(`real ${quien}: lista, lee reglas y detecta`, !l.error && !r.error && !d.error && Array.isArray(l.data) && r.data?.length === 3,
          [l.error?.message, r.error?.message, d.error?.message].filter(Boolean).join(" | "));
        nota(`real ${quien}: ve Demo activa en fraude_mis_antros`, Array.isArray(m.data) && m.data.some((x) => x.club_id === DEMO && x.activa));
      } else {
        nota(`real ${quien}: rechazado (${esperado})`, [l, r, d].every((x) => x.error?.code === esperado), [l, r, d].map((x) => x.error?.code ?? "ok").join(","));
        nota(`real ${quien}: fraude_mis_antros sin Club Demo Dev (o sin permiso)`, quien === "anónimo" ? m.error?.code === "42501" : Array.isArray(m.data) && !m.data.some((x) => x.club_id === DEMO));
      }
      nota(`real ${quien}: la tabla no se lee por la API`, Boolean(t.error), t.error?.code ?? "sin error");
    }
    const s = await svc.from("fraude_secreto").select("clave");
    nota("real service_role: fraude_secreto no se lee por la API", Boolean(s.error), JSON.stringify(s.data));
  } catch (e) {
    nota("real: la parte de sesiones corrió completa", false, e.message);
  } finally {
    if (flagAntes) await db.q(`update public.club_funciones set activa = $2 where club_id = $1 and funcion = 'antifraude'`, [DEMO, flagAntes.activa]);
    else await db.q(`delete from public.club_funciones where club_id = $1 and funcion = 'antifraude'`, [DEMO]);
    await db.q(`delete from public.funciones_cambios where id > $1 and club_id = $2 and funcion = 'antifraude'`, [maxCambio, DEMO]);
    await db.q(`delete from public.fraude_detecciones where club_id = $1`, [DEMO]);
    for (const id of temporales) {
      await svc.from("profiles").delete().eq("id", id);
      await svc.auth.admin.deleteUser(id);
    }
    const [q] = await db.q(`select (select count(*)::int from auth.users where email like 't_n4_fraude%') u,
      (select count(*)::int from public.profiles where nombre like 't_n4_fraude%') p,
      (select count(*)::int from public.fraude_alertas where club_id = $1) a,
      (select count(*)::int from public.fraude_detecciones) d,
      (select count(*)::int from public.club_funciones where club_id = $1 and funcion = 'antifraude' and activa) f`, [DEMO]);
    nota("parte 2: sin cuentas temporales, alertas ni búsquedas; bandera como estaba", q.u === 0 && q.p === 0 && q.a === 0 && q.d === 0 && q.f === (flagAntes?.activa ? 1 : 0), JSON.stringify(q));
  }
}
await db.fin();
const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length}`);
process.exit(ok === res.length ? 0 : 1);
