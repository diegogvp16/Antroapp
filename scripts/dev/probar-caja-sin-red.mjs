// Caja sin internet (cola persistente en el teléfono), en el navegador real:
//
//  1. capturar consumo y cobro sin red, RECARGAR la página sin red (sale
//     /offline.html con el conteo), volver la red: se aplican UNA sola vez;
//  2. reintento con la misma clave directo a la base (también después de
//     cuadrar): devuelve lo mismo, no duplica;
//  3. respuesta perdida a mitad del envío: se reintenta solo, sin duplicar;
//  4. dos pestañas del mismo teléfono vaciando la misma cola, y dos
//     teléfonos a la vez: cada movimiento una vez;
//  5. rechazos al sincronizar: mesa cuadrada mientras tanto, saldo cambiado,
//     permiso retirado y cuenta dada de baja. Se muestran con motivo, no se
//     reintentan en bucle y no se guardan;
//  6. otra persona en el mismo teléfono no manda lo de la primera;
//  7. con movimientos de la mesa en la cola no se deja cerrar ni cuadrar:
//     primero "Enviar ahora", y el cuadre sale con todo;
//  en el teléfono no se guardan nombres de clientes ni tokens. Los "una vez"
//  se comprueban contando las peticiones, no solo las filas de la base.
//
// Contra el servidor local de dev y antroapp-dev. Arma su propio antro
// ("T caja …", cuentas t_caja_…@example.com) y lo borra al final, aunque
// falle. No toca Club Demo Dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-caja-sin-red.mjs [http://localhost:3001] [--fase2]
//
// --limpiar-restos: solo borra lo que haya dejado una corrida interrumpida
// (antros "T caja …" y cuentas t_caja_…@example.com) y termina.
// --fase2: el servidor corre con NEXT_PUBLIC_FASE2=1; además prueba sin red
// un consumo del catálogo (descuenta existencias una vez) y un cobro con
// propina.
//
// Capturas en screenshots-b-caja/ (ignorada por Git).

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
const FASE2 = process.argv.includes("--fase2");
const SHOTS = path.join(RAIZ, "screenshots-b-caja") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);

// Restos de una corrida interrumpida (Ctrl+C, proceso muerto): sin el
// finally no se borró nada. Solo toca el prefijo de esta prueba y NUNCA lo
// de una corrida en curso (las pruebas del carril corren a la vez):
//   --tag=<TAG>       solo esa corrida ("T caja <TAG>", t_caja_*_<TAG>@example.com);
//   sin --tag         solo corridas cuyas cuentas tienen más de --minutos=N
//                     (120 por omisión): el TAG sale del correo.
if (process.argv.includes("--limpiar-restos")) {
  const argTag = process.argv.find((a) => a.startsWith("--tag="))?.slice(6);
  const minutos = Number(process.argv.find((a) => a.startsWith("--minutos="))?.slice(10) ?? 120);
  if (argTag !== undefined && !/^[0-9a-z]{4,12}$/i.test(argTag)) {
    console.log("--tag inválido.");
    process.exit(1);
  }
  if (!Number.isFinite(minutos) || minutos < 30) {
    console.log("--minutos debe ser 30 o más (para no tocar una corrida en curso).");
    process.exit(1);
  }
  const db = await conectarDevEscritura();
  let users;
  if (argTag) {
    users = await db.q("select id, email from auth.users where email like $1", [`t\\_caja\\_%\\_${argTag}@example.com`]);
  } else {
    users = await db.q(
      "select id, email from auth.users where email like 't\\_caja\\_%@example.com' and created_at < now() - make_interval(mins => $1)",
      [minutos],
    );
  }
  const tags = argTag ? [argTag] : [...new Set(users.map((u) => /_([0-9a-z]+)@example\.com$/i.exec(u.email)?.[1]).filter(Boolean))];
  const clubs = tags.length
    ? (await db.q("select id from public.clubs where nombre like any($1::text[])", [tags.map((t) => `T caja ${t}%`)])).map((r) => r.id)
    : [];
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    // Mismo orden que limpiar().
    for (const c of clubs) {
      for (const t of ["producto_movimientos", "caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos", "productos"])
        await db.q(`delete from public.${t} where club_id = $1`, [c]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = $1)", [c]);
      await db.q("delete from public.reservations where club_id = $1", [c]);
      await db.q("delete from public.club_tables where club_id = $1", [c]);
    }
    if (users.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [users.map((u) => u.id)]);
    for (const c of clubs) await db.q("delete from public.clubs where id = $1", [c]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("Error borrando restos:", e.message);
    await db.fin();
    process.exit(1);
  }
  await db.fin();
  for (const u of users) await svc.auth.admin.deleteUser(u.id);
  if (users.length) await svc.from("login_intentos").delete().in("email_hash", users.map((u) => createHash("sha256").update(u.email.toLowerCase()).digest("hex")));
  console.log(`Restos borrados: ${clubs.length} antros, ${users.length} cuentas (${argTag ? `TAG ${argTag}` : `corridas de hace más de ${minutos} min`}).`);
  process.exit(0);
}

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

