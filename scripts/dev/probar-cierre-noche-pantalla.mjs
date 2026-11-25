// Pantalla "Cierre de la noche" (/grupo/noche) contra el servidor local de
// dev y antroapp-dev, con las cuentas dev_<rol>. Solo lee: no cambia datos.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-cierre-noche-pantalla.mjs [http://localhost:3001]
//
// Revisa, a 390×844 y 360×740: que el gerente, el dueño y el admin vean la
// noche demo del 25/11 de Club Demo Dev con las MISMAS cifras que la base
// (reporte_cierre_noche con su sesión), sin scroll horizontal ni errores;
// que el CSV se descargue con esas cifras; la vista de impresión (fondo
// blanco); la noche cerrada (21/11) con su cuadre; el enlace desde /grupo y
// desde el cuadre de la caja; y que el staff y el RP no vean el reporte.
// Capturas en screenshots-b-reportes/ (ignorada por Git).

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
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
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-b-reportes") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;
const NOCHE = "2026-11-25";
const CERRADA = "2026-11-21";

let pasan = 0, fallan = 0;
function nota(texto, ok, detalle = "") {
  if (ok) pasan++; else fallan++;
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${!ok && detalle ? "  — " + detalle : ""}`);
}
// "$161,550" como lo pinta formatearCentavos (es-MX, sin centavos si son cero).
const pesos = (c) => {
  const n = Number(c) / 100;
  return Number.isInteger(n)
    ? new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n)
    : new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 }).format(n);
};
async function reporteBase(email, fecha) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email, password: cred.password });
  const { data, error } = await c.rpc("reporte_cierre_noche", { p_club_id: CLUB, p_fecha: fecha });
  if (error) throw new Error("reporte_cierre_noche: " + error.message);
  return data;
}

const navegador = await chromium.launch();
async function sesion(email, destino, viewport = { width: 390, height: 844 }) {
  const ctx = await navegador.newContext({ viewport, acceptDownloads: true });
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
async function abrir(p, url) {
  await p.goto(BASE + url);
  await p.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await p.getByRole("heading", { name: "Cierre de la noche" }).waitFor({ timeout: 60000 }).catch(() => {});
  await p.getByText("Estado de la noche").waitFor({ timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(800);
}
const sinScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const texto = (p) => p.locator("body").innerText();

try {
  // ---------- Gerente: noche demo 25/11 (abierta) a 390 y 360 ----------
  const esperado = await reporteBase(cred.usuarios.gerente, NOCHE);
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const { ctx, p, errores } = await sesion(cred.usuarios.gerente, /staff\/panel/, viewport);
    await abrir(p, `/grupo/noche?club=${CLUB}&fecha=${NOCHE}`);
    const t = await texto(p);
    const w = viewport.width;
    nota(`gerente ${w}: abre el cierre de la noche 25/11`, t.includes("Estado de la noche") && t.includes("Club Demo Dev"));
    for (const [que, valor] of [
      ["consumo en caja", pesos(esperado.consumo.total_centavos)],
      ["cobrado", pesos(esperado.cobros.total_centavos)],
      ["ticket por cuenta", pesos(esperado.consumo.ticket_promedio_centavos)],
      ["comisiones", pesos(esperado.comisiones.total_centavos)],
      ["consumo con reserva", pesos(esperado.consumo.con_reserva_centavos)],
      ["consumos anulados", pesos(esperado.anulaciones.consumos_centavos)],
    ]) nota(`gerente ${w}: ${que} = base (${valor})`, t.includes(valor), valor);
    nota(`gerente ${w}: reservas y por llegar = base`, t.includes(String(esperado.reservas.reservas)) && t.includes("Por llegar"));
    nota(`gerente ${w}: dice que las cifras son parciales`, /Cifras parciales/.test(t));
    nota(`gerente ${w}: los ${esperado.rps.length} RPs con su consumo`, esperado.rps.every((r) => t.includes(r.rp_nombre) && t.includes(pesos(r.consumo_centavos))));
    nota(`gerente ${w}: sin scroll horizontal`, await sinScroll(p));
    nota(`gerente ${w}: la tabla por origen cabe sin desplazarse`, await p.evaluate(() => [...document.querySelectorAll("table")].every((t) => t.parentElement.scrollWidth <= t.parentElement.clientWidth)));
    await p.screenshot({ path: `${SHOTS}cierre-gerente-25nov-${w}.png`, fullPage: true });
    if (w === 390) {
      // Botones táctiles ≥ 40 px.
      const bajos = await p.evaluate(() => [...document.querySelectorAll("button, a, select, input")]
        .filter((e) => e.offsetParent !== null).map((e) => [e.textContent?.trim().slice(0, 20) || e.getAttribute("aria-label") || e.tagName, e.getBoundingClientRect().height])
        .filter(([, h]) => h < 40));
      nota("gerente 390: controles de al menos 40 px", bajos.length === 0, JSON.stringify(bajos));
      // CSV
      const [descarga] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: /CSV/ }).click()]);
      const ruta = await descarga.path();
      const csv = readFileSync(ruta, "utf8");
      nota("CSV: nombre del archivo", descarga.suggestedFilename() === `cierre-club-demo-dev-${NOCHE}.csv`, descarga.suggestedFilename());
      nota("CSV: consumo y cobrado = base", csv.includes(`Consumo,Total en caja,${(esperado.consumo.total_centavos / 100).toFixed(2)}`) && csv.includes(`Cobros,Total cobrado,${(esperado.cobros.total_centavos / 100).toFixed(2)}`));
      nota("CSV: una fila por RP", esperado.rps.every((r) => csv.includes(r.rp_nombre)));
      nota("CSV: sin teléfonos", !/0000000\d{3}/.test(csv));
      // Vista de impresión.
      await p.emulateMedia({ media: "print" });
      await p.waitForTimeout(800); // las insignias tienen transición de color
      const fondo = await p.evaluate(() => getComputedStyle(document.querySelector(".reporte-imprimible")).backgroundColor);
      const botonesOcultos = await p.getByRole("button", { name: /Imprimir/ }).isHidden();
      nota("impresión: papel blanco", fondo === "rgb(255, 255, 255)", fondo);
      nota("impresión: sin botones ni selector", botonesOcultos);
      await p.screenshot({ path: `${SHOTS}cierre-gerente-25nov-impresion.png`, fullPage: true });
      await p.emulateMedia({ media: "screen" });
      // Noche anterior con el botón.
      await p.getByRole("button", { name: "Noche anterior" }).click();
      await p.waitForURL(/fecha=2026-11-24/, { timeout: 30000 }).catch(() => {});
      nota("noche anterior: cambia la fecha en la URL", p.url().includes("fecha=2026-11-24"), p.url());
      // Noche cerrada (21/11) con cuadre.
      const cerrada = await reporteBase(cred.usuarios.gerente, CERRADA);
      await abrir(p, `/grupo/noche?club=${CLUB}&fecha=${CERRADA}`);
      const tc = await texto(p);
      const dif = cerrada.cuadre?.diferencia_centavos ?? 0;
      nota("noche cerrada: 'Cerrada en caja' y quién la cerró", tc.includes("Cerrada en caja") && (!cerrada.noche.cerrada_por_nombre || tc.includes(cerrada.noche.cerrada_por_nombre)));
      nota("noche cerrada: diferencia del cuadre = base", dif === 0 ? tc.includes("Cuadra") : tc.includes(pesos(Math.abs(dif))), String(dif));
      nota("noche cerrada: 'No llegaron' en vez de 'Por llegar'", tc.includes("No llegaron") && !tc.includes("Por llegar"));
      await p.screenshot({ path: `${SHOTS}cierre-gerente-21nov-cerrada-390.png`, fullPage: true });
      // Enlace desde el cuadre de la caja.
      await p.goto(BASE + "/staff/caja");
      await p.getByRole("button", { name: "Cuadre de la noche" }).click({ timeout: 60000 }).catch(() => {});
      const enlace = p.getByRole("link", { name: /cierre de la noche|reporte de la noche/i });
      const hayEnlace = await enlace.waitFor({ state: "visible", timeout: 30000 }).then(() => true, () => false);
      nota("caja: el cuadre de la noche enlaza al cierre", hayEnlace);
      if (hayEnlace) {
        await p.screenshot({ path: `${SHOTS}caja-cuadre-enlace-390.png` });
        await enlace.click();
        await p.waitForURL(/grupo\/noche/, { timeout: 30000 }).catch(() => {});
        nota("caja → cierre: llega con 'Volver' a la caja", p.url().includes("desde=caja") && (await p.getByRole("link", { name: "← Volver" }).getAttribute("href")) === "/staff/caja");
      }
      // Enlace desde /grupo.
      await p.goto(BASE + "/grupo");
      const deGrupo = p.getByRole("link", { name: /Cierre de la noche/ });
      const hayDeGrupo = await deGrupo.first().waitFor({ state: "visible", timeout: 60000 }).then(() => true, () => false);
      nota("/grupo: la tarjeta del antro enlaza al cierre", hayDeGrupo && (await deGrupo.first().getAttribute("href"))?.startsWith(`/grupo/noche?club=${CLUB}`));
      await p.screenshot({ path: `${SHOTS}grupo-enlace-cierre-390.png`, fullPage: true });
    }
    nota(`gerente ${w}: sin errores de consola ni HTTP`, errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ---------- Dueño y admin ----------
  for (const [rol, email, destino] of [["dueno", cred.usuarios.dueno, /dueno\/panel|grupo/], ["admin", cred.usuarios.admin, /admin/]]) {
    const { ctx, p, errores } = await sesion(email, destino);
    await abrir(p, `/grupo/noche?club=${CLUB}&fecha=${NOCHE}`);
    const t = await texto(p);
    const base = await reporteBase(email, NOCHE);
    nota(`${rol}: ve el cierre con el consumo de la base`, t.includes(pesos(base.consumo.total_centavos)));
    nota(`${rol}: puede elegir antro`, await p.locator("#cierre-antro").isVisible().catch(() => false));
    nota(`${rol}: sin scroll horizontal`, await sinScroll(p));
    await p.screenshot({ path: `${SHOTS}cierre-${rol}-25nov-390.png`, fullPage: true });
    nota(`${rol}: sin errores de consola ni HTTP`, errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ---------- Staff y RP: no ---------
  for (const [rol, email, destino] of [["staff", cred.usuarios.staff, /staff\/panel/], ["rp", "demo_mariana@example.com", /rp\/panel/]]) {
    const { ctx, p } = await sesion(email, destino);
    await p.goto(BASE + `/grupo/noche?club=${CLUB}&fecha=${NOCHE}`);
    await p.getByText("El cierre de la noche es para gerentes y dueños.").waitFor({ timeout: 60000 }).catch(() => {});
    const t = await texto(p);
    nota(`${rol}: no ve el reporte (aviso)`, t.includes("es para gerentes y dueños") && !t.includes("Comisiones y pagos"));
    if (rol === "staff") {
      await p.screenshot({ path: `${SHOTS}cierre-staff-sin-acceso-390.png` });
      await p.goto(BASE + "/staff/caja");
      await p.getByRole("button", { name: "Cuadre de la noche" }).click({ timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(1500);
      nota("staff: el cuadre de la caja no enlaza al cierre", !(await p.getByRole("link", { name: /cierre de la noche|reporte de la noche/i }).isVisible().catch(() => false)));
    }
    await ctx.close();
  }
} catch (e) {
  nota("error inesperado", false, e.message);
} finally {
  await navegador.close();
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
