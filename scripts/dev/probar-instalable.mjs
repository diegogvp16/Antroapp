// App instalable y uso en celular, en el navegador (390 px):
//   * Cada área declara su manifest (cliente, Staff, RP, Dueño) y Chrome no
//     reporta errores de instalación (Page.getInstallabilityErrors).
//   * En modo instalado (display-mode: standalone) /staff y /rp cargan bien.
//   * Sin red, una navegación muestra la página propia "Sin conexión".
//   * El RP crea una reserva: el enlace de WhatsApp va al teléfono del
//     cliente, con fecha legible y el aviso del QR; ese enlace abre el boleto
//     desde un iPhone sin sesión. La reserva de prueba se borra al final.
// Contra un build de producción conectado a dev (scripts/dev/servidor-prod-dev.mjs,
// puerto 3002): el service worker y el manifest se comportan como en Vercel.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-instalable.mjs [http://localhost:3002]

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
const { chromium, devices } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv[2] ?? "http://localhost:3002";
const SHOTS = path.join(RAIZ, "screenshots-instalable") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const resultados = [];
function nota(texto, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}
async function entrar(p, clave, destino) {
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", cred.usuarios[clave]);
  await p.fill("#password", cred.password);
  await p.click("button[type=submit]");
  await p.waitForURL(destino, { timeout: 90000 });
}

