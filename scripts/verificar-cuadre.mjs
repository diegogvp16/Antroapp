// Verificación de cuadre (SOLO DEV, solo lectura). Para cada noche de caja
// compara las cifras que salen de lugares distintos y reporta cualquier
// diferencia, aunque sea de un centavo:
//
//   1. Cuadre de cada mesa: consumo registrado = suma de renglones vigentes;
//      cobrado por forma de pago = suma de cobros vigentes; saldo = resta.
//   2. Cierre de la noche: sus totales = suma de todos los renglones y cobros
//      de la noche; diferencia = contado − cobrado.
//   3. Comisiones del cuadre: una por cuenta liquidada con consumo de una
//      reserva de RP (modo reserva), con un monto que su regla permite (0 por
//      la cuota o el monto de la regla); consumo de la reserva = el de su cuenta.
//   4. Nómina semanal (nomina_semana_datos) = suma de comisiones de los
//      cuadres de esa semana, por RP; entradas = reservas con entrada.
//   5. /grupo (grupo_resumen) = caja y nómina: consumo, cuentas con consumo,
//      ticket promedio, reservas, entradas y comisiones, por antro y semana.
//   6. Panel del RP (rp_mis_reservas) = caja: consumo y comisión por reserva.
//
//   node scripts/verificar-cuadre.mjs [--club=<uuid>] [--desde=AAAA-MM-DD] [--hasta=AAAA-MM-DD]
//
// Corre en una transacción READ ONLY contra antroapp-dev; se niega a correr
// contra producción (conectarDevEscritura revisa el ref). Sale con código 1
// si encuentra alguna diferencia.

import { conectarDevEscritura } from "./db/conexion.mjs";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? null;
const CLUB = arg("club");
const DESDE = arg("desde") ?? "2000-01-01";
const HASTA = arg("hasta") ?? "2100-01-01";

const diferencias = [];
let revisiones = 0;
const cobertura = { mesas_cuadradas: 0, noches_cerradas: 0, cuentas_liquidadas: 0, comisiones_revisadas: 0, semanas: 0, grupo: 0, rps_panel: 0, reservas_panel: 0 };
function comparar(donde, que, a, b) {
  revisiones++;
  if (Number(a) !== Number(b)) diferencias.push(`${donde} · ${que}: ${a} ≠ ${b} (dif ${Number(a) - Number(b)})`);
}

