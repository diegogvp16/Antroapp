// Caja en condiciones reales, en el navegador: 3 sesiones a la vez en la
// misma mesa (2 staff y 1 gerente), doble toque, sin conexión y respuestas
// perdidas por la señal. Contra el servidor local de dev
// (node scripts/dev/servidor-dev.mjs) y antroapp-dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-caja-multi.mjs [http://localhost:3001]
//
// Arma su propio antro de prueba (no toca la noche demo) y al final lo borra.
// Capturas en screenshots-caja-multi/ (ignorada por Git).

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
const BASE = process.argv[2] ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-caja-multi") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);

const TAG = "multi" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
let clubId = null;
const resultados = [];
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
function nota(texto, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}

async function usuario(clave, role) {
  const email = `prueba-${clave}-${TAG}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id: clubId, activo: true }), "perfil " + clave);
  U[clave] = { id: u.user.id, email };
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubId) {
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
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
  // Intentos de login de estas cuentas (la app guarda el correo con sha256).
  await svc.from("login_intentos").delete().in("email_hash", Object.values(U).map((u) => createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex")));
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from auth.users where email like $1)::int usuarios`,
    [`%${TAG}%`],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

// Totales de la sesión, leídos de la base (la verdad).
async function totales(sesionId) {
  const c = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", sesionId).eq("anulado", false), "consumos");
  const p = ok(await svc.from("caja_pagos").select("monto_centavos").eq("sesion_id", sesionId).eq("anulado", false), "pagos");
  const suma = (xs) => xs.reduce((s, x) => s + Number(x.monto_centavos), 0);
  return { consumos: c.length, consumo: suma(c), pagos: p.length, cobrado: suma(p) };
}
// Igual que formatearCentavos de la app: pesos cerrados sin centavos.
const pesos = (c) => "$" + (c / 100).toLocaleString("es-MX", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

// Deja pasar la petición a la base y tira la respuesta: lo que pasa con
// mala señal cuando el servidor sí guardó pero el teléfono no se enteró.
async function perderRespuestaUnaVez(page, funcion) {
  let hecho = false;
  const patron = `**/rest/v1/rpc/${funcion}`;
  await page.route(patron, async (route) => {
    if (hecho) return route.continue();
    hecho = true;
    await route.fetch().catch(() => {});
    await route.abort("failed");
  });
  return () => page.unroute(patron);
}

const navegador = await chromium.launch();
const errores = [];
try {
  // ======================= Escenario =======================
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `Prueba ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva" }).eq("id", clubId), "publicar");
  await usuario("staffA", "staff");
  await usuario("staffB", "staff");
  await usuario("gerente", "gerente");
  const mesas = ok(await svc.from("club_tables").insert([1, 2, 3, 4].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const M1 = mesas.find((m) => m.numero === "1").id;
  const sA = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  ok(await sA.auth.signInWithPassword({ email: U.staffA.email, password: PASS }), "login api");
  const S1 = ok(await sA.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "abrir mesa");
  ok(await sA.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_cliente_nombre: "Grupo Prueba", p_personas: 6 }), "sentar");

  // ======================= Tres sesiones =======================
  const sesiones = {};
  for (const clave of ["staffA", "staffB", "gerente"]) {
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errores.push(`${clave}: ${e.message.slice(0, 160)}`));
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", U[clave].email);
    await p.fill("#password", PASS);
    await p.click("button[type=submit]");
    await p.waitForURL(/staff\/panel/, { timeout: 90000 });
    await p.goto(BASE + "/staff/caja");
    await p.getByRole("button", { name: /^Mesa 1,/ }).click({ timeout: 60000 });
    await p.getByText("Grupo Prueba").first().waitFor();
    sesiones[clave] = { ctx, p };
  }
  const { staffA: A, staffB: B, gerente: G } = sesiones;
  nota("3 sesiones (2 staff y gerente) abren la misma mesa", true);

  const abrirConsumo = async (p) => {
    await p.getByRole("button", { name: /Agregar consumo/ }).first().click();
    await p.getByRole("dialog", { name: "Agregar consumo" }).waitFor();
  };
  const capturar = async (p, concepto, precio) => {
    const hoja = p.getByRole("dialog", { name: "Agregar consumo" });
    await hoja.getByLabel("Concepto").fill(concepto);
    await hoja.getByLabel("Precio unitario ($)").fill(precio);
    return hoja.getByRole("button", { name: /Agregar a la mesa/ });
  };
  const hojaCerrada = (p, nombre) => p.getByRole("dialog", { name: nombre }).waitFor({ state: "detached", timeout: 30000 });

  // ---------- 1. Dos staff agregan consumo al mismo tiempo ----------
  await Promise.all([abrirConsumo(A.p), abrirConsumo(B.p)]);
  const [botonA, botonB] = await Promise.all([capturar(A.p, "Botella A", "1500"), capturar(B.p, "Botella B", "900")]);
  await Promise.all([botonA.click(), botonB.click()]);
  await Promise.all([hojaCerrada(A.p, "Agregar consumo"), hojaCerrada(B.p, "Agregar consumo")]);
  let t = await totales(S1);
  nota("dos staff agregan consumo a la vez: entran los dos", t.consumos === 2 && t.consumo === 240000, `${t.consumos} renglones, ${pesos(t.consumo)}`);

  // ---------- 2. La tercera sesión ve los cambios sin recargar ----------
  const t0 = Date.now();
  await G.p.getByText(pesos(240000)).first().waitFor({ timeout: 25000 }).then(
    () => nota("el gerente ve el total nuevo sin recargar", true, `${Math.round((Date.now() - t0) / 1000)} s`),
    () => nota("el gerente ve el total nuevo sin recargar", false, "no apareció en 25 s"),
  );
  await G.p.screenshot({ path: SHOTS + "01-gerente-ve-cambios.png", fullPage: true });

  // ---------- 3. Doble toque ----------
  await abrirConsumo(A.p);
  const boton = await capturar(A.p, "Ronda doble toque", "300");
  await boton.evaluate((b) => { b.click(); b.click(); b.click(); });
  await hojaCerrada(A.p, "Agregar consumo");
  t = await totales(S1);
  nota("triple toque en 'Agregar a la mesa': un solo consumo", t.consumos === 3 && t.consumo === 270000, `${t.consumos} renglones`);

  // ---------- 4. Respuesta perdida al agregar consumo ----------
  await abrirConsumo(B.p);
  const botonPerdido = await capturar(B.p, "Ronda sin señal", "450");
  let quitar = await perderRespuestaUnaVez(B.p, "caja_registrar_consumo");
  await botonPerdido.click();
  const aviso = B.p.getByText(/No hubo respuesta por la señal/).first();
  await aviso.waitFor({ timeout: 20000 });
  t = await totales(S1);
  nota("respuesta perdida: el consumo sí quedó en la base y la hoja sigue abierta con lo capturado",
    t.consumos === 4 && (await B.p.getByRole("dialog", { name: "Agregar consumo" }).getByLabel("Concepto").inputValue()) === "Ronda sin señal");
  await B.p.screenshot({ path: SHOTS + "02-respuesta-perdida-consumo.png", fullPage: true });
  await quitar();
  await B.p.getByRole("dialog", { name: "Agregar consumo" }).getByRole("button", { name: /Agregar a la mesa/ }).click();
  await hojaCerrada(B.p, "Agregar consumo");
  t = await totales(S1);
  nota("reintento tras la respuesta perdida: no se duplica", t.consumos === 4 && t.consumo === 315000, `${t.consumos} renglones, ${pesos(t.consumo)}`);

  // ---------- 5. Sin conexión ----------
  await abrirConsumo(A.p);
  await capturar(A.p, "Capturado sin red", "100");
  await A.ctx.setOffline(true);
  await A.p.getByText("Sin conexión · reconectando…").waitFor({ timeout: 10000 }).then(() => nota("sin red: aparece 'Sin conexión · reconectando…'", true), () => nota("sin red: aparece 'Sin conexión · reconectando…'", false));
  const botonSinRed = A.p.getByRole("dialog", { name: "Agregar consumo" }).getByRole("button", { name: "Sin conexión" });
  nota("sin red: el botón se desactiva y dice 'Sin conexión'", await botonSinRed.isDisabled().catch(() => false));
  await A.p.screenshot({ path: SHOTS + "03-sin-conexion.png", fullPage: true });
  await A.ctx.setOffline(false);
  const botonVuelve = A.p.getByRole("dialog", { name: "Agregar consumo" }).getByRole("button", { name: /Agregar a la mesa/ });
  await botonVuelve.waitFor({ timeout: 20000 });
  nota("al volver la red, lo capturado sigue ahí", (await A.p.getByRole("dialog", { name: "Agregar consumo" }).getByLabel("Concepto").inputValue()) === "Capturado sin red");
  await botonVuelve.click();
  await hojaCerrada(A.p, "Agregar consumo");
  t = await totales(S1);
  nota("…y se guarda una vez", t.consumos === 5 && t.consumo === 325000, `${t.consumos} renglones`);

  // ---------- 6. Dos staff cobran el saldo completo a la vez ----------
  // Las tres pantallas al día antes de cobrar.
  for (const s of [A, B, G]) await s.p.getByText(pesos(325000)).first().waitFor({ timeout: 25000 });
  const abrirCobro = async (p) => {
    await p.getByRole("button", { name: /^Cobrar \$/ }).first().click();
    await p.getByRole("dialog", { name: "Cobrar" }).waitFor();
    return p.getByRole("dialog", { name: "Cobrar" }).getByRole("button", { name: /^Cobrar/ });
  };
  const [cobroA, cobroB] = await Promise.all([abrirCobro(A.p), abrirCobro(B.p)]);
  await Promise.all([cobroA.click(), cobroB.click()]);
  await A.p.waitForTimeout(4000);
  t = await totales(S1);
  nota("dos staff cobran el saldo completo a la vez: entra un solo cobro", t.pagos === 1 && t.cobrado === 325000, `${t.pagos} cobros, ${pesos(t.cobrado)}`);
  const rechazo = await Promise.all([A.p, B.p].map((p) => p.getByText("La mesa ya quedó pagada.").first().isVisible().catch(() => false)));
  nota("al que llegó segundo se le explica que la mesa ya quedó pagada", rechazo.filter(Boolean).length === 1);
  await (rechazo[0] ? A.p : B.p).screenshot({ path: SHOTS + "04-cobro-rechazado-saldo-cambio.png", fullPage: true });
  for (const s of [A, B]) await s.p.getByRole("dialog", { name: "Cobrar" }).getByRole("button", { name: "Cerrar", exact: true }).click().catch(() => {});

  // ---------- 7. Respuesta perdida al cobrar ----------
  await abrirConsumo(G.p);
  const extra = await capturar(G.p, "Agua", "80");
  await extra.click();
  await hojaCerrada(G.p, "Agregar consumo");
  await G.p.getByRole("button", { name: /^Cobrar \$80/ }).waitFor({ timeout: 20000 });
  const cobroG = await abrirCobro(G.p);
  quitar = await perderRespuestaUnaVez(G.p, "caja_registrar_pago");
  await cobroG.click();
  await G.p.getByText(/No hubo respuesta por la señal/).first().waitFor({ timeout: 20000 });
  await quitar();
  t = await totales(S1);
  nota("cobro con respuesta perdida: sí quedó en la base", t.pagos === 2 && t.cobrado === 333000, `${t.pagos} cobros`);
  // Al recargar, la hoja ve que la mesa ya quedó pagada (por su propio cobro)
  // y en vez de cobrar otra vez ofrece "Listo".
  const hojaCobro = G.p.getByRole("dialog", { name: "Cobrar" });
  await hojaCobro.getByText("La mesa ya quedó pagada.").waitFor({ timeout: 20000 });
  nota("tras la respuesta perdida, la hoja dice que la mesa ya quedó pagada (no ofrece cobrar otra vez)",
    (await hojaCobro.getByRole("button", { name: /^Cobrar $/ }).count()) === 0);
  await G.p.screenshot({ path: SHOTS + "05-cobro-respuesta-perdida.png", fullPage: true });
  await hojaCobro.getByRole("button", { name: "Listo" }).click();
  await hojaCerrada(G.p, "Cobrar");
  t = await totales(S1);
  nota("el cobro quedó una sola vez", t.pagos === 2 && t.cobrado === 333000, `${t.pagos} cobros, ${pesos(t.cobrado)}`);

  // ---------- 8. Cuadrar con respuesta perdida ----------
  await G.p.getByRole("button", { name: /^Cuadrar mesa$/ }).click({ timeout: 20000 });
  await G.p.getByRole("dialog", { name: "Cuadrar mesa" }).waitFor();
  quitar = await perderRespuestaUnaVez(G.p, "caja_cuadrar_mesa");
  // La app no se queda con el error: revisa el estado real en la base, ve la
  // mesa ya cuadrada y termina sin pedir otro intento.
  await G.p.getByRole("dialog", { name: "Cuadrar mesa" }).getByRole("button", { name: /^Cuadrar mesa/ }).click();
  await hojaCerrada(G.p, "Cuadrar mesa");
  await quitar();
  const cuadres = ok(await svc.from("caja_cuadres").select("id").eq("sesion_id", S1), "cuadres");
  const ses = ok(await svc.from("mesa_sesiones").select("estado").eq("id", S1).single(), "sesión");
  nota("cuadrar con la respuesta perdida: la app revisa la base y termina bien, un solo cuadre", cuadres.length === 1 && ses.estado === "cuadrada", `${cuadres.length} cuadres, ${ses.estado}`);
  await G.p.screenshot({ path: SHOTS + "06-cuadrada.png", fullPage: true });
  for (const s of [A, B]) {
    await s.p.getByText("Mesa libre (cuadrada)").first().waitFor({ timeout: 25000 }).catch(() => {});
  }
  nota("los dos staff ven la mesa cuadrada sin recargar", (await Promise.all([A.p, B.p].map((p) => p.getByText("Mesa libre (cuadrada)").first().isVisible()))).every(Boolean));
  for (const s of Object.values(sesiones)) await s.ctx.close();
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
