// Pantalla "Descargar reportes" (/staff/exportar, /dueno/exportar y
// /grupo/exportar) contra el servidor local de dev y antroapp-dev, con las
// cuentas dev_<rol>. Solo lee: no cambia datos.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-exportes-pantalla.mjs [http://localhost:3001]
//
// Revisa, a 390×844 y 360×740:
// - gerente: llega desde su panel, descarga los 4 CSV de la noche demo 25/11
//   de Club Demo Dev y cada archivo trae los MISMOS renglones y sumas que la
//   base (las funciones con su sesión) y que reporte_cierre_noche; el rango
//   "Este mes" = grupo_resumen; BOM, coma, CRLF, teléfono completo;
// - dueño: llega desde su panel; Club Demo Dev con teléfono completo y el
//   antro de su grupo (Tijuana, que no es suyo) sin teléfono;
// - admin: solo los últimos 4 dígitos;
// - staff y RP: el aviso, sin enlace en el panel del staff;
// - sin scroll horizontal, controles de al menos 40 px, sin errores.
// Las cifras esperadas se leen en una transacción READ ONLY con la sesión
// (request.jwt.claims) de cada usuario, sin iniciar sesión de más en Auth.
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
const CLUB = cred.clubs.demo;
const TIJUANA = cred.clubs.tijuana;
const NOCHE = "2026-11-25";

