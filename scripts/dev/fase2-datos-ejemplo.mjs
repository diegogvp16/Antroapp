// Datos de ejemplo de la fase 2, bloque 8 (inventario y propinas) para
// «Club Demo Dev». SOLO DEV: se niega a correr contra producción
// (verificarEnvDev y conectarDevEscritura revisan la URL y las llaves).
//
//   node scripts/dev/fase2-datos-ejemplo.mjs [--fecha=AAAA-MM-DD] [--banderas]
//   node scripts/dev/fase2-datos-ejemplo.mjs --limpiar
//
// Arma, en una sola transacción, una noche PASADA y ya cerrada (por defecto,
// la de ayer; nunca la noche en curso, que usan otras pruebas):
//   - catálogo de 6 productos «Ejemplo F2 · …» con existencias iniciales;
//   - 4 mesas con walk-ins «Ejemplo F2 · …» (sin RP: no genera comisiones ni
//     toca la nómina), ventas del catálogo, un consumo libre y una venta
//     anulada (las existencias regresan);
//   - una entrada de mercancía, dos mermas y un conteo con diferencia;
//   - cobros con propina, propinas sueltas (una anulada), mesas cuadradas y
//     la noche cerrada con el conteo de lo cobrado (sin propinas);
//   - la regla del reparto (80 % personal con gerente, 20 % casa) y el
//     reparto entre el staff y el gerente de dev.
// Todo pasa por las funciones reales de la base, como el staff y el gerente
// de dev (auth.uid() de su sesión). Solo las horas se mueven después a la
// noche elegida (la base pone now()).
//
// Banderas: las enciende para crear y, al terminar, las deja como estaban
// (apagadas). Con --banderas las deja encendidas para ver las pantallas;
// --limpiar las deja como estaban antes de crear.
//
// --limpiar borra EXACTAMENTE lo que creó: productos «Ejemplo F2 · …» de Club
// Demo Dev (con su bitácora), las noches cuyas cuentas son todas «Ejemplo F2
// · …» (con mesas, consumos, cobros, propinas, cuadres, eventos y reparto) y
// y deja la regla del reparto y las banderas «inventario» y «propinas» de
// Club Demo Dev EXACTAMENTE como estaban antes de crear (las guarda al crear
// en un evento de la noche de ejemplo).

import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";

verificarEnvDev();
const CLUB = "0de70000-0000-4000-8000-000000000001"; // Club Demo Dev
const MARCA = "Ejemplo F2 · ";
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? null;
const LIMPIAR = process.argv.includes("--limpiar");
const DEJAR_BANDERAS = process.argv.includes("--banderas");

const db = await conectarDevEscritura();
const q = db.q;
const uno = async (sql, p) => (await q(sql, p))[0];
// La sesión de quien llama, como la pone Supabase en cada petición.
const como = (id) => q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated" })]);
const comoNadie = () => q("select set_config('request.jwt.claims', '', true)");

async function noches() {
  return (
    await q(
      `select n.id, n.fecha_operacion::text as fecha from public.caja_noches n
        where n.club_id = $1
          and exists (select 1 from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id
                       where s.noche_id = n.id and c.cliente_nombre like $2)
          and not exists (select 1 from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id
                           where s.noche_id = n.id and c.cliente_nombre not like $2)`,
      [CLUB, MARCA + "%"],
    )
  );
}

