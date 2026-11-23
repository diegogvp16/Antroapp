// Video y capturas de respaldo para la junta (plan B de docs/guion-junta.md):
// recorre a 390 px la ficha del antro, el boleto, el panel del RP, la caja,
// una mesa, /grupo y la nómina, SIN escribir nada, y deja un .webm y las
// capturas en screenshots-junta/.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/video-junta.mjs [http://localhost:3001]
//
// Solo lectura: se dejan pasar el inicio de sesión y las funciones de
// lectura; cualquier otra escritura (insertar, actualizar, borrar, funciones
// de caja o de puerta) se aborta y se cuenta. Usa las cuentas de dev.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (!process.env.PLAYWRIGHT_DESDE) {
  console.log("Falta PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const BASE = process.argv[2] ?? "http://localhost:3001";
const DIR = path.join(RAIZ, "screenshots-junta");
mkdirSync(DIR, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: boleto } = await svc.from("reservations").select("qr_code").eq("club_id", CLUB).neq("status", "usada").not("qr_code", "is", null).limit(1).maybeSingle();

const LECTURAS = /\/rpc\/(grupo_resumen|grupo_rendimiento_rp|rp_mis_reservas|rp_progreso_cuota|nomina_semana|nomina_semana_mia|caja_mis_permisos|caja_tiene_permiso|club_fecha_operacion|caja_firma_noche|obtener_reserva_por_qr)$/;
let bloqueadas = 0;

const nav = await chromium.launch();
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, recordVideo: { dir: DIR, size: { width: 390, height: 844 } } });
await ctx.route("**/*", (route) => {
  const r = route.request();
  const m = r.method();
  const url = r.url();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.continue();
  if (/\/api\/auth\/login$|\/auth\/v1\/(token|logout)/.test(url) || LECTURAS.test(new URL(url).pathname)) return route.continue();
  bloqueadas++;
  return route.abort();
});
const p = await ctx.newPage();
const pausa = (ms = 1800) => p.waitForTimeout(ms);
const foto = (n) => p.screenshot({ path: path.join(DIR, n) });
async function entrar(usuario, destino) {
  await ctx.clearCookies();
  await p.goto(BASE + "/cliente/login");
  await p.evaluate(() => localStorage.clear());
  await p.fill("#email", usuario);
  await p.fill("#password", cred.password);
  await p.click("button[type=submit]");
  await p.waitForURL(destino, { timeout: 90000 });
}

try {
  // Cliente: ficha y boleto.
  await p.goto(`${BASE}/cliente/${CLUB}`);
  await pausa(2500);
  await foto("01-ficha.png");
  await p.mouse.wheel(0, 700);
  await pausa();
  if (boleto) {
    await p.goto(`${BASE}/r/${boleto.qr_code}`);
    await pausa(2500);
    await foto("02-boleto.png");
  }
  // RP.
  await entrar("demo_mariana@example.com", /rp\/panel/);
  await pausa(3000);
  await foto("03-rp-reservas.png");
  await p.getByRole("button", { name: "Nómina", exact: true }).click().catch(() => {});
  await pausa(2500);
  await foto("04-rp-nomina.png");
  // Staff: caja y una mesa.
  await entrar(cred.usuarios.staff, /staff\/panel/);
  await pausa(2000);
  await foto("05-staff-panel.png");
  await p.goto(BASE + "/staff/caja");
  await p.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 60000 });
  await pausa(2000);
  await foto("06-caja-mapa.png");
  await p.getByRole("button", { name: /^Mesa 1,/ }).click();
  await pausa(2500);
  await foto("07-caja-mesa.png");
  // Dueño de grupo: /grupo y nómina.
  await entrar(cred.usuarios.dueno, /dueno\/panel/);
  await p.goto(BASE + "/grupo");
  await p.getByText("Consumo en caja").first().waitFor({ timeout: 60000 });
  await pausa(2500);
  await foto("08-grupo.png");
  await p.getByRole("tab", { name: "Semana anterior" }).click().catch(() => {});
  await pausa(2500);
  await foto("09-grupo-semana-anterior.png");
  await p.getByRole("button", { name: "Rendimiento por RP" }).first().click().catch(() => {});
  await pausa(2500);
  await foto("10-grupo-rendimiento.png");
  await p.goto(BASE + "/dueno/nomina");
  await pausa(3000);
  await foto("11-nomina.png");
} finally {
  await ctx.close();
  await nav.close();
}
const video = readdirSync(DIR).filter((f) => f.endsWith(".webm")).map((f) => path.join(DIR, f)).sort().pop();
if (video) renameSync(video, path.join(DIR, "recorrido-junta.webm"));
console.log(`Listo: screenshots-junta/ (video y 11 capturas). Escrituras bloqueadas: ${bloqueadas}`);
