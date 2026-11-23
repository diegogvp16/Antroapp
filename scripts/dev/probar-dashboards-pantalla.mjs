// /grupo en pantalla por rol (390 px): qué antros ve cada quien, que el
// consumo en pantalla sea el de la base y que el rendimiento por RP aparezca.
// Contra el servidor local de dev y las cuentas dev reales; solo lee.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-dashboards-pantalla.mjs [http://localhost:3001]

import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
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
const SHOTS = path.join(RAIZ, "screenshots-dashboards") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

const resultados = [];
function nota(texto, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}
// Igual que formatearCentavos de la app.
const pesos = (c) => "$" + (c / 100).toLocaleString("es-MX", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
// Semana operativa en curso (lunes a domingo, corte 08:00, hora de México): como rangoDeAtajo("semana").
function semana() {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
  const d = new Date(hoy + "T12:00:00Z");
  const lunes = new Date(d.getTime() - ((d.getUTCDay() || 7) - 1) * 86400e3);
  return { p_desde: lunes.toISOString().slice(0, 10), p_hasta: new Date(lunes.getTime() + 6 * 86400e3).toISOString().slice(0, 10) };
}

const CASOS = [
  ["gerente", ["Club Demo Dev"], ["Tijuana"]],
  ["dueno", ["Club Demo Dev", "Club Demo Dev Tijuana"], []],
  ["dueno_tijuana", ["Club Demo Dev Tijuana"], ["Club Demo Dev\n"]],
];

const navegador = await chromium.launch();
try {
  for (const [clave, ve, noVe] of CASOS) {
    const api = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await api.auth.signInWithPassword({ email: cred.usuarios[clave], password: cred.password });
    const { data: filas } = await api.rpc("grupo_resumen", semana());

    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    const errores = [];
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 120)));
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", cred.usuarios[clave]);
    await p.fill("#password", cred.password);
    await p.click("button[type=submit]");
    await p.waitForURL(/panel/, { timeout: 90000 });
    await p.goto(BASE + "/grupo");
    await p.getByText("Consumo en caja").first().waitFor({ timeout: 60000 });
    await p.waitForTimeout(1500);
    const texto = await p.locator("body").innerText();
    const titulos = await p.locator("[data-slot=card-title]").allInnerTexts();
    nota(`${clave}: ve ${ve.join(" y ")}`, ve.every((n) => titulos.includes(n)), titulos.join(" | "));
    nota(`${clave}: no ve otros antros`, noVe.every((n) => !titulos.some((t) => t.includes(n.trim()) && !ve.includes(t))), titulos.join(" | "));
    for (const f of filas ?? []) {
      nota(`${clave}: consumo de ${f.nombre} en pantalla = base (${pesos(Number(f.consumo_centavos))})`, texto.includes(pesos(Number(f.consumo_centavos))));
      // Con reservas que ya podían llegar hay %; sin ellas, "—".
      const ocurridas = Number(f.reservas) - Number(f.reservas_por_venir ?? 0);
      nota(`${clave}: conversión de ${f.nombre} visible`, ocurridas > 0 ? /\d+% de conversión/.test(texto) : /— de conversión/.test(texto));
    }
    // Rendimiento por RP: con datos, RPs con "consumieron (…)"; sin reservas
    // en la semana, el texto de vacío. Nunca "todavía no está disponible".
    const rendimiento = p.getByText(/consumieron \(|Ningún RP tuvo reservas/).first();
    if (ve.length > 1) await p.getByRole("button", { name: "Rendimiento por RP" }).first().click();
    await rendimiento.waitFor({ timeout: 20000 }).catch(() => {});
    nota(`${clave}: rendimiento por RP ${ve.length === 1 ? "abierto" : "se abre"}`, await rendimiento.isVisible().catch(() => false));
    const ancho = await p.evaluate(() => document.documentElement.scrollWidth);
    nota(`${clave}: sin scroll horizontal a 390 px`, ancho <= 390, `${ancho}px`);
    nota(`${clave}: sin errores de página`, errores.length === 0, errores.join(" | "));
    await p.screenshot({ path: SHOTS + `grupo-${clave}.png`, fullPage: true });
    await ctx.close();
  }
  // Staff: no entra.
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", cred.usuarios.staff);
  await p.fill("#password", cred.password);
  await p.click("button[type=submit]");
  await p.waitForURL(/staff\/panel/, { timeout: 90000 });
  await p.goto(BASE + "/grupo");
  await p.getByText("Esta vista es para dueños y gerentes.").waitFor({ timeout: 30000 }).then(
    () => nota("staff: /grupo le dice que es para dueños y gerentes", true),
    () => nota("staff: /grupo le dice que es para dueños y gerentes", false),
  );
  await ctx.close();
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  await navegador.close();
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exitCode = pasan === resultados.length ? 0 : 1;
