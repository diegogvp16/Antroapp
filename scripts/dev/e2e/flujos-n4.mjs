// Flujos de post-junta-3 (bloque 9, parte 1): una por función nueva, por la
// interfaz (Playwright a 390×844 táctil) y comprobada en la base, encadenada
// a la noche de los flujos 1–8 donde tiene sentido. Cada función va detrás
// de su bandera (sql/post-junta-3/00, por antro; /para-clubes por la de
// plataforma de sql/post-junta-3/50): primero se revisa que con la bandera
// apagada no se vea (un paso) y luego que con la bandera encendida funcione.
// Las banderas se encienden SOLO para el antro de la corrida y se dejan como
// estaban al terminar cada flujo (y otra vez al final, flujo B).
//
// Antes del cierre (necesitan la noche abierta; corren entre el 7 y el 8):
//   9)  Escáner de respaldo: código corto leído del boleto, con señal y sin
//       señal (la entrada se guarda en el teléfono y se envía sola).
//   10) Inventario y propina en el cobro (fase 2): walk-in en la Mesa 3,
//       producto del catálogo (baja el inventario), cobro con propina aparte
//       y cuadre. El flujo 8 suma ese cobro en tarjeta.
// Después del cierre (flujo 8):
//   11) Reparto de las propinas de la noche cerrada.
//   12) Ventas del POS ligadas a las cuentas de las Mesas 1 y 2.
//   13) Reporte PDF de la noche (/grupo/reportes) = cifras de la base.
//   14) Lista negra: el gerente bloquea un teléfono y el formulario público
//       lo rechaza con el mensaje neutro.
//   15) WhatsApp: el enlace wa.me de la lista del staff trae el número y el
//       texto correctos y abrirlo no manda nada.
//   16) /para-clubes: 404 con la bandera apagada; con ella, el contacto se
//       guarda y lo ve el admin.
//   B)  Banderas restauradas.
//
// (Pendiente) Antifraude: la bandera 'antifraude' se sigue corrigiendo en
// otra rama y NO entra en esta suite todavía. Su lugar está marcado abajo
// («LUGAR PARA ANTIFRAUDE»).

import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afirmar } from "./utiles.mjs";
import { banderaClub, banderaPlataforma, banderasDelAntro, correoContacto, ponerBanderaPlataforma, ZONA } from "./datos.mjs";
import {
  T_NAV, abrirCaja, abrirMesa, dialogo, entrar, nuevaPagina, sesionesDeMesa, una,
} from "./flujos.mjs";

// ---------- Ayudas ----------
const SIN_SENAL = 45_000;

// Página con sesión de staff o gerente: la de los flujos 3/6 si existe; si no
// (porque esos flujos no corrieron), una nueva.
async function paginaDe(c, clave) {
  const campo = { staff: "pStaff", gerente: "pGerente", admin: "pAdmin" }[clave];
  if (c[campo] && !c[campo].isClosed()) return c[campo];
  const p = await nuevaPagina(c, c.nav, clave);
  await entrar(c, p, c.esc.usuarios[clave], clave === "admin" ? /\/admin/ : /\/staff\/panel/);
  return (c[campo] = p);
}

// Panel del staff cargado (gerente: con sus botones). Las banderas se leen
// aparte (useFunciones): un enlace que falta se revisa después de un margen.
async function abrirPanel(c, p, { gerente = false } = {}) {
  await p.goto(c.base + "/staff/panel", { timeout: T_NAV });
  await p.getByRole("heading", { name: `Panel de ${c.esc.club.nombre}` }).waitFor({ timeout: T_NAV });
  // Los botones-enlace del panel (Base UI) no tienen rol de enlace: por su href.
  if (gerente) await p.locator('a[href="/staff/exportar"]').waitFor({ timeout: T_NAV });
}
async function noAparece(p, loc, ms = 2500) {
  await p.waitForTimeout(ms);
  return (await loc.count()) === 0;
}

async function nocheCerrada(c) {
  const n = await una(c.db, `select estado from public.caja_noches where club_id = $1 and fecha_operacion = $2`, [c.esc.club.id, c.esc.noche]);
  return n?.estado === "cerrada";
}

// Reserva de preparación (service role), con la marca de la corrida.
async function crearReserva(c, { nombre, fecha, telefono, personas = 2 }) {
  const r = { id: randomUUID(), cliente_nombre: nombre, cliente_telefono: telefono, personas, status: "pendiente", source: "organica",
    club_id: c.esc.club.id, fecha, qr_code: `antro-${randomUUID()}` };
  const ins = await c.svc.from("reservations").insert(r);
  if (ins.error) throw new Error("reserva de preparación: " + ins.error.message);
  return r;
}

