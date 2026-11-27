// SOLO DEV. Prueba de carga de fraude_detectar (revisión de RPs): todo en UNA
// transacción que al final se deshace (no deja nada).
//
//   node scripts/dev/probar-fraude-carga.mjs
//
// Datos sintéticos en Club Demo Dev, del 2/7 al 2/10/2026 (63 noches de
// rango + 30 de historia para "cliente repetido"): 300 reservas de RP por
// noche (6 RPs, 4,000 teléfonos que se repiten, 2 % ilegibles), 150 cuentas
// cuadradas por noche con consumo (y algunas de RP muy bajas), y ráfagas
// sembradas. Luego, como el GERENTE y con el statement_timeout de 8 s que
// tiene authenticated en Supabase, corre la detección de 63 noches y la de
// 14 noches, la lista y el detalle. Pasa si todo termina muy por debajo de
// 8 s (límite de la prueba: 4 s por llamada, la mitad).
import { conectarDevEscritura } from "../db/conexion.mjs";

const DEMO = "0de70000-0000-4000-8000-000000000001";
const LIMITE_MS = 4000; // la mitad del statement_timeout de 8 s
const db = await conectarDevEscritura();
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };
const [{ id: GERENTE }] = await db.q(`select id from auth.users where email = 'dev_gerente@example.com'`);

// antroapp-dev lo comparten otras ramas que aplican y deshacen SQL: si la
// llamada se queda esperando un candado de OTRA sesión (lock_timeout de 1 s,
// error 55P03) se repite, para medir el cálculo y no la espera.
async function comoGerente(sql, args = [], intento = 1) {
  const r = await comoGerenteUnaVez(sql, args);
  if (r.error === "55P03" && intento < 6) {
    console.log(`      (esperó un candado de otra sesión; intento ${intento + 1})`);
    await new Promise((ok) => setTimeout(ok, 3000));
    return comoGerente(sql, args, intento + 1);
  }
  return r;
}
async function comoGerenteUnaVez(sql, args) {
  await db.q("savepoint g");
  try {
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: GERENTE, role: "authenticated" })]);
    await db.q("set local role authenticated");
    await db.q("set local statement_timeout = '8s'");
    await db.q("set local lock_timeout = '1s'");
    const t = Date.now();
    const r = await db.q(sql, args);
    const ms = Date.now() - t;
    await db.q("release savepoint g");
    await db.q("reset role");
    await db.q("set local statement_timeout = 0");
    await db.q("set local lock_timeout = 0");
    return { r, ms };
  } catch (e) {
    await db.q("rollback to savepoint g");
    return { error: e.code, mensaje: e.message, ms: null };
  }
}
const permitirOtraBusqueda = () => db.q(`delete from public.fraude_detecciones where club_id = $1`, [DEMO]);

