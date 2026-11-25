// Flujos críticos de punta a punta, por la interfaz (Playwright a 390×844)
// y comprobados en la base (postgres de dev, solo los datos de la corrida).
// Los llama scripts/dev/e2e/correr.mjs; ver su cabecera.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afirmar, leerQRDePantalla, videoDesdePNG } from "./utiles.mjs";
import { COMISION_FIJA, ZONA } from "./datos.mjs";

const T_NAV = 90_000; // primera compilación de Turbopack
const T_UI = 25_000;

// ---------- Ayudas de interfaz ----------
async function nuevaPagina(c, nav, nombre, { camara = false } = {}) {
  const ctx = await nav.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    locale: "es-MX", timezoneId: ZONA, ...(camara ? { permissions: ["camera"] } : {}),
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(T_UI);
  p.on("pageerror", (e) => c.erroresConsola.push(`[${nombre}] pageerror: ${String(e.message).slice(0, 200)}`));
  p.on("console", (m) => {
    if (m.type() === "error") c.erroresConsola.push(`[${nombre}] console: ${m.text().slice(0, 200)}`);
  });
  c.contextos.push(ctx);
  return p;
}

async function entrar(c, p, usuario, destino) {
  await p.goto(c.base + "/cliente/login", { timeout: T_NAV });
  await p.fill("#email", usuario.email);
  await p.fill("#password", c.esc.password);
  await p.click("button[type=submit]");
  await p.waitForURL(destino, { timeout: T_NAV });
}

// El código del enlace de WhatsApp (…/r/antro-<uuid>) del boleto en pantalla.
async function codigoDelEnlace(alcance) {
  const href = await alcance.locator('a[href*="wa.me"]').first().getAttribute("href");
  const m = decodeURIComponent(href ?? "").match(/\/r\/(antro-[0-9a-f-]{36})/);
  afirmar(m, `no se encontró el enlace /r/<código> en el botón de WhatsApp (${(href ?? "sin href").slice(0, 80)})`);
  return m[1];
}

// Lee el QR que pintó la app dentro de `alcance`, lo cuelga como evidencia del
// paso y devuelve su texto y su PNG.
async function qrEnPantalla(c, f, alcance, nombre) {
  let r;
  try {
    r = await leerQRDePantalla(c.lector, alcance);
  } catch (e) {
    if (e.png) f.adjuntar(e.png, `qr-${nombre}-ilegible`);
    throw e;
  }
  f.adjuntar(r.png, `qr-${nombre}`);
  afirmar(/^antro-[0-9a-f-]{36}$/.test(r.texto), `el QR en pantalla no es un código de boleto: «${r.texto.slice(0, 60)}»`);
  r.nota = [r.intentos > 1 ? `a la ${r.intentos}ª captura` : "", r.variante !== "original" ? `pasada a blanco y negro (${r.variante})` : ""].filter(Boolean).join(", ");
  r.nota = r.nota ? ` (leído ${r.nota})` : "";
  return r;
}

const tarjeta = (p, texto) => p.locator("[data-slot=card]").filter({ hasText: texto }).first();
const dialogo = (p, nombre) => p.getByRole("dialog", { name: nombre });
const botonMesa = (p, numero) => p.getByRole("button", { name: new RegExp(`^Mesa ${numero},`) });

async function abrirCaja(c, p) {
  await p.goto(c.base + "/staff/caja", { timeout: T_NAV });
  await botonMesa(p, 1).waitFor({ timeout: T_NAV });
}

async function abrirMesa(p, numero) {
  await botonMesa(p, numero).click();
  await p.getByRole("button", { name: "Volver a las mesas" }).waitFor();
}

async function agregarConsumo(p, { concepto, precio, cantidad = 1, delListo = null, total }) {
  const hoja = dialogo(p, "Agregar consumo");
  await hoja.waitFor();
  if (delListo) {
    // Producto ya vendido esta noche: con el contador.
    for (let i = 0; i < delListo.veces; i++) await hoja.getByRole("button", { name: `Agregar uno: ${delListo.nombre}` }).click();
  } else {
    await hoja.getByLabel("Concepto").fill(concepto);
    await hoja.getByLabel("Precio unitario ($)").fill(precio);
    for (let i = 1; i < cantidad; i++) await hoja.getByRole("button", { name: "Agregar uno: Cantidad" }).click();
  }
  const boton = hoja.getByRole("button", { name: `Agregar a la mesa · ${total}` });
  await boton.click();
  await hoja.waitFor({ state: "detached" });
}

// Espía las llamadas a una función de la API (POST /rest/v1/rpc/<nombre>):
// guarda cada solicitud (url, cabeceras, cuerpo) y su respuesta.
function espiarRpc(p, nombre) {
  const llamadas = [];
  const alPedir = async (req) => {
    if (req.method() !== "POST" || !req.url().includes(`/rest/v1/rpc/${nombre}`)) return;
    const l = { url: req.url(), cuerpo: req.postData(), cabeceras: await req.allHeaders().catch(() => req.headers()), estado: null, respuesta: null };
    llamadas.push(l);
    const res = await req.response().catch(() => null);
    if (res) {
      l.estado = res.status();
      l.respuesta = await res.text().catch(() => null);
    }
  };
  p.on("request", alPedir);
  return { llamadas, parar: () => p.off("request", alPedir) };
}
const claveDe = (l) => {
  try {
    return JSON.parse(l.cuerpo).p_clave ?? null;
  } catch {
    return null;
  }
};

// Reenvía tal cual una llamada ya hecha (misma clave de idempotencia y misma
// sesión), como haría el teléfono si la primera respuesta se perdiera.
async function reenviar(p, l) {
  const permitidas = ["authorization", "apikey", "content-type", "content-profile", "accept-profile", "x-client-info", "prefer"];
  const cabeceras = Object.fromEntries(Object.entries(l.cabeceras).filter(([k]) => permitidas.includes(k.toLowerCase())));
  const r = await p.context().request.fetch(l.url, { method: "POST", headers: cabeceras, data: l.cuerpo });
  return { estado: r.status(), cuerpo: await r.text() };
}

// ---------- Consultas a la base (solo datos de la corrida) ----------
const una = async (db, sql, params) => (await db.q(sql, params))[0] ?? null;

async function reservaPorQr(c, qr) {
  return una(c.db, `select id, qr_code, cliente_nombre, cliente_telefono, source, status, rp_id, cliente_id, club_id, fecha::text, personas, puerta_estado, entrada_por, mesa_id, consumo_monto::text
                    from public.reservations where qr_code = $1`, [qr]);
}