// Bandera del antro de la corrida, con reintento (dev compartido: otro
// carril puede tener la tabla ocupada con un DDL).
async function bandera(c, funcion, activa) {
  for (let i = 1; ; i++) {
    try {
      return await banderaClub(c.db, c.esc.club.id, funcion, activa);
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

// Texto del PDF que arma lib/pdf/escritor.ts: ASCII con cada texto en una
// cadena hexadecimal «<…> Tj» (WinAnsi; para cifras y nombres basta latin1).
function textosDePdf(buf) {
  const s = buf.toString("latin1");
  return [...s.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
}
const pesos2 = (centavos) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(centavos / 100);

// Hora local del antro de un instante de la base, como la exporta un POS.
async function fechaHoraLocal(c, ts) {
  return una(c.db, `select to_char($1::timestamptz at time zone $2, 'DD/MM/YYYY') fecha, to_char($1::timestamptz at time zone $2, 'HH24:MI') hora`, [ts, ZONA]);
}

// ===================================================================
// Antes del cierre: 9 y 10.
// ===================================================================
export async function flujosAntesDelCierre(c, { tel, mesa }) {
  const { corredor: run, esc } = c;
  const u = esc.usuarios;
  c.navegadoresExtra ??= [];

  // ---------------- 9) Escáner de respaldo ----------------
  await run.flujo("9", "Escáner de respaldo: código corto con señal y sin señal (antes del cierre)",
    async () => ((await nocheCerrada(c)) ? "la noche ya está cerrada: la puerta no acepta entradas" : null),
    async (f) => {
      const R = {};
      const anon = c.pAnon ?? (c.pAnon = await nuevaPagina(c, c.nav, "anonimo"));
      try {
        await f.paso("Preparación: dos reservas de esta noche para la puerta (service role, con la marca)", async () => {
          R.linea = await crearReserva(c, { nombre: `${esc.tag} Respaldo Con Senal`, fecha: esc.noche, telefono: tel(4) });
          R.sinRed = await crearReserva(c, { nombre: `${esc.tag} Respaldo Sin Senal`, fecha: esc.noche, telefono: tel(5) });
          return `${R.linea.qr_code.slice(-6)} y ${R.sinRed.qr_code.slice(-6)}`;
        });
        await f.paso("Bandera escaner_respaldo apagada: el boleto /r/<código> no muestra el código corto", async () => {
          await bandera(c, "escaner_respaldo", null);
          await anon.goto(`${c.base}/r/${R.linea.qr_code}`, { timeout: T_NAV });
          await anon.locator("[data-prueba=qr-boleto]").waitFor({ timeout: T_NAV });
          afirmar(await noAparece(anon, anon.locator("[data-prueba=codigo-respaldo]")), "con la bandera apagada el boleto muestra el código corto");
        }, { pagina: anon });
        await f.paso("Bandera encendida (solo este antro): cada boleto muestra su código corto (los 6 últimos del QR)", async () => {
          await bandera(c, "escaner_respaldo", true);
          for (const r of [R.linea, R.sinRed]) {
            await anon.goto(`${c.base}/r/${r.qr_code}`, { timeout: T_NAV });
            const t = await anon.locator("[data-prueba=codigo-respaldo] span.font-mono").innerText({ timeout: 30_000 });
            r.corto = t.trim();
            afirmar(r.corto.replace(/\s/g, "") === r.qr_code.slice(-6).toUpperCase(), `el boleto dice «${r.corto}» y el QR termina en ${r.qr_code.slice(-6)}`);
          }
          return `con señal: ${R.linea.corto} · sin señal: ${R.sinRed.corto}`;
        }, { pagina: anon });

        // Cámara falsa SIN video propio (patrón de prueba de Chrome): el lector
        // no ve ningún QR, como una cámara que no lee.
        const nav = await c.chromium.launch({ headless: c.headless, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
        c.navegadoresExtra.push(nav);
        const p = await nuevaPagina(c, nav, "staff-respaldo", { camara: true });
        const ctx = p.context();
        p.on("dialog", (d) => void d.dismiss());
        await f.paso("Staff en otro teléfono: el panel baja la copia de la noche para escanear sin señal", async () => {
          await entrar(c, p, u.staff, /\/staff\/panel/);
          const copia = p.locator("[data-prueba=copia-puerta]", { hasText: "copia de las" });
          await copia.waitFor({ timeout: 45_000 });
          return (await copia.innerText()).replace(/\s+/g, " ");
        }, { pagina: p });
        await f.paso("Con señal: «Escanear QR» → escribe el código corto del boleto → «Confirmar entrada»", async () => {
          await p.getByRole("button", { name: "Escanear QR" }).first().click();
          await p.locator("#codigo-boleto").fill(R.linea.corto);
          await p.getByRole("button", { name: "Buscar" }).click();
          await p.getByRole("button", { name: "Confirmar entrada", exact: true }).waitFor({ timeout: 30_000 });
          afirmar((await p.locator("[data-prueba=ficha-sin-senal]").count()) === 0, "con señal la ficha dice que se validó con la copia");
          afirmar((await p.locator("body").innerText()).includes(R.linea.cliente_nombre), "la ficha no muestra al cliente");
          await p.getByRole("button", { name: "Confirmar entrada", exact: true }).click();
          await p.getByText(/¡Entrada confirmada!/).first().waitFor();
        }, { pagina: p });
        await f.verificar("Base: la reserva del código corto queda usada / entró, con el staff, por el camino de siempre (puerta_confirmar_entrada)", async () => {
          const r = await una(c.db, `select status, puerta_estado, entrada_por,
                                            (select count(*)::int from public.caja_eventos e where e.club_id = $2 and e.tipo = 'puerta_confirmar_entrada' and e.detalle->>'reservation_id' = r.id::text) confirmadas
                                     from public.reservations r where r.id = $1`, [R.linea.id, esc.club.id]);
          return { ok: r.status === "usada" && r.puerta_estado === "entro" && r.entrada_por === u.staff.id && r.confirmadas === 1,
            detalle: JSON.stringify({ status: r.status, puerta: r.puerta_estado, por_staff: r.entrada_por === u.staff.id, eventos_confirmar: r.confirmadas }) };
        }, { pagina: p });
        await f.paso("Sin señal: el código corto de la otra reserva se valida con la copia y queda «pendiente de enviar»", async () => {
          await p.getByRole("button", { name: "Escanear siguiente" }).first().click();
          await p.waitForTimeout(1500); // el lector (html5-qrcode) ya bajado
          await ctx.setOffline(true);
          await p.locator("#codigo-boleto").fill(R.sinRed.corto);
          await p.getByRole("button", { name: "Buscar" }).click();
          await p.locator("[data-prueba=ficha-sin-senal]").waitFor({ timeout: 25_000 });
          afirmar((await p.locator("body").innerText()).includes(R.sinRed.cliente_nombre), "la ficha sin señal no muestra al cliente");
          await p.getByRole("button", { name: "Confirmar entrada (sin señal)" }).click();
          await p.locator("[data-prueba=entrada-pendiente]").waitFor();
          await p.locator("[data-prueba=puerta-pendientes]", { hasText: "1 entrada pendiente" }).waitFor();
          const r = await una(c.db, `select status from public.reservations where id = $1`, [R.sinRed.id]);
          afirmar(r.status !== "usada", "la base ya tiene la entrada y el teléfono estaba sin señal");
          return `contador: ${(await p.locator("[data-prueba=puerta-pendientes]").innerText()).replace(/\s+/g, " ")} · base: ${r.status}`;
        }, { pagina: p });
        await f.paso("Vuelve la señal: la entrada guardada se envía sola («se envió 1 entrada guardada sin señal»)", async () => {
          await ctx.setOffline(false);
          await p.getByText(/se envió 1 entrada guardada sin señal/).first().waitFor({ timeout: SIN_SENAL });
        }, { pagina: p });
        await f.verificar("Base: la reserva sin señal entró UNA vez, con el staff (un evento puerta_entrada_diferida y uno de confirmación)", async () => {
          const r = await una(c.db, `select status, puerta_estado, entrada_por,
                                            (select count(*)::int from public.caja_eventos e where e.club_id = $2 and e.tipo = 'puerta_entrada_diferida' and e.detalle->>'reservation_id' = r.id::text) diferidas,
                                            (select count(*)::int from public.caja_eventos e where e.club_id = $2 and e.tipo = 'puerta_confirmar_entrada' and e.detalle->>'reservation_id' = r.id::text) confirmadas
                                     from public.reservations r where r.id = $1`, [R.sinRed.id, esc.club.id]);
          return { ok: r.status === "usada" && r.puerta_estado === "entro" && r.entrada_por === u.staff.id && r.diferidas === 1 && r.confirmadas === 1,
            detalle: JSON.stringify({ status: r.status, puerta: r.puerta_estado, por_staff: r.entrada_por === u.staff.id, diferidas: r.diferidas, confirmadas: r.confirmadas }) };
        }, { pagina: p });
      } finally {
        await bandera(c, "escaner_respaldo", null).catch(() => {});
      }
    });

  // ---------------- 10) Inventario y propina en el cobro ----------------
  await run.flujo("10", "Inventario y propina en el cobro (fase 2, Mesa 3, antes del cierre)", async () => {
    if (await nocheCerrada(c)) return "la noche ya está cerrada: no se puede vender";
    const [s] = await c.db.q(`select count(*)::int n from public.mesa_sesiones where mesa_id = $1`, [mesa(3).id]);
    return s.n ? "la Mesa 3 ya tiene grupos esta noche" : null;
  }, async (f) => {
    const g = await paginaDe(c, "gerente");
    const enlaceInv = g.locator('a[href="/staff/catalogo"]');
    const enlaceProp = g.locator('a[href="/staff/propinas"]');
    const PRODUCTO = "Tequila e2e";
    try {
      await f.paso("Banderas inventario y propinas apagadas: el panel del gerente no enlaza a la fase 2", async () => {
        await abrirPanel(c, g, { gerente: true });
        afirmar(await noAparece(g, enlaceInv.or(enlaceProp)), "con las banderas apagadas el panel enlaza a la fase 2");
      }, { pagina: g });
      await f.paso(`Banderas encendidas: el gerente da de alta «${PRODUCTO}» ($150, 10 piezas) con su sesión y el panel ya enlaza a la fase 2`, async () => {
        await bandera(c, "inventario", true);
        await bandera(c, "propinas", true);
        const sb = await c.sesionDe(u.gerente);
        const r = await sb.rpc("producto_guardar", { p_club_id: esc.club.id, p_id: null, p_nombre: PRODUCTO, p_categoria: "Destilados",
          p_precio_centavos: 15000, p_existencias_minimas: 2, p_activo: true, p_existencias_iniciales: 10 });
        await sb.auth.signOut({ scope: "local" }).catch(() => {});
        if (r.error) throw new Error("producto_guardar: " + r.error.message);
        c.productoId = r.data;
        await abrirPanel(c, g, { gerente: true });
        await enlaceInv.waitFor({ timeout: 30_000 });
        await enlaceProp.waitFor({ timeout: 30_000 });
      }, { pagina: g });
      const s = await paginaDe(c, "staff");
      await f.paso("Staff: Mesa 3 → «Recibir grupo» → «Sin reserva» (walk-in) → «Sentar en la mesa»", async () => {
        await abrirCaja(c, s);
        await abrirMesa(s, 3);
        await s.getByRole("button", { name: "Recibir grupo", exact: true }).click();
        const hoja = dialogo(s, "Sentar cliente · Mesa 3");
        await hoja.getByRole("button", { name: "Sin reserva" }).click();
        await hoja.getByPlaceholder("Nombre del cliente").fill(`${esc.tag} Walk-in`);
        await hoja.getByRole("button", { name: "Sentar en la mesa" }).click();
        await hoja.waitFor({ state: "detached" });
        c.mesa3Abierta = true;
        await s.getByRole("button", { name: "Agregar consumo", exact: true }).waitFor();
      }, { pagina: s });
      await f.paso(`«Agregar consumo» muestra el catálogo con existencias; 2 × ${PRODUCTO} → «Agregar a la mesa · $300»`, async () => {
        await s.getByRole("button", { name: "Agregar consumo", exact: true }).click();
        const hoja = dialogo(s, "Agregar consumo");
        await hoja.getByPlaceholder("Buscar en el catálogo").waitFor();
        const fila = hoja.locator("li").filter({ hasText: PRODUCTO });
        const texto = (await fila.innerText()).replace(/\s+/g, " ");
        afirmar(/\$150/.test(texto) && /\b10\b/.test(texto), `la fila del catálogo no dice $150 y 10 piezas: «${texto}»`);
        for (let i = 0; i < 2; i++) await hoja.getByRole("button", { name: `Agregar uno: ${PRODUCTO}` }).click();
        await hoja.getByRole("button", { name: "Agregar a la mesa · $300" }).click();
        await hoja.waitFor({ state: "detached" });
        await s.getByRole("button", { name: "Cobrar $300" }).waitFor();
        return `catálogo: ${texto}`;
      }, { pagina: s });
      await f.verificar("Base: el inventario bajó de 10 a 8 y la venta quedó en la bitácora, ligada al consumo de la Mesa 3", async () => {
        const pr = await una(c.db, `select existencias from public.productos where id = $1`, [c.productoId]);
        const mov = await c.db.q(`select m.tipo, m.cantidad, k.monto_centavos::int monto, k.cantidad kc, s.mesa_id
                                    from public.producto_movimientos m left join public.caja_consumos k on k.id = m.consumo_id
                                    left join public.mesa_sesiones s on s.id = k.sesion_id
                                   where m.producto_id = $1 order by m.hecho_en`, [c.productoId]);
        const venta = mov.find((m) => m.tipo === "venta");
        const suma = mov.reduce((a, m) => a + m.cantidad, 0);
        const ok = pr?.existencias === 8 && suma === 8 && venta && venta.cantidad === -2 && venta.monto === 30000 && venta.kc === 2 && venta.mesa_id === mesa(3).id;
        return { ok, detalle: `existencias ${pr?.existencias} (bitácora suma ${suma}) · movimientos ${JSON.stringify(mov.map((m) => [m.tipo, m.cantidad]))}` };
      }, { pagina: s });
      await f.paso("«Cobrar $300» en tarjeta con $50 de propina aparte (el campo solo existe con la bandera)", async () => {
        await s.getByRole("button", { name: "Cobrar $300" }).click();
        const hoja = dialogo(s, "Cobrar");
        await hoja.getByRole("button", { name: "Tarjeta" }).click();
        await hoja.getByLabel(/Propina \(\$, opcional\)/).fill("50");
        await hoja.getByRole("button", { name: "Cobrar $300" }).click();
        await hoja.waitFor({ state: "detached" });
        await s.getByText(/Cobrado\s*\$300/).first().waitFor();
      }, { pagina: s });
      await f.verificar("Base: un pago de $300 en tarjeta con propina de $50 aparte; el saldo de la mesa queda en 0", async () => {
        const [ses] = await sesionesDeMesa(c, mesa(3).id);
        const pagos = await c.db.q(`select metodo, monto_centavos::int monto, propina_centavos::int propina from public.caja_pagos where sesion_id = $1 and not anulado`, [ses.id]);
        const ok = pagos.length === 1 && pagos[0].metodo === "tarjeta" && pagos[0].monto === 30000 && pagos[0].propina === 5000 && ses.consumo === 30000 && ses.cobrado === 30000;
        return { ok, detalle: `pagos ${JSON.stringify(pagos)} · consumo ${ses.consumo}, cobrado ${ses.cobrado}` };
      }, { pagina: s });
      await f.paso("El gerente cuadra la Mesa 3 («Cuadrar mesa · $300»)", async () => {
        await abrirCaja(c, g);
        await abrirMesa(g, 3);
        await g.getByRole("button", { name: "Cuadrar mesa", exact: true }).click();
        const hoja = dialogo(g, "Cuadrar mesa");
        await hoja.getByRole("button", { name: "Cuadrar mesa · $300" }).click();
        await hoja.waitFor({ state: "detached" });
        await g.getByRole("button", { name: "Recibir nuevo grupo" }).waitFor();
      }, { pagina: g });
      await f.verificar("Base: Mesa 3 cuadrada por el gerente; el walk-in no genera comisión", async () => {
        const [ses] = await sesionesDeMesa(c, mesa(3).id);
        const [{ n }] = await c.db.q(`select count(*)::int n from public.commissions k join public.mesa_cuentas m on m.reservation_id = k.reservation_id where m.sesion_id = $1`, [ses.id]);
        const ok = ses.estado === "cuadrada" && ses.cuadrada_por === u.gerente.id && n === 0;
        if (ok) {
          c.extraTarjeta = 30000;
          c.propinaCobro = 5000;
          c.mesa3Abierta = false;
        }
        return { ok, detalle: `sesión ${ses.estado}, comisiones ${n}` };
      }, { pagina: g });
    } finally {
      // Si el flujo se cortó con la Mesa 3 abierta, se cobra y cuadra por la
      // API (gerente) para no dejar sin probar el cierre de la noche (8).
      if (c.mesa3Abierta) await rescatarMesa3(c, mesa(3).id).catch((e) => console.log(`   (no se pudo rescatar la Mesa 3: ${e.message})`));
    }
  });
}

async function rescatarMesa3(c, mesaId) {
  const abiertas = (await sesionesDeMesa(c, mesaId)).filter((x) => x.estado !== "cuadrada");
  if (!abiertas.length) return;
  const sb = await c.sesionDe(c.esc.usuarios.gerente);
  try {
    for (const s of abiertas) {
      const saldo = s.consumo - s.cobrado;
      if (saldo > 0) {
        const r = await sb.rpc("caja_registrar_pago", { p_sesion_id: s.id, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: saldo });
        if (r.error) throw new Error("cobro: " + r.error.message);
      }
      const q = await sb.rpc("caja_cuadrar_mesa", { p_sesion_id: s.id });
      if (q.error) throw new Error("cuadre: " + q.error.message);
    }
  } finally {
    await sb.auth.signOut({ scope: "local" }).catch(() => {});
  }
  // El flujo 8 cuadra la tarjeta con lo que haya cobrado la Mesa 3.
  const [{ t }] = await c.db.q(`select coalesce(sum(g.monto_centavos), 0)::int t from public.caja_pagos g join public.mesa_sesiones s on s.id = g.sesion_id
                                where s.mesa_id = $1 and g.metodo = 'tarjeta' and not g.anulado`, [mesaId]);
  const [{ o }] = await c.db.q(`select coalesce(sum(g.monto_centavos), 0)::int o from public.caja_pagos g join public.mesa_sesiones s on s.id = g.sesion_id
                                where s.mesa_id = $1 and g.metodo <> 'tarjeta' and not g.anulado`, [mesaId]);
  if (o) throw new Error(`la Mesa 3 tiene cobros que no son en tarjeta (${o}): el flujo 8 no los espera`);
  c.extraTarjeta = t;
  c.mesa3Abierta = false;
  console.log(`   (Mesa 3 rescatada por la API: tarjeta ${t} centavos, cuadrada)`);
}

// ===================================================================
// Después del cierre: 11–16 y B.
// ===================================================================
export async function flujosDespuesDelCierre(c, { nombres, tel }) {
  const { corredor: run, esc } = c;
  const u = esc.usuarios;

  // ---------------- 11) Reparto de propinas ----------------
  await run.flujo("11", "Reparto de las propinas de la noche cerrada (fase 2)", async () => {
    if (!c.propinaCobro) return "no hubo propina en el cobro (flujo 10)";
    if (!(await nocheCerrada(c))) return "la noche no se cerró (flujo 8)";
    return null;
  }, async (f) => {
    const g = await paginaDe(c, "gerente");
    try {
      await f.paso("Gerente en «Propinas de la noche»: $50 por repartir, avisa que 1 es del cobro", async () => {
        await abrirPanel(c, g, { gerente: true });
        await g.locator('a[href="/staff/propinas"]').click();
        await g.waitForURL(/\/staff\/propinas/);
        await g.getByRole("heading", { name: "Propinas de la noche" }).waitFor({ timeout: T_NAV });
        await g.getByText(/Incluye 1 propina capturada con el cobro/).waitFor({ timeout: 30_000 });
      }, { pagina: g });
      let vista = "";
      await f.paso("«Ver cómo queda» → «Repartir $50» → «Reparto de la noche»", async () => {
        await g.getByRole("button", { name: "Ver cómo queda" }).click();
        const repartir = g.getByRole("button", { name: "Repartir $50" });
        await repartir.waitFor();
        vista = (await g.locator("ul").filter({ hasText: "$" }).last().innerText()).replace(/\s+/g, " ");
        await repartir.click();
        await g.getByText("Reparto de la noche").first().waitFor();
        return `vista previa: ${vista}`;
      }, { pagina: g });
      await f.verificar("Base: UN reparto de la noche, hecho por el gerente, cuyas líneas suman los $50 al centavo", async () => {
        const rep = await c.db.q(`select r.id, r.hecho_por from public.propinas_repartos r join public.caja_noches n on n.id = r.noche_id
                                   where r.club_id = $1 and n.fecha_operacion = $2 and not r.anulado`, [esc.club.id, esc.noche]);
        const lineas = rep[0] ? await c.db.q(`select tipo, profile_id, monto_centavos::int monto from public.propinas_reparto_lineas where reparto_id = $1`, [rep[0].id]) : [];
        const suma = lineas.reduce((a, l) => a + l.monto, 0);
        const ok = rep.length === 1 && rep[0].hecho_por === u.gerente.id && suma === c.propinaCobro;
        const quien = (id) => Object.entries(u).find(([, x]) => x.id === id)?.[0] ?? (id ? "otro" : "casa");
        return { ok, detalle: `${rep.length} reparto(s) · líneas ${JSON.stringify(lineas.map((l) => [l.tipo, quien(l.profile_id), l.monto]))} · suma ${suma}` };
      }, { pagina: g });
    } finally {
      await bandera(c, "inventario", null).catch(() => {});
      await bandera(c, "propinas", null).catch(() => {});
    }
  });
  // Si el 11 no corrió, las banderas del 10 se apagan igual.
  await bandera(c, "inventario", null).catch(() => {});
  await bandera(c, "propinas", null).catch(() => {});

  // ---------------- 12) Ventas del POS ----------------
  await run.flujo("12", "Ventas del POS ligadas a las cuentas de la noche (Mesas 1 y 2)", async () => {
    if (!c.cuadradas || !c.resRp || !c.resCuenta) return "no hay cuentas de las Mesas 1 y 2 (flujos 4–6)";
    return null;
  }, async (f) => {
    const g = await paginaDe(c, "gerente");
    const enlace = g.locator('a[href="/staff/pos"]');
    let antes = null;
    const cuentaDe = async (reservaId) => una(c.db, `select k.id, k.sesion_id, s.abierta_en from public.mesa_cuentas k join public.mesa_sesiones s on s.id = k.sesion_id where k.reservation_id = $1`, [reservaId]);
    try {
      await f.paso("Bandera pos_ventas apagada: el panel del gerente no enlaza a «Ventas del POS»", async () => {
        await abrirPanel(c, g, { gerente: true });
        afirmar(await noAparece(g, enlace), "con la bandera apagada el panel enlaza al POS");
      }, { pagina: g });
      await f.paso("Bandera encendida: «Ventas del POS» → sube el CSV del POS con un ticket por mesa (hora de la caja de esta noche)", async () => {
        await bandera(c, "pos_ventas", true);
        await abrirPanel(c, g, { gerente: true });
        await enlace.waitFor({ timeout: 30_000 });
        await enlace.click();
        await g.waitForURL(/\/staff\/pos/);
        await g.locator("#pos-archivo").waitFor({ timeout: T_NAV });
        const c2 = await cuentaDe(c.resCuenta.id);
        const c1 = await cuentaDe(c.resRp.id);
        const h2 = await fechaHoraLocal(c, c2.abierta_en);
        const h1 = await fechaHoraLocal(c, c1.abierta_en);
        const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
        const csv = [
          ["Folio", "Fecha", "Hora", "Mesa", "Producto", "Cant", "Precio", "Importe", "Forma de pago", "Mesero"],
          ["E2E-1", h2.fecha, h2.hora, "Mesa 2", "Cerveza", "3", "$90.00", "$270.00", "Tarjeta", "e2e"],
          ["E2E-2", h1.fecha, h1.hora, "1", "Botella", "1", "$1,250.50", "$1,250.50", "Efectivo", "e2e"],
        ].map((fila) => fila.map(q).join(",")).join("\r\n");
        antes = await una(c.db, `select (select count(*) from public.caja_consumos where club_id = $1)::int consumos,
                                        (select coalesce(sum(monto_centavos), 0) from public.caja_consumos where club_id = $1)::bigint::text suma,
                                        (select count(*) from public.commissions where rp_id = $2)::int comisiones`, [esc.club.id, u.rp.id]);
        await g.setInputFiles("#pos-archivo", { name: `pos-${esc.tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
        await g.locator("#pos-campo-ticket").waitFor({ timeout: 30_000 });
        const campos = {};
        for (const k of ["ticket", "fecha", "hora", "mesa", "total"]) campos[k] = await g.locator(`#pos-campo-${k}`).inputValue();
        afirmar(campos.ticket === "Folio" && campos.fecha === "Fecha" && campos.hora === "Hora" && campos.mesa === "Mesa" && campos.total === "Importe",
          `mapeo propuesto: ${JSON.stringify(campos)}`);
        return `tickets a las ${h2.hora} (Mesa 2) y ${h1.hora} (Mesa 1) del ${h2.fecha} · mapeo ${JSON.stringify(campos)}`;
      }, { pagina: g });
      let manual = false;
      await f.paso("«3. Revisar ventas»: 2 nuevas por $1,520.50; si la Mesa 1 tuvo dos grupos, el ticket se asigna a mano a la cuenta del RP", async () => {
        await g.getByRole("button", { name: "3. Revisar ventas" }).click();
        await g.getByTestId("pos-resumen").waitFor({ timeout: T_NAV });
        const resumen = (await g.getByTestId("pos-resumen").innerText()).replace(/\s+/g, " ");
        afirmar(/Ventas nuevas 2/.test(resumen) && /\$1,520\.50/.test(resumen), `vista previa: ${resumen}`);
        const sinLigar = g.getByRole("tab", { name: /Sin ligar/ });
        if (await sinLigar.count()) await sinLigar.click();
        const sel = g.getByLabel("Cuenta para el ticket E2E-2");
        if (await sel.count()) {
          const opciones = await sel.locator("option").allInnerTexts();
          const op = opciones.find((o) => o.includes(nombres.rp));
          afirmar(op, `la cuenta del RP no está entre las candidatas: ${JSON.stringify(opciones)}`);
          await sel.selectOption({ label: op });
          manual = true;
        }
        afirmar(!(await g.getByLabel("Cuenta para el ticket E2E-1").count()), "el ticket de la Mesa 2 (un solo grupo) no se ligó solo");
        return `${resumen}${manual ? " · E2E-2 asignado a mano (Mesa 1 con 2 grupos)" : " · E2E-2 ligado solo"}`;
      }, { pagina: g });
      await f.paso("«Importar 2 ventas» → «2 ventas nuevas por $1,520.50 … 2 ligadas»", async () => {
        const casilla = g.getByRole("checkbox");
        if (await casilla.count()) await casilla.check();
        await g.getByRole("button", { name: /^Importar 2 ventas$/ }).click();
        await g.getByTestId("pos-resultado").waitFor({ timeout: T_NAV });
        const res = (await g.getByTestId("pos-resultado").innerText()).replace(/\s+/g, " ");
        afirmar(/2 ventas nuevas por \$1,520\.50/.test(res) && /2 ligadas/.test(res), res);
        return res;
      }, { pagina: g });
      await f.verificar("Base: cada venta quedó en la cuenta de su mesa (Mesa 2 → reserva directa, Mesa 1 → cliente del RP) y la caja y las comisiones no cambiaron", async () => {
        const ventas = await c.db.q(`select ticket, cuenta_id, sesion_id, liga, total_centavos::int total from public.pos_ventas where club_id = $1 order by ticket`, [esc.club.id]);
        const c1 = await cuentaDe(c.resRp.id);
        const c2 = await cuentaDe(c.resCuenta.id);
        const despues = await una(c.db, `select (select count(*) from public.caja_consumos where club_id = $1)::int consumos,
                                                (select coalesce(sum(monto_centavos), 0) from public.caja_consumos where club_id = $1)::bigint::text suma,
                                                (select count(*) from public.commissions where rp_id = $2)::int comisiones`, [esc.club.id, u.rp.id]);
        const v1 = ventas.find((v) => v.ticket === "E2E-1"), v2 = ventas.find((v) => v.ticket === "E2E-2");
        const ok = ventas.length === 2 && v1?.cuenta_id === c2.id && v1.total === 27000 && v2?.cuenta_id === c1.id && v2.total === 125050 &&
          (!manual || v2.liga === "manual") && JSON.stringify(antes) === JSON.stringify(despues);
        return { ok, detalle: `ventas ${JSON.stringify(ventas.map((v) => ({ t: v.ticket, cuenta_ok: v.ticket === "E2E-1" ? v.cuenta_id === c2.id : v.cuenta_id === c1.id, liga: v.liga, total: v.total })))} · caja/comisiones antes ${JSON.stringify(antes)} después ${JSON.stringify(despues)}` };
      }, { pagina: g });
      await f.paso("«Ver la conciliación»: la noche, POS $1,520.50 y la Mesa 2 «Coincide» con la caja", async () => {
        await g.getByRole("button", { name: /Ver la conciliación/ }).click();
        await g.getByTestId("pos-mesas").locator("li").first().waitFor({ timeout: T_NAV });
        afirmar((await g.locator("#pos-noche").inputValue()) === esc.noche, `abre la noche ${await g.locator("#pos-noche").inputValue()}`);
        const totales = (await g.getByTestId("pos-totales").innerText()).replace(/\s+/g, " ");
        afirmar(/POS \$1,520\.50/.test(totales), `totales: ${totales}`);
        // Tarjeta de la mesa (li de primer nivel); su textContent va pegado
        // («Mesa 2Coincide…»), así que nada de \b.
        const mesa2 = (await g.getByTestId("pos-mesas").locator(":scope > li").filter({ hasText: /Mesa 2(?!\d)/ }).first().innerText()).replace(/\s+/g, " ");
        afirmar(/^Mesa 2 Coincide/.test(mesa2), `Mesa 2: ${mesa2}`);
        return `${totales} · Mesa 2: ${mesa2.slice(0, 120)}`;
      }, { pagina: g });
    } finally {
      await bandera(c, "pos_ventas", null).catch(() => {});
    }
  });

  // ---------------- 13) Reporte PDF de la noche ----------------
  await run.flujo("13", "Reporte PDF de la noche (/grupo/reportes) con las cifras de la base", async () =>
    ((await nocheCerrada(c)) ? null : "la noche no se cerró (flujo 8)"), async (f) => {
    const g = await paginaDe(c, "gerente");
    const enlace = g.getByRole("link", { name: /Reportes PDF/ });
    let pdf = null;
    try {
      await f.paso("Bandera reportes_pdf apagada: «Resumen de tu antro» (/grupo) no enlaza a «Reportes PDF»", async () => {
        await g.goto(c.base + "/grupo", { timeout: T_NAV });
        await g.getByRole("heading", { name: "Resumen de tu antro" }).waitFor({ timeout: T_NAV });
        afirmar(await noAparece(g, enlace, 3000), "con la bandera apagada /grupo enlaza a los reportes PDF");
      }, { pagina: g });
      await f.paso("Bandera encendida: /grupo enlaza a «Reportes PDF» y abre /grupo/reportes", async () => {
        await bandera(c, "reportes_pdf", true);
        await g.goto(c.base + "/grupo", { timeout: T_NAV });
        await enlace.waitFor({ timeout: 30_000 });
        await enlace.click();
        await g.waitForURL(/\/grupo\/reportes/);
        await g.getByRole("heading", { name: "Reportes PDF" }).waitFor({ timeout: T_NAV });
      }, { pagina: g });
      await f.paso(`Reporte de la noche ${esc.noche}: «Descargar PDF» baja un PDF (en el teléfono, sin hoja de compartir)`, async () => {
        // En un teléfono real se abre la hoja de compartir; aquí se quita
        // para que entregarPdf use la descarga normal.
        await g.context().addInitScript(() => {
          try {
            delete Navigator.prototype.canShare;
            delete Navigator.prototype.share;
          } catch { /* nada */ }
        });
        await g.goto(`${c.base}/grupo/reportes?club=${esc.club.id}&tipo=noche&fecha=${esc.noche}`, { timeout: T_NAV });
        await g.getByRole("heading", { name: "Reportes PDF" }).waitFor({ timeout: T_NAV });
        await g.waitForFunction(() => {
          const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Descargar PDF"));
          return b && !b.disabled;
        }, null, { timeout: T_NAV });
        const [d] = await Promise.all([g.waitForEvent("download", { timeout: 30_000 }), g.getByRole("button", { name: "Descargar PDF" }).click()]);
        const ruta = path.join(c.carpeta, "reporte-noche.pdf");
        await d.saveAs(ruta);
        pdf = readFileSync(ruta);
        afirmar(pdf.subarray(0, 5).toString() === "%PDF-", "el archivo no es un PDF");
        await g.getByText(/Se generó el PDF/).first().waitFor();
        return `${d.suggestedFilename()} · ${pdf.length} bytes`;
      }, { pagina: g });
      await f.verificar("PDF = base: antro, consumo total, cobrado en efectivo y en tarjeta, «Faltan $50.00» del cuadre y comisiones", async () => {
        if (!pdf) return { ok: false, detalle: "no hay PDF" };
        const textos = textosDePdf(pdf);
        writeFileSync(path.join(c.carpeta, "reporte-noche.txt"), textos.join("\n"));
        const n = await una(c.db, `select id from public.caja_noches where club_id = $1 and fecha_operacion = $2`, [esc.club.id, esc.noche]);
        const b = await una(c.db,
          `select (select coalesce(sum(monto_centavos), 0) from public.caja_consumos where noche_id = $1 and not anulado)::int consumo,
                  (select coalesce(sum(monto_centavos), 0) from public.caja_pagos where noche_id = $1 and not anulado and metodo = 'efectivo')::int efectivo,
                  (select coalesce(sum(monto_centavos), 0) from public.caja_pagos where noche_id = $1 and not anulado and metodo = 'tarjeta')::int tarjeta,
                  (select diferencia_centavos from public.caja_cuadres where noche_id = $1 and tipo = 'noche')::int diferencia,
                  (select coalesce(round(sum(k.monto) * 100), 0) from public.commissions k join public.reservations r on r.id = k.reservation_id
                     where r.club_id = $2 and r.fecha = $3::date and k.tipo = 'rp')::int comisiones`, [n.id, esc.club.id, esc.noche]);
        const esperado = {
          antro: esc.club.nombre, consumo: pesos2(b.consumo), efectivo: pesos2(b.efectivo), tarjeta: pesos2(b.tarjeta),
          diferencia: b.diferencia < 0 ? `Faltan ${pesos2(-b.diferencia)}` : `Sobran ${pesos2(b.diferencia)}`, comisiones: pesos2(b.comisiones),
        };
        const todo = textos.join(" ");
        const faltan = Object.entries(esperado).filter(([, v]) => !textos.some((t) => t.includes(v)) && !todo.includes(v)).map(([k, v]) => `${k} «${v}»`);
        const ok = faltan.length === 0 && b.diferencia === -5000;
        return { ok, detalle: `${textos.length} textos en el PDF · base ${JSON.stringify(b)}${faltan.length ? ` · NO están en el PDF: ${faltan.join(", ")}` : " · todas las cifras están en el PDF"}` };
      }, { pagina: g });
    } finally {
      await bandera(c, "reportes_pdf", null).catch(() => {});
    }
  });

  // ---------------- 14) Lista negra ----------------
  const telBloqueado = tel(7);
  await run.flujo("14", "Lista negra: el gerente bloquea un teléfono y el formulario público lo rechaza con el mensaje neutro", null, async (f) => {
    const g = await paginaDe(c, "gerente");
    const enlace = g.locator('a[href="/staff/clientes"]');
    const anon = c.pAnon ?? (c.pAnon = await nuevaPagina(c, c.nav, "anonimo"));
    const NEUTRO = "No pudimos apartar tu lugar en este antro. Comunícate directamente con el antro.";
    try {
      await f.paso("Bandera lista_negra apagada: el panel no enlaza a «Clientes y mensajes»", async () => {
        await abrirPanel(c, g, { gerente: true });
        afirmar(await noAparece(g, enlace), "con las banderas apagadas el panel enlaza a «Clientes y mensajes»");
      }, { pagina: g });
      await f.paso("Bandera encendida: «Clientes y mensajes» → «Bloqueados» → «Bloquear un teléfono» con motivo", async () => {
        await bandera(c, "lista_negra", true);
        await abrirPanel(c, g, { gerente: true });
        await enlace.waitFor({ timeout: 30_000 });
        await enlace.click();
        await g.waitForURL(/\/staff\/clientes/);
        await g.getByRole("heading", { name: "Clientes y mensajes" }).waitFor({ timeout: T_NAV });
        await g.getByRole("tab", { name: "Bloqueados" }).click();
        await g.getByRole("button", { name: "Bloquear un teléfono" }).click();
        await g.getByPlaceholder("10 dígitos").fill(telBloqueado);
        await g.getByPlaceholder("Para reconocerlo en la lista").fill(`${esc.tag} Bloqueado`);
        await g.getByPlaceholder(/Qué pasó, solo lo necesario/).fill("Prueba e2e: no llegó varias noches");
        await g.getByRole("button", { name: "Bloquear", exact: true }).click();
        await g.getByText(`***${telBloqueado.slice(-4)}`).first().waitFor({ timeout: 30_000 });
        return `bloqueado ***${telBloqueado.slice(-4)}`;
      }, { pagina: g });
      await f.verificar("Base: un bloqueo abierto de ese teléfono en este antro, por el gerente, sin vencimiento", async () => {
        const b = await c.db.q(`select telefono, bloqueado_por, vence_en, desbloqueado_en from public.club_bloqueos where club_id = $1`, [esc.club.id]);
        const ok = b.length === 1 && b[0].telefono === telBloqueado && b[0].bloqueado_por === u.gerente.id && b[0].vence_en === null && b[0].desbloqueado_en === null;
        return { ok, detalle: JSON.stringify(b.map((x) => ({ tel_ok: x.telefono === telBloqueado, por_gerente: x.bloqueado_por === u.gerente.id, vence: x.vence_en, abierto: !x.desbloqueado_en }))) };
      }, { pagina: g });
      let rechazo = null;
      await f.paso("Sin cuenta, con ese teléfono: /cliente/reservar → «Apartar lugar» → la base lo rechaza (P0001) y la página muestra el mensaje neutro", async () => {
        await anon.goto(`${c.base}/cliente/reservar?club=${esc.club.id}`, { timeout: T_NAV });
        await anon.getByText(`Reservar en ${esc.club.nombre}`).waitFor({ timeout: T_NAV });
        await anon.fill("#nombre", `${esc.tag} Cliente Bloqueado`);
        await anon.fill("#telefono", telBloqueado);
        await anon.fill("#fecha", esc.noche);
        const respuesta = anon.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/rest/v1/reservations"));
        await anon.getByRole("button", { name: "Apartar lugar" }).click();
        const res = await respuesta;
        const cuerpo = await res.json().catch(() => ({}));
        rechazo = { estado: res.status(), code: cuerpo.code ?? null, message: cuerpo.message ?? null };
        afirmar(rechazo.code === "P0001" && rechazo.message === NEUTRO, `PostgREST respondió ${JSON.stringify(rechazo)}`);
        const alerta = anon.locator("form [role=alert]").first();
        await alerta.waitFor();
        const texto = (await alerta.innerText()).trim();
        afirmar(texto === NEUTRO, `la página muestra «${texto}»`);
        afirmar(!/bloque|motivo|lista/i.test(texto), "el mensaje delata el bloqueo");
        return `HTTP ${rechazo.estado} ${rechazo.code} · aviso: «${texto}»`;
      }, { pagina: anon });
      await f.verificar("Base: no se guardó la reserva ni el intento de ese teléfono (el rechazo deshace su renglón en reserva_intentos)", async () => {
        const [x] = await c.db.q(
          `select (select count(*) from public.reservations where club_id = $1 and cliente_telefono = $2)::int reservas,
                  (select count(*) from public.reserva_intentos where club_id = $1
                      and telefono_hash = encode(sha256(convert_to(right($2, 10), 'UTF8')), 'hex'))::int intentos`, [esc.club.id, telBloqueado]);
        return { ok: x.reservas === 0 && x.intentos === 0, detalle: JSON.stringify(x) };
      }, { pagina: anon });
    } finally {
      await bandera(c, "lista_negra", null).catch(() => {});
    }
  });

  // ---------------- 15) WhatsApp ----------------
  await run.flujo("15", "WhatsApp: el enlace wa.me de la lista del staff trae número y texto correctos y no manda nada", null, async (f) => {
    const s = await paginaDe(c, "staff");
    const enlace = s.locator('a[href="/staff/clientes"]');
    let R = null;
    const [{ manana }] = await c.db.q(`select ($1::date + 1)::text manana`, [esc.noche]);
    try {
      await f.paso("Preparación: reserva de mañana por llegar (service role) · bandera whatsapp apagada: el panel del staff no enlaza a «Clientes y mensajes»", async () => {
        R = await crearReserva(c, { nombre: `Lucía ${esc.tag} Mañana`, fecha: manana, telefono: tel(8), personas: 4 });
        await abrirPanel(c, s);
        afirmar(await noAparece(s, enlace), "con las banderas apagadas el panel enlaza a «Clientes y mensajes»");
        return `${R.cliente_nombre} · ${manana} · 4 personas`;
      }, { pagina: s });
      let href = null;
      await f.paso("Bandera encendida: «Clientes y mensajes» → «Mañana»: la reserva trae «Confirmación» y «Recordatorio» por WhatsApp", async () => {
        await bandera(c, "whatsapp", true);
        await abrirPanel(c, s);
        await enlace.waitFor({ timeout: 30_000 });
        await enlace.click();
        await s.waitForURL(/\/staff\/clientes/);
        await s.getByRole("heading", { name: "Clientes y mensajes" }).waitFor({ timeout: T_NAV });
        await s.getByRole("tab", { name: "Mañana" }).click();
        const fila = s.locator("li").filter({ hasText: R.cliente_nombre });
        await fila.waitFor({ timeout: 30_000 });
        const conf = fila.getByRole("link", { name: /Confirmación/ });
        await fila.getByRole("link", { name: /Recordatorio/ }).waitFor();
        href = await conf.getAttribute("href");
        return href.slice(0, 60) + "…";
      }, { pagina: s });
      await f.verificar("El enlace es wa.me/52 + el teléfono de la reserva y el texto lleva nombre, antro, personas, el boleto /r/<código> y el aviso del QR", async () => {
        const m = String(href).match(/^https:\/\/wa\.me\/(\d+)\?text=(.*)$/);
        if (!m) return { ok: false, detalle: `enlace inesperado: ${href}` };
        const texto = decodeURIComponent(m[2]);
        const faltan = [`Hola Lucía, ya quedó tu lugar en ${esc.club.nombre}:`, "4 personas", `${c.base}/r/${R.qr_code}`, "no garantiza"].filter((x) => !texto.includes(x));
        return { ok: m[1] === `52${R.cliente_telefono}` && faltan.length === 0, detalle: `número ${m[1]} · texto: ${texto.replace(/\n/g, " ⏎ ")}${faltan.length ? ` · FALTA: ${faltan.join(" | ")}` : ""}` };
      }, { pagina: s });
      await f.paso("Tocar «Confirmación» solo abre wa.me con ese texto (otra pestaña): ninguna escritura a la base ni a /api", async () => {
        const ctx = s.context();
        await ctx.route("https://wa.me/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>wa.me (simulado)</title><p>WhatsApp simulado por la prueba</p>" }));
        const escrituras = [];
        const espia = (req) => {
          const url = req.url();
          if (req.method() !== "GET" && !url.startsWith("https://wa.me/") && (/\/rest\/v1\/|\/api\//.test(url))) escrituras.push(`${req.method()} ${url.slice(0, 90)}`);
        };
        ctx.on("request", espia);
        try {
          const fila = s.locator("li").filter({ hasText: R.cliente_nombre });
          const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 15_000 }), fila.getByRole("link", { name: /Confirmación/ }).click()]);
          await popup.waitForLoadState("domcontentloaded").catch(() => {});
          const destino = popup.url();
          await s.waitForTimeout(1500);
          await popup.close().catch(() => {});
          afirmar(decodeURIComponent(destino) === decodeURIComponent(href), `abrió ${destino.slice(0, 80)}`);
          afirmar(escrituras.length === 0, `hubo escrituras: ${escrituras.join(" | ")}`);
          return `abrió ${destino.slice(0, 40)}… · 0 escrituras`;
        } finally {
          ctx.off("request", espia);
          await ctx.unroute("https://wa.me/**").catch(() => {});
        }
      }, { pagina: s });
      await f.verificar("Base: la reserva sigue igual (por llegar) y no hay nada en la bandeja de salida del antro", async () => {
        const r = await una(c.db, `select status, puerta_estado from public.reservations where id = $1`, [R.id]);
        const [{ n }] = await c.db.q(`select count(*)::int n from public.correos_salida where club_id = $1`, [esc.club.id]).catch(() => [{ n: 0 }]);
        return { ok: r.status === "pendiente" && !r.puerta_estado && n === 0, detalle: `reserva ${r.status}/${r.puerta_estado ?? "sin puerta"} · correos_salida ${n}` };
      }, { pagina: s });
    } finally {
      await bandera(c, "whatsapp", null).catch(() => {});
    }
  });

  // ---------------- LUGAR PARA ANTIFRAUDE ----------------
  // La bandera 'antifraude' (sql/post-junta-3/30-…) se sigue corrigiendo en
  // otra rama: cuando llegue, su flujo va aquí, con el mismo patrón
  // (bandera apagada → no se ve; encendida → funciona, verificado en la base).

  // ---------------- 16) /para-clubes ----------------
  await run.flujo("16", "/para-clubes: 404 con la bandera apagada; con ella, el contacto se guarda y lo ve el admin", null, async (f) => {
    const anon = c.pAnon ?? (c.pAnon = await nuevaPagina(c, c.nav, "anonimo"));
    c.paraClubesPrevio ??= await banderaPlataforma(c.db, "para_clubes");
    const correo = correoContacto(esc.tag);
    const club = `T e2e Contacto ${esc.tag}`;
    try {
      await f.paso("Bandera de plataforma para_clubes apagada: /para-clubes responde 404", async () => {
        await ponerBanderaPlataforma(c.db, "para_clubes", false);
        const r = await anon.goto(c.base + "/para-clubes", { timeout: T_NAV });
        afirmar(r?.status() === 404, `respondió ${r?.status()}`);
        return `HTTP ${r.status()} (antes de la prueba la bandera estaba ${c.paraClubesPrevio ? "encendida" : "apagada"})`;
      }, { pagina: anon });
      await f.paso("Bandera encendida: la página abre (200) y el formulario de contacto dice «Recibimos tus datos.»", async () => {
        await ponerBanderaPlataforma(c.db, "para_clubes", true);
        const r = await anon.goto(c.base + "/para-clubes", { timeout: T_NAV });
        afirmar(r?.status() === 200, `respondió ${r?.status()}`);
        await anon.locator("#contacto-nombre").fill(`${esc.tag} Dueño`);
        await anon.locator("#contacto-club").fill(club);
        await anon.locator("#contacto-ciudad").fill("Pruebas");
        await anon.locator("#contacto-correo").fill(correo);
        await anon.locator("#contacto-mensaje").fill("Mensaje de la suite e2e.");
        await anon.getByRole("button", { name: "Enviar mis datos" }).click();
        await anon.getByText("Recibimos tus datos.").waitFor({ timeout: 30_000 });
      }, { pagina: anon });
      await f.verificar("Base: el contacto quedó «nuevo» en contactos_clubes con lo que se escribió", async () => {
        const k = await c.db.q(`select nombre, club_nombre, ciudad, estado from public.contactos_clubes where correo = $1`, [correo]);
        return { ok: k.length === 1 && k[0].club_nombre === club && k[0].estado === "nuevo" && k[0].ciudad === "Pruebas", detalle: JSON.stringify(k) };
      }, { pagina: anon });
      const a = await paginaDe(c, "admin");
      await f.paso("El admin lo ve en /admin/contactos (Nuevos)", async () => {
        await a.goto(c.base + "/admin/contactos", { timeout: T_NAV });
        await a.getByRole("heading", { name: club }).waitFor({ timeout: T_NAV });
        const item = a.locator("li").filter({ hasText: club }).first();
        const texto = (await item.innerText()).replace(/\s+/g, " ");
        afirmar(texto.includes(`${esc.tag} Dueño`) && texto.includes(correo), `la tarjeta no trae nombre y correo: ${texto.slice(0, 160)}`);
        return texto.slice(0, 160);
      }, { pagina: a });
      await f.paso("Bandera de vuelta como estaba: /para-clubes responde 404 otra vez", async () => {
        await ponerBanderaPlataforma(c.db, "para_clubes", c.paraClubesPrevio ?? false);
        const r = await anon.goto(c.base + "/para-clubes", { timeout: T_NAV });
        const esperado = c.paraClubesPrevio ? 200 : 404;
        afirmar(r?.status() === esperado, `respondió ${r?.status()}, se esperaba ${esperado}`);
        return `HTTP ${r.status()}`;
      }, { pagina: anon });
    } finally {
      await ponerBanderaPlataforma(c.db, "para_clubes", c.paraClubesPrevio ?? false).catch(() => {});
    }
  });

  // ---------------- B) Banderas restauradas ----------------
  await run.flujo("B", "Banderas restauradas (antes de borrar los datos)", null, async (f) => {
    await f.verificar("El antro de prueba no tiene ninguna bandera propia y para_clubes quedó como estaba antes de la corrida", async () => {
      const propias = await banderasDelAntro(c.db, esc.club.id);
      const pc = await banderaPlataforma(c.db, "para_clubes");
      const previo = c.paraClubesPrevio ?? pc;
      return { ok: propias.length === 0 && pc === previo, detalle: `banderas del antro: ${JSON.stringify(propias)} · para_clubes ${pc} (antes ${previo})` };
    });
  });
}