const navegador = await chromium.launch();
let qrPrueba = null;
try {
  // ---------- Service worker: cabeceras y contenido (noche 4, bloque 2) ----------
  // El navegador revisa sw.js en cada visita solo si no lo guarda en caché
  // HTTP: así una versión nueva entra sin esperar. Y el SW no guarda nada
  // con datos: ni páginas, ni /api, ni Supabase.
  {
    const r = await fetch(BASE + "/sw.js");
    const cuerpo = await r.text();
    const cc = r.headers.get("cache-control") ?? "";
    nota("sw.js no se guarda en la caché HTTP", /max-age=0|no-cache|no-store/.test(cc), cc);
    nota("sw.js: solo intercepta navegaciones y solo guarda /offline.html",
      /request\.mode !== "navigate"/.test(cuerpo) && /cache\.add\(new Request\(OFFLINE/.test(cuerpo) && !/cache\.put\(/.test(cuerpo));
    nota("sw.js: al activarse borra las cachés de versiones anteriores", /caches\.delete/.test(cuerpo) && /skipWaiting/.test(cuerpo) && /clients\.claim/.test(cuerpo));
    for (const m of ["/manifest.webmanifest", "/staff.webmanifest", "/rp.webmanifest", "/dueno.webmanifest"]) {
      const j = await (await fetch(BASE + m)).json();
      const dentro = new URL(j.start_url, BASE).pathname.startsWith(new URL(j.scope, BASE).pathname);
      nota(`${m}: start_url dentro del scope y lang es-MX`, dentro && j.lang === "es-MX", `${j.start_url} en ${j.scope}`);
    }
    const html = await (await fetch(BASE + "/")).text();
    nota('la app declara lang="es-MX"', /<html[^>]*lang="es-MX"/.test(html));
  }

  // ---------- Manifest e instalabilidad por área ----------
  const AREAS = [
    [null, "/", "/manifest.webmanifest", "AntroApp", "/"],
    ["staff", "/staff/panel", "/staff.webmanifest", "AntroApp Staff", "/staff/panel"],
    ["rp", "/rp/panel", "/rp.webmanifest", "AntroApp RP", "/rp/panel"],
    ["dueno", "/dueno/panel", "/dueno.webmanifest", "AntroApp Dueño", "/dueno/panel"],
  ];
  for (const [clave, ruta, manifest, nombre, inicio] of AREAS) {
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    if (clave) await entrar(p, clave, new RegExp(ruta.replace(/\//g, "\\/")));
    else await p.goto(BASE + ruta);
    await p.waitForLoadState("networkidle").catch(() => {});
    const cdp = await ctx.newCDPSession(p);
    const m = await cdp.send("Page.getAppManifest");
    const datos = m.data ? JSON.parse(m.data) : {};
    nota(`${ruta}: usa ${manifest}`, m.url.endsWith(manifest), m.url);
    nota(`${ruta}: "${nombre}" abre en ${inicio}`, datos.name === nombre && datos.start_url === inicio && datos.display === "standalone", `${datos.name} · ${datos.start_url} · ${datos.display}`);
    nota(`${ruta}: manifest sin errores`, (m.errors ?? []).length === 0, (m.errors ?? []).map((e) => e.message).join(" | "));
    // Chrome necesita el service worker activo para evaluar todo.
    await p.evaluate(() => navigator.serviceWorker?.ready).catch(() => {});
    const inst = await cdp.send("Page.getInstallabilityErrors");
    const errs = (inst.installabilityErrors ?? []).map((e) => e.errorId);
    nota(`${ruta}: instalable (sin errores de Chrome)`, errs.length === 0, errs.join(", "));
    const iconos = await Promise.all((datos.icons ?? []).map((i) => p.request.get(new URL(i.src, BASE).href).then((r) => r.status())));
    nota(`${ruta}: iconos del manifest existen (${iconos.length})`, iconos.length >= 3 && iconos.every((s) => s === 200), iconos.join(","));

    if (clave === "staff" || clave === "rp") {
      // Modo instalado: sin barra del navegador.
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] });
      await p.reload();
      await p.waitForLoadState("networkidle").catch(() => {});
      // Este Chromium no emula display-mode (CDP lo ignora): se revisa que la
      // pantalla cargue con la emulación pedida; en el teléfono se probó a mano.
      await p.waitForTimeout(1500);
      const texto = await p.locator("body").innerText();
      nota(`${ruta}: carga (modo instalado pedido)`, !/Application error|Algo salió mal/.test(texto) && texto.length > 50);
      await p.screenshot({ path: SHOTS + `${clave}-instalada.png` });
      if (clave === "staff") {
        await p.goto(BASE + "/staff/caja");
        await p.getByText(/Noche/).first().waitFor({ timeout: 30000 }).catch(() => {});
        nota("/staff/caja: carga en modo instalado", await p.getByText(/Noche/).first().isVisible().catch(() => false));
        // Sin red: navegación -> página propia.
        await ctx.setOffline(true);
        await p.goto(BASE + "/staff/panel").catch(() => {});
        const sinRed = await p.getByRole("heading", { name: "Sin conexión" }).isVisible().catch(() => false);
        nota("sin red: abrir una pantalla muestra 'Sin conexión' (no el error del navegador)", sinRed);
        await p.screenshot({ path: SHOTS + "sin-conexion.png" });
        await ctx.setOffline(false);
        // El service worker no guarda páginas ni datos: solo offline.html.
        const cacheado = await p.evaluate(async () => {
          const out = [];
          for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname);
          return out;
        });
        nota("el service worker solo guarda /offline.html", cacheado.length === 1 && cacheado[0] === "/offline.html", cacheado.join(", "));
      }
    }
    await ctx.close();
  }

  // ---------- WhatsApp del RP ----------
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await entrar(p, "rp", /rp\/panel/);
  await p.getByRole("button", { name: "+ Nueva reserva" }).click();
  const manana = new Date(Date.now() + 30 * 3600e3).toISOString().slice(0, 10);
  await p.fill("#cliente_nombre", "Prueba WhatsApp Instalable");
  await p.fill("#cliente_telefono", "55 1234 5678");
  await p.fill("#fecha", manana);
  await p.getByRole("button", { name: "Crear reserva" }).click();
  // Es un <a> con rol de botón (Base UI): se busca por texto.
  const enlace = p.locator("a", { hasText: "Compartir por WhatsApp" });
  await enlace.waitFor({ timeout: 30000 });
  const href = await enlace.getAttribute("href");
  const url = new URL(href);
  const texto = url.searchParams.get("text") ?? "";
  qrPrueba = (texto.match(/\/r\/(antro-[\w-]+)/) ?? [])[1] ?? null;
  console.log("\nMensaje:\n" + texto.split("\n").map((l) => "  | " + l).join("\n"));
  nota("WhatsApp va directo al teléfono del cliente (+52)", url.pathname === "/525512345678");
  nota("el mensaje trae la fecha legible (no AAAA-MM-DD)", !/\d{4}-\d{2}-\d{2}/.test(texto) && /de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/.test(texto));
  nota("el mensaje avisa que el QR no garantiza la entrada", /no garantiza la entrada/.test(texto));
  nota("el mensaje es corto (≤ 400 caracteres)", texto.length <= 400, `${texto.length}`);
  nota("la tarjeta del RP también muestra el aviso", await p.getByText(/no garantiza la entrada/).first().isVisible());
  await p.getByText("Prueba WhatsApp Instalable").nth(1).waitFor({ timeout: 15000 }).catch(() => {});
  nota("la lista de reservas ya incluye la recién creada", (await p.getByText("Prueba WhatsApp Instalable").count()) >= 2);
  await p.screenshot({ path: SHOTS + "rp-reserva-creada.png", fullPage: true });
  await ctx.close();

  // El enlace abre el boleto desde un iPhone, sin sesión.
  const enlaceQr = (texto.match(/https?:\/\/\S+\/r\/antro-[\w-]+/) ?? [])[0];
  const iphone = await navegador.newContext({ ...devices["iPhone 13"] });
  const pi = await iphone.newPage();
  await pi.goto(enlaceQr);
  await pi.getByText("Prueba WhatsApp Instalable").waitFor({ timeout: 30000 }).catch(() => {});
  const boleto = await pi.locator("body").innerText();
  nota("el enlace abre el boleto en iPhone sin sesión", boleto.includes("Prueba WhatsApp Instalable") && (await pi.locator("svg").count()) > 0);
  nota("el boleto muestra el aviso y la fecha legible", /no garantiza (la entrada|el acceso)/.test(boleto) && !/\d{4}-\d{2}-\d{2}/.test(boleto));
  nota("el boleto no muestra el teléfono", !/5512345678|55 1234 5678/.test(boleto));
  await pi.screenshot({ path: SHOTS + "boleto-iphone.png", fullPage: true });
  await iphone.close();
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  await navegador.close();
  // Por nombre (único de esta prueba): se borra aunque la prueba falle antes de leer el QR.
  const { data: borradas, error } = await svc.from("reservations").delete().eq("cliente_nombre", "Prueba WhatsApp Instalable").select("id");
  console.log(error ? `No se pudo borrar la reserva de prueba: ${error.message}` : `Reservas de prueba borradas: ${borradas?.length ?? 0}`);
  void qrPrueba;
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exitCode = pasan === resultados.length ? 0 : 1;
