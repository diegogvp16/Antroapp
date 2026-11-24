// Capturas y revisión de pulido (bloque 9) a 390×844 y 1280×800, con
// sesiones reales de dev: contraste de texto (WCAG AA) y tamaño táctil.
//
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/capturas-post-junta.mjs [--base=http://localhost:3001] [--sufijo=apagadas]
//
// Capturas y resumen en screenshots-post-junta/<sufijo>/ (ignorada por Git).
// Solo lee: no guarda nada en la base.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const BASE = arg("base", "http://localhost:3001").replace(/\/$/, "");
const SALIDA = path.join(RAIZ, "screenshots-post-junta", arg("sufijo", "pulido"));
mkdirSync(SALIDA, { recursive: true });
if (!process.env.PLAYWRIGHT_DESDE) {
  console.log("Falta PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

const RECORRIDO = {
  anonimo: ["/", "/cliente", "/dueno/login", "/admin/login"],
  cliente: ["/cliente", "/cliente/perfil"],
  dueno: ["/dueno/panel", "/dueno/equipo", "/dueno/nomina", "/grupo"],
  admin: ["/admin", "/admin/alta-antro"],
  gerente: ["/staff/panel", "/staff/equipo", "/staff/nomina"],
  rp: ["/rp/panel"],
};
const TAMANOS = [
  [390, 844],
  [1280, 800],
];

// Corre en la página: contraste de cada texto visible contra su fondo
// efectivo y elementos táctiles de menos de 40 px de alto (a 390).
function revisarPagina(anchoMovil) {
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
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return rgba(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
  };
  const bajoContraste = [];
  const caminante = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const vistos = new Set();
  for (let n = caminante.nextNode(); n; n = caminante.nextNode()) {
    const el = n.parentElement;
    if (!el || vistos.has(el) || !n.textContent.trim()) continue;
    vistos.add(el);
    const cs = getComputedStyle(el);
    const caja = el.getBoundingClientRect();
    if (cs.visibility === "hidden" || cs.display === "none" || caja.width === 0 || caja.height === 0 || Number(cs.opacity) < 0.5) continue;
    if (el.closest("[disabled], [aria-disabled='true'], .sr-only")) continue;
    const c = rgba(cs.color);
    if (!c) continue;
    const f = fondo(el);
    const a = lum(c), b = lum(f);
    const razon = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const grande = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (razon < (grande ? 3 : 4.5)) bajoContraste.push(`${razon.toFixed(2)} «${n.textContent.trim().slice(0, 40)}»`);
  }
  const chicos = [];
  if (window.innerWidth <= anchoMovil) {
    for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]")) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // Controles ocultos a propósito (input de archivo de 1 px detrás de su botón).
      if (r.width <= 2 || r.height <= 2 || cs.visibility === "hidden") continue;
      // Enlaces dentro de un párrafo se miden por su línea; aquí solo controles sueltos.
      if (el.tagName === "A" && el.closest("p, li") && r.height < 40) continue;
      if (r.height < 40 && !(el.tagName === "INPUT" && ["checkbox", "radio"].includes(el.type))) chicos.push(`${Math.round(r.height)}px «${(el.innerText || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30)}»`);
    }
  }
  return { bajoContraste, chicos, desborde: document.documentElement.scrollWidth > window.innerWidth };
}

const browser = await chromium.launch();
const resumen = {};
try {
  for (const [rol, rutas] of Object.entries(RECORRIDO)) {
    for (const [w, h] of TAMANOS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
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
        const nombre = `${rol}${ruta.replace(/\//g, "_") || "_inicio"}-${w}`;
        await p.screenshot({ path: path.join(SALIDA, nombre + ".png"), fullPage: true });
        const r = await p.evaluate(revisarPagina, 400);
        resumen[nombre] = { url: p.url().replace(BASE, ""), ...r };
        const marca = r.desborde || r.bajoContraste.length || r.chicos.length ? "REVISAR" : "OK     ";
        console.log(`${marca} ${nombre.padEnd(34)} contraste<AA: ${r.bajoContraste.length}  táctil<40: ${r.chicos.length}${r.desborde ? "  DESBORDE" : ""}`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(path.join(SALIDA, "revision.json"), JSON.stringify(resumen, null, 2));
console.log(`\nCapturas y detalle en ${path.relative(RAIZ, SALIDA)}/ (revision.json).`);
