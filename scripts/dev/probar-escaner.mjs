// Escáner del QR y "Confirmar entrada" desde un celular en vertical
// (390×844), con cámara falsa en tres condiciones de luz: normal, poca luz y
// muy oscuro (menos contraste y con ruido). Contra el servidor local de dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright y qrcode> \
//     node scripts/dev/probar-escaner.mjs [http://localhost:3001]
//
// Crea sus propias reservas de esta noche en Club Demo Dev (no gasta las de
// la demo) y las borra al final. Capturas en screenshots-escaner/.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DESDE = process.env.PLAYWRIGHT_DESDE;
if (!DESDE) {
  console.log("Falta PLAYWRIGHT_DESDE (carpeta con node_modules/playwright y qrcode).");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(path.join(DESDE, "node_modules", "playwright", "index.mjs")).href);
const QRCode = createRequire(path.join(DESDE, "package.json"))("qrcode");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const BASE = process.argv[2] ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-escaner") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLUB = cred.clubs.demo;

// Video .y4m con el QR (Chrome lo repite como cámara). negro/blanco y ruido
// simulan la luz: con poca luz el QR se ve gris sobre gris y con grano.
function videoConQR(texto, ruta, { negro, blanco, ruido }) {
  const W = 640, H = 480, MOD = 6;
  const qr = QRCode.create(texto, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const lado = (n + 8) * MOD;
  const x0 = Math.floor((W - lado) / 2), y0 = Math.floor((H - lado) / 2);
  let semilla = 7;
  const azar = () => ((semilla = (semilla * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const cuadro = () => {
    const Y = Buffer.alloc(W * H, blanco);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      for (let dy = 0; dy < MOD; dy++) for (let dx = 0; dx < MOD; dx++) Y[(y0 + (r + 4) * MOD + dy) * W + (x0 + (c + 4) * MOD + dx)] = negro;
    }
    if (ruido) for (let i = 0; i < Y.length; i++) Y[i] = Math.max(0, Math.min(255, Y[i] + Math.round(azar() * ruido)));
    const UV = Buffer.alloc((W / 2) * (H / 2), 128);
    return Buffer.concat([Buffer.from("FRAME\n"), Y, UV, UV]);
  };
  writeFileSync(ruta, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), cuadro(), cuadro(), cuadro()]));
  return ruta;
}

const noche = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const LUCES = [
  { nombre: "normal", negro: 0, blanco: 255, ruido: 0 },
  { nombre: "poca-luz", negro: 45, blanco: 115, ruido: 18 },
  { nombre: "muy-oscuro", negro: 28, blanco: 62, ruido: 14 },
];
const creadas = [];
const resultados = [];
function nota(texto, ok, detalle = "") {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}

try {
  for (const luz of LUCES) {
    const r = { id: randomUUID(), cliente_nombre: `Prueba Escáner ${luz.nombre}`, cliente_telefono: "0000000999", personas: 2, status: "confirmada",
      source: "organica", club_id: CLUB, fecha: noche, qr_code: `antro-${randomUUID()}` };
    const ins = await svc.from("reservations").insert(r);
    if (ins.error) throw new Error("reserva: " + ins.error.message);
    creadas.push(r.id);
    const video = videoConQR(r.qr_code, path.join(SHOTS, `qr-${luz.nombre}.y4m`), luz);
    const nav = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`] });
    try {
      const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["camera"] });
      const p = await ctx.newPage();
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", cred.usuarios.staff);
      await p.fill("#password", cred.password);
      await p.click("button[type=submit]");
      await p.waitForURL(/staff\/panel/, { timeout: 90000 });
      await p.getByRole("button", { name: "Escanear QR" }).first().click();
      const t0 = Date.now();
      const leyo = await p.getByRole("button", { name: "Confirmar entrada" }).waitFor({ timeout: 25000 }).then(() => true, () => false);
      const segundos = ((Date.now() - t0) / 1000).toFixed(1);
      await p.screenshot({ path: SHOTS + `${luz.nombre}-1-escaneo.png` });
      nota(`${luz.nombre}: lee el QR en vertical`, leyo, leyo ? `${segundos} s` : "no lo leyó en 25 s");
      if (leyo) {
        const texto = await p.locator("body").innerText();
        nota(`${luz.nombre}: la ficha muestra al cliente y el aviso del QR`, texto.includes(r.cliente_nombre) && /no garantiza la entrada/i.test(texto));
        await p.getByRole("button", { name: "Confirmar entrada" }).click();
        await p.getByText(/Entrada confirmada|Sentar en mesa/).first().waitFor({ timeout: 20000 }).catch(() => {});
        const { data } = await svc.from("reservations").select("status, puerta_estado").eq("id", r.id).single();
        nota(`${luz.nombre}: "Confirmar entrada" deja la reserva como entró`, data?.status === "usada" && data?.puerta_estado === "entro", JSON.stringify(data));
        await p.screenshot({ path: SHOTS + `${luz.nombre}-2-confirmada.png` });
      } else {
        // Plan B: confirmar sin cámara desde la lista de la noche.
        await p.getByRole("button", { name: "Cerrar escáner" }).click().catch(() => {});
        const boton = p.locator("div", { hasText: r.cliente_nombre }).filter({ has: p.getByRole("button", { name: "Confirmar entrada sin cámara" }) }).last();
        const hay = await boton.getByRole("button", { name: "Confirmar entrada sin cámara" }).isVisible().catch(() => false);
        nota(`${luz.nombre}: plan B "Confirmar entrada sin cámara" disponible`, hay);
      }
      await ctx.close();
    } finally {
      await nav.close();
    }
  }
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  if (creadas.length) {
    const { error } = await svc.from("reservations").delete().in("id", creadas);
    console.log(error ? `No se pudieron borrar las reservas de prueba: ${error.message}` : `Reservas de prueba borradas: ${creadas.length}`);
  }
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exitCode = pasan === resultados.length ? 0 : 1;
