// Caja FICTICIA para la noche demo en antroapp-dev (la usa
// scripts/demo-datos.mjs --env=.env.dev). Solo dev: la conexión de
// escritura se niega fuera de dev.
//
// Por noche: las reservas que entraron se sientan en mesas compartidas (2 o
// 3 cuentas por mesa, cada una con su RP), con sus consumos.
//   - Semana anterior: todas las mesas cuadradas y la noche cerrada con su
//     cuadre; las comisiones nacen al cuadrar (como en la caja real).
//   - Noche objetivo: ~40% de mesas cuadradas, ~20% cerradas (pagadas, sin
//     cuadrar) y el resto abiertas (con pago parcial), una cuenta walk-in y
//     un consumo anulado con motivo. La noche queda abierta para operar.
// Se inserta directo con el permiso de limpieza de pruebas (las funciones de
// caja solo operan la noche en curso y con sesión de usuario).

import { randomUUID } from "node:crypto";
import { conectarDevEscritura } from "../db/conexion.mjs";

export async function escribirCajaDev({ clubId, fechaObjetivo, reservas, consumos, reparto, rpIds, mesas, azar, entre }) {
  const db = await conectarDevEscritura();
  const tot = { noches: 0, sesiones: 0, abiertas: 0, cerradas: 0, cuadradas: 0, consumos: 0, anulados: 0, comisiones: 0, porNoche: {} };
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    const [staff] = await db.q("select id from public.profiles where club_id = $1 and role = 'staff' order by nombre limit 1", [clubId]);
    const [gerente] = await db.q("select id from public.profiles where club_id = $1 and role = 'gerente' order by nombre limit 1", [clubId]);
    if (!staff || !gerente) throw new Error("Club Demo Dev necesita un staff y un gerente (corre scripts/dev/sembrar-dev.mjs)");
    const reglaDe = Object.fromEntries(reparto.map((r) => [rpIds[r.clave], r]));
    const consumosDe = (resId) => consumos.filter((c) => c.reservation_id === resId);

    const noches = [...new Set(reservas.map((r) => r.fecha))].sort();
    for (const noche of noches) {
      const objetivo = noche === fechaObjetivo;
      const porNoche = { consumo: 0, comisiones: 0 };
      tot.porNoche[noche] = porNoche;
      const nocheId = randomUUID();
      await db.q(`insert into public.caja_noches (id, club_id, fecha_operacion, estado, abierta_por) values ($1, $2, $3, 'abierta', $4)`, [nocheId, clubId, noche, staff.id]);
      tot.noches++;

      // Grupos de 2 o 3 reservas que entraron, una mesa por grupo.
      const entraron = reservas.filter((r) => r.fecha === noche && r.status === "usada");
      const grupos = [];
      for (let i = 0; i < entraron.length;) { const n = Math.min(entre(2, 3), entraron.length - i); grupos.push(entraron.slice(i, i + n)); i += n; }
      let regNoche = 0, efNoche = 0, taNoche = 0;
      for (const [g, grupo] of grupos.entries()) {
        const mesa = mesas[g % mesas.length].id;
        const estado = !objetivo ? "cuadrada" : g < Math.round(grupos.length * 0.4) ? "cuadrada" : g < Math.round(grupos.length * 0.6) ? "cerrada" : "abierta";
        const sesion = randomUUID();
        await db.q(`insert into public.mesa_sesiones (id, club_id, noche_id, mesa_id, estado, abierta_por) values ($1, $2, $3, $4, 'abierta', $5)`, [sesion, clubId, nocheId, mesa, staff.id]);
        tot.sesiones++;
        tot[estado === "abierta" ? "abiertas" : estado === "cerrada" ? "cerradas" : "cuadradas"]++;

        let regMesa = 0;
        const cuentas = [];
        for (const r of grupo) {
          const cuenta = randomUUID();
          await db.q(`update public.reservations set mesa_id = $2, puerta_estado = 'entro', entrada_en = coalesce(entrada_en, now()) where id = $1`, [r.id, mesa]);
          await db.q(`insert into public.mesa_cuentas (id, club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_por)
                      values ($1, $2, $3, $4, $5, 'reserva', $6, $7, $8)`, [cuenta, clubId, sesion, r.id, r.rp_id, r.cliente_nombre, r.personas, staff.id]);
          let base = 0;
          for (const c of consumosDe(r.id)) {
            const cent = Math.round(c.monto * 100);
            await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id, monto_centavos, concepto, registrado_por, registrado_en)
                        values ($1, $2, $3, $4, $5, $6, $7, $8, 'Consumo', $9, $10)`, [clubId, nocheId, sesion, mesa, cuenta, r.id, r.rp_id, cent, staff.id, c.created_at]);
            base += cent;
            tot.consumos++;
          }
          porNoche.consumo += base / 100;
          regMesa += base;
          cuentas.push({ cuenta, r, base });
        }

        // Noche objetivo: en la primera mesa abierta, un walk-in y un cargo anulado con motivo.
        if (objetivo && estado === "abierta" && tot.anulados === 0) {
          const walk = randomUUID();
          await db.q(`insert into public.mesa_cuentas (id, club_id, sesion_id, origen, cliente_nombre, personas, creada_por) values ($1, $2, $3, 'walk_in', 'Walk-in en barra', 2, $4)`, [walk, clubId, sesion, staff.id]);
          await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, monto_centavos, concepto, registrado_por) values ($1, $2, $3, $4, $5, 85000, 'Botella', $6)`, [clubId, nocheId, sesion, mesa, walk, staff.id]);
          regMesa += 85000;
          const [anulado] = await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id, monto_centavos, concepto, registrado_por)
                      values ($1, $2, $3, $4, $5, $6, $7, 95000, 'Botella (capturada dos veces)', $8) returning id`, [clubId, nocheId, sesion, mesa, cuentas[0].cuenta, cuentas[0].r.id, cuentas[0].r.rp_id, staff.id]);
          await db.q(`update public.caja_consumos set anulado = true, anulado_por = $2, anulado_en = now(), motivo_anulacion = 'Capturada dos veces por error' where id = $1`, [anulado.id, gerente.id]);
          await db.q(`insert into public.caja_eventos (club_id, noche_id, sesion_id, tipo, detalle, hecho_por) values ($1, $2, $3, 'anular_consumo', $4, $5)`,
            [clubId, nocheId, sesion, JSON.stringify({ consumo_id: anulado.id, monto_centavos: 95000, motivo: "Capturada dos veces por error" }), gerente.id]);
          tot.anulados++;
          tot.consumos += 2;
        }

        // Pagos: completos en mesas cerradas o cuadradas; parciales en abiertas.
        const pagar = estado === "abierta" ? Math.round(regMesa * (azar() < 0.5 ? 0 : 0.5)) : regMesa;
        const ef = Math.round(pagar * 0.4), ta = pagar - ef;
        if (ef > 0) await db.q(`insert into public.caja_pagos (club_id, noche_id, sesion_id, metodo, monto_centavos, registrado_por) values ($1, $2, $3, 'efectivo', $4, $5)`, [clubId, nocheId, sesion, ef, staff.id]);
        if (ta > 0) await db.q(`insert into public.caja_pagos (club_id, noche_id, sesion_id, metodo, monto_centavos, registrado_por, referencia) values ($1, $2, $3, 'tarjeta', $4, $5, 'Terminal 1')`, [clubId, nocheId, sesion, ta, staff.id]);

        if (estado !== "abierta") {
          await db.q(`update public.mesa_sesiones set estado = 'cerrada', cerrada_por = $2, cerrada_en = now() where id = $1`, [sesion, staff.id]);
        }
        if (estado === "cuadrada") {
          await db.q(`insert into public.caja_cuadres (club_id, noche_id, sesion_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos, hecho_por)
                      values ($1, $2, $3, 'mesa', $4, $5, $6, 0, 0, $7)`, [clubId, nocheId, sesion, regMesa, ef, ta, gerente.id]);
          await db.q(`update public.mesa_sesiones set estado = 'cuadrada', cuadrada_por = $2, cuadrada_en = now() where id = $1`, [sesion, gerente.id]);
          // Comisión al cuadrar, por cuenta, sobre lo vigente de esa cuenta.
          for (const { cuenta, r, base } of cuentas) {
            await db.q(`update public.mesa_cuentas set liquidada_en = now() where id = $1`, [cuenta]);
            if (base > 0) await db.q(`update public.reservations set consumo_monto = round($2::numeric / 100, 2) where id = $1`, [r.id, base]);
            const regla = r.rp_id ? reglaDe[r.rp_id] : null;
            if (!regla || base <= 0) continue;
            const cent = regla.tipo === "fijo" ? Math.round(regla.monto * 100) : Math.round((base * regla.monto) / 100);
            await db.q(`insert into public.commissions (reservation_id, rp_id, tipo, monto, status) values ($1, $2, 'rp', round($3::numeric / 100, 2), 'pendiente')`, [r.id, r.rp_id, cent]);
            porNoche.comisiones += cent / 100;
            tot.comisiones++;
          }
        }
        regNoche += regMesa; efNoche += ef; taNoche += ta;
      }

      if (!objetivo) {
        await db.q(`insert into public.caja_cuadres (club_id, noche_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos,
                      contado_efectivo_centavos, contado_tarjeta_centavos, contado_otro_centavos, diferencia_centavos, hecho_por)
                    values ($1, $2, 'noche', $3, $4, $5, 0, 0, $4, $5, 0, 0, $6)`, [clubId, nocheId, regNoche, efNoche, taNoche, gerente.id]);
        await db.q(`update public.caja_noches set estado = 'cerrada', cerrada_por = $2, cerrada_en = now() where id = $1`, [nocheId, gerente.id]);
      }
    }
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    throw e;
  } finally {
    await db.fin();
  }
  return tot;
}