async function sesionesDeMesa(c, mesaId) {
  return c.db.q(`select s.id, s.estado, s.cuadrada_por,
                        (select coalesce(sum(monto_centavos), 0) from public.caja_consumos k where k.sesion_id = s.id and not k.anulado)::int consumo,
                        (select count(*) from public.caja_pagos g where g.sesion_id = s.id and not g.anulado)::int pagos,
                        (select coalesce(sum(monto_centavos), 0) from public.caja_pagos g where g.sesion_id = s.id and not g.anulado)::int cobrado
                 from public.mesa_sesiones s where s.mesa_id = $1 order by s.abierta_en`, [mesaId]);
}

async function comisionesDe(c, reservaId) {
  return c.db.q(`select tipo, monto::text, status, rp_id, regla_id from public.commissions where reservation_id = $1`, [reservaId]);
}

const pesos = (centavos) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: centavos % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(centavos / 100);

// ===================================================================
export async function correrFlujos(c) {
  const { corredor: run, esc } = c;
  const u = esc.usuarios;
  const mesa = (n) => esc.mesas[n - 1];
  const nombres = {
    rp: `${esc.tag} Cliente de RP`,
    cuenta: u.cliente.nombre,
    anon: `${esc.tag} Sin Cuenta`,
  };
  const tel = (n) => `56${String(Date.now()).slice(-7)}${n}`;

  // ---------------- 1) Reserva por RP con QR ----------------
  await run.flujo("1", "Reserva por RP con QR", null, async (f) => {
    const p = (c.pRp = await nuevaPagina(c, c.nav, "rp"));
    await f.paso("El RP entra por /cliente/login y llega a /rp/panel", async () => {
      await entrar(c, p, u.rp, /\/rp\/panel/);
      await p.getByRole("heading", { name: "Mis reservas" }).waitFor({ timeout: T_NAV });
    }, { pagina: p });
    const telefono = tel(1);
    await f.paso("Abre «+ Nueva reserva» y llena nombre, teléfono, fecha (noche en curso) y 3 personas", async () => {
      await p.getByRole("button", { name: "+ Nueva reserva" }).click();
      await p.fill("#cliente_nombre", nombres.rp);
      await p.fill("#cliente_telefono", telefono);
      await p.fill("#fecha", esc.noche);
      // El contador arranca en 2: se sube a 3 para no depender del valor por defecto.
      await p.getByRole("button", { name: "Agregar una persona" }).click();
      const grupo = p.locator('[aria-labelledby="personas-label"]');
      afirmar(/\b3\b/.test(await grupo.innerText()), `el contador de personas no quedó en 3: «${(await grupo.innerText()).replace(/\s+/g, " ")}»`);
      return `${nombres.rp} · ${telefono} · ${esc.noche} · 3 personas`;
    }, { pagina: p });
    await f.paso("«Crear reserva» muestra «¡Reserva creada!»; el QR pintado se lee y coincide con el enlace del boleto", async () => {
      await p.getByRole("button", { name: "Crear reserva" }).click();
      await p.getByText("¡Reserva creada!").waitFor();
      const card = tarjeta(p, "¡Reserva creada!");
      afirmar(/Personas:\s*3/.test(await card.innerText()), "la tarjeta no dice «Personas: 3»");
      const qr = await qrEnPantalla(c, f, card, "rp");
      const enlace = await codigoDelEnlace(card);
      afirmar(qr.texto === enlace, `el QR dice «${qr.texto}» y el enlace de WhatsApp «${enlace}»`);
      c.qrRp = qr.texto;
      c.pngQrRp = qr.png;
      return `QR leído de la pantalla: ${qr.texto}${qr.nota} (igual al enlace)`;
    }, { pagina: p });
    await f.verificar("Base: el qr_code de la reserva es el del QR en pantalla; vía RP, del antro, de la noche, pendiente, 3 personas", async () => {
      const r = (c.resRp = await reservaPorQr(c, c.qrRp));
      const ok = r && r.qr_code === c.qrRp && r.source === "rp" && r.rp_id === u.rp.id && r.club_id === esc.club.id && r.fecha === esc.noche && r.status === "pendiente" && r.personas === 3 && r.cliente_id === null;
      return { ok, detalle: r ? JSON.stringify({ qr_igual: r.qr_code === c.qrRp, source: r.source, rp: r.rp_id === u.rp.id, fecha: r.fecha, status: r.status, personas: r.personas }) : `no hay reserva con qr_code ${c.qrRp}` };
    }, { pagina: p });
    const anon = (c.pAnon = await nuevaPagina(c, c.nav, "anonimo"));
    await f.paso("El boleto público /r/<código> abre sin sesión; su QR se lee y es el mismo código", async () => {
      await anon.goto(`${c.base}/r/${c.qrRp}`, { timeout: T_NAV });
      await anon.getByText(nombres.rp).first().waitFor();
      const qr = await qrEnPantalla(c, f, tarjeta(anon, nombres.rp), "boleto-rp");
      afirmar(qr.texto === c.qrRp, `el boleto público pinta «${qr.texto}», la base tiene «${c.qrRp}»`);
      afirmar(!(await anon.getByText(telefono).count()), "el boleto público muestra el teléfono");
      return `QR del boleto: ${qr.texto}${qr.nota}`;
    }, { pagina: anon });
    await f.paso("La reserva aparece en «Mis reservas» del RP como «Por llegar»", async () => {
      await p.getByRole("button", { name: `${nombres.rp}, Por llegar` }).waitFor();
    }, { pagina: p });
  });

  // ---------------- 2) Reserva directa ----------------
  await run.flujo("2", "Reserva directa (cliente con cuenta y sin cuenta)", null, async (f) => {
    const p = (c.pCliente = await nuevaPagina(c, c.nav, "cliente"));
    await f.paso("El cliente entra por /cliente/login y llega a /cliente", async () => {
      await entrar(c, p, u.cliente, /\/cliente$/);
    }, { pagina: p });
    await f.paso("Abre la ficha del antro y toca «Reservar»", async () => {
      await p.goto(`${c.base}/cliente/${esc.club.id}`, { timeout: T_NAV });
      await p.getByText(esc.club.nombre).first().waitFor();
      await p.locator(`a[href*="/cliente/reservar?club=${esc.club.id}"]`).first().click();
      await p.waitForURL(/\/cliente\/reservar\?club=/);
      await p.getByText(`Reservar en ${esc.club.nombre}`).waitFor();
    }, { pagina: p });
    await f.paso("El formulario trae su nombre y teléfono; elige la noche, confirma y el QR pintado se lee", async () => {
      await p.locator("#nombre").waitFor();
      const nombre = await p.inputValue("#nombre");
      const telefono = await p.inputValue("#telefono");
      afirmar(nombre === u.cliente.nombre, `nombre precargado «${nombre}», se esperaba «${u.cliente.nombre}»`);
      afirmar(telefono === u.cliente.telefono, `teléfono precargado «${telefono}»`);
      await p.fill("#fecha", esc.noche);
      await p.getByRole("button", { name: "Confirmar reserva" }).click();
      await p.getByText("¡Reserva confirmada!").waitFor();
      const card = tarjeta(p, "¡Reserva confirmada!");
      const qr = await qrEnPantalla(c, f, card, "cliente");
      const enlace = await codigoDelEnlace(card);
      afirmar(qr.texto === enlace, `el QR dice «${qr.texto}» y el enlace «${enlace}»`);
      c.qrCuenta = qr.texto;
      return `QR leído de la pantalla: ${qr.texto}${qr.nota}`;
    }, { pagina: p });
    await f.verificar("Base: el qr_code es el del QR en pantalla; orgánica, con cliente_id del cliente, sin RP", async () => {
      const r = (c.resCuenta = await reservaPorQr(c, c.qrCuenta));
      const ok = r && r.qr_code === c.qrCuenta && r.source === "organica" && r.cliente_id === u.cliente.id && r.rp_id === null && r.fecha === esc.noche && r.status === "pendiente";
      return { ok, detalle: r ? JSON.stringify({ source: r.source, cliente: r.cliente_id === u.cliente.id, rp: r.rp_id, fecha: r.fecha }) : `no hay reserva con qr_code ${c.qrCuenta}` };
    }, { pagina: p });

    const anon = c.pAnon ?? (c.pAnon = await nuevaPagina(c, c.nav, "anonimo"));
    const telAnon = tel(2);
    await f.paso("Sin cuenta: /cliente/reservar?club=<id>, llena el formulario, confirma y el QR pintado se lee", async () => {
      const t0 = Date.now();
      await anon.goto(`${c.base}/cliente/reservar?club=${esc.club.id}`, { timeout: T_NAV });
      await anon.getByText(`Reservar en ${esc.club.nombre}`).waitFor({ timeout: T_NAV });
      const tCarga = Date.now() - t0;
      await anon.fill("#nombre", nombres.anon);
      await anon.fill("#telefono", telAnon);
      await anon.fill("#fecha", esc.noche);
      const t1 = Date.now();
      await anon.getByRole("button", { name: "Confirmar reserva" }).click();
      await anon.getByText(/¡Reserva confirmada!|No pudimos crear tu reserva/).first().waitFor();
      const tEnvio = Date.now() - t1;
      if (!(await anon.getByText("¡Reserva confirmada!").count())) {
        throw new Error("la página dijo: " + (await anon.locator("form [role=alert]").first().innerText({ timeout: 2000 }).catch(() => "?")));
      }
      const card = tarjeta(anon, "¡Reserva confirmada!");
      const qr = await qrEnPantalla(c, f, card, "sin-cuenta");
      const enlace = await codigoDelEnlace(card);
      afirmar(qr.texto === enlace, `el QR dice «${qr.texto}» y el enlace «${enlace}»`);
      c.qrAnon = qr.texto;
      return `QR ${qr.texto}${qr.nota} · formulario en ${tCarga} ms, reserva en ${tEnvio} ms`;
    }, { pagina: anon });
    await f.verificar("Base: qr_code igual al de pantalla; orgánica, sin cliente_id ni RP; quedó UN intento con el hash de SU teléfono", async () => {
      const r = (c.resAnon = await reservaPorQr(c, c.qrAnon));
      if (!r) return { ok: false, detalle: `no hay reserva con qr_code ${c.qrAnon}` };
      const intento = await una(c.db,
        `select count(*)::int n from public.reserva_intentos
          where club_id = $1 and fecha = $2::date
            and telefono_hash = encode(sha256(convert_to(right(regexp_replace($3, '\\D', '', 'g'), 10), 'UTF8')), 'hex')`,
        [esc.club.id, esc.noche, r.cliente_telefono]);
      const ok = r.qr_code === c.qrAnon && r.source === "organica" && r.cliente_id === null && r.rp_id === null && intento.n === 1;
      return { ok, detalle: JSON.stringify({ source: r.source, cliente: r.cliente_id, rp: r.rp_id, intentos_de_su_telefono: intento.n }) };
    }, { pagina: anon });
    await f.paso("Boleto sin cuenta /r/<código>: abre y su QR se lee con el mismo código", async () => {
      await anon.goto(`${c.base}/r/${c.qrAnon}`, { timeout: T_NAV });
      await anon.getByText(nombres.anon).first().waitFor();
      const qr = await qrEnPantalla(c, f, tarjeta(anon, nombres.anon), "boleto-sin-cuenta");
      afirmar(qr.texto === c.qrAnon, `el boleto pinta «${qr.texto}», la base tiene «${c.qrAnon}»`);
      return `QR del boleto: ${qr.texto}${qr.nota}`;
    }, { pagina: anon });

    // Límite por teléfono (3 por antro y noche): se simulan 3 intentos en la
    // base (sin gastar el cupo de 20 por IP que comparten otros agentes) y
    // se intenta una 4ª por la interfaz.
    const telLimite = tel(3);
    let rechazo = null;
    await f.paso("Límite de la base: la 4ª reserva del mismo teléfono la rechaza PostgREST con el P0001 del límite por teléfono", async () => {
      await c.db.q(
        `insert into public.reserva_intentos (ip_hash, club_id, telefono_hash, fecha)
         select null, $1, encode(sha256(convert_to(right($2, 10), 'UTF8')), 'hex'), $3::date from generate_series(1, 3)`,
        [esc.club.id, telLimite, esc.noche]);
      await anon.goto(`${c.base}/cliente/reservar?club=${esc.club.id}`, { timeout: T_NAV });
      await anon.fill("#nombre", `${esc.tag} Limite`);
      await anon.fill("#telefono", telLimite);
      await anon.fill("#fecha", esc.noche);
      const respuesta = anon.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/rest/v1/reservations"));
      await anon.getByRole("button", { name: "Confirmar reserva" }).click();
      const res = await respuesta;
      const cuerpo = await res.json().catch(() => ({}));
      rechazo = { estado: res.status(), code: cuerpo.code ?? null, message: cuerpo.message ?? null };
      const [{ n }] = await c.db.q(`select count(*)::int n from public.reservations where club_id = $1 and cliente_telefono = $2`, [esc.club.id, telLimite]);
      afirmar(n === 0, `se guardó la reserva que debía rechazarse (${n})`);
      afirmar(rechazo.code === "P0001" && /varias reservas con este teléfono/i.test(rechazo.message ?? ""),
        `PostgREST respondió ${JSON.stringify(rechazo)}: no es el límite por teléfono`);
      return `PostgREST ${rechazo.estado} ${rechazo.code}: «${rechazo.message}» · 0 filas guardadas`;
    }, { pagina: anon, continuar: true });
    await f.paso("La página muestra el aviso de la base (P0001) en vez de un error genérico", async () => {
      afirmar(rechazo, "no hubo respuesta de PostgREST que revisar");
      const alerta = anon.locator("form [role=alert]").first();
      await alerta.waitFor();
      const texto = (await alerta.innerText()).trim();
      afirmar(texto === rechazo.message || /varias reservas con este teléfono/i.test(texto),
        `la base respondió ${rechazo.code} «${rechazo.message}», pero la página muestra «${texto}»`);
      return `aviso: ${texto}`;
    }, { pagina: anon, continuar: true });
  });

  // ---------------- 3) Check-in ----------------
  await run.flujo("3", "Check-in en la puerta (QR con cámara y sin cámara)",
    () => (!c.qrRp || !c.pngQrRp ? "no hay QR del RP leído de la pantalla (flujo 1)" : !c.resRp ? "la reserva del RP no está en la base (flujo 1)" : !c.resCuenta ? "no hay reserva directa (flujo 2)" : null),
    async (f) => {
      // La cámara falsa muestra la CAPTURA del QR que pintó /rp/panel.
      const video = videoDesdePNG(c.PNG, c.pngQrRp, path.join(c.carpeta, "qr-rp.y4m"));
      c.navCam = await c.chromium.launch({ headless: c.headless, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`] });
      const p = (c.pStaff = await nuevaPagina(c, c.navCam, "staff", { camara: true }));
      await f.paso("El staff entra y ve el panel con las reservas de la noche", async () => {
        await entrar(c, p, u.staff, /\/staff\/panel/);
        await p.getByRole("heading", { name: `Panel de ${esc.club.nombre}` }).waitFor({ timeout: T_NAV });
        await p.getByText(nombres.rp).first().waitFor();
        await p.getByText(nombres.cuenta).first().waitFor();
      }, { pagina: p });
      await f.paso("«Escanear QR»: la cámara (falsa) ve la captura del QR del panel del RP y abre su ficha", async () => {
        await p.getByRole("button", { name: "Escanear QR" }).first().click();
        const t0 = Date.now();
        await p.getByRole("button", { name: "Confirmar entrada" }).waitFor({ timeout: 30_000 });
        const texto = await p.locator("body").innerText();
        afirmar(texto.includes(nombres.rp), "la ficha no muestra al cliente");
        afirmar(texto.includes(`RP: ${u.rp.nombre}`), "la ficha no muestra el RP");
        afirmar(/no garantiza la entrada/i.test(texto), "falta el aviso del QR");
        return `leído en ${((Date.now() - t0) / 1000).toFixed(1)} s`;
      }, { pagina: p });
      await f.paso("«Confirmar entrada» → «¡Entrada confirmada!»", async () => {
        await p.getByRole("button", { name: "Confirmar entrada" }).click();
        await p.getByText("¡Entrada confirmada!").waitFor();
      }, { pagina: p });
      await f.verificar("Base: la reserva del RP queda usada / entró, con el staff que la confirmó", async () => {
        const r = await reservaPorQr(c, c.qrRp);
        return { ok: r.status === "usada" && r.puerta_estado === "entro" && r.entrada_por === u.staff.id, detalle: JSON.stringify({ status: r.status, puerta: r.puerta_estado, por_staff: r.entrada_por === u.staff.id }) };
      }, { pagina: p });
      await f.paso("Cierra el escáner y la reserva directa entra con «Confirmar entrada sin cámara»", async () => {
        await p.getByRole("button", { name: "Cerrar escáner" }).click();
        const t = p.locator("[data-slot=card]").filter({ hasText: nombres.cuenta });
        await t.getByRole("button", { name: "Confirmar entrada sin cámara" }).click();
        await t.getByText("Sentar en mesa").waitFor();
      }, { pagina: p });
      await f.verificar("Base: la reserva directa queda usada / entró, con el staff que la confirmó", async () => {
        const r = await reservaPorQr(c, c.qrCuenta);
        return { ok: r.status === "usada" && r.puerta_estado === "entro" && r.entrada_por === u.staff.id, detalle: JSON.stringify({ status: r.status, puerta: r.puerta_estado, por_staff: r.entrada_por === u.staff.id }) };
      }, { pagina: p });
      if (c.qrAnon) {
        await f.paso("La reserva sin cuenta también entra sin cámara (para el 2º grupo)", async () => {
          const t = p.locator("[data-slot=card]").filter({ hasText: nombres.anon });
          await t.getByRole("button", { name: "Confirmar entrada sin cámara" }).click();
          await t.getByText("Sentar en mesa").waitFor();
          const r = await reservaPorQr(c, c.qrAnon);
          afirmar(r.status === "usada" && r.puerta_estado === "entro" && r.entrada_por === u.staff.id, `base: ${r.status}/${r.puerta_estado}/por staff ${r.entrada_por === u.staff.id}`);
          c.anonEntro = true;
        }, { pagina: p });
      }
      if (f.vivo) c.entraron = true;
    });

  // ---------------- 4) Asignación de mesa ----------------
  await run.flujo("4", "Asignación de mesa en /staff/caja", () => (!c.entraron ? "no hubo check-in (flujo 3)" : null), async (f) => {
    const p = c.pStaff;
    await f.paso("El staff abre la caja: mapa de la noche con las 3 mesas libres", async () => {
      await abrirCaja(c, p);
      for (const n of [1, 2, 3]) afirmar(/libre/.test((await botonMesa(p, n).getAttribute("aria-label")) ?? ""), `la mesa ${n} no está libre`);
    }, { pagina: p });
    await f.paso("Mesa 1 → «Recibir grupo» → elige la reserva del RP → «Sentar en la mesa»", async () => {
      await abrirMesa(p, 1);
      await p.getByRole("button", { name: "Recibir grupo", exact: true }).click();
      const hoja = dialogo(p, "Sentar cliente · Mesa 1");
      await hoja.getByRole("button", { name: new RegExp(nombres.rp) }).click();
      await hoja.getByRole("button", { name: "Sentar en la mesa" }).click();
      await hoja.waitFor({ state: "detached" });
      await p.getByText(nombres.rp).first().waitFor();
      await p.getByRole("button", { name: "Agregar consumo", exact: true }).waitFor();
    }, { pagina: p });
    await f.verificar("Base: Mesa 1 con una sesión abierta y la cuenta de la reserva con su RP", async () => {
      const [cu] = await c.db.q(`select k.rp_id, k.origen, s.estado, s.mesa_id from public.mesa_cuentas k join public.mesa_sesiones s on s.id = k.sesion_id where k.reservation_id = $1`, [c.resRp.id]);
      return { ok: cu && cu.mesa_id === mesa(1).id && cu.estado === "abierta" && cu.rp_id === u.rp.id && cu.origen === "reserva", detalle: JSON.stringify(cu && { estado: cu.estado, origen: cu.origen, rp: cu.rp_id === u.rp.id }) };
    }, { pagina: p });
    await f.paso("Mesa 2 → «Recibir grupo» → la reserva directa", async () => {
      await p.getByRole("button", { name: "Volver a las mesas" }).click();
      await abrirMesa(p, 2);
      await p.getByRole("button", { name: "Recibir grupo", exact: true }).click();
      const hoja = dialogo(p, "Sentar cliente · Mesa 2");
      await hoja.getByRole("button", { name: new RegExp(nombres.cuenta) }).click();
      await hoja.getByRole("button", { name: "Sentar en la mesa" }).click();
      await hoja.waitFor({ state: "detached" });
      await p.getByRole("button", { name: "Agregar consumo", exact: true }).waitFor();
    }, { pagina: p });
    await f.verificar("Base: Mesa 2 con la cuenta de la reserva directa, sin RP", async () => {
      const [cu] = await c.db.q(`select k.rp_id, k.origen, s.estado, s.mesa_id from public.mesa_cuentas k join public.mesa_sesiones s on s.id = k.sesion_id where k.reservation_id = $1`, [c.resCuenta.id]);
      return { ok: cu && cu.mesa_id === mesa(2).id && cu.rp_id === null && cu.estado === "abierta", detalle: JSON.stringify(cu && { estado: cu.estado, rp: cu.rp_id }) };
    }, { pagina: p });
    if (f.vivo) c.sentados = true;
  });

  // ---------------- 5) Consumo y cobro ----------------
  await run.flujo("5", "Consumo y cobro (idempotencia: doble clic y reintento con la misma clave)", () => (!c.sentados ? "no hay mesas con clientes (flujo 4)" : null), async (f) => {
    const p = c.pStaff;
    await f.paso("Mesa 2 (abierta): «Agregar consumo» con concepto libre 2 × Cerveza e2e de $90", async () => {
      await p.getByRole("button", { name: "Agregar consumo", exact: true }).click();
      await agregarConsumo(p, { concepto: "Cerveza e2e", precio: "90", cantidad: 2, total: "$180" });
      await p.getByText("2 × Cerveza e2e").waitFor();
    }, { pagina: p });
    await f.paso("Mesa 2: «+ Agregar consumo» toma «Cerveza e2e» de lo vendido esta noche (+1)", async () => {
      await p.getByRole("button", { name: "+ Agregar consumo" }).click();
      await agregarConsumo(p, { delListo: { nombre: "Cerveza e2e", veces: 1 }, total: "$90" });
      await p.getByRole("button", { name: "Cobrar $270" }).waitFor();
    }, { pagina: p });
    await f.verificar("Base: Mesa 2 suma $270 en 2 cargos", async () => {
      const [s] = await sesionesDeMesa(c, mesa(2).id);
      const [{ n }] = await c.db.q(`select count(*)::int n from public.caja_consumos where sesion_id = $1`, [s.id]);
      return { ok: s.consumo === 27000 && n === 2, detalle: `consumo ${s.consumo} centavos, ${n} cargos` };
    }, { pagina: p });
    let cobroTarjeta = null;
    await f.paso("Idempotencia: Mesa 2 «Cobrar $270» en tarjeta con DOBLE CLIC en el botón de cobrar", async () => {
      await p.getByRole("button", { name: "Cobrar $270" }).click();
      const hoja = dialogo(p, "Cobrar");
      await hoja.getByRole("button", { name: "Tarjeta" }).click();
      await hoja.getByPlaceholder("Últimos 4 dígitos o folio").fill("4242");
      const espia = espiarRpc(p, "caja_registrar_pago");
      await hoja.getByRole("button", { name: "Cobrar $270" }).dblclick();
      await hoja.waitFor({ state: "detached" });
      // Margen para que un segundo envío (si lo hubiera) llegue a la base.
      await p.waitForTimeout(1500);
      espia.parar();
      await p.getByText(/Cobrado\s*\$270/).first().waitFor();
      afirmar(espia.llamadas.length >= 1, "no se vio ninguna llamada a caja_registrar_pago");
      cobroTarjeta = espia.llamadas[0];
      const claves = new Set(espia.llamadas.map(claveDe));
      return `${espia.llamadas.length} llamada(s) a caja_registrar_pago${espia.llamadas.length > 1 ? `, ${claves.size} clave(s) distinta(s)` : " (el candado del botón frenó el 2º clic)"}`;
    }, { pagina: p });
    await f.verificar("Base (idempotencia): un solo pago de $270 en tarjeta, saldo 0", async () => {
      const [s] = await sesionesDeMesa(c, mesa(2).id);
      const pagos = await c.db.q(`select id, metodo, monto_centavos::int as monto_centavos, referencia from public.caja_pagos where sesion_id = $1`, [s.id]);
      c.pagoTarjeta = pagos[0]?.id ?? null;
      return { ok: pagos.length === 1 && pagos[0].monto_centavos === 27000 && pagos[0].metodo === "tarjeta" && s.cobrado === s.consumo, detalle: `${pagos.length} pago(s): ${JSON.stringify(pagos.map((x) => ({ metodo: x.metodo, monto_centavos: x.monto_centavos, referencia: x.referencia })))}` };
    }, { pagina: p });
    await f.verificar("Reintento real: la MISMA llamada (misma clave, misma sesión) reenviada como si se hubiera perdido la respuesta devuelve el mismo pago y no crea otro", async () => {
      if (!cobroTarjeta) return { ok: false, detalle: "no se capturó la llamada original" };
      const claveOriginal = claveDe(cobroTarjeta);
      const r = await reenviar(p, cobroTarjeta);
      const id = (() => {
        try {
          return JSON.parse(r.cuerpo);
        } catch {
          return r.cuerpo;
        }
      })();
      const [s] = await sesionesDeMesa(c, mesa(2).id);
      const [{ n }] = await c.db.q(`select count(*)::int n from public.caja_pagos where sesion_id = $1`, [s.id]);
      const ok = !!claveOriginal && r.estado === 200 && id === c.pagoTarjeta && n === 1;
      return { ok, detalle: `clave ${claveOriginal ? "presente" : "AUSENTE"} · reenvío HTTP ${r.estado} → ${id === c.pagoTarjeta ? "mismo id de pago" : `otro resultado: ${String(r.cuerpo).slice(0, 160)}`} · pagos en la mesa: ${n}` };
    }, { pagina: p });
    await f.paso("Mesa 1: consumo libre 1 × Botella e2e de $1,250.50", async () => {
      await p.getByRole("button", { name: "Volver a las mesas" }).click();
      await abrirMesa(p, 1);
      await p.getByRole("button", { name: "Agregar consumo", exact: true }).click();
      await agregarConsumo(p, { concepto: "Botella e2e", precio: "1250.50", total: "$1,250.50" });
      await p.getByRole("button", { name: "Cobrar $1,250.50" }).waitFor();
    }, { pagina: p });
    await f.paso("Mesa 1: «Cobrar $1,250.50» en efectivo", async () => {
      await p.getByRole("button", { name: "Cobrar $1,250.50" }).click();
      const hoja = dialogo(p, "Cobrar");
      afirmar((await hoja.getByRole("button", { name: "Efectivo" }).getAttribute("aria-pressed")) === "true", "efectivo no viene elegido");
      await hoja.getByRole("button", { name: "Cobrar $1,250.50" }).click();
      await hoja.waitFor({ state: "detached" });
      await p.getByText(/Cobrado\s*\$1,250\.50/).first().waitFor();
    }, { pagina: p });
    await f.verificar("Base: Mesa 1 con $1,250.50 de consumo y un pago en efectivo por lo mismo", async () => {
      const [s] = await sesionesDeMesa(c, mesa(1).id);
      return { ok: s.consumo === 125050 && s.cobrado === 125050 && s.pagos === 1, detalle: JSON.stringify({ estado: s.estado, consumo: s.consumo, cobrado: s.cobrado, pagos: s.pagos }) };
    }, { pagina: p });
    await f.paso("El staff no puede cuadrar: con saldo 0 su botón es «Cerrar mesa»", async () => {
      await p.getByRole("button", { name: "Cerrar mesa", exact: true }).waitFor();
      afirmar(!(await p.getByRole("button", { name: "Cuadrar mesa" }).count()), "el staff ve «Cuadrar mesa»");
    }, { pagina: p });
    if (f.vivo) c.cobrado = true;
  });

  // ---------------- 6) Comisión ----------------
  await run.flujo("6", "Comisión al cuadrar (gerente)", () => (!c.cobrado ? "no se cobró (flujo 5)" : null), async (f) => {
    const p = (c.pGerente = await nuevaPagina(c, c.navCam, "gerente"));
    await f.paso("El gerente entra y abre la caja", async () => {
      await entrar(c, p, u.gerente, /\/staff\/panel/);
      await abrirCaja(c, p);
    }, { pagina: p });
    await f.paso("Mesa 1 → «Cuadrar mesa» → «Cuadrar mesa · $1,250.50»", async () => {
      await abrirMesa(p, 1);
      await p.getByRole("button", { name: "Cuadrar mesa", exact: true }).click();
      const hoja = dialogo(p, "Cuadrar mesa");
      await hoja.getByRole("button", { name: "Cuadrar mesa · $1,250.50" }).click();
      await hoja.waitFor({ state: "detached" });
      await p.getByRole("button", { name: "Recibir nuevo grupo" }).waitFor();
      await p.getByText("Cuadrado · no se modifica").first().waitFor();
    }, { pagina: p });
    await f.verificar(`Base: nació UNA comisión de RP de $${COMISION_FIJA} (regla del antro: fijo por reserva, sin cuota) para la reserva del RP`, async () => {
      const club = await una(c.db, `select comision_tipo, comision_monto::numeric::text m, comision_desbloqueo_reservas d, pago_rp_modo from public.clubs where id = $1`, [esc.club.id]);
      const esperado = club.comision_tipo === "fijo" && Number(club.d) === 0 ? Number(club.m) : NaN;
      const com = await comisionesDe(c, c.resRp.id);
      const r = await reservaPorQr(c, c.qrRp);
      const [s] = await sesionesDeMesa(c, mesa(1).id);
      const ok = com.length === 1 && com[0].tipo === "rp" && Number(com[0].monto) === esperado && esperado === COMISION_FIJA && com[0].rp_id === u.rp.id && com[0].status === "pendiente" && com[0].regla_id === null && s.estado === "cuadrada" && s.cuadrada_por === u.gerente.id && Number(r.consumo_monto) === 1250.5;
      return { ok, detalle: `esperado $${esperado} · comisiones ${JSON.stringify(com.map((x) => ({ tipo: x.tipo, monto: x.monto, status: x.status })))} · sesión ${s.estado} · consumo_monto ${r.consumo_monto}` };
    }, { pagina: p });
    await f.paso("Mesa 2 → «Cuadrar mesa · $270»", async () => {
      await p.getByRole("button", { name: "Volver a las mesas" }).click();
      await abrirMesa(p, 2);
      await p.getByRole("button", { name: "Cuadrar mesa", exact: true }).click();
      const hoja = dialogo(p, "Cuadrar mesa");
      await hoja.getByRole("button", { name: "Cuadrar mesa · $270" }).click();
      await hoja.waitFor({ state: "detached" });
      await p.getByRole("button", { name: "Recibir nuevo grupo" }).waitFor();
    }, { pagina: p });
    await f.verificar("Base: la reserva directa (orgánica) NO genera comisión de RP", async () => {
      const com = await comisionesDe(c, c.resCuenta.id);
      const [s] = await sesionesDeMesa(c, mesa(2).id);
      return { ok: com.length === 0 && s.estado === "cuadrada", detalle: `comisiones: ${com.length}, sesión ${s.estado}` };
    }, { pagina: p });
    if (f.vivo) c.cuadradas = true;
  });

  // ---------------- 7) Segundo grupo en la Mesa 1 ----------------
  await run.flujo("7", "Segundo grupo en la misma mesa (Mesa 1)",
    () => (!c.cuadradas ? "la Mesa 1 no se cuadró (flujo 6)" : !c.resAnon ? "no hay reserva sin cuenta (flujo 2)" : !c.anonEntro ? "la reserva sin cuenta no entró (flujo 3)" : null),
    async (f) => {
      const p = c.pStaff;
      await f.paso("El staff recarga la caja: Mesa 1 cuadrada → «Recibir nuevo grupo» con la reserva sin cuenta", async () => {
        await abrirCaja(c, p);
        afirmar(/cuadrada/.test((await botonMesa(p, 1).getAttribute("aria-label")) ?? ""), "la Mesa 1 no sale cuadrada en el mapa");
        await abrirMesa(p, 1);
        await p.getByRole("button", { name: "Recibir nuevo grupo" }).click();
        const hoja = dialogo(p, "Recibir nuevo grupo · Mesa 1");
        await hoja.getByRole("button", { name: new RegExp(nombres.anon) }).click();
        await hoja.getByRole("button", { name: "Sentar en la mesa" }).click();
        await hoja.waitFor({ state: "detached" });
        c.segundoGrupoAbierto = true;
        await p.getByText("Grupo 1 · ").first().waitFor();
        await p.getByRole("button", { name: "Agregar consumo", exact: true }).waitFor();
      }, { pagina: p });
      await f.verificar("Base: la Mesa 1 tiene 2 sesiones en la noche (la 1ª cuadrada, la 2ª abierta)", async () => {
        const s = await sesionesDeMesa(c, mesa(1).id);
        return { ok: s.length === 2 && s[0].estado === "cuadrada" && s[1].estado === "abierta", detalle: JSON.stringify(s.map((x) => x.estado)) };
      }, { pagina: p });
      await f.paso("2º grupo: 2 × Cerveza e2e de lo vendido esta noche", async () => {
        await p.getByRole("button", { name: "Agregar consumo", exact: true }).click();
        await agregarConsumo(p, { delListo: { nombre: "Cerveza e2e", veces: 2 }, total: "$180" });
        await p.getByRole("button", { name: "Cobrar $180" }).waitFor();
      }, { pagina: p });
      let cobro = null;
      await f.paso("Idempotencia: «Cobrar $180» con dos clics en el mismo instante (antes de que React repinte)", async () => {
        await p.getByRole("button", { name: "Cobrar $180" }).click();
        const hoja = dialogo(p, "Cobrar");
        const espia = espiarRpc(p, "caja_registrar_pago");
        await hoja.getByRole("button", { name: "Cobrar $180" }).evaluate((b) => { b.click(); b.click(); });
        await hoja.waitFor({ state: "detached" });
        await p.waitForTimeout(1500);
        espia.parar();
        afirmar(espia.llamadas.length >= 1, "no se vio ninguna llamada a caja_registrar_pago");
        cobro = espia.llamadas;
        const claves = new Set(espia.llamadas.map(claveDe));
        // Quién frenó el 2º clic: el candado síncrono (1 llamada) o la clave
        // de idempotencia en la base (2 llamadas con la misma clave).
        const defensa = espia.llamadas.length === 1 ? "el candado del botón (useAccion): salió 1 sola llamada"
          : claves.size === 1 ? `la clave de idempotencia: salieron ${espia.llamadas.length} llamadas con la misma clave`
            : `NINGUNA: salieron ${espia.llamadas.length} llamadas con ${claves.size} claves distintas`;
        afirmar(espia.llamadas.length === 1 || claves.size === 1, `defensa: ${defensa}`);
        return `defensa: ${defensa}`;
      }, { pagina: p });
      await f.verificar("Base (idempotencia): un solo pago de $180 en el 2º grupo", async () => {
        const s = await sesionesDeMesa(c, mesa(1).id);
        const pagos = await c.db.q(`select id, metodo, monto_centavos::int as monto_centavos from public.caja_pagos where sesion_id = $1`, [s[1].id]);
        c.pagoGrupo2 = pagos[0]?.id ?? null;
        return { ok: pagos.length === 1 && pagos[0].monto_centavos === 18000 && pagos[0].metodo === "efectivo", detalle: `${pagos.length} pago(s): ${JSON.stringify(pagos.map((x) => ({ metodo: x.metodo, monto_centavos: x.monto_centavos, referencia: x.referencia })))}` };
      }, { pagina: p });
      await f.verificar("Reintento real del cobro del 2º grupo (misma clave) devuelve el mismo pago", async () => {
        if (!cobro?.length) return { ok: false, detalle: "no se capturó la llamada original" };
        const r = await reenviar(p, cobro[0]);
        let id = r.cuerpo;
        try { id = JSON.parse(r.cuerpo); } catch { /* texto */ }
        const s = await sesionesDeMesa(c, mesa(1).id);
        const [{ n }] = await c.db.q(`select count(*)::int n from public.caja_pagos where sesion_id = $1`, [s[1].id]);
        return { ok: r.estado === 200 && id === c.pagoGrupo2 && n === 1, detalle: `reenvío HTTP ${r.estado} → ${id === c.pagoGrupo2 ? "mismo id de pago" : String(r.cuerpo).slice(0, 160)} · pagos del 2º grupo: ${n}` };
      }, { pagina: p });
      await f.paso("El gerente cuadra el 2º grupo; el mapa muestra la Mesa 1 con «2 grupos»", async () => {
        const g = c.pGerente;
        await abrirCaja(c, g);
        await abrirMesa(g, 1);
        await g.getByRole("button", { name: "Cuadrar mesa", exact: true }).click();
        const hoja = dialogo(g, "Cuadrar mesa");
        await hoja.getByRole("button", { name: "Cuadrar mesa · $180" }).click();
        await hoja.waitFor({ state: "detached" });
        await g.getByText("Grupo 2 · ").first().waitFor();
        await g.getByRole("button", { name: "Volver a las mesas" }).click();
        await botonMesa(g, 1).filter({ hasText: "2 grupos" }).waitFor();
        return (await botonMesa(g, 1).innerText()).replace(/\s+/g, " ");
      }, { pagina: () => c.pGerente });
      await f.verificar("Base: el 2º grupo (reserva orgánica sin cuenta) no genera comisión; la Mesa 1 suma $1,430.50 en la noche", async () => {
        const com = await comisionesDe(c, c.resAnon.id);
        const s = await sesionesDeMesa(c, mesa(1).id);
        const total = s.reduce((a, x) => a + x.consumo, 0);
        return { ok: com.length === 0 && s.every((x) => x.estado === "cuadrada") && total === 143050, detalle: `comisiones ${com.length} · sesiones ${s.map((x) => x.estado)} · total ${total}` };
      }, { pagina: () => c.pGerente });
      if (f.vivo) c.segundoGrupo = true;
    });

  // ---------------- 8) Cierre de noche ----------------
  await run.flujo("8", "Cierre de la noche y panel del RP", async () => {
    if (!c.cuadradas) return "no se cuadraron las mesas (flujo 6)";
    if (c.segundoGrupoAbierto && !c.segundoGrupo) return "el 2º grupo de la Mesa 1 se sentó pero el flujo 7 no terminó (falta cuadrarlo): el cierre de noche no se puede probar";
    const pendientes = await c.db.q(`select count(*)::int n from public.mesa_sesiones where club_id = $1 and estado <> 'cuadrada'`, [esc.club.id]);
    if (pendientes[0].n) return `${pendientes[0].n} sesión(es) de mesa sin cuadrar en la base`;
    return null;
  }, async (f) => {
    const p = c.pGerente;
    const efectivo = 125050 + (c.segundoGrupo ? 18000 : 0);
    const tarjeta = 27000;
    const faltante = 5000; // se cuentan $50 menos de efectivo
    await f.paso("«Cuadre de la noche»: todas las mesas cuadradas y los cobrados por método", async () => {
      await abrirCaja(c, p);
      await p.getByRole("button", { name: "Cuadre de la noche" }).click();
      await p.getByText("Todas las mesas de la noche están cuadradas.").waitFor();
      const texto = await p.locator("body").innerText();
      afirmar(texto.includes(pesos(efectivo)) && texto.includes(pesos(tarjeta)), `no aparecen los cobrados ${pesos(efectivo)} / ${pesos(tarjeta)}`);
      return `efectivo ${pesos(efectivo)} · tarjeta ${pesos(tarjeta)}`;
    }, { pagina: p });
    await f.paso(`Conteo físico: efectivo con $50 de menos, tarjeta exacta, otro 0 → «Faltan $50»`, async () => {
      await p.fill("#conteo-efectivo", ((efectivo - faltante) / 100).toFixed(2));
      await p.fill("#conteo-tarjeta", (tarjeta / 100).toFixed(2));
      await p.fill("#conteo-otro", "0");
      await p.fill("#notas-noche", `${esc.tag} faltante de prueba`);
      await p.getByText("Faltan $50").first().waitFor();
    }, { pagina: p });
    await f.paso("«Cerrar la noche» → «Noche cerrada» con la diferencia", async () => {
      await p.getByRole("button", { name: "Cerrar la noche" }).click();
      await p.getByText("Noche cerrada").first().waitFor();
      await p.getByText("Faltan $50").first().waitFor();
    }, { pagina: p });
    await f.verificar("Base: caja_noches cerrada por el gerente y cuadre de noche con diferencia −$50", async () => {
      const n = await una(c.db, `select id, estado, cerrada_por from public.caja_noches where club_id = $1 and fecha_operacion = $2`, [esc.club.id, esc.noche]);
      const q = n && (await una(c.db, `select registrado_centavos::int reg, cobrado_efectivo_centavos::int ef, cobrado_tarjeta_centavos::int ta, saldo_sin_cobrar_centavos::int saldo,
                                              contado_efectivo_centavos::int cef, contado_tarjeta_centavos::int cta, diferencia_centavos::int dif
                                       from public.caja_cuadres where noche_id = $1 and tipo = 'noche'`, [n.id]));
      const reg = efectivo + tarjeta;
      const ok = n?.estado === "cerrada" && n.cerrada_por === u.gerente.id && q && q.reg === reg && q.ef === efectivo && q.ta === tarjeta && q.saldo === 0 && q.cef === efectivo - faltante && q.cta === tarjeta && q.dif === -faltante;
      return { ok, detalle: `noche ${n?.estado} · cuadre ${JSON.stringify(q)} · esperado registrado ${reg}, diferencia ${-faltante}` };
    }, { pagina: p });
    await f.paso("Panel del RP: su reserva sale «Consumió» con $1,250.50", async () => {
      const r = c.pRp;
      await r.goto(c.base + "/rp/panel", { timeout: T_NAV });
      const fila = r.getByRole("button", { name: `${nombres.rp}, Consumió` });
      await fila.waitFor();
      const texto = await fila.innerText();
      afirmar(texto.includes("$1,250.50"), `la fila no muestra el consumo: ${texto.replace(/\s+/g, " ")}`);
      return texto.replace(/\s+/g, " ");
    }, { pagina: () => c.pRp });
    await f.paso(`Nómina del RP: «Esta semana» muestra $${COMISION_FIJA}`, async () => {
      const r = c.pRp;
      await r.getByRole("navigation", { name: "Navegación principal" }).getByRole("button", { name: "Nómina" }).click();
      await r.getByText("Esta semana").first().waitFor();
      await r.getByText(/Cargando/).first().waitFor({ state: "hidden" }).catch(() => {});
      try {
        await r.getByText(new RegExp(`^\\$${COMISION_FIJA}(\\.00)?$`)).first().waitFor({ timeout: 15_000 });
      } catch {
        throw new Error(`la nómina no muestra $${COMISION_FIJA}. ${await diagnosticoNomina(c, r)}`);
      }
      return (await r.locator("main").innerText()).split("\n").slice(0, 6).join(" · ");
    }, { pagina: () => c.pRp });
  });
}

// Diagnóstico de la nómina, calculado en el momento (nada de texto fijo):
// qué muestra la pantalla, qué hay en la base, qué ve el RP con SU sesión por
// la tabla y por la función, si existe la política de lectura propia del RP y
// de dónde lee el panel.
async function diagnosticoNomina(c, r) {
  const partes = [];
  const pantalla = (await r.locator("main").innerText().catch(() => "")).split("\n").filter(Boolean).slice(0, 8).join(" · ");
  partes.push(`Pantalla: «${pantalla}».`);
  const com = await comisionesDe(c, c.resRp.id);
  partes.push(`Base: ${com.length} comisión(es) ${JSON.stringify(com.map((x) => x.monto))} del RP.`);
  try {
    const sb = await c.sesionDe(c.esc.usuarios.rp);
    const directo = await sb.from("reservations").select("id", { count: "exact", head: true }).eq("rp_id", c.esc.usuarios.rp.id);
    const fn = await sb.rpc("rp_mis_reservas", { p_desde: c.esc.noche, p_hasta: c.esc.noche });
    partes.push(`Con la sesión del RP: select a reservations → ${directo.error ? "error " + directo.error.code : directo.count + " fila(s)"}; rp_mis_reservas(noche) → ${fn.error ? "error " + fn.error.code : (fn.data?.length ?? 0) + " fila(s)"}.`);
    await sb.auth.signOut().catch(() => {});
  } catch (e) {
    partes.push(`No se pudo abrir la sesión del RP para diagnosticar: ${String(e.message).slice(0, 120)}.`);
  }
  const [pol] = await c.db.q(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'reservations' and policyname = 'reservations_select_rp_own'`);
  partes.push(`Política reservations_select_rp_own en dev: ${pol.n ? "existe" : "no existe"}.`);
  try {
    const fuente = readFileSync(path.join(c.raiz, "app", "rp", "panel", "page.tsx"), "utf8");
    partes.push(`app/rp/panel/page.tsx ${/\.from\("reservations"\)\s*\.select/.test(fuente) ? "lee reservations directo" : "no lee reservations directo"}${/rp_mis_reservas/.test(fuente) ? " y usa rp_mis_reservas" : ""}.`);
  } catch { /* sin fuente */ }
  return partes.join(" ");
}
