// Historia FICTICIA de caja para antroapp-dev: noches cerradas con mesas
// cuadradas, consumos, pagos y comisiones, para que la nómina y el panel de
// grupo tengan datos. Solo dev (se niega fuera de dev).
//
// La llama scripts/dev/sembrar-dev.mjs al final. Inserta directo (con el
// permiso de limpieza de pruebas, antroapp.borrado_pruebas, que solo usa el
// dueño de las tablas en dev) porque las funciones de caja solo operan la
// noche en curso.

import { randomUUID } from "node:crypto";
import { conectarDevEscritura } from "../db/conexion.mjs";

let semilla = 20261120;
const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
const entre = (a, b) => Math.floor(a + azar() * (b - a + 1));
const sumarDias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const nocheEn = (zona) => new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date(Date.now() - 8 * 3600e3));
const lunesDe = (iso) => { const d = new Date(iso + "T12:00:00Z"); const dia = d.getUTCDay() || 7; return sumarDias(iso, 1 - dia); };

// Estado de la comisión según la antigüedad de su semana.
function estadoPorSemana(noche, hoy) {
  const semanas = Math.round((Date.parse(lunesDe(hoy)) - Date.parse(lunesDe(noche))) / (7 * 86400e3));
  if (semanas >= 2) return "pagada";
  if (semanas === 1) return "validada";
  return "pendiente";
}

/**
 * @param {{ clubs: { id: string, zona: string, rp: string, staff: string, gerente: string, mesas: string[] }[], noches: number }} opciones
 */
export async function sembrarHistoria({ clubs, noches = 8 }) {
  const db = await conectarDevEscritura();
  let totales = { noches: 0, sesiones: 0, consumos: 0, comisiones: 0 };
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    let tel = 500;
    for (const c of clubs) {
      const hoy = nocheEn(c.zona);
      for (let k = noches; k >= 1; k--) {
        const noche = sumarDias(hoy, -k);
        const nocheId = randomUUID();
        const t0 = `${noche}T23:00:00`; // la hora exacta no importa: la noche manda
        await db.q(`insert into public.caja_noches (id, club_id, fecha_operacion, estado, abierta_por, abierta_en, cerrada_por, cerrada_en)
                    values ($1, $2, $3, 'abierta', $4, $5::timestamp, null, null)`, [nocheId, c.id, noche, c.staff, t0]);
        let regNoche = 0, efNoche = 0, taNoche = 0;
        const mesasNoche = c.mesas.slice(0, entre(2, Math.min(4, c.mesas.length)));
        for (const mesa of mesasNoche) {
          const sesion = randomUUID();
          await db.q(`insert into public.mesa_sesiones (id, club_id, noche_id, mesa_id, estado, abierta_por) values ($1, $2, $3, $4, 'abierta', $5)`, [sesion, c.id, nocheId, mesa, c.staff]);
          let regMesa = 0;
          const cuentas = [];
          // Cuenta con reserva de RP.
          const res = randomUUID();
          await db.q(`insert into public.reservations (id, cliente_nombre, cliente_telefono, personas, status, source, rp_id, club_id, fecha, qr_code, puerta_estado, entrada_en, mesa_id)
                      values ($1, $2, $3, $4, 'usada', 'rp', $5, $6, $7, $8, 'entro', $9::timestamp, $10)`,
            [res, `Cliente Historia ${tel}`, `0000000${tel++}`, entre(2, 6), c.rp, c.id, noche, `antro-${randomUUID()}`, t0, mesa]);
          cuentas.push({ id: randomUUID(), res, rp: c.rp, nombre: `Cliente Historia ${tel - 1}` });
          // Walk-in.
          cuentas.push({ id: randomUUID(), res: null, rp: null, nombre: "Walk-in" });
          for (const cu of cuentas) {
            await db.q(`insert into public.mesa_cuentas (id, club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_por)
                        values ($1, $2, $3, $4, $5, $6, $7, 2, $8)`, [cu.id, c.id, sesion, cu.res, cu.rp, cu.res ? "reserva" : "walk_in", cu.nombre, c.staff]);
            let base = 0;
            for (let j = 0; j < entre(1, 3); j++) {
              const monto = entre(8, 60) * 10000; // $800 a $6,000
              base += monto;
              await db.q(`insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id, monto_centavos, concepto, registrado_por)
                          values ($1, $2, $3, $4, $5, $6, $7, $8, 'Consumo', $9)`, [c.id, nocheId, sesion, mesa, cu.id, cu.res, cu.rp, monto, c.staff]);
              totales.consumos++;
            }
            regMesa += base;
            if (cu.res) {
              await db.q(`update public.reservations set consumo_monto = round($1::numeric / 100, 2) where id = $2`, [base, cu.res]);
              await db.q(`insert into public.commissions (reservation_id, rp_id, tipo, monto, status, pagada_en, pagada_por)
                          values ($1, $2, 'rp', 150, $3, case when $3 = 'pagada' then now() end, case when $3 = 'pagada' then $4::uuid end)`,
                [cu.res, c.rp, estadoPorSemana(noche, hoy), c.gerente]);
              totales.comisiones++;
            }
          }
          const ef = Math.round(regMesa * 0.4), ta = regMesa - ef;
          await db.q(`insert into public.caja_pagos (club_id, noche_id, sesion_id, metodo, monto_centavos, registrado_por) values ($1, $2, $3, 'efectivo', $4, $5), ($1, $2, $3, 'tarjeta', $6, $5)`,
            [c.id, nocheId, sesion, ef, c.staff, ta]);
          await db.q(`update public.mesa_cuentas set liquidada_en = now() where sesion_id = $1`, [sesion]);
          await db.q(`update public.mesa_sesiones set estado = 'cuadrada', cerrada_por = $2, cerrada_en = now(), cuadrada_por = $3, cuadrada_en = now() where id = $1`, [sesion, c.staff, c.gerente]);
          await db.q(`insert into public.caja_cuadres (club_id, noche_id, sesion_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos, hecho_por)
                      values ($1, $2, $3, 'mesa', $4, $5, $6, 0, 0, $7)`, [c.id, nocheId, sesion, regMesa, ef, ta, c.gerente]);
          regNoche += regMesa; efNoche += ef; taNoche += ta;
          totales.sesiones++;
        }
        const faltante = azar() < 0.3 ? 5000 : 0;
        await db.q(`insert into public.caja_cuadres (club_id, noche_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos,
                      contado_efectivo_centavos, contado_tarjeta_centavos, contado_otro_centavos, diferencia_centavos, hecho_por)
                    values ($1, $2, 'noche', $3, $4, $5, 0, 0, $6, $5, 0, $7, $8)`,
          [c.id, nocheId, regNoche, efNoche, taNoche, efNoche - faltante, -faltante, c.gerente]);
        await db.q(`update public.caja_noches set estado = 'cerrada', cerrada_por = $2, cerrada_en = now() where id = $1`, [nocheId, c.gerente]);
        totales.noches++;
      }
    }
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    throw e;
  } finally {
    await db.fin();
  }
  return totales;
}

// Borra la caja (y grupos) de los antros de dev. Solo dev, con el permiso de
// limpieza de pruebas.
export async function limpiarCajaDev(clubIds, nombreGrupo) {
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
      await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    await db.q("delete from public.grupo_clubs where club_id = any($1::uuid[])", [clubIds]);
    await db.q("delete from public.grupos where nombre = $1", [nombreGrupo]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    throw e;
  } finally {
    await db.fin();
  }
}
