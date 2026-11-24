// Recorrido de los 6 roles a 390 px contra el servidor local de dev
// (node scripts/dev/servidor-dev.mjs) y la base antroapp-dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/recorrido-roles.mjs [http://localhost:3001]
//
// Por cada pantalla revisa: carga sin error de la app, sin scroll
// horizontal, sin errores de consola ni respuestas 4xx/5xx, y guarda una
// captura en screenshots-recorrido-roles/ (ignorada por Git).

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
async function cargarPlaywright() {
  try {
    return req("playwright");
  } catch {
    if (process.env.PLAYWRIGHT_DESDE) {
      const { pathToFileURL } = await import("node:url");
      return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    }
    console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
    process.exit(1);
  }
}
const { chromium } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3001";
// --banderas: el servidor se levantó con las banderas encendidas (CAPTCHA con
// llaves de prueba, legales, mensualidad y fase 2): espera la casilla del
// CAPTCHA, acepta los legales en la primera entrada si se piden y recorre
// también las pantallas que solo existen con bandera.
const BANDERAS = process.argv.includes("--banderas");
const SHOTS = path.join(RAIZ, "screenshots-recorrido-roles") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: unaReserva } = await svc.from("reservations").select("qr_code").eq("club_id", CLUB).not("qr_code", "is", null).limit(1).maybeSingle();

// Rol → [usuario o null (sin sesión), pantallas, URL esperada tras el login].
const ROLES = [
  ["anonimo", null, ["/", "/cliente", `/cliente/${CLUB}`, "/acceso-negocios", "/cliente/login", "/cliente/signup", "/dueno/signup", ...(unaReserva ? [`/r/${unaReserva.qr_code}`] : []), ...(BANDERAS ? ["/terminos", "/privacidad"] : [])]],
  ["cliente", cred.usuarios.cliente, ["/cliente", `/cliente/${CLUB}`, `/cliente/reservar?club=${CLUB}`, "/cliente/perfil"], /\/cliente$/],
  ["rp", "demo_mariana@example.com", ["/rp/panel"], /rp\/panel/],
  ["staff", cred.usuarios.staff, ["/staff/panel", "/staff/caja", "/staff/nomina"], /staff\/panel/],
  ["gerente", cred.usuarios.gerente, ["/staff/panel", "/staff/caja", "/staff/nomina", "/staff/equipo", ...(BANDERAS ? ["/staff/catalogo"] : [])], /staff\/panel/],
  ["dueno", cred.usuarios.dueno, ["/dueno/panel", "/dueno/nomina", "/grupo", "/dueno/equipo", ...(BANDERAS ? ["/dueno/mensualidad"] : [])], /dueno\/panel/],
  ["admin", cred.usuarios.admin, ["/admin", "/admin/alta-antro", ...(BANDERAS ? ["/admin/mensualidad"] : [])], /admin/],
];
// Pestañas del panel del RP (cada una es una pantalla).
const PESTANAS_RP = ["Perfil", "Reservas", "Turnos", "Nómina"];

const resultados = [];
function nota(texto, ok, detalle = "") {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}

const navegador = await chromium.launch();
try {
  for (const [rol, email, pantallas, destino] of ROLES) {
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    let errores = [];
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
    p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon/.test(m.text())) errores.push(m.text().slice(0, 140)); });
    p.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errores.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });

    if (email) {
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", email);
      await p.fill("#password", cred.password);
      if (BANDERAS) {
        // La casilla de Turnstile (llave de prueba: se resuelve sola) da su token.
        await p.waitForFunction(() => { try { return !!window.turnstile?.getResponse(); } catch { return false; } }, null, { timeout: 30000 }).catch(() => {});
      }
      await p.click("button[type=submit]");
      await p.waitForURL(destino, { timeout: 90000 }).catch(() => {});
      nota(`${rol}: inicia sesión`, destino.test(new URL(p.url()).pathname), new URL(p.url()).pathname);
      // Legales: primera entrada del RP con la bandera encendida.
      if (BANDERAS && rol === "rp" && (await p.getByText("Antes de empezar").waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false))) {
        await p.check("#acepto-rp");
        await p.getByRole("button", { name: "Aceptar y continuar" }).click();
        nota("rp: acepta términos y aviso en su primera entrada", await p.getByText("Antes de empezar").waitFor({ state: "hidden", timeout: 15000 }).then(() => true, () => false));
      }
    }

    const revisar = async (nombre) => {
      await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(1200);
      const texto = await p.locator("body").innerText();
      const ancho = await p.evaluate(() => document.documentElement.scrollWidth);
      const caida = /Application error|Algo salió mal|Unhandled Runtime Error/.test(texto);
      const archivo = `${rol}-${nombre.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "inicio"}.png`;
      await p.screenshot({ path: SHOTS + archivo, fullPage: true });
      const ok = !caida && ancho <= 390 && errores.length === 0;
      nota(`${rol} ${nombre}`, ok, [caida && "pantalla de error", ancho > 390 && `scroll horizontal ${ancho}px`, ...errores].filter(Boolean).join(" | "));
      errores = [];
    };

    for (const ruta of pantallas) {
      await p.goto(BASE + ruta);
      if (rol === "rp") {
        for (const pestana of PESTANAS_RP) {
          await p.getByRole("tab", { name: pestana }).or(p.getByRole("button", { name: pestana, exact: true })).first().click().catch(() => {});
          await revisar(`${ruta} ${pestana}`);
        }
      } else {
        await revisar(ruta);
      }
    }
    await ctx.close();
  }
} finally {
  await navegador.close();
}

const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exit(pasan === resultados.length ? 0 : 1);
