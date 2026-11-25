// Pantalla "Salud de la plataforma" (/admin/salud) contra el servidor local
// de dev y antroapp-dev, con las cuentas dev_<rol>. Solo lee: no cambia datos
// (fuera de los intentos de login que anota /api/auth/login).
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-salud-pantalla.mjs [http://localhost:3001]
//
// Revisa:
// - admin: llega desde /admin por el botón, ve servicio, inicios de sesión,
//   registros, errores y reglas; tantos antros como admin_salud_reglas() (leída
//   con su sesión por claims, en una transacción READ ONLY); ningún hash en la
//   página; sin scroll horizontal a 390×844 y 360×740; controles de al menos
//   40 px; sin errores de consola ni HTTP.
// - dueño: /admin/salud lo regresa a /admin/login.
// Capturas en screenshots-b-reportes/ (ignorada por Git).

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
async function cargarPlaywright() {
  try {
    return req("playwright");
  } catch {
    if (process.env.PLAYWRIGHT_DESDE) return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
    process.exit(1);
  }
}
const { chromium } = await cargarPlaywright();
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-b-reportes") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

let pasan = 0, fallan = 0;
function nota(texto, ok, detalle = "") {
  if (ok) pasan++; else fallan++;
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${!ok && detalle ? "  — " + detalle : ""}`);
}

const db = await conectarDevEscritura();
async function reglasComo(email) {
  const [u] = await db.q("select id from auth.users where email = $1", [email]);
  await db.q("begin transaction read only");
  try {
    await db.q("set local role authenticated");
    await db.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.id, role: "authenticated" })]);
    return await db.q("select club_id, nombre, alertas from public.admin_salud_reglas()");
  } finally {
    await db.q("rollback");
  }
}

const navegador = await chromium.launch();
async function sesion(email, destino, viewport = { width: 390, height: 844 }) {
  const ctx = await navegador.newContext({ viewport });
  const p = await ctx.newPage();
  const errores = [];
  p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
  p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React/.test(m.text())) errores.push(m.text().slice(0, 140)); });
  p.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errores.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", email);
  await p.fill("#password", cred.password);
  await p.click("button[type=submit]");
  await p.waitForURL(destino, { timeout: 90000 }).catch(() => {});
  return { ctx, p, errores };
}
async function revisarMedidas(p, etiqueta) {
  const m = await p.evaluate(() => {
    const ancho = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const chicos = [...document.querySelectorAll("button, a[href]")]
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ t: (e.textContent || "").trim().slice(0, 30), h: e.getBoundingClientRect().height }))
      .filter((x) => x.h < 40);
    return { ancho, chicos };
  });
  nota(`${etiqueta}: sin scroll horizontal`, m.ancho <= 0, `${m.ancho}px de más`);
  nota(`${etiqueta}: controles de al menos 40 px`, m.chicos.length === 0, JSON.stringify(m.chicos));
}

try {
  // ======================= Admin =======================
  {
    const esperadas = await reglasComo(cred.usuarios.admin);
    const { ctx, p, errores } = await sesion(cred.usuarios.admin, /\/admin$/);
    const boton = p.locator('a[href="/admin/salud"]');
    await boton.waitFor({ timeout: 90000 }).catch(() => {});
    if (!(await boton.isVisible().catch(() => false))) await p.screenshot({ path: `${SHOTS}salud-admin-sin-boton.png` });
    nota("admin: /admin tiene el botón «Salud de la plataforma»", await boton.isVisible().catch(() => false));
    // Entradas del admin a los reportes (B11 y B4): antes solo tecleando la URL.
    for (const [nombre, href] of [["Resumen por antro", "/grupo"], ["Cierre de la noche", "/grupo/noche"], ["Descargar reportes (CSV)", "/grupo/exportar"]]) {
      // (El Button con render={<Link>} es un <a> con role=button: se busca por href.)
      const a = p.locator(`a[href="${href}"]`);
      const t = ((await a.first().innerText().catch(() => "")) || "").trim();
      nota(`admin: /admin enlaza «${nombre}» a ${href}`, (await a.count()) === 1 && t === nombre, t);
    }
    {
      const alturas = await p.evaluate(() => [...document.querySelectorAll('a[href="/grupo"], a[href="/grupo/noche"], a[href="/grupo/exportar"]')].map((e) => e.getBoundingClientRect().height));
      nota("admin: los enlaces nuevos miden al menos 40 px", alturas.length === 3 && alturas.every((h) => h >= 40), JSON.stringify(alturas));
    }
    await p.screenshot({ path: `${SHOTS}admin-enlaces-reportes-390.png` });
    await p.locator('a[href="/grupo/noche"]').click();
    await p.waitForURL(/\/grupo\/noche/, { timeout: 60000 }).catch(() => {});
    await p.getByText("Estado de la noche").waitFor({ timeout: 60000 }).catch(() => {});
    nota("admin: «Cierre de la noche» abre el reporte", (await p.locator("body").innerText()).includes("Estado de la noche"));
    await p.goto(BASE + "/admin");
    await boton.waitFor({ timeout: 90000 }).catch(() => {});
    // Estado de cargando mientras se revisa la sesión (antes: página en blanco).
    await p.route("**/rest/v1/profiles*", async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue().catch(() => {}); });
    await boton.click();
    const cargandoVisible = await p.getByRole("status").filter({ hasText: "Cargando…" }).waitFor({ timeout: 2000 }).then(() => true, () => false);
    nota("admin: /admin/salud muestra «Cargando…» mientras revisa la sesión", cargandoVisible);
    await p.unroute("**/rest/v1/profiles*");
    await p.waitForURL(/\/admin\/salud/, { timeout: 60000 }).catch(() => {});
    await p.getByRole("heading", { name: "Reglas de pago de RPs" }).waitFor({ timeout: 90000 }).catch(() => {});
    await p.getByText(/Base en línea|Base lenta|Base sin respuesta|no respondió/).first().waitFor({ timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(500);
    const texto = await p.locator("body").innerText();
    for (const t of ["Salud de la plataforma", "Servicio", "Inicios de sesión", "Bloqueos ahora", "Registros de cuentas", "Errores de la app", "Reglas de pago de RPs"])
      nota(`admin: se ve «${t}»`, texto.includes(t));
    nota("admin: el servicio responde", /Base en línea|Base lenta/.test(texto));
    // La base es compartida: otros agentes crean y borran antros mientras
    // corre la prueba; vale si coincide con la lectura de antes o la de después.
    const despues = await reglasComo(cred.usuarios.admin);
    const tarjetas = await p.locator("[data-antro]").count();
    nota("admin: un antro por renglón de admin_salud_reglas()", [esperadas.length, despues.length].includes(tarjetas), `${tarjetas} ≠ ${esperadas.length}/${despues.length}`);
    nota("admin: Club Demo Dev en la lista", texto.includes("Club Demo Dev"));
    const legacy = (l) => l.filter((e) => e.alertas.includes("legacy")).length;
    const avisos = await p.getByText("Sin regla nueva: sigue con la configuración anterior").count();
    nota("admin: aviso «configuración anterior» en cada antro que la usa", [legacy(esperadas), legacy(despues)].includes(avisos), `${avisos} ≠ ${legacy(esperadas)}/${legacy(despues)}`);
    const rojasDemo = despues.find((e) => e.nombre === "Club Demo Dev")?.alertas ?? [];
    const tarjetaDemo = await p.locator("[data-antro]", { hasText: "Club Demo Dev" }).first().innerText();
    nota("admin: alertas de Club Demo Dev = la base", rojasDemo.includes("sin_regla") === tarjetaDemo.includes("Comisión en $0"));
    nota("admin: ningún hash en la página", !/[0-9a-f]{64}/i.test(texto));
    await revisarMedidas(p, "admin 390");
    await p.screenshot({ path: `${SHOTS}salud-admin-390.png`, fullPage: true });
    await p.screenshot({ path: `${SHOTS}salud-admin-390-arriba.png` });
    await p.setViewportSize({ width: 360, height: 740 });
    await p.waitForTimeout(500);
    await revisarMedidas(p, "admin 360");
    await p.screenshot({ path: `${SHOTS}salud-admin-360.png`, fullPage: true });
    await p.getByRole("button", { name: "Actualizar" }).click();
    await p.getByRole("button", { name: "Actualizar" }).waitFor({ timeout: 30000 }).catch(() => {});
    // (Next pone su propio role=alert para anunciar rutas: se busca el nuestro.)
    nota("admin: «Actualizar» vuelve a cargar sin error", !(await p.locator("[role=alert]", { hasText: "No pudimos" }).count()));
    nota("admin: sin errores de consola ni HTTP", errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ======================= Dueño: no =======================
  {
    const { ctx, p } = await sesion(cred.usuarios.dueno, /dueno\/panel/);
    await p.goto(BASE + "/admin/salud");
    await p.waitForURL(/\/admin\/login/, { timeout: 60000 }).catch(() => {});
    nota("dueño: /admin/salud lo manda a /admin/login", /\/admin\/login/.test(p.url()), p.url());
    await ctx.close();
  }
} catch (e) {
  nota("error inesperado", false, e.stack?.slice(0, 400) ?? e.message);
} finally {
  await navegador.close();
  await db.fin();
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
