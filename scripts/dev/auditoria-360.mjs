// SOLO DEV. Auditoría de accesibilidad en el teléfono apretado (C6): 360×740,
// táctil, con sesiones reales de cada rol. Solo lee: no guarda nada en la base
// (los clics son solo en pestañas).
//
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/auditoria-360.mjs [--base=http://localhost:3031] [--solo=rp,staff]
//
// En cada pantalla (y en cada pestaña de las pantallas con pestañas) revisa:
//   desborde    la página se mueve de lado (y qué elemento se sale)
//   táctil      botones, enlaces y campos de menos de 40 px de alto, o de
//               menos de 40 px de ancho cuando son solo un ícono
//   contraste   texto por debajo de WCAG AA (4.5:1; 3:1 si es grande)
//   etiqueta    campos sin etiqueta (label, aria-label o aria-labelledby)
//   nombre      botones o enlaces sin nombre accesible (ícono sin aria-label)
//   alt         imágenes sin texto alternativo (alt="" vale si es decorativa)
//   corte       texto cortado sin puntos suspensivos (se sale de su caja)
// Capturas y detalle en screenshots-a11y-360/ (ignorada por Git: /screenshots-*/).
// Sale con código 1 si hay hallazgos.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const BASE = arg("base", "http://localhost:3031").replace(/\/$/, "");
const SOLO = arg("solo", "") ? arg("solo", "").split(",") : null;
const SALIDA = path.join(RAIZ, "screenshots-a11y-360");
mkdirSync(SALIDA, { recursive: true });
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("--base debe ser un servidor local contra dev");
if (!process.env.PLAYWRIGHT_DESDE) { console.log("Falta PLAYWRIGHT_DESDE (carpeta con node_modules/playwright)."); process.exit(1); }
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;

// Un boleto real de Club Demo Dev para /r/<código> (solo lectura).
const db = await conectarDevEscritura();
let qr = null;
try { qr = (await db.q(`select qr_code from public.reservations where club_id = $1 and qr_code is not null order by fecha desc limit 1`, [CLUB]))[0]?.qr_code ?? null; } finally { await db.fin(); }

const RECORRIDO = {
  anonimo: ["/", "/cliente/login", "/cliente/signup", "/dueno/login", "/dueno/signup", "/admin/login", "/acceso-negocios", "/recuperar-contrasena", `/cliente/reservar?club=${CLUB}`, ...(qr ? [`/r/${qr}`] : [])],
  cliente: ["/cliente", `/cliente/${CLUB}`, `/cliente/reservar?club=${CLUB}`, "/cliente/perfil"],
  rp: ["/rp/panel"],
  staff: ["/staff/panel", "/staff/caja", "/staff/equipo"],
  gerente: ["/staff/panel", "/staff/caja", "/staff/equipo", "/staff/nomina", "/staff/exportar"],
  dueno: ["/dueno/panel", "/dueno/equipo", "/dueno/nomina", "/dueno/exportar", "/grupo", "/grupo/configuracion", "/grupo/noche", "/grupo/exportar"],
  admin: ["/admin", "/admin/alta-antro", `/admin/alta-antro?desde=${CLUB}`, "/admin/correos", "/admin/salud"],
};

function revisarPagina() {
  const rgba = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const fondo = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // foto o degradado: no se puede medir
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return rgba(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // Lo de un <details> cerrado (fuera de su <summary>) no se ve, aunque
    // Chromium le dé tamaño.
    const cerrado = el.closest("details:not([open])");
    if (cerrado && !el.closest("summary")) return false;
    return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[aria-hidden='true'], [hidden]");
  };
  const nombreDe = (el) => {
    const etiquetado = el.getAttribute("aria-labelledby");
    const porId = etiquetado ? etiquetado.split(/\s+/).map((i) => document.getElementById(i)?.innerText ?? "").join(" ") : "";
    return (el.getAttribute("aria-label") || porId || el.innerText || el.textContent || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || el.value || "").trim();
  };
  const corto = (s) => s.replace(/\s+/g, " ").trim().slice(0, 40);
  const h = { desborde: [], tactil: [], contraste: [], etiqueta: [], nombre: [], alt: [], corte: [] };

  const ancho = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > ancho + 1) {
    const culpables = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.right > ancho + 1 && r.width > 0 && visible(el)) {
        // Solo el más externo de cada rama que se sale (y que no esté dentro de algo con scroll propio).
        let p = el.parentElement, dentroDeScroll = false;
        for (; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === "auto" || ox === "scroll" || ox === "hidden") { dentroDeScroll = true; break; } }
        if (dentroDeScroll) continue;
        if (el.parentElement && el.parentElement.getBoundingClientRect().right > ancho + 1 && el.parentElement !== document.body) continue;
        culpables.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 3).join(".") : ""} (${Math.round(r.right - ancho)} px de más) «${corto(el.innerText || "")}»`);
      }
    }
    h.desborde.push(`scrollWidth ${document.documentElement.scrollWidth} > ${ancho}` + (culpables.length ? ": " + culpables.slice(0, 4).join(" · ") : ""));
  }

  const caminante = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const vistos = new Set();
  for (let n = caminante.nextNode(); n; n = caminante.nextNode()) {
    const el = n.parentElement;
    if (!el || vistos.has(el) || !n.textContent.trim()) continue;
    vistos.add(el);
    const cs = getComputedStyle(el);
    if (!visible(el) || Number(cs.opacity) < 0.5) continue;
    if (el.closest("[disabled], [aria-disabled='true'], .sr-only, svg")) continue;
    const c = rgba(cs.color);
    const f = fondo(el);
    if (!c || !f) continue;
    const a = lum(c), b = lum(f);
    const razon = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const grande = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (razon < (grande ? 3 : 4.5)) h.contraste.push(`${razon.toFixed(2)}:1 «${corto(n.textContent)}»`);
    // Texto cortado: se sale de su caja sin puntos suspensivos y sin scroll.
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow === "hidden" && cs.textOverflow !== "ellipsis" && el.children.length === 0) h.corte.push(`«${corto(n.textContent)}»`);
  }

  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const tipo = el.tagName === "INPUT" ? el.type : "";
    const nombre = nombreDe(el);
    // Enlaces dentro de un párrafo se miden por su línea.
    const enTexto = el.tagName === "A" && el.closest("p, li");
    const casilla = ["checkbox", "radio"].includes(tipo) || ["checkbox", "switch"].includes(el.getAttribute("role"));
    if (!enTexto && !casilla && r.height < 40) h.tactil.push(`${Math.round(r.width)}×${Math.round(r.height)} «${corto(nombre || el.tagName)}»`);
    else if (!enTexto && !casilla && r.width < 40 && !(el.innerText || "").trim()) h.tactil.push(`${Math.round(r.width)}×${Math.round(r.height)} (ícono) «${corto(nombre || el.tagName)}»`);
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && !["submit", "button", "reset", "image"].includes(tipo)) {
      const conLabel = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      if (!conLabel) h.etiqueta.push(`${el.tagName.toLowerCase()}${tipo ? "[" + tipo + "]" : ""}${el.name ? " name=" + el.name : ""}${el.placeholder ? " «" + corto(el.placeholder) + "»" : ""}`);
    } else if (!nombre) h.nombre.push(`${el.tagName.toLowerCase()}${el.getAttribute("href") ? " href=" + el.getAttribute("href").slice(0, 40) : ""}`);
  }
  for (const img of document.querySelectorAll("img")) if (visible(img) && !img.hasAttribute("alt")) h.alt.push(img.getAttribute("src")?.slice(-50) ?? "img");
  for (const k of Object.keys(h)) h[k] = [...new Set(h[k])];
  return h;
}

const browser = await chromium.launch();
const resumen = {};
let total = 0;
try {
  for (const [rol, rutas] of Object.entries(RECORRIDO)) {
    if (SOLO && !SOLO.includes(rol)) continue;
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    if (rol !== "anonimo") {
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", cred.usuarios[rol]);
      await p.fill("#password", cred.password);
      await p.click("button[type=submit]");
      await p.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 90_000 });
    }
    for (const ruta of rutas) {
      await p.goto(BASE + ruta, { waitUntil: "networkidle", timeout: 120_000 }).catch(() => {});
      await p.waitForTimeout(1500);
      const estados = [{ nombre: "", accion: null }];
      const pestanas = await p.locator("[role=tab]").allInnerTexts().catch(() => []);
      for (const t of pestanas.map((x) => x.trim()).filter(Boolean).slice(1)) estados.push({ nombre: t, accion: t });
      for (const est of estados) {
        if (est.accion) { await p.getByRole("tab", { name: est.accion, exact: true }).first().click().catch(() => {}); await p.waitForTimeout(1200); }
        const clave = `${rol} ${ruta.replace(CLUB, "<club>").replace(qr ?? "§", "<qr>")}${est.nombre ? " [" + est.nombre + "]" : ""}`;
        const archivo = clave.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 90);
        await p.screenshot({ path: path.join(SALIDA, archivo + ".png"), fullPage: true });
        const r = await p.evaluate(revisarPagina);
        const n = Object.values(r).reduce((s, v) => s + v.length, 0);
        total += n;
        resumen[clave] = { url: p.url().replace(BASE, "").replace(CLUB, "<club>").replace(qr ?? "§", "<qr>"), captura: archivo + ".png", ...r };
        const partes = Object.entries(r).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.length}`);
        console.log(`${n ? "REVISAR" : "OK     "} ${clave.padEnd(58)} ${partes.join(" · ")}`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(path.join(SALIDA, "auditoria.json"), JSON.stringify(resumen, null, 2));
console.log(`\n${Object.keys(resumen).length} pantallas, ${total} hallazgos. Detalle en ${path.relative(RAIZ, SALIDA)}/auditoria.json`);
process.exit(total ? 1 : 0);
