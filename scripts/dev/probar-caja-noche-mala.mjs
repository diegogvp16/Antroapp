// Caja en plena noche con mala señal (B9, segunda pasada): lo que le pasa a
// un staff de verdad, en el navegador real:
//
//  1. reloj del teléfono desfasado (adelantado y luego corregido entre el
//     consumo y el cobro): se envían en el orden en que se capturaron;
//  2. dos staff sobre la misma mesa: otro cobra y el gerente cuadra mientras
//     uno captura sin señal; el rechazo se ve con motivo y qué hacer;
//  3. cerrar o cuadrar una mesa con movimientos suyos aún en el teléfono:
//     no se deja hasta que lleguen (antes se cerraba sin ellos);
//  4. el token vence a media cola (401): se renueva y se manda una vez;
//  5. otra cuenta entra en otra pestaña del mismo teléfono con pendientes:
//     la caja se tapa y lo de la primera no sale con la sesión de la otra;
//  6. la sesión se cierra con pendientes: se avisa, no se rechaza ni se
//     pierde; al volver a entrar se manda una vez;
//  7. cerrar sesión con pendientes: pregunta antes; sin señal la sesión sí
//     se borra del teléfono;
//  8. pestaña en segundo plano al volver la señal: igual se manda.
//
// Capturas a 360 px de sin red, enviando y rechazado en screenshots-b-caja/.
//
// Contra el servidor local de dev y antroapp-dev. Arma su propio antro
// ("T caja …", cuentas t_caja_…@example.com) y lo borra al final, aunque
// falle (si el proceso muere: probar-caja-sin-red.mjs --limpiar-restos).
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-caja-noche-mala.mjs [http://localhost:3001]

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
async function cargarPlaywright() {
  try {
    return req("playwright");
  } catch {
    if (!process.env.PLAYWRIGHT_DESDE) {
      console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
      process.exit(1);
    }
    return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
  }
}
const { chromium } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-b-caja") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);

// Restos de una corrida interrumpida (Ctrl+C, proceso muerto): sin el
// finally no se borró nada. Solo toca el prefijo de esta prueba.
const TAG = randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
let clubId = null;
const resultados = [];
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
function nota(texto, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function usuario(clave, role) {
  const email = `t_caja_${clave.toLowerCase()}_${TAG}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  U[clave] = { id: u.user.id, email };
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id: clubId, activo: true }), "perfil " + clave);
  const api = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  ok(await api.auth.signInWithPassword({ email, password: PASS }), "login api " + clave);
  U[clave].api = api;
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubId) {
      // producto_movimientos (fase 2) apunta a caja_consumos: va primero.
      for (const t of ["producto_movimientos", "caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos", "productos"])
        await db.q(`delete from public.${t} where club_id = $1`, [clubId]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = $1)", [clubId]);
      await db.q("delete from public.reservations where club_id = $1", [clubId]);
      await db.q("delete from public.club_tables where club_id = $1", [clubId]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = $1", [clubId]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  await svc
    .from("login_intentos")
    .delete()
    .in("email_hash", Object.values(U).map((u) => createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex")));
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from auth.users where email like $2)::int usuarios`,
    [`T caja ${TAG}%`, `t_caja_%_${TAG}@example.com`],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

// La verdad: lo que hay en la base para una sesión.
async function totales(sesionId) {
  const c = ok(await svc.from("caja_consumos").select("monto_centavos, clave_cliente, registrado_por").eq("sesion_id", sesionId).eq("anulado", false), "consumos");
  const p = ok(await svc.from("caja_pagos").select("monto_centavos, clave_cliente, registrado_por").eq("sesion_id", sesionId).eq("anulado", false), "pagos");
  const suma = (xs) => xs.reduce((s, x) => s + Number(x.monto_centavos), 0);
  return { consumos: c.length, consumo: suma(c), pagos: p.length, cobrado: suma(p), filasC: c, filasP: p };
}
const pesos = (c) => "$" + (c / 100).toLocaleString("es-MX", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

// Lo que hay en la cola del teléfono (IndexedDB de ese contexto).
const leerCola = (p) =>
  p.evaluate(
    () =>
      new Promise((ok) => {
        const r = indexedDB.open("antroapp-caja");
        r.onupgradeneeded = () => r.transaction.abort();
        r.onerror = () => ok([]);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("pendientes")) {
            db.close();
            return ok([]);
          }
          const g = db.transaction("pendientes").objectStore("pendientes").getAll();
          g.onsuccess = () => {
            db.close();
            ok(g.result);
          };
        };
      }),
  );
async function esperarCola(p, condicion, ms = 30000) {
  const fin = Date.now() + ms;
  let x = [];
  while (Date.now() < fin) {
    x = await leerCola(p).catch(() => []);
    if (condicion(x)) return x;
    await esperar(400);
  }
  return x;
}
async function esperarBase(sesionId, condicion, ms = 30000) {
  const fin = Date.now() + ms;
  let t = await totales(sesionId);
  while (Date.now() < fin && !condicion(t)) {
    await esperar(500);
    t = await totales(sesionId);
  }
  return t;
}

const navegador = await chromium.launch();
const errores = [];
const consola = new Set();
async function dispositivo(nombre) {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  ctx.on("weberror", (e) => errores.push(`${nombre}: ${String(e.error()).slice(0, 160)}`));
  // Avisos de la consola (informativo: sin red el navegador registra los fetch fallidos).
  ctx.on("console", (m) => {
    if (m.type() === "error") consola.add(`${nombre}: ${m.text().slice(0, 140)}`);
  });
  return ctx;
}
async function entrar(ctx, clave) {
  const p = await ctx.newPage();
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", U[clave].email);
  await p.fill("#password", PASS);
  await p.click("button[type=submit]");
  await p.waitForURL(/staff\/panel/, { timeout: 90000 });
  await p.goto(BASE + "/staff/caja");
  await p.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 60000 });
  // El service worker tiene que controlar la página para que, sin red, la
  // recarga muestre /offline.html.
  await p.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  });
  return p;
}
const abrirMesa = async (p, n) => {
  await p.getByRole("button", { name: new RegExp(`^Mesa ${n},`) }).click();
  await p.getByRole("button", { name: "Volver a las mesas" }).waitFor();
};
const volver = (p) => p.getByRole("button", { name: "Volver a las mesas" }).click();
const hojaCerrada = (p, nombre) => p.getByRole("dialog", { name: nombre }).waitFor({ state: "detached", timeout: 30000 });
async function agregarConsumo(p, concepto, precio) {
  await p.getByRole("button", { name: /Agregar consumo/ }).first().click();
  const hoja = p.getByRole("dialog", { name: "Agregar consumo" });
  await hoja.waitFor();
  await hoja.getByLabel("Concepto").fill(concepto);
  await hoja.getByLabel("Precio unitario ($)").fill(precio);
  await hoja.getByRole("button", { name: /Guardar en el teléfono|Agregar a la mesa/ }).click();
  await hojaCerrada(p, "Agregar consumo");
}
async function cobrarSaldo(p) {
  await p.getByRole("button", { name: /^Cobrar \$/ }).first().click();
  const hoja = p.getByRole("dialog", { name: "Cobrar" });
  await hoja.waitFor();
  await hoja.getByRole("button", { name: /^(Cobrar|Guardar cobro) \$/ }).click();
  await hojaCerrada(p, "Cobrar");
}