try {
  await db.q("begin");
  await db.q("set local statement_timeout = 0");
  await db.q(`select set_config('antroapp.borrado_pruebas', 'on', true)`);
  await db.q(`insert into public.club_funciones (club_id, funcion, activa) values ($1, 'antifraude', true)
              on conflict (club_id, funcion) do update set activa = true`, [DEMO]);
  await permitirOtraBusqueda();
  const rps = (await db.q(`select id from public.profiles where club_id = $1 and role = 'rp' order by id limit 6`, [DEMO])).map((r) => r.id);
  nota("hay 6 RPs en Club Demo Dev", rps.length === 6, `${rps.length}`);

  let t = Date.now();
  // 300 reservas de RP por noche, 93 noches (2/7 → 2/10).
  await db.q(`
    insert into public.reservations (cliente_nombre, cliente_telefono, rp_id, source, fecha, personas, status, qr_code, club_id, created_at)
    select 't_n4_fraude_carga',
           case when random() < 0.02 then 'tel ' || (random() * 999)::int  -- ilegible
                else '55' || lpad(((random() * 3999)::int)::text, 8, '0') end,
           ($1::uuid[])[1 + (random() * 5)::int], 'rp', d::date, 2, 'confirmada',
           't_n4_fraude_' || gen_random_uuid(), $2,
           ((d::date - 1 + time '12:00') at time zone 'America/Mexico_City') + random() * interval '20 hours'
      from generate_series('2026-07-02'::date, '2026-10-02'::date, interval '1 day') d
     cross join generate_series(1, 300) i`, [rps, DEMO]);
  // Ráfagas: un RP con 10 reservas en 3 minutos, una vez por semana.
  await db.q(`
    insert into public.reservations (cliente_nombre, cliente_telefono, rp_id, source, fecha, personas, status, qr_code, club_id, created_at)
    select 't_n4_fraude_carga', '56' || lpad((w * 100 + i)::text, 8, '0'), $1, 'rp', ('2026-08-01'::date + w * 7), 2, 'confirmada',
           't_n4_fraude_' || gen_random_uuid(), $2,
           (('2026-08-01'::date + w * 7 + time '22:00') at time zone 'America/Mexico_City') + i * interval '18 seconds'
      from generate_series(0, 8) w cross join generate_series(1, 10) i`, [rps[0], DEMO]);
  const reservas = Date.now() - t;

  // Caja: 150 cuentas cuadradas por noche del rango, con consumo.
  t = Date.now();
  const [mesa] = await db.q(`select id from public.club_tables where club_id = $1 order by numero limit 1`, [DEMO]);
  await db.q(`insert into public.caja_noches (club_id, fecha_operacion, estado)
              select $1, d::date, 'cerrada' from generate_series('2026-07-02'::date, '2026-10-02'::date, interval '1 day') d`, [DEMO]);
  await db.q(`insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado)
              select $1, n.id, $2, 'cuadrada' from public.caja_noches n
               where n.club_id = $1 and n.fecha_operacion between '2026-07-02' and '2026-10-02'`, [DEMO, mesa.id]);
  await db.q(`insert into public.mesa_cuentas (club_id, sesion_id, rp_id, origen, cliente_nombre, personas, liquidada_en)
              select $1, s.id, case when i % 3 = 0 then ($3::uuid[])[1 + ((i / 3) % 6)] end, 'walk_in', 't_n4_fraude_carga', 2, now()
                from public.mesa_sesiones s join public.caja_noches n on n.id = s.noche_id
               cross join generate_series(1, 150) i
               where s.club_id = $1 and n.fecha_operacion between '2026-07-02' and '2026-10-02' and s.mesa_id = $2`, [DEMO, mesa.id, rps]);
  await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, monto_centavos, registrado_por)
              select c.club_id, s.noche_id, s.id, s.mesa_id, c.id,
                     case when c.rp_id = $3 and random() < 0.3 then 3000 else 50000 + (random() * 150000)::int end, $2
                from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id
               where c.club_id = $1 and c.cliente_nombre = 't_n4_fraude_carga'`, [DEMO, GERENTE, rps[1]]);
  const caja = Date.now() - t;
  const [conteo] = await db.q(`select (select count(*)::int from public.reservations where cliente_nombre = 't_n4_fraude_carga') r,
                                      (select count(*)::int from public.mesa_cuentas where cliente_nombre = 't_n4_fraude_carga') c`);
  console.log(`      datos: ${conteo.r} reservas (${reservas} ms), ${conteo.c} cuentas con consumo (${caja} ms)`);
  await db.q("analyze public.reservations");

  // 63 noches.
  const d63 = await comoGerente(`select public.fraude_detectar($1, '2026-08-01', '2026-10-02') as d`, [DEMO]);
  nota(`gerente: detección de 63 noches con 300 reservas/noche en ${d63.ms} ms (< ${LIMITE_MS} ms, timeout 8 s)`,
    d63.ms !== null && d63.ms < LIMITE_MS, d63.mensaje);
  const r63 = d63.r?.[0]?.d;
  if (r63) console.log(`      resumen: ${JSON.stringify({ telefonos: r63.telefonos, ...Object.fromEntries(Object.entries(r63.reglas).map(([k, v]) => [k, v.detectadas])) })}`);
  nota("…encontró las 9 ráfagas sembradas", r63?.reglas?.rafaga?.detectadas >= 9, JSON.stringify(r63?.reglas?.rafaga));
  nota("…y cuentas de consumo bajo", r63?.reglas?.consumo_atipico?.detectadas >= 1, JSON.stringify(r63?.reglas?.consumo_atipico));
  nota("…y cuenta los teléfonos ilegibles", r63?.telefonos?.ilegibles > 300, JSON.stringify(r63?.telefonos));

  // Volver a correr (actualiza, no duplica).
  await permitirOtraBusqueda();
  const d63b = await comoGerente(`select public.fraude_detectar($1, '2026-08-01', '2026-10-02') as d`, [DEMO]);
  nota(`gerente: segunda detección de 63 noches en ${d63b.ms} ms (< ${LIMITE_MS} ms)`, d63b.ms !== null && d63b.ms < LIMITE_MS, d63b.mensaje);
  const r2 = d63b.r?.[0]?.d;
  nota("…0 nuevas", r2 && Object.values(r2.reglas).every((x) => !x.nuevas), JSON.stringify(r2?.reglas));

  // 14 noches.
  await permitirOtraBusqueda();
  const d14 = await comoGerente(`select public.fraude_detectar($1, '2026-09-19', '2026-10-02') as d`, [DEMO]);
  nota(`gerente: detección de 14 noches en ${d14.ms} ms (< ${LIMITE_MS} ms)`, d14.ms !== null && d14.ms < LIMITE_MS, d14.mensaje);

  // Lista y detalle.
  const l = await comoGerente(`select * from public.fraude_alertas_listar($1)`, [DEMO]);
  nota(`gerente: lista (100 de ${l.r?.[0]?.total ?? "?"}) en ${l.ms} ms`, l.ms !== null && l.ms < LIMITE_MS && l.r.length === Math.min(100, Number(l.r[0]?.total ?? 0)), l.mensaje);
  if (l.r?.[0]) {
    const det = await comoGerente(`select public.fraude_alerta_detalle($1)`, [l.r[0].id]);
    nota(`gerente: detalle en ${det.ms} ms`, det.ms !== null && det.ms < LIMITE_MS, det.mensaje);
  }
  // Límite de una búsqueda cada 2 minutos.
  const otra = await comoGerente(`select public.fraude_detectar($1, '2026-09-19', '2026-10-02')`, [DEMO]);
  nota("otra búsqueda enseguida: rechazada (una cada 2 minutos por antro)", otra.error === "P0001" && /2 minutos/.test(otra.mensaje), otra.mensaje);
} finally {
  await db.q("rollback").catch(() => {});
}
const [q] = await db.q(`select (select count(*)::int from public.reservations where cliente_nombre like 't_n4_fraude%') r,
  (select count(*)::int from public.fraude_alertas) a, (select count(*)::int from public.fraude_detecciones) d,
  (select count(*)::int from public.club_funciones where funcion = 'antifraude') f`);
nota("nada quedó en dev (todo se deshizo)", q.r === 0 && q.a === 0 && q.d === 0 && q.f === 0, JSON.stringify(q));
await db.fin();
const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length}`);
process.exit(ok === res.length ? 0 : 1);