async function limpiar() {
  const ns = await noches();
  const ids = ns.map((n) => n.id);
  const prods = (await q("select id from public.productos where club_id = $1 and nombre like $2", [CLUB, MARCA + "%"])).map((p) => p.id);
  // Lo que había antes de crear (banderas y regla del reparto), guardado en un
  // evento de la noche de ejemplo. Sin ese evento no se tocan.
  const previo = ids.length
    ? (await uno("select detalle from public.caja_eventos where noche_id = any($1::uuid[]) and tipo = 'ejemplo_f2_previo' order by id limit 1", [ids]))?.detalle ?? null
    : null;
  await q("begin");
  try {
    await q("set local antroapp.borrado_pruebas = 'on'");
    const borrados = {};
    const borrar = async (nombre, sql, p) => {
      const r = await db.cliente.query(sql, p);
      borrados[nombre] = r.rowCount;
    };
    await borrar("líneas de reparto", "delete from public.propinas_reparto_lineas where reparto_id in (select id from public.propinas_repartos where noche_id = any($1::uuid[]))", [ids]);
    await borrar("repartos", "delete from public.propinas_repartos where noche_id = any($1::uuid[])", [ids]);
    await borrar("propinas sueltas", "delete from public.caja_propinas where noche_id = any($1::uuid[])", [ids]);
    await borrar("propinas de cobro anuladas", "delete from public.propinas_cobro_anuladas where noche_id = any($1::uuid[])", [ids]);
    await borrar("eventos", "delete from public.caja_eventos where noche_id = any($1::uuid[])", [ids]);
    await borrar("cuadres", "delete from public.caja_cuadres where noche_id = any($1::uuid[])", [ids]);
    await borrar("cobros", "delete from public.caja_pagos where noche_id = any($1::uuid[])", [ids]);
    await borrar("movimientos", "delete from public.producto_movimientos where producto_id = any($1::uuid[])", [prods]);
    await borrar("consumos", "delete from public.caja_consumos where noche_id = any($1::uuid[])", [ids]);
    await borrar("cuentas", "delete from public.mesa_cuentas where sesion_id in (select id from public.mesa_sesiones where noche_id = any($1::uuid[]))", [ids]);
    await borrar("mesas abiertas", "delete from public.mesa_sesiones where noche_id = any($1::uuid[])", [ids]);
    await borrar("noches", "delete from public.caja_noches where id = any($1::uuid[])", [ids]);
    await borrar("productos", "delete from public.productos where id = any($1::uuid[])", [prods]);
    if (previo) {
      // Exactamente lo que había: la regla (o ninguna) y las banderas (o ninguna).
      await borrar("regla del reparto (se restaura la anterior)", "delete from public.propinas_config where club_id = $1", [CLUB]);
      if (previo.regla)
        await q(
          "insert into public.propinas_config (club_id, pct_personal, pct_rp, pct_casa, incluye_gerente, actualizado_por, actualizado_en) values ($1, $2, $3, $4, $5, $6, $7)",
          [CLUB, previo.regla.pct_personal, previo.regla.pct_rp, previo.regla.pct_casa, previo.regla.incluye_gerente, previo.regla.actualizado_por, previo.regla.actualizado_en],
        );
      await borrar("banderas (se restauran las anteriores)", "delete from public.club_funciones where club_id = $1 and funcion in ('inventario', 'propinas')", [CLUB]);
      for (const b of previo.banderas ?? [])
        await q("insert into public.club_funciones (club_id, funcion, activa, cambiado_por, cambiado_en) values ($1, $2, $3, $4, $5)", [CLUB, b.funcion, b.activa, b.cambiado_por, b.cambiado_en]);
    } else if (ids.length) {
      console.log("  Aviso: no se encontró lo que había antes; banderas y regla no se tocan.");
    }
    await q("commit");
    console.log(`Limpieza de Club Demo Dev (noches ${ns.map((n) => n.fecha).join(", ") || "—"}):`);
    for (const [k, v] of Object.entries(borrados)) console.log(`  ${k}: ${v}`);
  } catch (e) {
    await q("rollback");
    throw e;
  }
  const resto = await uno(
    `select (select count(*) from public.productos where club_id = $1 and nombre like $2)::int productos,
            (select count(*) from public.mesa_cuentas where club_id = $1 and cliente_nombre like $2)::int cuentas,
            (select count(*) from public.club_funciones where club_id = $1 and funcion in ('inventario', 'propinas'))::int banderas,
            (select count(*) from public.propinas_config where club_id = $1)::int reglas`,
    [CLUB, MARCA + "%"],
  );
  console.log(`Quedan: ${JSON.stringify(resto)}`);
}