const a360 = async (p, nombre) => {
  await p.setViewportSize({ width: 360, height: 740 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: SHOTS + nombre, fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
};
async function iniciarSesion(p, clave) {
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", U[clave].email);
  await p.fill("#password", PASS);
  await p.click("button[type=submit]");
  await p.waitForURL(/staff\/panel/, { timeout: 90000 });
}
async function irACaja(p) {
  await p.goto(BASE + "/staff/caja");
  await p.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 60000 });
}
const visible = (loc, ms = 15000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const llamadasDe = (ctx, patron) => {
  const c = { n: 0 };
  ctx.on("request", (r) => {
    if (patron.test(r.url())) c.n++;
  });
  return c;
};
const cookiesDeSesion = async (ctx) => (await ctx.cookies()).filter((c) => /auth-token/.test(c.name)).length;

try {
  // ======================= Escenario =======================
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `T caja ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva" }).eq("id", clubId), "publicar");
  await usuario("staffA", "staff");
  await usuario("staffB", "staff");
  await usuario("staffD", "staff");
  await usuario("gerente", "gerente");
  const mesas = ok(await svc.from("club_tables").insert([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const S = {};
  const cuenta = async (sesion) => ok(await svc.from("mesa_cuentas").select("id").eq("sesion_id", sesion).single(), "cuenta").id;
  for (const m of mesas) {
    S[m.numero] = ok(await U.staffA.api.rpc("caja_abrir_mesa", { p_mesa_id: m.id }), "abrir mesa " + m.numero);
    ok(await U.staffA.api.rpc("caja_sentar_cliente", { p_sesion_id: S[m.numero], p_cliente_nombre: `Cliente ${m.numero}`, p_personas: 4 }), "sentar " + m.numero);
    ok(await U.staffB.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[m.numero]), p_monto_centavos: 50000, p_concepto: "Botella", p_clave: randomUUID() }), "consumo inicial " + m.numero);
  }

  const devA = await dispositivo("A");
  const A = await entrar(devA, "staffA");
  let t, cola;

  // ---------- 1. Reloj del teléfono desfasado ----------
  await abrirMesa(A, 1);
  await devA.setOffline(true);
  await A.getByText("Sin conexión · reconectando…").waitFor({ timeout: 15000 });
  const real = Date.now();
  await A.clock.setSystemTime(new Date(real + 2 * 3600e3)); // el reloj del teléfono, 2 h adelantado
  await agregarConsumo(A, "Reloj adelantado", "100");
  await A.clock.setSystemTime(new Date(Date.now())); // se corrige solo (o lo corrigen)
  await cobrarSaldo(A);
  cola = await leerCola(A);
  const cConsumo = cola.find((x) => x.tipo === "consumo");
  const cPago = cola.find((x) => x.tipo === "pago");
  nota("reloj corregido hacia atrás entre consumo y cobro: el cobro queda DESPUÉS en la cola", cola.length === 2 && cPago?.orden > cConsumo?.orden, `orden consumo ${cConsumo?.orden}, cobro ${cPago?.orden}`);
  await a360(A, "10-sin-red-mesa-360.png");
  await volver(A);
  await a360(A, "11-sin-red-mapa-360.png");
  await devA.setOffline(false);
  t = await esperarBase(S[1], (x) => x.consumos === 2 && x.pagos === 1, 40000);
  cola = await esperarCola(A, (x) => x.length === 0);
  nota("…al volver la señal entran los dos, en orden, una vez (el cobro con su saldo esperado no se rechaza)",
    t.consumos === 2 && t.consumo === 60000 && t.pagos === 1 && t.cobrado === 60000 && cola.length === 0,
    `${t.consumos} consumos ${pesos(t.consumo)}, ${t.pagos} cobros ${pesos(t.cobrado)}, cola ${cola.map((x) => x.estado)}`);

  // ---------- 2. Dos staff sobre la misma mesa ----------
  await abrirMesa(A, 2);
  await devA.setOffline(true);
  await agregarConsumo(A, "Tarde", "80");
  ok(await U.staffB.api.rpc("caja_registrar_pago", { p_sesion_id: S[2], p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 50000, p_referencia: null, p_clave: randomUUID(), p_saldo_esperado: 50000 }), "B cobra mesa 2");
  ok(await U.gerente.api.rpc("caja_cerrar_mesa", { p_sesion_id: S[2] }), "gerente cierra mesa 2");
  ok(await U.gerente.api.rpc("caja_cuadrar_mesa", { p_sesion_id: S[2], p_notas: null }), "gerente cuadra mesa 2");
  await devA.setOffline(false);
  await volver(A);
  const vioRechazo = await visible(A.getByText("1 movimiento no se guardó"), 30000);
  const vioQueHacer = await visible(A.getByText(/Avísale a tu gerente/), 2000);
  t = await totales(S[2]);
  nota("otro staff cobró y el gerente cuadró mientras A no tenía señal: A ve el rechazo con motivo y qué hacer; no entra", vioRechazo && vioQueHacer && t.consumos === 1, `consumos ${t.consumos}`);
  await a360(A, "12-rechazado-mapa-360.png");
  await A.getByRole("button", { name: "Entendido" }).first().click();

  // ---------- 3. Cerrar o cuadrar con movimientos aún en el teléfono ----------
  const devG = await dispositivo("G");
  const G = await entrar(devG, "gerente");
  const cerrarG = llamadasDe(devG, /\/rest\/v1\/rpc\/caja_(cerrar|cuadrar)_mesa/);
  await abrirMesa(G, 3);
  await devG.setOffline(true);
  await G.getByText("Sin conexión · reconectando…").waitFor({ timeout: 15000 });
  await cobrarSaldo(G);
  const bloqueadoSinRed = await visible(G.getByText(/Para cerrar o cuadrar, primero tiene que llegar a la base el movimiento/), 10000);
  nota("gerente con un cobro en el teléfono: no aparece 'Cuadrar mesa' (dice qué falta)", bloqueadoSinRed && (await G.getByRole("button", { name: "Cuadrar mesa" }).count()) === 0);
  await devG.route("**/rest/v1/rpc/caja_registrar_pago", (r) => r.abort("failed"));
  await devG.setOffline(false);
  await G.getByRole("button", { name: /Enviar ahora · 1 movimiento por enviar/ }).waitFor({ timeout: 15000 }).catch(() => {});
  const menu = G.getByRole("button", { name: "Más acciones" });
  let soloCerrar = 0;
  if (await menu.count()) {
    await menu.click();
    soloCerrar = await G.getByRole("button", { name: "Solo cerrar (cuadrar después)" }).count();
    await menu.click();
  }
  nota("con señal pero el cobro sin llegar: tampoco 'Cuadrar' ni 'Solo cerrar'; ofrece 'Enviar ahora'",
    (await G.getByRole("button", { name: /Enviar ahora · 1 movimiento/ }).count()) === 1 && (await G.getByRole("button", { name: "Cuadrar mesa" }).count()) === 0 && soloCerrar === 0);
  await a360(G, "13-cuadrar-espera-envio-360.png");
  await devG.unroute("**/rest/v1/rpc/caja_registrar_pago");
  // Envío lento para ver "Enviando…".
  await devG.route("**/rest/v1/rpc/caja_registrar_pago", async (r) => {
    await esperar(4000);
    await r.continue().catch(() => {});
  });
  await volver(G);
  await G.getByRole("button", { name: "Enviar ahora" }).first().click();
  const vioEnviando = await visible(G.getByText("Enviando…"), 3000);
  await a360(G, "14-sincronizando-mapa-360.png");
  nota("el aviso global dice 'Enviando…' mientras se manda", vioEnviando);
  t = await esperarBase(S[3], (x) => x.pagos === 1, 30000);
  await esperarCola(G, (x) => x.length === 0);
  await devG.unroute("**/rest/v1/rpc/caja_registrar_pago");
  await abrirMesa(G, 3);
  const yaCuadra = await visible(G.getByRole("button", { name: "Cuadrar mesa" }), 15000);
  nota("cuando el cobro llega a la base, aparece 'Cuadrar mesa'; antes no se llamó a cerrar ni cuadrar", yaCuadra && t.pagos === 1 && cerrarG.n === 0, `cerrar/cuadrar llamados ${cerrarG.n}`);
  await devG.close();

  // ---------- 4. El token vence a media cola (401) ----------
  await A.getByRole("button", { name: /^Mesa 4,/ }).waitFor({ timeout: 30000 });
  await abrirMesa(A, 4);
  let primera401 = true;
  await devA.route("**/rest/v1/rpc/caja_registrar_consumo", (r) => {
    if (!primera401) return r.continue();
    primera401 = false;
    return r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "PGRST301", message: "JWT expired", details: null, hint: null }) });
  });
  const renovar = llamadasDe(devA, /\/auth\/v1\/token\?grant_type=refresh_token/);
  await agregarConsumo(A, "Token vencido", "70");
  t = await esperarBase(S[4], (x) => x.consumos === 2, 30000);
  cola = await esperarCola(A, (x) => x.length === 0);
  await esperar(2000);
  t = await totales(S[4]);
  const tarjetaSesion = await A.getByText("Tu sesión se cerró").count();
  nota("token vencido a media cola: se renueva, entra una vez y no dice 'sesión cerrada'", t.consumos === 2 && cola.length === 0 && renovar.n >= 1 && tarjetaSesion === 0, `${t.consumos} consumos, renovaciones ${renovar.n}`);
  await devA.unroute("**/rest/v1/rpc/caja_registrar_consumo");
  await volver(A);

  // ---------- 5. Otra cuenta entra en otra pestaña con pendientes ----------
  await abrirMesa(A, 5);
  await devA.route("**/rest/v1/rpc/caja_registrar_consumo", (r) => r.abort("failed"));
  await agregarConsumo(A, "De A", "25");
  cola = await esperarCola(A, (x) => x.length === 1, 10000);
  const A2 = await devA.newPage();
  await iniciarSesion(A2, "staffD");
  const enviosTras = llamadasDe(devA, /\/rest\/v1\/rpc\/caja_registrar_/);
  await devA.unroute("**/rest/v1/rpc/caja_registrar_consumo");
  await A.evaluate(() => window.dispatchEvent(new Event("online")));
  const tapada = await visible(A.getByText("Entró otra cuenta en este teléfono"), 20000);
  await esperar(4000);
  t = await totales(S[5]);
  nota("otra cuenta entra en otra pestaña: la caja de A se tapa y lo de A NO se manda con la sesión de D", tapada && enviosTras.n === 0 && t.consumos === 1, `envíos ${enviosTras.n}, consumos ${t.consumos}`);
  nota("…la tarjeta dice que lo de A sigue guardado", await visible(A.getByText(/Tienes 1 movimiento de caja guardado en este teléfono/), 3000));
  await a360(A, "15-otra-cuenta-360.png");
  await A.getByRole("button", { name: "Abrir la caja con la cuenta de ahora" }).click();
  await A.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 60000 });
  const verAjeno = await visible(A.getByText(/Hay 1 movimiento de caja de otra cuenta guardado en este teléfono/), 10000);
  await esperar(3000);
  nota("al reabrir con la cuenta de D: ve solo el número de lo de otra cuenta, no lo manda", verAjeno && enviosTras.n === 0 && (await A.getByText(/movimientos? por enviar/).count()) === 0, `envíos ${enviosTras.n}`);
  await a360(A, "16-pendientes-de-otra-cuenta-360.png");
  await A2.close();
  await devA.clearCookies();
  await iniciarSesion(A, "staffA");
  await irACaja(A);
  t = await esperarBase(S[5], (x) => x.consumos >= 2, 30000);
  nota("A vuelve a entrar: lo suyo entra una vez, a su nombre",
    t.consumos === 2 && t.filasC.filter((x) => x.registrado_por === U.staffA.id).length === 1 && !t.filasC.some((x) => x.registrado_por === U.staffD.id));

  // ---------- 6. La sesión se cierra con pendientes ----------
  await abrirMesa(A, 6);
  await devA.route("**/rest/v1/rpc/caja_registrar_consumo", (r) => r.abort("failed"));
  await agregarConsumo(A, "Sesión cerrada", "30");
  await esperarCola(A, (x) => x.length === 1, 10000);
  await devA.clearCookies(); // la sesión se cerró (otra pestaña, o venció sin poder renovarse)
  await devA.unroute("**/rest/v1/rpc/caja_registrar_consumo");
  await A.evaluate(() => window.dispatchEvent(new Event("online")));
  const avisoSesion = await visible(A.getByText("Tu sesión se cerró"), 20000);
  cola = await leerCola(A);
  t = await totales(S[6]);
  nota("sesión cerrada con pendientes: se avisa, el movimiento sigue 'pendiente' (no rechazado) y no entra",
    avisoSesion && cola.length === 1 && cola[0].estado === "pendiente" && t.consumos === 1, `cola ${cola.map((x) => x.estado)}, consumos ${t.consumos}`);
  nota("…la tarjeta dice cuántos siguen guardados", await visible(A.getByText(/Tienes 1 movimiento de caja guardado en este teléfono/), 3000));
  await a360(A, "17-sesion-cerrada-360.png");
  await A.getByRole("link", { name: "Entrar otra vez" }).click();
  await A.waitForURL(/cliente\/login/, { timeout: 30000 });
  await iniciarSesion(A, "staffA");
  await irACaja(A);
  t = await esperarBase(S[6], (x) => x.consumos >= 2, 30000);
  cola = await esperarCola(A, (x) => x.length === 0);
  nota("al volver a entrar se manda una vez", t.consumos === 2 && cola.length === 0, `${t.consumos} consumos`);

  // ---------- 7. Cerrar sesión con pendientes ----------
  await abrirMesa(A, 7);
  await devA.route("**/rest/v1/rpc/caja_registrar_consumo", (r) => r.abort("failed"));
  await agregarConsumo(A, "Antes de salir", "40");
  await esperarCola(A, (x) => x.length === 1, 10000);
  await A.goto(BASE + "/staff/panel");
  const salir = A.getByRole("button", { name: "Cerrar sesión" });
  await salir.waitFor({ timeout: 60000 });
  let mensaje = "";
  A.once("dialog", (d) => {
    mensaje = d.message();
    void d.dismiss();
  });
  await salir.click();
  await esperar(1500);
  nota("cerrar sesión con pendientes pregunta antes (y 'Cancelar' no cierra)",
    /1 movimiento de caja sin enviar/.test(mensaje) && /staff\/panel/.test(A.url()) && (await cookiesDeSesion(devA)) > 0, mensaje.slice(0, 60));
  A.once("dialog", (d) => void d.accept());
  await salir.click();
  await A.waitForURL(/cliente\/login/, { timeout: 30000 });
  cola = await leerCola(A);
  nota("…'Aceptar' cierra la sesión y lo pendiente se queda en el teléfono", cola.length === 1 && cola[0].estado === "pendiente" && (await cookiesDeSesion(devA)) === 0);
  await devA.unroute("**/rest/v1/rpc/caja_registrar_consumo");
  await iniciarSesion(A, "staffA");
  await irACaja(A);
  t = await esperarBase(S[7], (x) => x.consumos >= 2, 30000);
  nota("…y se manda al volver a entrar", t.consumos === 2);
  // Sin señal: cerrar sesión igual la borra del teléfono.
  await esperarCola(A, (x) => x.length === 0);
  await A.goto(BASE + "/staff/panel");
  await salir.waitFor({ timeout: 60000 });
  await devA.setOffline(true);
  await salir.click();
  await esperar(10000);
  nota("cerrar sesión SIN señal: la sesión se borra del teléfono", (await cookiesDeSesion(devA)) === 0);
  await devA.setOffline(false);

  // ---------- 8. Pestaña congelada (ahorro de batería) al volver la señal ----------
  await iniciarSesion(A, "staffA");
  await irACaja(A);
  await abrirMesa(A, 8);
  await devA.setOffline(true);
  await agregarConsumo(A, "Pestaña dormida", "15");
  const cdp = await devA.newCDPSession(A);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await devA.setOffline(false);
  await esperar(3000);
  t = await totales(S[8]);
  const mientrasCongelada = t.consumos;
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  t = await esperarBase(S[8], (x) => x.consumos >= 2, 30000);
  // Chromium sin pantalla no siempre congela una pestaña visible: si mandó
  // mientras tanto, se informa (lo que se exige es que entre una sola vez).
  if (mientrasCongelada === 2) console.log("  (nota) el navegador de prueba no congeló la pestaña: mandó antes de despertarla");
  nota("pestaña congelada por el sistema y la señal vuelve: al despertar entra una vez", t.consumos === 2, `mientras congelada ${mientrasCongelada}, después ${t.consumos}`);
  await esperar(3000);
  nota("…sin duplicar", (await totales(S[8])).consumos === 2);

  await devA.close();
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  await navegador.close();
  await limpiar();
  if (consola.size) console.log("Consola (errores, informativo):\n  " + [...consola].slice(0, 25).join("\n  "));
  if (errores.length) console.log("Errores de página:\n  " + errores.join("\n  "));
  const pasan = resultados.filter(Boolean).length;
  console.log(`\nResultado: ${pasan}/${resultados.length}`);
  process.exitCode = pasan === resultados.length && errores.length === 0 ? 0 : 1;
}
