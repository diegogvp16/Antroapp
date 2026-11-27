// FASE 2, bloque 8, en pantalla (Playwright, 390×844 y 360×740).
//
//   node scripts/dev/fase2-datos-ejemplo.mjs --banderas      # antes: datos de ejemplo
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-fase2-completa-pantalla.mjs [http://localhost:3047] [--fecha=AAAA-MM-DD]
//   node scripts/dev/fase2-datos-ejemplo.mjs --limpiar       # después
//
// Contra un servidor con NEXT_PUBLIC_FASE2=1 y las llaves de dev.
//
// A. Con los datos de ejemplo de Club Demo Dev (gerente de dev): el panel
//    enlaza a catálogo, reporte de inventario y propinas; el reporte de
//    inventario y el de propinas de la noche de ejemplo; un conteo desde el
//    catálogo y su historial.
// B. En un antro de prueba propio: con las banderas del antro apagadas la caja
//    se ve como antes (sin catálogo, sin propina, sin enlaces); al encenderlas
//    aparecen, y el staff registra una propina suelta que no cambia el saldo.
// Capturas en screenshots-n4-fase2/. Borra el antro de prueba al final.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
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
const BASE = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:3047";
const SHOTS = path.join(RAIZ, "screenshots-n4-fase2") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const CRED = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const DEMO = "0de70000-0000-4000-8000-000000000001";
const MARCA = "Ejemplo F2 · ";

const TAG = "f2p" + randomUUID().slice(0, 6);
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
const visible = (loc) => loc.first().isVisible().catch(() => false);
const espera = (loc, ms = 20000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);

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
      await db.q("delete from public.caja_propinas where club_id = $1", [clubId]);
      await db.q("delete from public.propinas_cobro_anuladas where club_id = $1", [clubId]);
      await db.q("delete from public.producto_movimientos where club_id = $1", [clubId]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = $1`, [clubId]);
      await db.q("delete from public.club_tables where club_id = $1", [clubId]);
      await db.q("delete from public.productos where club_id = $1", [clubId]);
      await db.q("delete from public.club_funciones where club_id = $1", [clubId]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = $1", [clubId]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  await svc.from("login_intentos").delete().in("email_hash", Object.values(U).map((u) => createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex")));
  const quedan = await db.q(`select (select count(*) from public.clubs where nombre like $1)::int clubs, (select count(*) from auth.users where email like $1)::int usuarios`, [`%${TAG}%`]);
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

const navegador = await chromium.launch();
const errores = [];
async function entrar(email, password, destino, viewport = { width: 390, height: 844 }) {
  for (let intento = 1; ; intento++) {
    const ctx = await navegador.newContext({ viewport });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errores.push(`${email}: ${e.message.slice(0, 160)}`));
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", email);
    await p.fill("#password", password);
    await p.click("button[type=submit]");
    try {
      await p.waitForURL(destino, { timeout: 90000 });
      return { ctx, p };
    } catch (e) {
      await ctx.close();
      if (intento >= 3) throw e;
      await new Promise((r) => setTimeout(r, 3000 * intento));
    }
  }
}
// Captura a 390 y a 360 (el caso apretado), revisando que no haya scroll horizontal.
async function capturas(s, nombre) {
  await s.p.screenshot({ path: SHOTS + `${nombre}-390.png`, fullPage: true });
  await s.p.setViewportSize({ width: 360, height: 740 });
  await s.p.waitForTimeout(300);
  const ancho = await s.p.evaluate(() => document.documentElement.scrollWidth);
  await s.p.screenshot({ path: SHOTS + `${nombre}-360.png`, fullPage: true });
  await s.p.setViewportSize({ width: 390, height: 844 });
  nota(`${nombre}: sin scroll horizontal a 360 px`, ancho <= 360, `scrollWidth ${ancho}`);
}
// Botones y enlaces visibles de menos de 40 px de alto (objetivo táctil).
async function botonesChicos(p) {
  return p.evaluate(() =>
    [...document.querySelectorAll("main button, main a, button, a")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < 40 && getComputedStyle(el).visibility !== "hidden";
      })
      .map((el) => (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)),
  );
}

try {
  // ======================= A. Datos de ejemplo =======================
  const fecha =
    process.argv.find((a) => a.startsWith("--fecha="))?.split("=")[1] ??
    ok(await svc.from("caja_noches").select("fecha_operacion, mesa_sesiones!inner(mesa_cuentas!inner(cliente_nombre))").eq("club_id", DEMO).like("mesa_sesiones.mesa_cuentas.cliente_nombre", MARCA + "%").limit(1), "noche ejemplo")[0]?.fecha_operacion;
  if (!fecha) throw new Error("No hay datos de ejemplo: corre node scripts/dev/fase2-datos-ejemplo.mjs --banderas");
  console.log(`== A. Datos de ejemplo de Club Demo Dev (noche ${fecha})`);
  const G = await entrar(CRED.usuarios.gerente, CRED.password, /staff\/panel/);
  for (const t of ["Catálogo e inventario", "Reporte de inventario", "Propinas de la noche"])
    nota(`panel del gerente: enlace «${t}»`, await espera(G.p.getByRole("link", { name: t }).or(G.p.getByText(t, { exact: true }))));
  await capturas(G, "01-panel-gerente-enlaces");

  await G.p.goto(BASE + "/staff/inventario");
  await G.p.getByRole("heading", { name: "Reporte de inventario" }).waitFor();
  await G.p.locator('input[type="date"]').fill(fecha);
  const filaCerveza = G.p.locator("li", { hasText: MARCA + "Cerveza clara" });
  nota("reporte de inventario: Cerveza clara con 16 vendidas, entrada +24 y merma −2", await espera(filaCerveza.filter({ hasText: "Vendidas 16" }).filter({ hasText: "Entradas +72" }).filter({ hasText: "Mermas −2" })), await filaCerveza.first().innerText().catch(() => "sin fila"));
  nota("reporte: el whisky anulado sale como anulado", await espera(G.p.locator("li", { hasText: MARCA + "Botella de whisky" }).filter({ hasText: "Anuladas 1" })));
  nota("reporte: el conteo del refresco sale con su diferencia (−5)", await espera(G.p.locator("li", { hasText: MARCA + "Refresco" }).filter({ hasText: "Conteo -5" })));
  await capturas(G, "02-reporte-inventario");
  nota("reporte de inventario: botones de 40 px o más", (await botonesChicos(G.p)).length === 0, (await botonesChicos(G.p)).join(" | "));

  await G.p.goto(BASE + "/staff/propinas");
  await G.p.getByRole("heading", { name: "Propinas de la noche" }).waitFor();
  await G.p.locator('input[type="date"]').fill(fecha);
  nota("propinas: total $580 de la noche de ejemplo", await espera(G.p.getByText("$580", { exact: true })));
  nota("propinas: la propina anulada sale tachada con su motivo", await espera(G.p.getByText(/anulada: Capturada dos veces/)));
  nota("propinas: reparto hecho (Staff Dev y Gerente Dev $232, la casa $116)", (await espera(G.p.getByText("$232"))) && (await visible(G.p.getByText("$116"))) && (await visible(G.p.getByText("Staff Dev"))));
  nota("propinas: la regla se lee en palabras", await visible(G.p.getByText(/80 % al personal \(con gerente\) · 20 % a la casa/)));
  await capturas(G, "03-propinas-reparto");
  nota("propinas: botones de 40 px o más", (await botonesChicos(G.p)).length === 0, (await botonesChicos(G.p)).join(" | "));

  await G.p.goto(BASE + "/staff/catalogo");
  await G.p.getByRole("heading", { name: "Catálogo e inventario" }).waitFor();
  const prod = G.p.locator("li", { hasText: MARCA + "Agua mineral" });
  await prod.getByRole("button", { name: "Existencias" }).click();
  await prod.getByRole("button", { name: "Conteo" }).click();
  const antes = ok(await svc.from("productos").select("id, existencias").eq("club_id", DEMO).eq("nombre", MARCA + "Agua mineral").single(), "agua");
  await prod.getByLabel("¿Cuántas hay?").fill(String(antes.existencias - 1));
  nota("conteo: avisa la diferencia antes de guardar", await visible(prod.getByText("Faltan 1")));
  await prod.getByLabel(/Motivo/).fill("Conteo de prueba en pantalla");
  await capturas(G, "04-catalogo-conteo");
  await prod.getByRole("button", { name: "Guardar conteo" }).click();
  await G.p.waitForTimeout(1500);
  const despues = ok(await svc.from("productos").select("existencias").eq("id", antes.id).single(), "agua 2");
  nota("conteo desde la pantalla: existencias quedan en lo contado", despues.existencias === antes.existencias - 1, `${antes.existencias} → ${despues.existencias}`);
  await G.p.locator("li", { hasText: MARCA + "Agua mineral" }).getByRole("button", { name: "Historial" }).click();
  nota("historial: muestra el conteo y la venta con su saldo", (await espera(G.p.getByText("Conteo", { exact: true }))) && (await visible(G.p.getByText(/Conteo de prueba en pantalla/))) && (await visible(G.p.getByText("Venta", { exact: true }))));
  await capturas(G, "05-catalogo-historial");
  await G.ctx.close();

  // ======================= B. Antro de prueba: banderas =======================
  console.log("\n== B. Antro de prueba: con las banderas apagadas, la caja como antes");
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `Prueba ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva" }).eq("id", clubId), "publicar");
  await usuario("staff", "staff");
  await usuario("gerente", "gerente");
  const mesas = ok(await svc.from("club_tables").insert([1, 2].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  ok(await svc.from("productos").insert({ club_id: clubId, nombre: "Cerveza de prueba", categoria: "Cervezas", precio_centavos: 9000, existencias: 5 }), "producto");
  const api = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  ok(await api.auth.signInWithPassword({ email: U.staff.email, password: PASS }), "login api");
  const S1 = ok(await api.rpc("caja_abrir_mesa", { p_mesa_id: mesas.find((m) => m.numero === "1").id }), "abrir");
  const C1 = ok(await api.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_cliente_nombre: "Grupo prueba", p_personas: 4 }), "sentar");
  ok(await api.rpc("caja_registrar_consumo", { p_cuenta_id: C1, p_monto_centavos: 50000, p_concepto: "Botella", p_clave: randomUUID() }), "consumo");

  const St = await entrar(U.staff.email, PASS, /staff\/panel/);
  await St.p.goto(BASE + "/staff/caja");
  await St.p.getByRole("button", { name: /^Mesa 1,/ }).click({ timeout: 60000 });
  await St.p.getByRole("button", { name: /Agregar consumo/ }).first().waitFor();
  await St.p.waitForTimeout(1500);
  nota("apagadas: la mesa no ofrece «Registrar propina»", !(await visible(St.p.getByRole("button", { name: /Registrar propina/ }))));
  await St.p.getByRole("button", { name: /Agregar consumo/ }).first().click();
  const hojaC = St.p.getByRole("dialog", { name: "Agregar consumo" });
  await hojaC.waitFor();
  nota("apagadas: agregar consumo sin catálogo (la hoja de siempre)", !(await visible(hojaC.getByPlaceholder("Buscar en el catálogo"))));
  await St.p.keyboard.press("Escape");
  await St.p.getByRole("button", { name: /^Cobrar \$500/ }).click({ timeout: 20000 });
  const hojaP = St.p.getByRole("dialog", { name: "Cobrar" });
  await hojaP.waitFor();
  nota("apagadas: el cobro no pide propina", !(await visible(hojaP.getByLabel(/Propina/))));
  await capturas(St, "06-caja-banderas-apagadas");
  await St.p.keyboard.press("Escape");

  const Ge = await entrar(U.gerente.email, PASS, /staff\/panel/);
  await Ge.p.waitForTimeout(1500);
  nota("apagadas: el panel del gerente no enlaza a la fase 2", !(await visible(Ge.p.getByText("Catálogo e inventario", { exact: true }))) && !(await visible(Ge.p.getByText("Propinas de la noche", { exact: true }))));
  await Ge.p.goto(BASE + "/staff/propinas");
  nota("apagadas: /staff/propinas dice que no está activo", await espera(Ge.p.getByText("Las propinas todavía no están activas en tu antro.")));
  await Ge.p.goto(BASE + "/staff/inventario");
  nota("apagadas: /staff/inventario dice que no está activo", await espera(Ge.p.getByText("El inventario todavía no está activo en tu antro.")));

  console.log("\n== B2. Banderas encendidas en el antro de prueba");
  ok(await svc.from("club_funciones").insert(["inventario", "propinas"].map((funcion) => ({ club_id: clubId, funcion, activa: true }))), "banderas");
  await St.p.reload();
  await St.p.getByRole("button", { name: /^Mesa 1,/ }).click({ timeout: 60000 });
  nota("encendidas: la mesa ofrece «Registrar propina»", await espera(St.p.getByRole("button", { name: /Registrar propina/ })));
  await St.p.getByRole("button", { name: /Registrar propina/ }).click();
  const hojaT = St.p.getByRole("dialog", { name: "Registrar propina" });
  await hojaT.waitFor();
  await hojaT.getByLabel("Propina ($)").fill("150");
  await hojaT.getByRole("button", { name: "Efectivo" }).click();
  await capturas(St, "07-hoja-registrar-propina");
  await hojaT.getByRole("button", { name: /Registrar \$150/ }).click();
  await hojaT.waitFor({ state: "detached", timeout: 30000 });
  const tp = ok(await svc.from("caja_propinas").select("monto_centavos, metodo, cuenta_id").eq("sesion_id", S1), "propinas");
  nota("la propina queda en la base ($150 efectivo, de la única cuenta)", tp.length === 1 && Number(tp[0].monto_centavos) === 15000 && tp[0].metodo === "efectivo" && tp[0].cuenta_id === C1, JSON.stringify(tp));
  nota("la mesa muestra la propina aparte y el saldo sigue en $500", (await espera(St.p.getByText(/Propinas aparte/))) && (await visible(St.p.getByText("$500"))));
  await capturas(St, "08-mesa-con-propina-suelta");
  await St.p.getByRole("button", { name: /Agregar consumo/ }).first().click();
  nota("encendidas: agregar consumo muestra el catálogo", await espera(St.p.getByRole("dialog", { name: "Agregar consumo" }).getByPlaceholder("Buscar en el catálogo")));
  await St.p.keyboard.press("Escape");
  nota("caja: botones de 40 px o más", (await botonesChicos(St.p)).length === 0, (await botonesChicos(St.p)).join(" | "));

  // Propina sin mesa desde una mesa libre (o ya cuadrada) de la caja.
  await St.p.goto(BASE + "/staff/caja");
  await St.p.getByRole("button", { name: /^Mesa 2,/ }).click({ timeout: 60000 });
  nota("mesa libre: ofrece «Propina sin mesa»", await espera(St.p.getByRole("button", { name: /Propina sin mesa/ })));
  await St.p.getByRole("button", { name: /Propina sin mesa/ }).click();
  const hojaS = St.p.getByRole("dialog", { name: "Propina sin mesa" });
  await hojaS.waitFor();
  await hojaS.getByLabel("Propina ($)").fill("80");
  await capturas(St, "10-hoja-propina-sin-mesa");
  await hojaS.getByRole("button", { name: /Registrar \$80/ }).click();
  await hojaS.waitFor({ state: "detached", timeout: 30000 });
  const sm = ok(await svc.from("caja_propinas").select("id, sesion_id, monto_centavos").eq("club_id", clubId).is("sesion_id", null), "sin mesa");
  nota("la propina sin mesa queda en la base ($80, sin mesa)", sm.length === 1 && Number(sm[0].monto_centavos) === 8000, JSON.stringify(sm));
  nota("la caja confirma la propina sin mesa", await espera(St.p.getByText(/Propina sin mesa registrada: \$80/)));

  await Ge.p.goto(BASE + "/staff/propinas");
  nota("gerente: propinas de hoy $230 y la noche sigue abierta", (await espera(Ge.p.getByText("$230", { exact: true }))) && (await visible(Ge.p.getByText(/La noche sigue abierta/))));
  nota("gerente: el reparto espera a que cierre la noche", await visible(Ge.p.getByText(/Se reparte con la noche cerrada/)));
  nota("gerente: puede registrar una propina sin mesa", await visible(Ge.p.getByRole("button", { name: "Registrar propina sin mesa" })));
  nota("gerente: totales por origen (con el cobro / aparte)", (await visible(Ge.p.getByText("Con el cobro (0)"))) && (await visible(Ge.p.getByText("Aparte (2)"))));
  await capturas(Ge, "09-propinas-noche-abierta");
  const filaSinMesa = Ge.p.locator("li", { hasText: "Sin mesa · Efectivo" });
  await filaSinMesa.getByRole("button", { name: "Anular propina" }).click();
  await filaSinMesa.getByPlaceholder(/Motivo/).fill("Se capturó dos veces");
  await filaSinMesa.getByRole("button", { name: "Anular propina" }).click();
  nota("gerente: anula una propina desde el reporte (queda tachada y fuera del total)", (await espera(Ge.p.getByText(/anulada: Se capturó dos veces/))) && (await espera(Ge.p.getByText("$150", { exact: true }))));
  const an = ok(await svc.from("caja_propinas").select("anulado, motivo_anulacion").eq("id", sm[0].id).single(), "anulada");
  nota("la anulación queda en la base con su motivo", an.anulado && an.motivo_anulacion === "Se capturó dos veces");
  for (const s of [St, Ge]) await s.ctx.close();
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