const db = await conectarDevEscritura();
try {
  await db.q("begin transaction read only");

  const noches = await db.q(
    `select n.id, n.club_id, c.nombre, n.fecha_operacion::text as fecha, n.estado
     from public.caja_noches n join public.clubs c on c.id = n.club_id
     where n.fecha_operacion between $1 and $2 and ($3::uuid is null or n.club_id = $3)
     order by c.nombre, n.fecha_operacion`,
    [DESDE, HASTA, CLUB],
  );
  console.log(`Noches a revisar: ${noches.length}`);

  for (const n of noches) {
    const donde = `${n.nombre} ${n.fecha}`;
    // ---------- 1. Cuadre de cada mesa ----------
    const mesas = await db.q(
      `select q.sesion_id, q.registrado_centavos, q.cobrado_efectivo_centavos, q.cobrado_tarjeta_centavos,
              q.cobrado_otro_centavos, q.saldo_sin_cobrar_centavos, t.numero,
              coalesce((select sum(monto_centavos) from public.caja_consumos k where k.sesion_id = q.sesion_id and not k.anulado), 0) as renglones,
              coalesce((select sum(monto_centavos) from public.caja_pagos p where p.sesion_id = q.sesion_id and not p.anulado and p.metodo = 'efectivo'), 0) as efectivo,
              coalesce((select sum(monto_centavos) from public.caja_pagos p where p.sesion_id = q.sesion_id and not p.anulado and p.metodo = 'tarjeta'), 0) as tarjeta,
              coalesce((select sum(monto_centavos) from public.caja_pagos p where p.sesion_id = q.sesion_id and not p.anulado and p.metodo = 'otro'), 0) as otro
       from public.caja_cuadres q
       join public.mesa_sesiones s on s.id = q.sesion_id
       join public.club_tables t on t.id = s.mesa_id
       where q.noche_id = $1 and q.tipo = 'mesa'`,
      [n.id],
    );
    cobertura.mesas_cuadradas += mesas.length;
    for (const m of mesas) {
      const d = `${donde} mesa ${m.numero}`;
      comparar(d, "consumo del cuadre vs renglones", m.registrado_centavos, m.renglones);
      comparar(d, "efectivo del cuadre vs cobros", m.cobrado_efectivo_centavos, m.efectivo);
      comparar(d, "tarjeta del cuadre vs cobros", m.cobrado_tarjeta_centavos, m.tarjeta);
      comparar(d, "otro del cuadre vs cobros", m.cobrado_otro_centavos, m.otro);
      comparar(d, "saldo sin cobrar = consumo − cobrado", m.saldo_sin_cobrar_centavos,
        Number(m.registrado_centavos) - Number(m.cobrado_efectivo_centavos) - Number(m.cobrado_tarjeta_centavos) - Number(m.cobrado_otro_centavos));
    }
    const sinCuadre = await db.q(
      `select count(*)::int as n from public.mesa_sesiones s
       where s.noche_id = $1 and s.estado = 'cuadrada'
         and not exists (select 1 from public.caja_cuadres q where q.sesion_id = s.id and q.tipo = 'mesa')`,
      [n.id],
    );
    comparar(donde, "mesas cuadradas sin registro de cuadre", sinCuadre[0].n, 0);

    // ---------- 2. Cierre de la noche ----------
    const [cierre] = await db.q(
      `select q.*,
              coalesce((select sum(monto_centavos) from public.caja_consumos k where k.noche_id = $1 and not k.anulado), 0) as renglones,
              coalesce((select sum(monto_centavos) from public.caja_pagos p where p.noche_id = $1 and not p.anulado and p.metodo = 'efectivo'), 0) as efectivo,
              coalesce((select sum(monto_centavos) from public.caja_pagos p where p.noche_id = $1 and not p.anulado and p.metodo = 'tarjeta'), 0) as tarjeta,
              coalesce((select sum(monto_centavos) from public.caja_pagos p where p.noche_id = $1 and not p.anulado and p.metodo = 'otro'), 0) as otro
       from public.caja_cuadres q where q.noche_id = $1 and q.tipo = 'noche'`,
      [n.id],
    );
    if (n.estado === "cerrada") comparar(donde, "noche cerrada con su cuadre general", cierre ? 1 : 0, 1);
    if (cierre) {
      cobertura.noches_cerradas++;
      comparar(donde, "cierre: consumo vs renglones de la noche", cierre.registrado_centavos, cierre.renglones);
      comparar(donde, "cierre: efectivo vs cobros", cierre.cobrado_efectivo_centavos, cierre.efectivo);
      comparar(donde, "cierre: tarjeta vs cobros", cierre.cobrado_tarjeta_centavos, cierre.tarjeta);
      comparar(donde, "cierre: otro vs cobros", cierre.cobrado_otro_centavos, cierre.otro);
      const cobrado = Number(cierre.cobrado_efectivo_centavos) + Number(cierre.cobrado_tarjeta_centavos) + Number(cierre.cobrado_otro_centavos);
      const contado = Number(cierre.contado_efectivo_centavos) + Number(cierre.contado_tarjeta_centavos) + Number(cierre.contado_otro_centavos);
      comparar(donde, "cierre: diferencia = contado − cobrado", cierre.diferencia_centavos, contado - cobrado);
      const sumaMesas = mesas.reduce((s, m) => s + Number(m.registrado_centavos), 0);
      comparar(donde, "cierre: consumo = suma de los cuadres de mesa", cierre.registrado_centavos, sumaMesas);
    }

    // ---------- 3. Comisiones del cuadre ----------
    const cuentas = await db.q(
      `select c.id, c.reservation_id, c.rp_id, r.source, r.consumo_monto, cl.pago_rp_modo,
              coalesce(o.comision_tipo, cl.comision_tipo) as tipo,
              coalesce(o.comision_monto, cl.comision_monto) as monto_regla,
              coalesce((select sum(monto_centavos) from public.caja_consumos k where k.cuenta_id = c.id and not k.anulado), 0) as base,
              (select count(*) from public.commissions x where x.reservation_id = c.reservation_id and x.tipo = 'rp')::int as comisiones,
              (select round(x.monto * 100) from public.commissions x where x.reservation_id = c.reservation_id and x.tipo = 'rp' limit 1) as comision_cent
       from public.mesa_cuentas c
       join public.mesa_sesiones s on s.id = c.sesion_id
       join public.clubs cl on cl.id = c.club_id
       left join public.reservations r on r.id = c.reservation_id
       left join public.rp_comision_overrides o on o.club_id = c.club_id and o.rp_id = c.rp_id
       where s.noche_id = $1 and c.liquidada_en is not null`,
      [n.id],
    );
    cobertura.cuentas_liquidadas += cuentas.length;
    for (const c of cuentas) {
      const d = `${donde} cuenta ${c.id.slice(0, 8)}`;
      const base = Number(c.base);
      if (c.reservation_id && base > 0) comparar(d, "consumo de la reserva vs su cuenta (centavos)", Math.round(Number(c.consumo_monto) * 100), base);
      const generaComision = base > 0 && c.reservation_id && c.source === "rp" && c.rp_id && c.pago_rp_modo === "reserva";
      comparar(d, "comisiones de RP de la reserva", c.comisiones, generaComision ? 1 : 0);
      if (generaComision && c.comisiones === 1) {
        const regla = c.tipo === "fijo" ? Math.round(Number(c.monto_regla) * 100) : Math.round((base * Number(c.monto_regla)) / 100);
        cobertura.comisiones_revisadas++;
        const valido = Number(c.comision_cent) === 0 || Number(c.comision_cent) === regla;
        revisiones++;
        if (!valido) diferencias.push(`${d} · comisión ${c.comision_cent} no es 0 ni la de su regla (${regla})`);
      }
    }
  }

  // ---------- 4 y 5. Por antro y semana: nómina y /grupo ----------
  const semanas = await db.q(
    `select distinct n.club_id, c.nombre,
            (n.fecha_operacion - (extract(isodow from n.fecha_operacion)::int - 1))::text as lunes
     from public.caja_noches n join public.clubs c on c.id = n.club_id
     where n.fecha_operacion between $1 and $2 and ($3::uuid is null or n.club_id = $3)
     order by 2, 3`,
    [DESDE, HASTA, CLUB],
  );
  const adminId = (await db.q(`select id from public.profiles where role = 'admin' and activo is not false limit 1`))[0]?.id;
  for (const s of semanas) {
    const donde = `${s.nombre} semana del ${s.lunes}`;
    cobertura.semanas++;
    // Comisiones nacidas en los cuadres de esa semana (por la noche de la caja).
    const delCuadre = await db.q(
      `select x.rp_id, sum(round(x.monto * 100))::bigint as cent, count(*)::int as n
       from public.commissions x
       join public.mesa_cuentas c on c.reservation_id = x.reservation_id
       join public.mesa_sesiones ms on ms.id = c.sesion_id
       join public.caja_noches nn on nn.id = ms.noche_id
       where x.tipo = 'rp' and x.status <> 'anulada' and nn.club_id = $1
         and nn.fecha_operacion between $2::date and $2::date + 6
       group by x.rp_id`,
      [s.club_id, s.lunes],
    );
    const nomina = await db.q(`select * from public.nomina_semana_datos($1, $2::date, null)`, [s.club_id, s.lunes]);
    const porRp = new Map(nomina.map((r) => [r.rp_id, r]));
    for (const c of delCuadre) {
      const r = porRp.get(c.rp_id);
      comparar(`${donde} RP ${r?.rp_nombre ?? c.rp_id.slice(0, 8)}`, "nómina (comisión) vs comisiones de los cuadres", r?.comision_centavos ?? 0, c.cent);
    }
    const totalNominaCom = nomina.reduce((a, r) => a + Number(r.comision_centavos), 0);
    const totalCuadre = delCuadre.reduce((a, r) => a + Number(r.cent), 0);
    // Comisiones fuera de caja (flujo viejo, sin cuenta) explican la diferencia: se reportan aparte.
    const [viejas] = await db.q(
      `select coalesce(sum(round(x.monto * 100)), 0)::bigint as cent from public.commissions x
       join public.reservations r on r.id = x.reservation_id
       where x.tipo = 'rp' and x.status <> 'anulada' and r.club_id = $1 and r.fecha between $2::date and $2::date + 6
         and not exists (select 1 from public.mesa_cuentas c where c.reservation_id = x.reservation_id)`,
      [s.club_id, s.lunes],
    );
    comparar(donde, "nómina total (comisión) = cuadres + comisiones sin caja", totalNominaCom, totalCuadre + Number(viejas.cent));
    const entradas = await db.q(
      `select r.rp_id, count(*)::int as n from public.reservations r
       where r.club_id = $1 and r.source = 'rp' and r.fecha between $2::date and $2::date + 6
         and (r.puerta_estado = 'entro' or (r.puerta_estado is null and r.status = 'usada'))
       group by r.rp_id`,
      [s.club_id, s.lunes],
    );
    for (const e of entradas) comparar(`${donde} RP ${porRp.get(e.rp_id)?.rp_nombre ?? e.rp_id}`, "nómina: reservas que entraron", porRp.get(e.rp_id)?.reservas_entraron ?? 0, e.n);

    // /grupo como admin (ve todos los antros), mismo rango.
    if (adminId) {
      await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: adminId, role: "authenticated" })]);
      const [g] = await db.q(`select * from public.grupo_resumen($1::date, $1::date + 6) where club_id = $2`, [s.lunes, s.club_id]);
      const [caja] = await db.q(
        `select coalesce(sum(k.monto_centavos), 0)::bigint as cent, count(distinct k.cuenta_id)::int as cuentas
         from public.caja_consumos k join public.caja_noches nn on nn.id = k.noche_id
         where not k.anulado and nn.club_id = $1 and nn.fecha_operacion between $2::date and $2::date + 6`,
        [s.club_id, s.lunes],
      );
      const [res] = await db.q(
        `select count(*)::int as n,
                count(*) filter (where r.puerta_estado = 'entro' or (r.puerta_estado is null and r.status = 'usada'))::int as entraron
         from public.reservations r where r.club_id = $1 and r.fecha between $2::date and $2::date + 6`,
        [s.club_id, s.lunes],
      );
      const totalNomina = nomina.reduce((a, r) => a + Number(r.total_centavos), 0);
      if (!g) {
        diferencias.push(`${donde} · /grupo no devolvió el antro para el admin`);
      } else {
        cobertura.grupo++;
        comparar(donde, "/grupo consumo vs caja", g.consumo_centavos, caja.cent);
        comparar(donde, "/grupo cuentas con consumo vs caja", g.cuentas_con_consumo, caja.cuentas);
        comparar(donde, "/grupo ticket promedio = consumo / cuentas", g.ticket_promedio_centavos, caja.cuentas ? Math.round(Number(caja.cent) / caja.cuentas) : 0);
        comparar(donde, "/grupo reservas", g.reservas, res.n);
        comparar(donde, "/grupo entraron", g.entraron, res.entraron);
        comparar(donde, "/grupo comisiones vs nómina (comisión + días)", g.comisiones_centavos, totalNomina);
      }
    }
  }

  // ---------- 6. Panel del RP ----------
  const rps = await db.q(
    `select distinct c.rp_id, p.nombre, p.activo from public.mesa_cuentas c
     join public.mesa_sesiones s on s.id = c.sesion_id join public.caja_noches n on n.id = s.noche_id
     join public.profiles p on p.id = c.rp_id
     where c.rp_id is not null and n.fecha_operacion between $1 and $2 and ($3::uuid is null or n.club_id = $3)`,
    [DESDE, HASTA, CLUB],
  );
  for (const rp of rps) {
    if (rp.activo === false) continue;
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: rp.rp_id, role: "authenticated" })]);
    const filas = await db.q(
      `select m.reservation_id, m.consumo_centavos, m.comision_centavos,
              coalesce((select sum(k.monto_centavos) from public.caja_consumos k join public.mesa_cuentas c on c.id = k.cuenta_id
                        where c.reservation_id = m.reservation_id and not k.anulado), 0) as caja,
              (select round(x.monto * 100) from public.commissions x where x.reservation_id = m.reservation_id and x.tipo = 'rp' and x.status <> 'anulada') as comision
       from public.rp_mis_reservas(greatest($1::date, current_date - 62), least($2::date, greatest($1::date, current_date - 62) + 62)) m`,
      [DESDE, HASTA],
    ).catch((e) => { diferencias.push(`Panel RP ${rp.nombre}: ${e.message}`); return []; });
    cobertura.rps_panel++;
    cobertura.reservas_panel += filas.length;
    for (const f of filas) {
      if (f.consumo_centavos !== null) comparar(`Panel RP ${rp.nombre} reserva ${f.reservation_id.slice(0, 8)}`, "consumo en el panel vs caja", f.consumo_centavos, f.caja);
      if (f.comision !== null) comparar(`Panel RP ${rp.nombre} reserva ${f.reservation_id.slice(0, 8)}`, "comisión en el panel vs nómina", f.comision_centavos ?? 0, f.comision);
    }
  }
  await db.q("rollback");
} finally {
  await db.fin();
}

console.log(`Revisiones: ${revisiones}`);
console.log(`Cobertura: ${JSON.stringify(cobertura)}`);
if (diferencias.length) {
  console.log(`\nDIFERENCIAS (${diferencias.length}):`);
  for (const d of diferencias.slice(0, 200)) console.log("  " + d);
  if (diferencias.length > 200) console.log(`  … y ${diferencias.length - 200} más`);
  process.exitCode = 1;
} else {
  console.log("Sin diferencias: caja, cuadres, comisiones, nómina, /grupo y panel del RP coinciden al centavo.");
}
