// Caja de la demo (la usa scripts/demo-datos.mjs), por la API con la service
// role: funciona en dev y en producción DESPUÉS del pase (necesita las tablas
// de sql/2026-11-20-caja-por-mesa.sql). Los triggers de la caja se respetan:
// todo se inserta en el orden real (noche abierta -> mesa abierta -> cuentas
// -> consumos -> pagos -> cerrar -> cuadrar -> cerrar la noche).
//
// Por noche, las reservas que entraron se sientan en mesas compartidas (2 o
// 3 cuentas por mesa, cada una con su RP), con consumos "N × producto".
//   - Noches pasadas: todo cuadrado y la noche cerrada con su cuadre.
//   - Noche objetivo: una mesa con 3 grupos (2 cuadrados + 1 abierto), otra
//     con 2 grupos, mesas cuadradas, por cuadrar y abiertas, un walk-in, un
//     consumo anulado con motivo, una cuenta sentada sin consumo y 2 reservas
//     con entrada que aún no se sientan ("llegó, sin consumo").
// La comisión nace al cuadrar, por cuenta, con la regla del RP y el
// desbloqueo semanal (la reserva número N de la semana es la primera que paga).

import { randomUUID } from "node:crypto";

const CONCEPTO_POR_MONTO = {
  1200: "2 × Botella de vino tinto",
  1650: "3 × Cubeta de cerveza",
  1800: "1 × Botella de ron",
  2200: "1 × Botella de vodka",
  2400: "2 × Botella de mezcal",
  2900: "1 × Botella de tequila reposado",
  3200: "1 × Botella de tequila añejo",
  3600: "1 × Botella de whisky 12 años",
  4200: "2 × Botella de ginebra",
  4800: "2 × Botella de tequila",
  5500: "1 × Botella de champaña",
  6400: "2 × Botella de whisky",
  7800: "3 × Botella de tequila cristalino",
};
const conceptoDe = (pesos) => CONCEPTO_POR_MONTO[pesos] ?? "Consumo";
const lunesDe = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  const dia = d.getUTCDay() || 7;
  return new Date(d.getTime() - (dia - 1) * 86400e3).toISOString().slice(0, 10);
};