let pasan = 0, fallan = 0;
function nota(texto, ok, detalle = "") {
  if (ok) pasan++; else fallan++;
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${!ok && detalle ? "  — " + detalle : ""}`);
}

// ---------- Lo esperado, leído de la base con la sesión de cada quien ----------
const db = await conectarDevEscritura();
async function comoUsuario(email, fn) {
  const [u] = await db.q("select id from auth.users where email = $1", [email]);
  if (!u) throw new Error("no existe " + email);
  await db.q("begin transaction read only");
  try {
    await db.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.id, role: "authenticated" })]);
    return await fn();
  } finally {
    await db.q("rollback");
  }
}
async function filasBase(fn, club, desde, hasta) {
  const filas = [];
  let despues = null;
  for (;;) {
    const p = (await db.q(`select to_jsonb(t) j from public.${fn}($1, $2::date, $3::date, $4, 1000) t`, [club, desde, hasta, despues])).map((x) => x.j);
    filas.push(...p);
    if (p.length < 1000) return filas;
    despues = p[p.length - 1].orden;
  }
}
async function esperado(email, club, desde, hasta) {
  return comoUsuario(email, async () => {
    const reservas = await filasBase("reporte_reservas", club, desde, hasta);
    const consumos = await filasBase("reporte_consumos", club, desde, hasta);
    const comisiones = await filasBase("reporte_comisiones", club, desde, hasta);
    const rps = (await db.q("select to_jsonb(t) j from public.grupo_rendimiento_rp($1, $2::date, $3::date) t", [club, desde, hasta]))
      .map((x) => x.j).filter((f) => Number(f.reservas) > 0 || Number(f.comisiones_centavos) > 0);
    const cierre = desde === hasta ? (await db.q("select public.reporte_cierre_noche($1, $2::date) j", [club, desde]))[0].j : null;
    const [grupo] = (await db.q("select to_jsonb(t) j from public.grupo_resumen($1::date, $2::date) t", [desde, hasta])).map((x) => x.j).filter((g) => g.club_id === club);
    return { reservas, consumos, comisiones, rps, cierre, grupo };
  });
}
const sumaC = (filas, campo, filtro = () => true) => filas.filter(filtro).reduce((a, f) => a + Number(f[campo] ?? 0), 0);

// ---------- CSV ----------
function parsearCsv(texto) {
  const filas = [];
  let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\r" && texto[i + 1] === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; i++; }
    else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}
const aCentavos = (s) => Math.round(Number(s || 0) * 100);
function columna(filas, nombre) {
  const i = filas[0].indexOf(nombre);
  if (i < 0) throw new Error(`falta la columna "${nombre}" (${filas[0].join(" | ")})`);
  return filas.slice(1).map((f) => f[i]);
}

// ---------- Navegador ----------
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
async function esperarTarjetas(p) {
  await p.getByRole("heading", { name: "Descargar reportes" }).waitFor({ timeout: 60000 }).catch(() => {});
  await p.getByRole("button", { name: /Descargar CSV/ }).first().waitFor({ timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(500);
}
async function elegirAntro(p, club) {
  if (await p.locator("#exportar-antro").isVisible().catch(() => false)) {
    await p.selectOption("#exportar-antro", club);
    await p.waitForTimeout(300);
    await esperarTarjetas(p);
  }
}
async function elegirNoche(p, fecha) {
  await p.getByRole("tab", { name: "Una noche" }).click();
  await p.fill("#exportar-noche", fecha);
  await p.waitForTimeout(300);
}
const TITULOS = { reservas: "Reservas", consumos: "Consumo en caja", comisiones: "Comisiones y pagos a RPs", rps: "Rendimiento por RP" };
const tarjeta = (p, tipo) => p.locator('[data-slot="card"]').filter({ has: p.getByRole("heading", { name: TITULOS[tipo], exact: true }) });
async function descargar(p, tipo) {
  const t = tarjeta(p, tipo);
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 90000 }), t.getByRole("button", { name: /Descargar CSV/ }).click()]);
  const texto = readFileSync(await d.path(), "utf8");
  await t.getByText("Listo:").waitFor({ timeout: 30000 }).catch(() => {});
  return { nombre: d.suggestedFilename(), texto, filas: parsearCsv(texto.replace(/^﻿/, "")), aviso: await t.innerText() };
}
const sinScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const controlesBajos = (p) => p.evaluate(() => [...document.querySelectorAll("button, a, select, input")]
  .filter((e) => e.offsetParent !== null).map((e) => [e.textContent?.trim().slice(0, 24) || e.getAttribute("aria-label") || e.tagName, Math.round(e.getBoundingClientRect().height)])
  .filter(([, h]) => h < 40));
const pesosPantalla = (c) => {
  const n = Number(c) / 100;
  return Number.isInteger(n)
    ? new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n)
    : new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 }).format(n);
};

try {
  // ======================= Gerente =======================
  const eg = await esperado(cred.usuarios.gerente, CLUB, NOCHE, NOCHE);
  {
    const { ctx, p, errores } = await sesion(cred.usuarios.gerente, /staff\/panel/);
    const enlace = p.locator('a[href="/staff/exportar"]');
    nota("gerente: su panel enlaza a «Descargar reportes»", await enlace.waitFor({ timeout: 60000 }).then(() => true, () => false));
    await enlace.click();
    await p.waitForURL(/staff\/exportar/, { timeout: 60000 }).catch(() => {});
    await esperarTarjetas(p);
    nota("gerente: llega a /staff/exportar", p.url().includes("/staff/exportar"), p.url());
    const t0 = await p.locator("body").innerText();
    nota("gerente: le dice que verá el teléfono completo", t0.includes("con teléfono completo"));
    await elegirNoche(p, NOCHE);
    const t1 = await p.locator("body").innerText();
    nota("gerente: «Noche del …» y la zona del antro", /Noche del/.test(t1) && /Ciudad de México|Centro/.test(t1), t1.slice(0, 300));

    // Reservas
    const r = await descargar(p, "reservas");
    nota("reservas: nombre del archivo", r.nombre === `reservas-club-demo-dev-${NOCHE}.csv`, r.nombre);
    nota("reservas: BOM, coma y CRLF", r.texto.startsWith("﻿") && r.texto.includes("\r\n") && r.filas[0].length > 5);
    nota("reservas: un renglón por reserva = base", r.filas.length - 1 === eg.reservas.length, `${r.filas.length - 1} ≠ ${eg.reservas.length}`);
    nota("reservas: = reservas del cierre", r.filas.length - 1 === eg.cierre.reservas.reservas);
    const tel = columna(r.filas, "Teléfono");
    nota("reservas: teléfono completo (gerente)", tel.some((x) => /^\d{10}$/.test(x)) && tel.filter(Boolean).every((x) => !x.startsWith("***")));
    const consR = columna(r.filas, "Consumo").reduce((a, x) => a + aCentavos(x), 0);
    nota("reservas: consumo de las reservas = cierre (con reserva)", consR === Number(eg.cierre.reservas.consumo_centavos), `${consR} ≠ ${eg.cierre.reservas.consumo_centavos}`);
    nota("reservas: «Consumió» = consumieron del cierre", columna(r.filas, "Estado").filter((x) => x === "Consumió").length === eg.cierre.reservas.consumieron);
    nota("reservas: folio con #", columna(r.filas, "Folio").every((x) => /^#[0-9A-F]{8}$/.test(x)));
    nota("reservas: la pantalla dice cuántos renglones", r.aviso.includes(`Listo: ${eg.reservas.length.toLocaleString("es-MX")}`), r.aviso);

    // Consumo
    const k = await descargar(p, "consumos");
    nota("consumo: renglones = base (anulados incluidos)", k.filas.length - 1 === eg.consumos.length, `${k.filas.length - 1} ≠ ${eg.consumos.length}`);
    const anul = columna(k.filas, "Anulado");
    const montos = columna(k.filas, "Monto");
    const vig = montos.reduce((a, x, i) => a + (anul[i] === "No" ? aCentavos(x) : 0), 0);
    nota(`consumo: suma sin anulados = cierre (${pesosPantalla(eg.cierre.consumo.total_centavos)})`, vig === Number(eg.cierre.consumo.total_centavos), `${vig}`);
    nota("consumo: anulados = cierre", anul.filter((x) => x === "Sí").length === eg.cierre.anulaciones.consumos);
    nota("consumo: la pantalla muestra la suma del cierre", k.aviso.includes(pesosPantalla(eg.cierre.consumo.total_centavos)), k.aviso);
    nota("consumo: hora en formato AAAA-MM-DD HH:MM", columna(k.filas, "Hora (hora del antro)").every((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x)));

    // Comisiones
    const c = await descargar(p, "comisiones");
    nota("comisiones: renglones = base", c.filas.length - 1 === eg.comisiones.length, `${c.filas.length - 1} ≠ ${eg.comisiones.length}`);
    const est = columna(c.filas, "Estado");
    const sumCom = columna(c.filas, "Monto").reduce((a, x, i) => a + (est[i] !== "Anulada" ? aCentavos(x) : 0), 0);
    nota(`comisiones: suma vigente = cierre (${pesosPantalla(eg.cierre.comisiones.total_centavos)})`, sumCom === Number(eg.cierre.comisiones.total_centavos), `${sumCom}`);

    // Rendimiento por RP
    const rp = await descargar(p, "rps");
    nota("rendimiento por RP: una fila por RP = cierre", rp.filas.length - 1 === eg.cierre.rps.length, `${rp.filas.length - 1} ≠ ${eg.cierre.rps.length}`);
    const consRp = columna(rp.filas, "Consumo").reduce((a, x) => a + aCentavos(x), 0);
    nota("rendimiento por RP: consumo = suma de RPs del cierre", consRp === sumaC(eg.cierre.rps, "consumo_centavos"));
    nota("rendimiento por RP: sin teléfonos", !/\d{10}/.test(rp.texto));

    nota("gerente 390: sin scroll horizontal", await sinScroll(p));
    const bajos = await controlesBajos(p);
    nota("gerente 390: controles de al menos 40 px", bajos.length === 0, JSON.stringify(bajos));
    await p.screenshot({ path: `${SHOTS}exportar-gerente-25nov-390.png`, fullPage: true });

    // Rango: "Este mes"
    await p.getByRole("tab", { name: "Varias noches" }).click();
    await p.getByRole("tab", { name: "Este mes" }).click();
    await p.waitForTimeout(300);
    const km = await descargar(p, "consumos");
    const m = km.nombre.match(/^consumo-club-demo-dev-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/);
    nota("rango: nombre del archivo con inicio y fin", !!m, km.nombre);
    if (m) {
      const em = await esperado(cred.usuarios.gerente, CLUB, m[1], m[2]);
      const an = columna(km.filas, "Anulado");
      const v = columna(km.filas, "Monto").reduce((a, x, i) => a + (an[i] === "No" ? aCentavos(x) : 0), 0);
      nota(`rango ${m[1]}–${m[2]}: renglones = base`, km.filas.length - 1 === em.consumos.length);
      nota(`rango: consumo = /grupo (${pesosPantalla(em.grupo?.consumo_centavos)})`, v === Number(em.grupo?.consumo_centavos), `${v}`);
      const kr = await descargar(p, "reservas");
      nota("rango: reservas = /grupo", kr.filas.length - 1 === Number(em.grupo?.reservas), `${kr.filas.length - 1}`);
      const kc = await descargar(p, "comisiones");
      const ec = columna(kc.filas, "Estado");
      nota("rango: comisiones y pagos = /grupo", columna(kc.filas, "Monto").reduce((a, x, i) => a + (ec[i] !== "Anulada" ? aCentavos(x) : 0), 0) === Number(em.grupo?.comisiones_centavos));
    }
    await p.screenshot({ path: `${SHOTS}exportar-gerente-mes-390.png`, fullPage: true });

    // Personalizado de más de 93 días: aviso, sin descarga.
    await p.getByRole("tab", { name: "Personalizado" }).click();
    const fechas = p.locator('input[type="date"]');
    if ((await fechas.count()) >= 2) {
      await fechas.nth(0).fill("2026-01-01");
      await fechas.nth(1).fill("2026-11-25");
      await p.getByRole("button", { name: "Consultar" }).click();
      await p.waitForTimeout(500);
      const tt = await p.locator("body").innerText();
      nota("rango de más de 93 días: aviso en pantalla", /93 días/.test(tt), tt.slice(0, 200));
      // El selector no aplica el rango inválido: la etiqueta sigue con el anterior (no dice "enero").
      nota("rango de más de 93 días: no se aplica (la etiqueta no cambia a enero)", !/ene/i.test(await p.locator("p.tabular-nums").first().innerText()));
      const bajosR = await controlesBajos(p);
      nota("rango personalizado 390: controles de al menos 40 px", bajosR.length === 0, JSON.stringify(bajosR));
      await p.screenshot({ path: `${SHOTS}exportar-gerente-personalizado-390.png`, fullPage: true });
    } else nota("rango personalizado: dos fechas", false, String(await fechas.count()));

    // 360×740
    await p.setViewportSize({ width: 360, height: 740 });
    await elegirNoche(p, NOCHE);
    await descargar(p, "reservas");
    nota("gerente 360: sin scroll horizontal", await sinScroll(p));
    await p.screenshot({ path: `${SHOTS}exportar-gerente-25nov-360.png`, fullPage: true });
    nota("gerente: sin errores de consola ni HTTP", errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ======================= Dueño =======================
  {
    const ed = await esperado(cred.usuarios.dueno, CLUB, NOCHE, NOCHE);
    const { ctx, p, errores } = await sesion(cred.usuarios.dueno, /dueno\/panel/);
    const enlace = p.locator('a[href="/dueno/exportar"]');
    nota("dueño: su panel enlaza a «Descargar reportes (CSV)»", await enlace.waitFor({ timeout: 60000 }).then(() => true, () => false));
    await enlace.click();
    await p.waitForURL(/dueno\/exportar/, { timeout: 60000 }).catch(() => {});
    await esperarTarjetas(p);
    nota("dueño: elige entre sus antros", await p.locator("#exportar-antro").isVisible().catch(() => false));
    await elegirAntro(p, CLUB);
    await elegirNoche(p, NOCHE);
    const r = await descargar(p, "reservas");
    nota("dueño (su antro): teléfono completo", columna(r.filas, "Teléfono").some((x) => /^\d{10}$/.test(x)));
    nota("dueño: reservas = base", r.filas.length - 1 === ed.reservas.length);
    await p.screenshot({ path: `${SHOTS}exportar-dueno-390.png`, fullPage: true });
    // Tijuana: de su grupo, no suyo.
    const opciones = await p.locator("#exportar-antro option").evaluateAll((os) => os.map((o) => o.value));
    if (opciones.includes(TIJUANA)) {
      await elegirAntro(p, TIJUANA);
      const t = await p.locator("body").innerText();
      nota("dueño (antro de su grupo): le dice «sin teléfono»", t.includes("sin teléfono") && t.includes("Como dueño del grupo"), t.slice(0, 400));
      const et = await esperado(cred.usuarios.dueno, TIJUANA, "2026-11-01", "2026-11-30");
      await p.getByRole("tab", { name: "Varias noches" }).click();
      await p.getByRole("tab", { name: "Este mes" }).click();
      await p.waitForTimeout(300);
      if (et.reservas.length) {
        const rt = await descargar(p, "reservas");
        nota("dueño (grupo): el CSV no trae columna de teléfono", !rt.filas[0].some((x) => x.startsWith("Teléfono")) && !/\d{10}/.test(rt.texto), rt.filas[0].join("|"));
      } else {
        const t2 = tarjeta(p, "reservas");
        await t2.getByRole("button", { name: /Descargar CSV/ }).click();
        await t2.getByText(/No hay renglones/).waitFor({ timeout: 30000 }).catch(() => {});
        nota("dueño (grupo): sin reservas en el mes → «No hay renglones», sin descarga", (await t2.innerText()).includes("No hay renglones"));
      }
      await p.screenshot({ path: `${SHOTS}exportar-dueno-grupo-tijuana-390.png`, fullPage: true });
    } else nota("dueño: Tijuana aparece en su lista (grupo)", false, opciones.join(","));
    nota("dueño: sin errores de consola ni HTTP", errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ======================= Admin =======================
  {
    const { ctx, p, errores } = await sesion(cred.usuarios.admin, /admin/);
    await p.goto(BASE + "/grupo/exportar");
    await esperarTarjetas(p);
    await elegirAntro(p, CLUB);
    await elegirNoche(p, NOCHE);
    const r = await descargar(p, "reservas");
    const tel = columna(r.filas, "Teléfono (últimos 4)");
    nota("admin: solo los últimos 4 dígitos", tel.filter(Boolean).length > 0 && tel.filter(Boolean).every((x) => /^\*\*\*\d{4}$/.test(x)) && !/\d{10}/.test(r.texto));
    nota("admin: «← Volver» lleva a /admin", (await p.getByRole("link", { name: "← Volver" }).getAttribute("href")) === "/admin");
    await p.screenshot({ path: `${SHOTS}exportar-admin-390.png`, fullPage: true });
    nota("admin: sin errores de consola ni HTTP", errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ======================= Staff y RP: no =======================
  for (const [rol, email, destino, url] of [
    ["staff", cred.usuarios.staff, /staff\/panel/, "/staff/exportar"],
    ["rp", "demo_mariana@example.com", /rp\/panel/, "/dueno/exportar"],
  ]) {
    const { ctx, p } = await sesion(email, destino);
    if (rol === "staff") {
      await p.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
      await p.waitForTimeout(1500);
      nota("staff: su panel NO enlaza a «Descargar reportes»", !(await p.locator('a[href="/staff/exportar"]').isVisible().catch(() => false)));
    }
    await p.goto(BASE + url);
    await p.getByText("Descargar reportes es para gerentes y dueños.").waitFor({ timeout: 60000 }).catch(() => {});
    const t = await p.locator("body").innerText();
    nota(`${rol}: ve el aviso y ninguna descarga`, t.includes("es para gerentes y dueños") && !(await p.getByRole("button", { name: /Descargar CSV/ }).count()));
    await p.screenshot({ path: `${SHOTS}exportar-${rol}-sin-acceso-390.png` });
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
