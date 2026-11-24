// Pruebas de pantalla del panel del RP (rediseño) contra la app local que
// apunta a antroapp-dev (node scripts/dev/servidor-dev.mjs).
//
//   node scripts/dev/probar-rp-panel.mjs [URL]   (por defecto http://localhost:3001)
//
// Verifica con demo_mariana y demo_diego, a 390 y 360 px: los 4 estados por
// consumo, el detalle (línea de tiempo, comisión, "Escribirle"), la tarjeta de
// cuota, que no haya scroll horizontal ni textos viejos, y que la consulta
// no traiga reservas de otros RPs. Capturas en screenshots-rp-rediseno/.
// Requiere la noche demo: node scripts/demo-datos.mjs --env=.env.dev --si

import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
// Playwright no es dependencia del proyecto (descarga navegadores al
// instalarse y no hace falta en el build de Vercel): se toma del proyecto si
// está, o de la carpeta indicada en PLAYWRIGHT_DESDE.
async function cargarPlaywright() {
  try {
    return req("playwright");
  } catch {
    if (process.env.PLAYWRIGHT_DESDE) {
      const { pathToFileURL } = await import("node:url");
      return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    }
    console.log("Falta Playwright: npm i -g playwright && npx playwright install chromium, o define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
    process.exit(1);
  }
}
const { chromium } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv[2] ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-rp-rediseno") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const { password } = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const res = [];
const nota = (n, ok, d = "") => { res.push(ok); console.log(`${ok ? "PASA " : "FALLA"}  ${n}${d ? "  — " + d : ""}`); };
const errores = [];
const b = await chromium.launch();
const vistos = { consumio: false, llego_sin_consumo: false, no_llego: false, por_llegar: false };
const ETIQUETA = { consumio: "Consumió", llego_sin_consumo: "Llegó, sin consumo", no_llego: "No llegó", por_llegar: "Por llegar" };

try {
  for (const [usuario, ancho, alto] of [["demo_mariana", 390, 844], ["demo_mariana", 360, 740], ["demo_diego", 390, 844], ["demo_diego", 360, 740]]) {
    const email = `${usuario}@example.com`;
    const p = await (await b.newContext({ viewport: { width: ancho, height: alto } })).newPage();
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 160)));
    p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon/.test(m.text())) errores.push(m.text().slice(0, 160)); });
    p.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errores.push(`HTTP ${r.status()} ${r.url().slice(0, 100)}`); });
    // La consulta de reservas: que solo traiga las de este RP.
    const filasConsulta = [];
    p.on("response", async (r) => {
      if (r.url().includes("/rpc/rp_mis_reservas") && r.ok()) {
        try { filasConsulta.push(...(await r.json())); } catch { /* sin cuerpo */ }
      }
    });
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", email); await p.fill("#password", password);
    await p.click("button[type=submit]");
    await p.waitForURL(/rp\/panel/, { timeout: 90000 });
    await p.getByRole("tab", { name: "Esta semana" }).waitFor({ timeout: 60000 });
    await p.waitForTimeout(2000);
    const pre = `${SHOTS}${usuario}-${ancho}`;
    let t = await p.locator("body").innerText();
    await p.screenshot({ path: `${pre}-1-semana.png`, fullPage: true });
    nota(`${usuario} ${ancho}: sin "Ingresó / Confirmada / Pendiente"`, !/\bIngresó\b|\bConfirmada\b|\bPendiente\b(?! de)/.test(t.replace(/Pendiente:/g, "")));
    nota(`${usuario} ${ancho}: sin scroll horizontal`, (await p.evaluate(() => document.documentElement.scrollWidth)) <= ancho);
    const cuota = t.match(/Cuota alcanzada[^\n]*|\d+ de \d+[^\n]*reservas que consumen[^\n]*/)?.[0];
    nota(`${usuario} ${ancho}: tarjeta de cuota visible`, !!cuota, cuota ?? "no apareció");
    for (const [e, et] of Object.entries(ETIQUETA)) if (t.includes(et) && (await p.getByRole("button", { name: new RegExp(`, ${et}$`) }).count())) vistos[e] = true;

    // Mes: aparecen también los "No llegó".
    await p.getByRole("tab", { name: "Mes" }).click();
    await p.waitForTimeout(2500);
    t = await p.locator("body").innerText();
    await p.screenshot({ path: `${pre}-2-mes.png`, fullPage: true });
    for (const [e, et] of Object.entries(ETIQUETA)) if (await p.getByRole("button", { name: new RegExp(`, ${et}$`) }).count()) vistos[e] = true;
    // Filtro "No llegaron".
    await p.getByRole("tab", { name: "No llegaron" }).click();
    await p.waitForTimeout(500);
    const filasNoLlego = await p.locator("ul li button").allInnerTexts();
    nota(`${usuario} ${ancho}: filtro "No llegaron" solo muestra no llegadas`, filasNoLlego.length > 0 && filasNoLlego.every((x) => x.includes("No llegó")), `${filasNoLlego.length} filas`);
    await p.getByRole("tab", { name: "Todas" }).click();
    await p.waitForTimeout(300);

    // Detalle de una reserva que consumió.
    const consumio = p.getByRole("button", { name: /, Consumió$/ }).first();
    if (await consumio.count()) {
      await consumio.click();
      await p.waitForTimeout(800);
      const d = await p.locator("body").innerText();
      await p.screenshot({ path: `${pre}-3-detalle-consumio.png`, fullPage: true });
      nota(`${usuario} ${ancho}: detalle con línea de tiempo completa`, ["Reserva creada", "Llegó", "Ocupó la mesa", "Consumo registrado", "Mesa cuadrada"].every((x) => d.includes(x)));
      nota(`${usuario} ${ancho}: detalle con comisión y su estado`, d.includes("Mi comisión") && /Pendiente|En revisión|Validada|Pagada|Anulada|cuadre la mesa/.test(d));
      const wa = await p.getByRole("link", { name: "Escribirle" }).getAttribute("href").catch(() => null);
      nota(`${usuario} ${ancho}: botón "Escribirle" por WhatsApp`, !!wa && wa.startsWith("https://wa.me/52"), wa ?? "sin enlace");
      const alto = await p.getByRole("link", { name: "Escribirle" }).boundingBox();
      nota(`${usuario} ${ancho}: botón ≥ 44 px`, (alto?.height ?? 0) >= 44, `${alto?.height}px`);
      await p.getByRole("button", { name: "Volver a mis reservas" }).click();
      await p.waitForTimeout(500);
    }

    // Seguridad: la consulta solo trae reservas de este RP.
    const { data: perfil } = await svc.from("profiles").select("id").eq("id", (await svc.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email).id).single();
    const ids = [...new Set(filasConsulta.map((f) => f.reservation_id))];
    const { data: dueños } = ids.length ? await svc.from("reservations").select("id, rp_id").in("id", ids) : { data: [] };
    nota(`${usuario} ${ancho}: la consulta no trae reservas de otros RPs`, ids.length > 0 && dueños.every((r) => r.rp_id === perfil.id), `${ids.length} reservas, ${dueños.filter((r) => r.rp_id !== perfil.id).length} ajenas`);
    await p.close();
  }
  for (const [e, et] of Object.entries(ETIQUETA)) nota(`estado "${et}" aparece en el demo`, vistos[e]);
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  await b.close();
  console.log("Errores consola/red:", errores.length ? [...new Set(errores)].join(" | ") : "ninguno");
  const f = res.filter((x) => !x).length;
  console.log(`Resultado: ${res.length - f}/${res.length} pasan`);
  if (f) process.exitCode = 1;
}