// Cuenta las llamadas a una función de caja hechas desde un contexto.
function contador(ctx, funcion) {
  const c = { n: 0 };
  ctx.on("request", (r) => {
    if (r.url().includes(`/rest/v1/rpc/${funcion}`)) c.n++;
  });
  return c;
}

const navegador = await chromium.launch();
const errores = [];
async function dispositivo(nombre) {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  ctx.on("weberror", (e) => errores.push(`${nombre}: ${String(e.error()).slice(0, 160)}`));
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

try {
  // ======================= Escenario =======================
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `T caja ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva" }).eq("id", clubId), "publicar");
  await usuario("staffA", "staff");
  await usuario("staffB", "staff");
  await usuario("staffC", "staff");
  await usuario("staffE", "staff");
  await usuario("gerente", "gerente");
  const mesas = ok(await svc.from("club_tables").insert([1, 2, 3, 4, 5, 6, 7].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const S = {};
  for (const m of mesas) {
    S[m.numero] = ok(await U.staffA.api.rpc("caja_abrir_mesa", { p_mesa_id: m.id }), "abrir mesa " + m.numero);
    ok(await U.staffA.api.rpc("caja_sentar_cliente", { p_sesion_id: S[m.numero], p_cliente_nombre: `Cliente Secreto ${m.numero}`, p_personas: 4 }), "sentar " + m.numero);
  }
  const cuenta = async (sesion) => ok(await svc.from("mesa_cuentas").select("id").eq("sesion_id", sesion).single(), "cuenta").id;
  ok(await U.staffA.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[1]), p_monto_centavos: 50000, p_concepto: "Botella", p_clave: randomUUID() }), "consumo inicial mesa 1");
  ok(await U.staffB.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[4]), p_monto_centavos: 30000, p_concepto: "Ronda", p_clave: randomUUID() }), "consumo inicial mesa 4");

  const devA = await dispositivo("A");
  const A = await entrar(devA, "staffA");
  const llamadasConsumoA = contador(devA, "caja_registrar_consumo");
  // Todas las llamadas de la cola (consumo, consumo del catálogo y cobro).
  const llamadasColaA = contador(devA, "caja_registrar_");

  // ---------- 1. Capturar sin red, recargar sin red, volver la red ----------
  await abrirMesa(A, 1);
  await devA.setOffline(true);
  await A.getByText("Sin conexión · reconectando…").waitFor({ timeout: 15000 });
  await agregarConsumo(A, "Ronda sin red", "100");
  await A.getByText(/Guardado en este teléfono/).first().waitFor({ timeout: 10000 });
  nota("sin red: 'Agregar consumo' guarda en el teléfono y cierra la hoja con el aviso", true);
  await A.getByRole("button", { name: /^Cobrar \$600/ }).waitFor({ timeout: 10000 }).then(
    () => nota("el saldo de la mesa ya incluye lo capturado sin red ($600)", true),
    () => nota("el saldo de la mesa ya incluye lo capturado sin red ($600)", false),
  );
  await cobrarSaldo(A);
  await A.screenshot({ path: SHOTS + "01-mesa-con-pendientes-390.png", fullPage: true });
  let cola = await leerCola(A);
  let t = await totales(S[1]);
  nota("sin red: 2 movimientos en la cola del teléfono y nada en la base", cola.length === 2 && t.consumos === 1 && t.pagos === 0, `cola ${cola.length}, base ${t.consumos} consumos/${t.pagos} cobros`);
  const pago = cola.find((x) => x.tipo === "pago");
  nota("el cobro sin red lleva el saldo que vio el staff (con lo pendiente)", pago?.args.p_saldo_esperado === 60000, `p_saldo_esperado ${pago?.args.p_saldo_esperado}`);
  const crudo = JSON.stringify(cola);
  nota("en el teléfono no hay nombres de clientes, tokens ni correos", !/Cliente Secreto|access_token|refresh_token|eyJ|@example\.com/.test(crudo));
  await volver(A);
  await A.getByText("2 movimientos por enviar").first().waitFor({ timeout: 10000 }).then(
    () => nota("aviso global '2 movimientos por enviar'", true),
    () => nota("aviso global '2 movimientos por enviar'", false),
  );
  const marca = await A.getByRole("button", { name: /^Mesa 1,.*2 por enviar/ }).count();
  nota("la mesa 1 en el mapa dice '2 por enviar'", marca === 1);
  await A.screenshot({ path: SHOTS + "02-mapa-con-pendientes-390.png", fullPage: true });
  await A.setViewportSize({ width: 360, height: 740 });
  await A.screenshot({ path: SHOTS + "02b-mapa-con-pendientes-360.png", fullPage: true });
  await A.setViewportSize({ width: 390, height: 844 });

  // Recargar sin red: el service worker da /offline.html, que dice cuántos hay.
  await A.reload().catch(() => {});
  await A.getByText("Sin conexión", { exact: true }).waitFor({ timeout: 15000 });
  await A.getByText(/Hay 2 movimientos de caja guardados en este teléfono/).waitFor({ timeout: 10000 }).then(
    () => nota("recargar sin red: la página sin conexión dice 'Hay 2 movimientos de caja guardados'", true),
    () => nota("recargar sin red: la página sin conexión dice 'Hay 2 movimientos de caja guardados'", false),
  );
  await A.screenshot({ path: SHOTS + "03-offline-con-pendientes-390.png", fullPage: true });
  nota("recargar sin red: la cola sigue en el teléfono", (await leerCola(A)).length === 2);

  // Vuelve la red: /offline.html recarga sola, la caja abre y manda la cola.
  await devA.setOffline(false);
  t = await esperarBase(S[1], (x) => x.consumos === 2 && x.pagos === 1, 40000);
  cola = await esperarCola(A, (x) => x.length === 0);
  if (cola.length) {
    console.log("  (diagnóstico) URL:", A.url());
    await A.screenshot({ path: SHOTS + "diag-vuelve-red.png", fullPage: true }).catch(() => {});
  }
  nota("vuelve la red: se aplica UNA vez (2 consumos y 1 cobro en la base) y la cola queda vacía",
    t.consumos === 2 && t.consumo === 60000 && t.pagos === 1 && t.cobrado === 60000 && cola.length === 0,
    `${t.consumos} consumos ${pesos(t.consumo)}, ${t.pagos} cobros ${pesos(t.cobrado)}, cola ${cola.length}`);
  // Con la cola vacía no debe salir ninguna llamada más: se cuentan las
  // peticiones (la base no duplicaría aunque hubiera reenvíos, por la clave).
  const antesVentana = llamadasColaA.n;
  await esperar(5000);
  t = await totales(S[1]);
  const reenvios = llamadasColaA.n - antesVentana;
  nota("5 s después: 0 envíos más a caja_registrar_* y la base sigue igual", reenvios === 0 && t.consumos === 2 && t.pagos === 1, `${reenvios} envíos en la ventana`);
  await A.getByText(/por enviar/).first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  nota("el aviso de pendientes desaparece", (await A.getByText(/movimientos? por enviar/).count()) === 0);

  // ---------- 2. Idempotencia en la base (misma clave) ----------
  const filaRonda = t.filasC.find((x) => x.monto_centavos === 10000);
  const reintento = await U.staffA.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[1]), p_monto_centavos: 10000, p_concepto: "Ronda sin red", p_clave: filaRonda.clave_cliente });
  t = await totales(S[1]);
  nota("base: reintentar con la misma clave devuelve el mismo consumo y no duplica", !reintento.error && t.consumos === 2);
  const otroMonto = await U.staffA.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[1]), p_monto_centavos: 99900, p_concepto: "x", p_clave: filaRonda.clave_cliente });
  nota("base: la misma clave con otro monto se rechaza", otroMonto.error?.code === "P0001");

  // ---------- 3. Respuesta perdida a mitad del envío ----------
  await A.getByRole("button", { name: /^Mesa 2,/ }).waitFor({ timeout: 30000 });
  await abrirMesa(A, 2);
  let perdida = false;
  await devA.route("**/rest/v1/rpc/caja_registrar_consumo", async (route) => {
    if (perdida) return route.continue();
    perdida = true;
    await route.fetch().catch(() => {});
    await route.abort("failed");
  });
  await agregarConsumo(A, "Respuesta perdida", "70");
  await A.getByText(/Guardado en este teléfono/).first().waitFor({ timeout: 10000 }).then(
    () => nota("respuesta perdida: la hoja se cierra con 'Guardado en este teléfono'", true),
    () => nota("respuesta perdida: la hoja se cierra con 'Guardado en este teléfono'", false),
  );
  t = await esperarBase(S[2], (x) => x.consumos >= 1, 10000);
  cola = await esperarCola(A, (x) => x.length === 0, 30000);
  await esperar(1500);
  t = await totales(S[2]);
  nota("…se reintenta solo (espera creciente) y queda UNA vez", t.consumos === 1 && t.consumo === 7000 && cola.length === 0, `${t.consumos} consumos, cola ${cola.length}`);
  await devA.unroute("**/rest/v1/rpc/caja_registrar_consumo");
  await volver(A);

  // ---------- 4a. Dos pestañas del mismo teléfono ----------
  const A2 = await devA.newPage();
  await A2.goto(BASE + "/staff/caja");
  await A2.getByRole("button", { name: /^Mesa 2,/ }).waitFor({ timeout: 60000 });
  await devA.setOffline(true);
  await abrirMesa(A, 2);
  await agregarConsumo(A, "Dos pestañas", "45");
  await A2.getByText("1 movimiento por enviar").first().waitFor({ timeout: 10000 }).then(
    () => nota("la otra pestaña del mismo teléfono ve '1 movimiento por enviar'", true),
    () => nota("la otra pestaña del mismo teléfono ve '1 movimiento por enviar'", false),
  );
  const antes = llamadasConsumoA.n;
  await devA.setOffline(false);
  t = await esperarBase(S[2], (x) => x.consumos >= 2, 30000);
  await esperarCola(A, (x) => x.length === 0);
  await esperar(4000);
  t = await totales(S[2]);
  const enviosDosPestanas = llamadasConsumoA.n - antes;
  // El candado (Web Locks) forma a las dos pestañas: la segunda encuentra la
  // cola vacía. Se compara el número de envíos, no solo las filas (la clave
  // absorbería un reenvío y la prueba seguiría en verde).
  nota("dos pestañas vaciando la misma cola: entra una vez y sale UN solo envío", t.consumos === 2 && t.consumo === 11500 && enviosDosPestanas === 1, `${t.consumos} consumos; ${enviosDosPestanas} envíos`);
  await A2.close();
  await volver(A);

  // ---------- 4b. Dos teléfonos sin red a la vez ----------
  const devB = await dispositivo("B");
  const B = await entrar(devB, "staffB");
  await Promise.all([abrirMesa(A, 2), abrirMesa(B, 2)]);
  await Promise.all([devA.setOffline(true), devB.setOffline(true)]);
  await Promise.all([agregarConsumo(A, "Teléfono A", "200"), agregarConsumo(B, "Teléfono B", "300")]);
  await Promise.all([devA.setOffline(false), devB.setOffline(false)]);
  t = await esperarBase(S[2], (x) => x.consumos >= 4, 30000);
  await Promise.all([esperarCola(A, (x) => x.length === 0), esperarCola(B, (x) => x.length === 0)]);
  await esperar(3000);
  t = await totales(S[2]);
  nota("dos teléfonos sin red a la vez: cada consumo una vez", t.consumos === 4 && t.consumo === 61500, `${t.consumos} consumos ${pesos(t.consumo)}`);
  await Promise.all([volver(A), volver(B)]);

  // ---------- 5a. Rechazo: la mesa se cuadró mientras no había señal ----------
  await abrirMesa(A, 3);
  await devA.setOffline(true);
  await agregarConsumo(A, "Tarde", "90");
  ok(await U.gerente.api.rpc("caja_cerrar_mesa", { p_sesion_id: S[3] }), "gerente cierra mesa 3");
  ok(await U.gerente.api.rpc("caja_cuadrar_mesa", { p_sesion_id: S[3], p_notas: null }), "gerente cuadra mesa 3");
  const antesCuadrada = llamadasConsumoA.n;
  await devA.setOffline(false);
  await A.getByText("La mesa ya está cuadrada.").first().waitFor({ timeout: 30000 }).then(
    () => nota("mesa cuadrada mientras no había señal: se muestra 'La mesa ya está cuadrada.'", true),
    () => nota("mesa cuadrada mientras no había señal: se muestra 'La mesa ya está cuadrada.'", false),
  );
  await A.screenshot({ path: SHOTS + "04-rechazo-mesa-cuadrada-390.png", fullPage: true });
  await esperar(8000);
  t = await totales(S[3]);
  const envios = llamadasConsumoA.n - antesCuadrada;
  cola = await leerCola(A);
  nota("…no se guardó, se intentó una sola vez (sin bucle) y queda 'rechazado' en el teléfono",
    t.consumos === 0 && envios === 1 && cola.length === 1 && cola[0].estado === "rechazado", `${t.consumos} consumos, ${envios} envíos, cola ${cola.map((x) => x.estado)}`);
  await volver(A);
  await A.getByText("1 movimiento no se guardó").waitFor({ timeout: 10000 }).then(
    () => nota("en la lista de mesas: '1 movimiento no se guardó' con su motivo", true),
    () => nota("en la lista de mesas: '1 movimiento no se guardó' con su motivo", false),
  );
  nota("la mesa 3 en el mapa dice '1 sin guardar'", (await A.getByRole("button", { name: /^Mesa 3,.*1 sin guardar/ }).count()) === 1);
  await A.screenshot({ path: SHOTS + "05-rechazados-en-mapa-390.png", fullPage: true });
  await A.setViewportSize({ width: 360, height: 740 });
  await A.screenshot({ path: SHOTS + "05b-rechazados-en-mapa-360.png", fullPage: true });
  await A.setViewportSize({ width: 390, height: 844 });
  await A.getByRole("button", { name: "Entendido" }).first().click();
  cola = await esperarCola(A, (x) => x.length === 0, 5000);
  nota("'Entendido' lo quita del teléfono", cola.length === 0 && (await A.getByText("1 movimiento no se guardó").count()) === 0);

  // Reintento directo a la base de un consumo YA guardado, después de cuadrar: devuelve el mismo.
  const filasM2 = (await totales(S[2])).filasC.filter((x) => x.registrado_por === U.staffA.id);
  ok(await U.gerente.api.rpc("caja_registrar_pago", { p_sesion_id: S[2], p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 61500, p_referencia: null, p_clave: randomUUID(), p_saldo_esperado: 61500 }), "cobro mesa 2");
  ok(await U.gerente.api.rpc("caja_cerrar_mesa", { p_sesion_id: S[2] }), "cerrar mesa 2");
  ok(await U.gerente.api.rpc("caja_cuadrar_mesa", { p_sesion_id: S[2], p_notas: null }), "cuadrar mesa 2");
  const tras = await U.staffA.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[2]), p_monto_centavos: filasM2[0].monto_centavos, p_concepto: "x", p_clave: filasM2[0].clave_cliente });
  t = await totales(S[2]);
  nota("base: reintento de algo ya guardado DESPUÉS de cuadrar devuelve el mismo (no falla ni duplica)", !tras.error && t.consumos === 4, tras.error?.message);

  // ---------- 5b. Rechazo: el saldo cambió (otro staff cobró) ----------
  await abrirMesa(A, 4);
  await devA.setOffline(true);
  await cobrarSaldo(A);
  ok(await U.staffB.api.rpc("caja_registrar_pago", { p_sesion_id: S[4], p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: 10000, p_referencia: null, p_clave: randomUUID(), p_saldo_esperado: 30000 }), "staff B cobra $100");
  const llamadasPagoA = contador(devA, "caja_registrar_pago");
  await devA.setOffline(false);
  await A.getByText(/El saldo de la mesa cambió/).first().waitFor({ timeout: 30000 }).then(
    () => nota("saldo cambiado mientras no había señal: se muestra el motivo", true),
    () => nota("saldo cambiado mientras no había señal: se muestra el motivo", false),
  );
  await esperar(6000);
  t = await totales(S[4]);
  nota("…el cobro de $300 no se guardó, solo el de $100 de B, y no se reintentó con otro saldo", t.pagos === 1 && t.cobrado === 10000 && llamadasPagoA.n === 1, `${t.pagos} cobros ${pesos(t.cobrado)}, ${llamadasPagoA.n} envíos`);
  await A.screenshot({ path: SHOTS + "06-rechazo-saldo-cambio-390.png", fullPage: true });
  await A.getByRole("button", { name: "Entendido" }).first().click();
  await volver(A);

  // ---------- 5c. Rechazo: permiso retirado ----------
  await abrirMesa(B, 4);
  await devB.setOffline(true);
  await agregarConsumo(B, "Sin permiso", "50");
  // Solo el dueño o el admin configuran permisos: aquí se hace con la llave de servicio.
  ok(await svc.from("caja_permisos").insert({ club_id: clubId, permiso: "registrar_consumo", rol: null, profile_id: U.staffB.id, permitido: false, actualizado_por: U.gerente.id }), "quitar permiso a B");
  await devB.setOffline(false);
  await B.getByText(/No tienes permiso para registrar consumos/).first().waitFor({ timeout: 30000 }).then(
    () => nota("permiso retirado mientras no había señal: se muestra el motivo", true),
    () => nota("permiso retirado mientras no había señal: se muestra el motivo", false),
  );
  t = await totales(S[4]);
  nota("…y no se guardó", t.consumos === 1, `${t.consumos} consumos`);

  // ---------- 5d. Rechazo: cuenta dada de baja ----------
  const devC = await dispositivo("C");
  const C = await entrar(devC, "staffC");
  await abrirMesa(C, 5);
  await devC.setOffline(true);
  await agregarConsumo(C, "Dado de baja", "80");
  ok(await svc.from("profiles").update({ activo: false }).eq("id", U.staffC.id), "baja de C");
  await devC.setOffline(false);
  await C.getByText(/No tienes permiso para registrar consumos: te lo quitaron o tu cuenta fue dada de baja/).first().waitFor({ timeout: 30000 }).then(
    () => nota("cuenta dada de baja mientras no había señal: se muestra el motivo", true),
    () => nota("cuenta dada de baja mientras no había señal: se muestra el motivo", false),
  );
  t = await totales(S[5]);
  nota("…y no se guardó", t.consumos === 0);
  await C.screenshot({ path: SHOTS + "07-rechazo-baja-390.png", fullPage: true });

  // ---------- 6. Otra persona en el mismo teléfono ----------
  // A deja algo en la cola (la base no contesta), cierra sesión y entra B.
  ok(await U.staffA.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[5]), p_monto_centavos: 1000, p_concepto: "base", p_clave: randomUUID() }), "consumo base mesa 5");
  await A.getByRole("button", { name: /^Mesa 5,/ }).waitFor({ timeout: 30000 });
  await abrirMesa(A, 5);
  await devA.route("**/rest/v1/rpc/caja_registrar_consumo", (route) => route.abort("failed"));
  await agregarConsumo(A, "De A", "25");
  cola = await esperarCola(A, (x) => x.length === 1, 5000);
  await devA.unroute("**/rest/v1/rpc/caja_registrar_consumo");
  await devA.clearCookies();
  const llamadasB = { n: 0 };
  devA.on("request", (r) => {
    if (r.url().includes("/rest/v1/rpc/caja_registrar_")) llamadasB.n++;
  });
  await A.goto(BASE + "/cliente/login");
  await A.fill("#email", U.staffB.email);
  await A.fill("#password", PASS);
  await A.click("button[type=submit]");
  await A.waitForURL(/staff\/panel/, { timeout: 90000 });
  await A.goto(BASE + "/staff/caja");
  await A.getByRole("button", { name: /^Mesa 5,/ }).waitFor({ timeout: 60000 });
  await esperar(6000);
  t = await totales(S[5]);
  const verPendientes = await A.getByText(/movimientos? por enviar/).count();
  nota("otra persona en el mismo teléfono no manda lo de la primera ni lo ve", llamadasB.n === 0 && t.consumos === 1 && verPendientes === 0, `${llamadasB.n} envíos, ${t.consumos} consumos`);
  await devA.clearCookies();
  await A.goto(BASE + "/cliente/login");
  await A.fill("#email", U.staffA.email);
  await A.fill("#password", PASS);
  await A.click("button[type=submit]");
  await A.waitForURL(/staff\/panel/, { timeout: 90000 });
  await A.goto(BASE + "/staff/caja");
  t = await esperarBase(S[5], (x) => x.consumos >= 2, 30000);
  cola = await esperarCola(A, (x) => x.length === 0);
  nota("cuando la primera vuelve a entrar, lo suyo se manda una vez", t.consumos === 2 && t.consumo === 3500 && cola.length === 0, `${t.consumos} consumos ${pesos(t.consumo)}`);

  // ---------- 5e. Dado de baja con pendientes, con la caja cerrada ----------
  // La baja llega mientras la caja no está abierta: al volver a abrirla se le
  // cierra la sesión. Sus pendientes no se quedan para siempre como "de otra
  // cuenta… se envían cuando vuelva a entrar" (nunca va a poder): pasan a
  // rechazados con el motivo, y desde ahí vencen a las 72 h.
  const devE = await dispositivo("E");
  const E = await entrar(devE, "staffE");
  await abrirMesa(E, 5);
  await devE.setOffline(true);
  await agregarConsumo(E, "Baja sin caja", "60");
  await E.close();
  await devE.setOffline(false);
  ok(await svc.from("profiles").update({ activo: false }).eq("id", U.staffE.id), "baja de E");
  const E2 = await devE.newPage();
  await E2.goto(BASE + "/staff/caja");
  await E2.waitForURL(/cliente\/login\?baja=1/, { timeout: 60000 }).catch(() => {});
  cola = await esperarCola(E2, (x) => x.length === 1 && x[0].estado === "rechazado", 10000);
  t = await totales(S[5]);
  nota("dado de baja que vuelve a abrir la caja: sale al login y su pendiente pasa a rechazado ('tu cuenta fue dada de baja'); no entra",
    /baja=1/.test(E2.url()) && cola.length === 1 && cola[0].estado === "rechazado" && /dada de baja/.test(cola[0].motivo ?? "") && t.consumos === 2,
    `${E2.url().replace(BASE, "")}, cola ${cola.map((x) => `${x.estado}: ${x.motivo}`)}, ${t.consumos} consumos`);
  await devE.close();

  // ---------- 7. Cerrar o cuadrar con movimientos de la mesa en la cola ----------
  // La base cierra y cuadra solo con lo que ya tiene: si se dejara cuadrar
  // con algo en el teléfono, el cuadre y la comisión saldrían sin eso y al
  // llegar lo rechazaría ("la mesa ya está cuadrada").
  ok(await U.staffA.api.rpc("caja_registrar_consumo", { p_cuenta_id: await cuenta(S[7]), p_monto_centavos: 50000, p_concepto: "Botella", p_clave: randomUUID() }), "consumo mesa 7");
  ok(await U.gerente.api.rpc("caja_registrar_pago", { p_sesion_id: S[7], p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 50000, p_referencia: null, p_clave: randomUUID(), p_saldo_esperado: 50000 }), "cobro mesa 7");
  const devG = await dispositivo("G");
  const G = await entrar(devG, "gerente");
  await abrirMesa(G, 7);
  await G.getByRole("button", { name: /^Cuadrar mesa$/ }).waitFor({ timeout: 15000 });
  // Hay red, pero la base no recibe nada de la cola (como con señal mala).
  await devG.route("**/rest/v1/rpc/caja_registrar_*", (route) => route.abort("failed"));
  await agregarConsumo(G, "Pendiente al cuadrar", "200");
  await cobrarSaldo(G);
  cola = await esperarCola(G, (x) => x.filter((y) => y.estado === "pendiente").length === 2, 15000);
  await G.getByRole("button", { name: /^Enviar ahora · 2 movimientos por enviar/ }).waitFor({ timeout: 15000 }).catch(() => {});
  const ofreceCuadrar = await G.getByRole("button", { name: /^Cuadrar mesa/ }).count();
  const ofreceEnviar = await G.getByRole("button", { name: /^Enviar ahora · 2 movimientos por enviar/ }).count();
  await G.getByRole("button", { name: "Más acciones" }).click();
  const ofreceSoloCerrar = await G.getByText("Solo cerrar (cuadrar después)").count();
  await G.getByRole("button", { name: "Más acciones" }).click();
  nota("con 2 movimientos de la mesa en la cola no se ofrece cuadrar ni 'Solo cerrar': se ofrece 'Enviar ahora'",
    cola.length === 2 && ofreceCuadrar === 0 && ofreceSoloCerrar === 0 && ofreceEnviar === 1,
    `cola ${cola.length}, cuadrar ${ofreceCuadrar}, solo cerrar ${ofreceSoloCerrar}, enviar ahora ${ofreceEnviar}`);
  await G.screenshot({ path: SHOTS + "09-cuadrar-espera-envio-390.png", fullPage: true });
  await G.setViewportSize({ width: 360, height: 740 });
  await G.screenshot({ path: SHOTS + "09b-cuadrar-espera-envio-360.png", fullPage: true });
  await G.setViewportSize({ width: 390, height: 844 });
  const s7 = ok(await svc.from("mesa_sesiones").select("estado").eq("id", S[7]).single(), "estado mesa 7");
  t = await totales(S[7]);
  nota("…la mesa sigue abierta en la base, con $500 y $500", s7.estado === "abierta" && t.consumo === 50000 && t.cobrado === 50000, `${s7.estado}, ${pesos(t.consumo)} / ${pesos(t.cobrado)}`);
  await devG.unroute("**/rest/v1/rpc/caja_registrar_*");
  await G.getByRole("button", { name: /^Enviar ahora/ }).click();
  t = await esperarBase(S[7], (x) => x.consumos === 2 && x.pagos === 2, 30000);
  cola = await esperarCola(G, (x) => x.length === 0);
  await G.getByRole("button", { name: /^Cuadrar mesa$/ }).waitFor({ timeout: 20000 }).catch(() => {});
  let textoCuadre = "";
  if ((await G.getByRole("button", { name: /^Cuadrar mesa$/ }).count()) === 1) {
    await G.getByRole("button", { name: /^Cuadrar mesa$/ }).click();
    const hoja = G.getByRole("dialog", { name: "Cuadrar mesa" });
    await hoja.waitFor();
    textoCuadre = (await hoja.getByRole("button", { name: /^Cuadrar mesa · / }).textContent()) ?? "";
    await hoja.getByRole("button", { name: /^Cuadrar mesa · / }).click();
    await hojaCerrada(G, "Cuadrar mesa");
  }
  const s7b = ok(await svc.from("mesa_sesiones").select("estado").eq("id", S[7]).single(), "estado mesa 7");
  t = await totales(S[7]);
  nota("'Enviar ahora' los manda, vuelve 'Cuadrar mesa' y se cuadra con TODO ($700 consumo y $700 cobrado)",
    s7b.estado === "cuadrada" && t.consumo === 70000 && t.cobrado === 70000 && cola.length === 0 && /\$700/.test(textoCuadre),
    `${s7b.estado}, ${pesos(t.consumo)} / ${pesos(t.cobrado)}, hoja "${textoCuadre.trim()}"`);
  await devG.close();

  // ---------- 7b. Fuera de la caja (la app instalada abre en /staff/panel) ----------
  // Sin red en la caja, el staff se va al panel (sale /offline.html) y la
  // señal vuelve ahí: la cola tiene que salir sin entrar a la Caja.
  await A.getByRole("button", { name: /^Mesa 5,/ }).waitFor({ timeout: 30000 });
  await abrirMesa(A, 5);
  await devA.setOffline(true);
  await agregarConsumo(A, "Desde el panel", "35");
  await A.goto(BASE + "/staff/panel").catch(() => {});
  await A.getByText("Sin conexión", { exact: true }).waitFor({ timeout: 15000 });
  const textoOffline = (await A.locator("#caja").textContent().catch(() => "")) ?? "";
  const antesPanel = llamadasColaA.n;
  await devA.setOffline(false); // /offline.html recarga /staff/panel
  t = await esperarBase(S[5], (x) => x.consumos >= 3, 40000);
  cola = await esperarCola(A, (x) => x.length === 0);
  await esperar(3000);
  t = await totales(S[5]);
  const enviosPanel = llamadasColaA.n - antesPanel;
  nota("sin entrar a la caja: al volver la señal en /staff/panel lo pendiente entra UNA vez",
    t.consumos === 3 && t.consumo === 7000 && cola.length === 0 && /staff\/panel/.test(A.url()) && enviosPanel === 1,
    `${t.consumos} consumos ${pesos(t.consumo)}, cola ${cola.length}, ${enviosPanel} envíos, ${A.url().replace(BASE, "")}`);
  nota("la página sin conexión ya no promete de más ('con la app de staff abierta')", /app de staff/.test(textoOffline), textoOffline.slice(0, 80));
  // Con señal pero sin que la base reciba: el panel avisa y lleva a la Caja.
  await devA.route("**/rest/v1/rpc/caja_registrar_*", (route) => route.abort("failed"));
  await A.goto(BASE + "/staff/caja");
  await A.getByRole("button", { name: /^Mesa 5,/ }).waitFor({ timeout: 60000 });
  await abrirMesa(A, 5);
  await agregarConsumo(A, "Aviso en el panel", "15");
  await A.goto(BASE + "/staff/panel");
  const avisoPanel = await A.getByText("Caja: 1 movimiento por enviar").waitFor({ timeout: 30000 }).then(() => true, () => false);
  const enlaceCaja = await A.getByRole("link", { name: "Abrir caja" }).count();
  await A.getByRole("button", { name: "Cerrar sesión" }).waitFor({ timeout: 60000 }).catch(() => {});
  await A.screenshot({ path: SHOTS + "21-panel-aviso-cola-390.png" });
  await A.setViewportSize({ width: 360, height: 740 });
  await A.screenshot({ path: SHOTS + "21b-panel-aviso-cola-360.png" });
  await A.setViewportSize({ width: 390, height: 844 });
  nota("en el panel se ve 'Caja: 1 movimiento por enviar' con 'Abrir caja'", avisoPanel && enlaceCaja === 1, `aviso ${avisoPanel}, enlace ${enlaceCaja}`);
  await devA.unroute("**/rest/v1/rpc/caja_registrar_*");
  await A.evaluate(() => window.dispatchEvent(new Event("online")));
  t = await esperarBase(S[5], (x) => x.consumos >= 4, 30000);
  await A.getByText("Caja: 1 movimiento por enviar").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  nota("…se manda desde el panel y el aviso se va", t.consumos === 4 && t.consumo === 8500 && (await A.getByText(/Caja: \d+ movimientos? por enviar/).count()) === 0, `${t.consumos} consumos ${pesos(t.consumo)}`);
  await A.goto(BASE + "/staff/caja");
  await A.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 60000 });

  // ---------- 8. Fase 2: catálogo y propina sin red ----------
  if (FASE2) {
    const prod = ok(
      await svc.from("productos").insert({ club_id: clubId, nombre: "Cerveza T", categoria: "Cerveza", precio_centavos: 8000, existencias: 10, existencias_minimas: 0 }).select("id").single(),
      "producto",
    );
    await A.getByRole("button", { name: /^Mesa 6,/ }).waitFor({ timeout: 30000 });
    await A.reload();
    await A.getByRole("button", { name: /^Mesa 6,/ }).waitFor({ timeout: 60000 });
    await abrirMesa(A, 6);
    await devA.setOffline(true);
    await A.getByRole("button", { name: /Agregar consumo/ }).first().click();
    const hoja = A.getByRole("dialog", { name: "Agregar consumo" });
    await hoja.getByRole("button", { name: "Agregar uno: Cerveza T" }).click();
    await hoja.getByRole("button", { name: "Agregar uno: Cerveza T" }).click();
    await hoja.getByRole("button", { name: /Guardar en el teléfono · \$160/ }).click();
    await hojaCerrada(A, "Agregar consumo");
    await A.getByRole("button", { name: /^Cobrar \$160/ }).click();
    const cobro = A.getByRole("dialog", { name: "Cobrar" });
    await cobro.getByLabel(/Propina/).fill("50");
    await cobro.getByRole("button", { name: /^Guardar cobro \$160/ }).click();
    await hojaCerrada(A, "Cobrar");
    await A.screenshot({ path: SHOTS + "08-fase2-sin-red-390.png", fullPage: true });
    await devA.setOffline(false);
    t = await esperarBase(S[6], (x) => x.consumos >= 1 && x.pagos >= 1, 30000);
    await esperarCola(A, (x) => x.length === 0);
    await esperar(3000);
    t = await totales(S[6]);
    const p6 = ok(await svc.from("caja_pagos").select("propina_centavos").eq("sesion_id", S[6]), "propina");
    const ex = ok(await svc.from("productos").select("existencias").eq("id", prod.id).single(), "existencias");
    nota("fase 2 sin red: consumo del catálogo y cobro con propina, una vez cada uno; existencias bajan una vez",
      t.consumos === 1 && t.consumo === 16000 && t.pagos === 1 && Number(p6[0]?.propina_centavos) === 5000 && ex.existencias === 8,
      `${t.consumos} consumos ${pesos(t.consumo)}, ${t.pagos} cobros, propina ${p6[0]?.propina_centavos}, existencias ${ex.existencias}`);
  }

  for (const ctx of [devA, devB, devC]) await ctx.close();
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  await navegador.close();
  await limpiar();
  if (errores.length) console.log("Errores de página:\n  " + errores.join("\n  "));
  const pasan = resultados.filter(Boolean).length;
  console.log(`\nResultado: ${pasan}/${resultados.length}`);
  process.exitCode = pasan === resultados.length && errores.length === 0 ? 0 : 1;
}