async function crear() {
  const fecha = arg("fecha") ?? (await uno("select (public.club_fecha_operacion($1) - 1)::text as f", [CLUB])).f;
  const hoy = (await uno("select public.club_fecha_operacion($1)::text as f", [CLUB])).f;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha >= hoy) throw new Error(`La noche de ejemplo debe ser pasada (hoy es ${hoy}): --fecha=${fecha}`);
  if ((await noches()).length || (await uno("select count(*)::int n from public.productos where club_id = $1 and nombre like $2", [CLUB, MARCA + "%"])).n)
    throw new Error("Ya hay datos de ejemplo: corre primero --limpiar");
  if ((await uno("select count(*)::int n from public.caja_noches where club_id = $1 and fecha_operacion = $2", [CLUB, fecha])).n)
    throw new Error(`Club Demo Dev ya tiene caja la noche ${fecha}: elige otra con --fecha`);
  // Lo que había antes (se guarda en la noche de ejemplo y --limpiar lo restaura tal cual).
  const previas = await q("select funcion, activa, cambiado_por, cambiado_en from public.club_funciones where club_id = $1 and funcion in ('inventario', 'propinas')", [CLUB]);
  const reglaPrevia = (await q("select pct_personal, pct_rp, pct_casa, incluye_gerente, actualizado_por, actualizado_en from public.propinas_config where club_id = $1", [CLUB]))[0] ?? null;
  const gerente = (await uno("select p.id from public.profiles p join auth.users u on u.id = p.id where u.email = 'dev_gerente@example.com' and p.club_id = $1", [CLUB]))?.id;
  const staff = (await uno("select p.id from public.profiles p join auth.users u on u.id = p.id where u.email = 'dev_staff@example.com' and p.club_id = $1", [CLUB]))?.id;
  if (!gerente || !staff) throw new Error("Faltan dev_gerente / dev_staff de Club Demo Dev (corre sembrar-dev)");
  // Cuatro mesas sin grupo abierto ahora (una mesa solo tiene una sesión
  // abierta a la vez; las de la noche en curso no se tocan).
  const mesas = await q(
    `select t.id, t.numero from public.club_tables t
      where t.club_id = $1 and not exists (select 1 from public.mesa_sesiones s where s.mesa_id = t.id and s.estado = 'abierta')
      order by case when t.numero ~ '^[0-9]+$' then t.numero::int end nulls last, t.numero limit 4`,
    [CLUB],
  );
  if (mesas.length < 4) throw new Error("Club Demo Dev necesita 4 mesas sin grupo abierto");

  await q("begin");
  try {
    // Banderas encendidas mientras se crea (las funciones nuevas las piden).
    await q(
      `insert into public.club_funciones (club_id, funcion, activa) values ($1, 'inventario', true), ($1, 'propinas', true)
       on conflict (club_id, funcion) do update set activa = true`,
      [CLUB],
    );
    const fn = async (quien, sql, p) => {
      await como(quien);
      const r = await uno(sql, p);
      await comoNadie();
      return r ? Object.values(r)[0] : null;
    };

    // ---- Catálogo (gerente) ----
    const catalogo = [
      ["Cerveza clara", "Cervezas", 9000, 48, 12],
      ["Cerveza oscura", "Cervezas", 9500, 24, 12],
      ["Botella de tequila", "Botellas", 280000, 6, 2],
      ["Botella de whisky", "Botellas", 320000, 4, 2],
      ["Agua mineral", "Sin alcohol", 4000, 30, 10],
      ["Refresco", "Sin alcohol", 4500, 30, 10],
    ];
    const P = {};
    for (const [nombre, cat, precio, ini, min] of catalogo)
      P[nombre] = await fn(gerente, "select public.producto_guardar($1, null, $2, $3, $4, $5, true, $6)", [CLUB, MARCA + nombre, cat, precio, min, ini]);

    // ---- La noche y sus mesas (la caja solo abre la noche de hoy: se crea
    //      directo, abierta, como la crearía caja_noche_actual) ----
    const noche = (await uno("insert into public.caja_noches (club_id, fecha_operacion, abierta_por) values ($1, $2, $3) returning id", [CLUB, fecha, gerente])).id;
    await q("insert into public.caja_eventos (club_id, noche_id, tipo, detalle) values ($1, $2, 'ejemplo_f2_previo', $3)", [CLUB, noche, JSON.stringify({ banderas: previas, regla: reglaPrevia })]);
    const S = [];
    const C = [];
    for (const [i, m] of mesas.entries()) {
      S[i] = (await uno("insert into public.mesa_sesiones (club_id, noche_id, mesa_id, abierta_por) values ($1, $2, $3, $4) returning id", [CLUB, noche, m.id, staff])).id;
      C[i] = await fn(staff, "select public.caja_sentar_cliente($1, null, $2, $3)", [S[i], `${MARCA}Mesa ${m.numero}`, 2 + i * 2]);
    }

    // ---- Ventas del catálogo (staff), un consumo libre y una anulación ----
    const vender = (i, prod, n) => fn(staff, "select public.caja_registrar_consumo_producto($1, $2, $3, gen_random_uuid())", [C[i], P[prod], n]);
    await vender(0, "Cerveza clara", 6);
    await vender(0, "Agua mineral", 2);
    await vender(1, "Botella de tequila", 1);
    await vender(1, "Refresco", 4);
    const anulada = await vender(2, "Botella de whisky", 1);
    await vender(2, "Cerveza oscura", 8);
    await vender(3, "Cerveza clara", 10);
    await vender(3, "Botella de whisky", 1);
    await fn(staff, "select public.caja_registrar_consumo($1, 15000, $2, gen_random_uuid())", [C[3], `${MARCA}Botana (fuera del catálogo)`]);
    await fn(gerente, "select public.caja_anular_consumo($1, $2)", [anulada, "Se capturó en la mesa equivocada"]);

    // ---- Inventario (gerente): entrada, mermas y conteo ----
    await fn(gerente, "select public.inventario_entrada($1, 24, 108000, $2, gen_random_uuid())", [P["Cerveza clara"], `${MARCA}Factura 1234`]);
    await fn(gerente, "select public.inventario_merma($1, 2, $2, gen_random_uuid())", [P["Cerveza clara"], "Se rompieron en la barra"]);
    await fn(gerente, "select public.inventario_merma($1, 1, $2, gen_random_uuid())", [P["Botella de tequila"], "Se derramó"]);
    await fn(gerente, "select public.inventario_conteo($1, 21, $2, gen_random_uuid())", [P["Refresco"], "Conteo de cierre: faltan 5"]);

    // ---- Cobros con propina y propinas sueltas (staff) ----
    for (const [i, metodo, propina] of [[0, "tarjeta", 5000], [1, "efectivo", 20000], [2, "tarjeta", 0], [3, "efectivo", 10000]]) {
      const saldo = Number((await uno("select registrado - (efectivo + tarjeta + otro) as s from public.caja_totales_sesion($1)", [S[i]])).s);
      await fn(staff, "select public.caja_registrar_pago($1, null, $2, $3, null, gen_random_uuid(), $3, $4)", [S[i], metodo, saldo, propina]);
    }
    await fn(staff, "select public.caja_registrar_propina($1, $2, $3, 'efectivo', 15000, $4, gen_random_uuid())", [noche, S[2], C[2], `${MARCA}la dejaron en la mesa`]);
    await fn(staff, "select public.caja_registrar_propina($1, null, null, 'efectivo', 8000, $2, gen_random_uuid())", [noche, `${MARCA}bote de la barra`]);
    const mal = await fn(staff, "select public.caja_registrar_propina($1, null, null, 'tarjeta', 3000, $2, gen_random_uuid())", [noche, `${MARCA}capturada dos veces`]);
    await fn(gerente, "select public.caja_anular_propina($1, $2)", [mal, "Capturada dos veces"]);

    // ---- Cuadrar mesas y cerrar la noche (gerente) ----
    for (const s of S) {
      await fn(gerente, "select public.caja_cerrar_mesa($1)", [s]);
      await fn(gerente, "select public.caja_cuadrar_mesa($1, null)", [s]);
    }
    const cobrado = await uno(
      `select coalesce(sum(monto_centavos) filter (where metodo = 'efectivo'), 0) ef, coalesce(sum(monto_centavos) filter (where metodo = 'tarjeta'), 0) ta,
              coalesce(sum(monto_centavos) filter (where metodo = 'otro'), 0) ot from public.caja_pagos where noche_id = $1 and not anulado`,
      [noche],
    );
    await fn(gerente, "select public.caja_cerrar_noche($1, $2, $3, $4, $5)", [noche, cobrado.ef, cobrado.ta, cobrado.ot, `${MARCA}noche de ejemplo`]);

    // ---- Regla y reparto (gerente) ----
    await fn(gerente, "select public.propinas_config_guardar($1, 80, 0, 20, true)", [CLUB]);
    await como(gerente);
    const total = (await uno("select coalesce(sum(monto_centavos), 0)::bigint t from public.propinas_de_noche($1)", [noche])).t;
    await comoNadie();
    await fn(gerente, "select public.propinas_repartir($1, $2::uuid[], $3, 80, 0, 20, true)", [noche, [staff, gerente], total]);

    // ---- Horas: todo a la noche elegida (la base puso now()) ----
    await q("set local antroapp.borrado_pruebas = 'on'");
    const base = `(($2::date + time '22:00') at time zone (select zona_horaria from public.clubs where id = $1))`;
    const mover = async (tabla, columna, filtro, orden = "id") =>
      q(
        `update public.${tabla} t set ${columna} = ${base} + (x.k * interval '6 minutes')
           from (select id, row_number() over (order by ${orden}) k from public.${tabla} where ${filtro}) x
          where t.id = x.id and t.${columna} is not null`,
        [CLUB, fecha, noche],
      );
    await mover("producto_movimientos", "hecho_en", "club_id = $1 and producto_id in (select id from public.productos where club_id = $1 and nombre like '" + MARCA + "%') and $3::uuid is not null", "orden");
    await mover("caja_consumos", "registrado_en", "noche_id = $3");
    await mover("caja_consumos", "anulado_en", "noche_id = $3");
    await mover("caja_pagos", "registrado_en", "noche_id = $3");
    await mover("caja_propinas", "registrado_en", "noche_id = $3");
    await mover("caja_propinas", "anulado_en", "noche_id = $3");
    await q(`update public.mesa_sesiones set abierta_en = ${base}, cerrada_en = ${base} + interval '5 hours', cuadrada_en = ${base} + interval '5 hours 10 minutes' where noche_id = $3`, [CLUB, fecha, noche]);
    await q(`update public.mesa_cuentas set creada_en = ${base} + interval '2 minutes' where sesion_id in (select id from public.mesa_sesiones where noche_id = $3)`, [CLUB, fecha, noche]);
    await q(`update public.caja_cuadres set hecho_en = ${base} + interval '5 hours 30 minutes' where noche_id = $3`, [CLUB, fecha, noche]);
    await q(`update public.caja_noches set abierta_en = ${base}, cerrada_en = ${base} + interval '5 hours 40 minutes' where id = $3`, [CLUB, fecha, noche]);
    await q(`update public.propinas_repartos set hecho_en = ${base} + interval '5 hours 50 minutes' where noche_id = $3`, [CLUB, fecha, noche]);
    await q(`update public.caja_eventos set hecho_en = ${base} + interval '5 hours' where noche_id = $3`, [CLUB, fecha, noche]);

    // Revisiones: nada de comisiones, existencias = bitácora, reparto = total.
    const rev = await uno(
      `select (select count(*) from public.commissions c join public.reservations r on r.id = c.reservation_id where r.club_id = $1 and r.fecha = $2)::int comisiones,
              (select count(*) from public.productos p where p.club_id = $1 and p.nombre like $4
                 and p.existencias <> (select coalesce(sum(m.cantidad), 0) from public.producto_movimientos m where m.producto_id = p.id))::int descuadres,
              (select sum(l.monto_centavos) from public.propinas_reparto_lineas l join public.propinas_repartos r on r.id = l.reparto_id where r.noche_id = $3 and not r.anulado)::bigint repartido`,
      [CLUB, fecha, noche, MARCA + "%"],
    );
    if (rev.descuadres !== 0 || Number(rev.repartido) !== Number(total)) throw new Error(`Revisión falló: ${JSON.stringify(rev)}`);

    if (!DEJAR_BANDERAS) {
      await q("delete from public.club_funciones where club_id = $1 and funcion in ('inventario', 'propinas')", [CLUB]);
      for (const b of previas)
        await q("insert into public.club_funciones (club_id, funcion, activa, cambiado_por, cambiado_en) values ($1, $2, $3, $4, $5)", [CLUB, b.funcion, b.activa, b.cambiado_por, b.cambiado_en]);
    }
    await q("commit");
    console.log(`Datos de ejemplo creados en Club Demo Dev, noche ${fecha} (cerrada):`);
    console.log(`  6 productos, 4 mesas, 9 consumos (1 anulado), 4 cobros, propinas $${Number(total) / 100} (repartidas), existencias = bitácora`);
    console.log(`  banderas inventario y propinas: ${DEJAR_BANDERAS ? "ENCENDIDAS (--limpiar las deja como estaban)" : "como estaban"}`);
    console.log("  Para quitarlo: node scripts/dev/fase2-datos-ejemplo.mjs --limpiar");
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

try {
  if (LIMPIAR) await limpiar();
  else await crear();
} finally {
  await db.fin();
}