export async function escribirCaja({ svc, clubId, fechaObjetivo, reservas, consumos, reparto, rpIds, mesas, entre, alHora }) {
  const ok = (r, que) => {
    if (r.error) throw new Error(`${que}: ${r.error.message}`);
    return r.data;
  };
  const tot = { noches: 0, sesiones: 0, abiertas: 0, cerradas: 0, cuadradas: 0, consumos: 0, anulados: 0, comisiones: 0, sinMesa: 0, multigrupo: 0, porNoche: {} };
  const perfiles = ok(await svc.from("profiles").select("id, role").eq("club_id", clubId).in("role", ["staff", "gerente"]), "personal");
  const staff = perfiles.find((p) => p.role === "staff")?.id;
  const gerente = perfiles.find((p) => p.role === "gerente")?.id;
  if (!staff || !gerente) throw new Error("El antro demo necesita un staff y un gerente");
  const regla = Object.fromEntries(reparto.map((r) => [rpIds[r.clave], r]));
  const consumosDe = (resId) => consumos.filter((c) => c.reservation_id === resId);
  const conteoSemana = {}; // rp|lunes -> comisiones ya creadas esa semana

  const noches = [...new Set(reservas.map((r) => r.fecha))].filter((n) => n <= fechaObjetivo).sort();
  for (const noche of noches) {
    const objetivo = noche === fechaObjetivo;
    const porNoche = { consumo: 0, comisiones: 0 };
    tot.porNoche[noche] = porNoche;
    const nocheId = randomUUID();
    ok(await svc.from("caja_noches").insert({ id: nocheId, club_id: clubId, fecha_operacion: noche, estado: "abierta", abierta_por: staff, abierta_en: alHora(noche, 21, 30) }), "noche");
    tot.noches++;

    const entraron = reservas.filter((r) => r.fecha === noche && r.status === "usada");
    // Noche objetivo: 2 reservas con entrada que todavía no se sientan.
    const sinMesa = objetivo ? entraron.splice(-2, 2) : [];
    for (const r of sinMesa) {
      ok(await svc.from("reservations").update({ puerta_estado: "entro", entrada_en: alHora(noche, 23, 40), mesa_id: null }).eq("id", r.id), "entrada sin mesa");
      tot.sinMesa++;
    }

    // Grupos de 2 o 3 reservas.
    const grupos = [];
    for (let i = 0; i < entraron.length; ) {
      const n = Math.min(entre(2, 3), entraron.length - i);
      grupos.push(entraron.slice(i, i + n));
      i += n;
    }
    // Plan de mesas: en la noche objetivo la mesa 1 recibe 3 grupos y la
    // mesa 2 recibe 2 (los primeros cuadrados, el último abierto).
    const plan = grupos.map((g, i) => ({ grupo: g, mesa: i, estado: "cuadrada" }));
    if (objetivo && grupos.length >= 6) {
      plan[0].mesa = 0; plan[1].mesa = 0; plan[2].mesa = 0; plan[2].estado = "abierta";
      plan[3].mesa = 1; plan[4].mesa = 1; plan[4].estado = "abierta";
      const resto = plan.slice(5);
      resto.forEach((p, k) => {
        p.mesa = 2 + k;
        p.estado = k < Math.round(resto.length * 0.3) ? "cuadrada" : k < Math.round(resto.length * 0.5) ? "cerrada" : "abierta";
      });
      tot.multigrupo = 2;
    }

    let regNoche = 0, efNoche = 0, taNoche = 0, minuto = 0, anuladoHecho = false, cuentaVaciaHecha = false;
    for (const p of plan) {
      const mesa = mesas[p.mesa % mesas.length].id;
      const sesion = randomUUID();
      // Orden real de la noche: llegan y se sientan (21:30–22:10), consumen
      // (22:30 en adelante) y se cierra y cuadra de madrugada (03:00–04:00).
      const abiertaEn = alHora(noche, 21, 30 + minuto);
      const cerradaEn = alHora(noche, 27, minuto);
      const cuadradaEn = alHora(noche, 27, 30 + minuto);
      minuto += 3;
      ok(await svc.from("mesa_sesiones").insert({ id: sesion, club_id: clubId, noche_id: nocheId, mesa_id: mesa, estado: "abierta", abierta_por: staff, abierta_en: abiertaEn }), "sesión");
      tot.sesiones++;
      tot[p.estado === "abierta" ? "abiertas" : p.estado === "cerrada" ? "cerradas" : "cuadradas"]++;

      let regMesa = 0;
      const cuentas = [];
      for (const [k, r] of p.grupo.entries()) {
        const cuenta = randomUUID();
        ok(await svc.from("reservations").update({ mesa_id: mesa, puerta_estado: "entro", entrada_en: abiertaEn }).eq("id", r.id), "reserva entró");
        ok(await svc.from("mesa_cuentas").insert({ id: cuenta, club_id: clubId, sesion_id: sesion, reservation_id: r.id, rp_id: r.rp_id, origen: "reserva", cliente_nombre: r.cliente_nombre, personas: r.personas, creada_por: staff, creada_en: abiertaEn }), "cuenta");
        // Noche objetivo: una cuenta de mesa abierta sentada sin consumo todavía.
        const vacia = objetivo && p.estado === "abierta" && !cuentaVaciaHecha && k === p.grupo.length - 1 && p.grupo.length > 1;
        if (vacia) cuentaVaciaHecha = true;
        const filas = vacia ? [] : consumosDe(r.id).map((c) => ({
          club_id: clubId, noche_id: nocheId, sesion_id: sesion, mesa_id: mesa, cuenta_id: cuenta, reservation_id: r.id, rp_id: r.rp_id,
          monto_centavos: Math.round(c.monto * 100), concepto: conceptoDe(c.monto), registrado_por: staff, registrado_en: c.created_at,
        }));
        if (filas.length) ok(await svc.from("caja_consumos").insert(filas), "consumos");
        const base = filas.reduce((s, f) => s + f.monto_centavos, 0);
        tot.consumos += filas.length;
        porNoche.consumo += base / 100;
        regMesa += base;
        cuentas.push({ cuenta, r, base });
      }

      // Noche objetivo: walk-in y un cargo anulado con motivo en la primera mesa abierta.
      if (objetivo && p.estado === "abierta" && !anuladoHecho) {
        anuladoHecho = true;
        const walk = randomUUID();
        ok(await svc.from("mesa_cuentas").insert({ id: walk, club_id: clubId, sesion_id: sesion, origen: "walk_in", cliente_nombre: "Walk-in en barra", personas: 2, creada_por: staff }), "walk-in");
        ok(await svc.from("caja_consumos").insert({ club_id: clubId, noche_id: nocheId, sesion_id: sesion, mesa_id: mesa, cuenta_id: walk, monto_centavos: 85000, concepto: "1 × Botella de tequila", registrado_por: staff }), "consumo walk-in");
        regMesa += 85000;
        const [an] = ok(await svc.from("caja_consumos").insert({ club_id: clubId, noche_id: nocheId, sesion_id: sesion, mesa_id: mesa, cuenta_id: cuentas[0].cuenta, reservation_id: cuentas[0].r.id, rp_id: cuentas[0].r.rp_id, monto_centavos: 95000, concepto: "1 × Botella de whisky 18 años", registrado_por: staff }).select("id"), "consumo a anular");
        ok(await svc.from("caja_consumos").update({ anulado: true, anulado_por: gerente, anulado_en: new Date().toISOString(), motivo_anulacion: "Capturada dos veces por error" }).eq("id", an.id), "anular");
        ok(await svc.from("caja_eventos").insert({ club_id: clubId, noche_id: nocheId, sesion_id: sesion, tipo: "anular_consumo", detalle: { consumo_id: an.id, monto_centavos: 95000, motivo: "Capturada dos veces por error" }, hecho_por: gerente }), "evento");
        tot.anulados++;
        tot.consumos += 2;
      }

      // Pagos: completos si la mesa se cierra; parciales si sigue abierta.
      const pagar = p.estado === "abierta" ? Math.round(regMesa * (p.mesa % 2 ? 0 : 0.5)) : regMesa;
      const ef = Math.round(pagar * 0.4), ta = pagar - ef;
      const pagos = [];
      if (ef > 0) pagos.push({ club_id: clubId, noche_id: nocheId, sesion_id: sesion, metodo: "efectivo", monto_centavos: ef, registrado_por: staff });
      if (ta > 0) pagos.push({ club_id: clubId, noche_id: nocheId, sesion_id: sesion, metodo: "tarjeta", monto_centavos: ta, registrado_por: staff, referencia: "Terminal 1" });
      if (pagos.length) ok(await svc.from("caja_pagos").insert(pagos), "pagos");

      if (p.estado !== "abierta") {
        ok(await svc.from("mesa_sesiones").update({ estado: "cerrada", cerrada_por: staff, cerrada_en: cerradaEn }).eq("id", sesion), "cerrar");
      }
      if (p.estado === "cuadrada") {
        ok(await svc.from("caja_cuadres").insert({ club_id: clubId, noche_id: nocheId, sesion_id: sesion, tipo: "mesa", registrado_centavos: regMesa, cobrado_efectivo_centavos: ef, cobrado_tarjeta_centavos: ta, cobrado_otro_centavos: 0, saldo_sin_cobrar_centavos: 0, hecho_por: gerente }), "cuadre mesa");
        ok(await svc.from("mesa_sesiones").update({ estado: "cuadrada", cuadrada_por: gerente, cuadrada_en: cuadradaEn }).eq("id", sesion), "cuadrar");
        for (const { cuenta, r, base } of cuentas) {
          ok(await svc.from("mesa_cuentas").update({ liquidada_en: new Date().toISOString() }).eq("id", cuenta), "liquidar");
          if (base > 0) ok(await svc.from("reservations").update({ consumo_monto: Math.round(base) / 100 }).eq("id", r.id), "consumo reserva");
          const rg = r.rp_id ? regla[r.rp_id] : null;
          if (!rg || base <= 0) continue;
          // Desbloqueo semanal: la reserva número N de la semana es la primera que paga.
          const llave = `${r.rp_id}|${lunesDe(noche)}`;
          const llevas = conteoSemana[llave] ?? 0;
          conteoSemana[llave] = llevas + 1;
          const cent = llevas + 1 < (rg.desbloqueo ?? 0) ? 0 : rg.tipo === "fijo" ? Math.round(rg.monto * 100) : Math.round((base * rg.monto) / 100);
          ok(await svc.from("commissions").insert({ reservation_id: r.id, rp_id: r.rp_id, tipo: "rp", monto: cent / 100, status: "pendiente" }), "comisión");
          porNoche.comisiones += cent / 100;
          tot.comisiones++;
        }
      }
      regNoche += regMesa; efNoche += ef; taNoche += ta;
    }

    if (!objetivo) {
      ok(await svc.from("caja_cuadres").insert({ club_id: clubId, noche_id: nocheId, tipo: "noche", registrado_centavos: regNoche, cobrado_efectivo_centavos: efNoche, cobrado_tarjeta_centavos: taNoche, cobrado_otro_centavos: 0, saldo_sin_cobrar_centavos: 0, contado_efectivo_centavos: efNoche, contado_tarjeta_centavos: taNoche, contado_otro_centavos: 0, diferencia_centavos: 0, hecho_por: gerente }), "cuadre noche");
      ok(await svc.from("caja_noches").update({ estado: "cerrada", cerrada_por: gerente, cerrada_en: new Date().toISOString() }).eq("id", nocheId), "cerrar noche");
    }
  }
  return tot;
}

// ¿Ya hay caja ligada a las reservas demo? (En producción no se puede borrar
// por la API: "nada se borra en caja".)
export async function cajaDemoExistente(svc, reservaIds) {
  if (!reservaIds.length) return 0;
  let total = 0;
  for (let i = 0; i < reservaIds.length; i += 100) {
    const { count, error } = await svc.from("mesa_cuentas").select("id", { count: "exact", head: true }).in("reservation_id", reservaIds.slice(i, i + 100));
    if (error) throw new Error(`revisar caja demo: ${error.message}`);
    total += count ?? 0;
  }
  return total;
}

// ¿La base ya tiene la caja (sql/2026-11-20-caja-por-mesa.sql aplicado)?
export async function hayCaja(svc) {
  const { error } = await svc.from("caja_noches").select("id").limit(1);
  return !error;
}
