// Capturas del comparativo de temas (bloque 4): /staff/nomina, /grupo y
// /dueno/nomina en el tema actual, la variante oscura y la clara, a 390 y
// 1280 px. Usa ?tema= (solo fuera de producción; ver components/tema-reportes.tsx).
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/capturas-temas.mjs [http://localhost:3001]
//
// Escribe en screenshots-temas/<pantalla>-<tema>-<ancho>.png (fuera de Git).

import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

verificarEnvDev();
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
const BASE = process.argv[2] ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-temas") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

const PANTALLAS = [
  ["staff-nomina", "/staff/nomina", "gerente", /staff\/panel/],
  ["grupo", "/grupo", "dueno", /dueno\/panel/],
  ["dueno-nomina", "/dueno/nomina", "dueno", /dueno\/panel/],
];
const TEMAS = ["actual", "oscuro", "claro"];
const ANCHOS = [390, 1280];

const navegador = await chromium.launch();
let fallas = 0;
try {
  for (const [nombre, ruta, usuario, destino] of PANTALLAS) {
    for (const ancho of ANCHOS) {
      const ctx = await navegador.newContext({ viewport: { width: ancho, height: ancho === 390 ? 844 : 900 } });
      const p = await ctx.newPage();
      const errores = [];
      p.on("pageerror", (e) => errores.push(e.message.slice(0, 120)));
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", cred.usuarios[usuario]);
      await p.fill("#password", cred.password);
      await p.click("button[type=submit]");
      await p.waitForURL(destino, { timeout: 90000 });
      for (const tema of TEMAS) {
        await p.goto(`${BASE}${ruta}?tema=${tema}`);
        await p.waitForLoadState("networkidle").catch(() => {});
        await p.waitForTimeout(2500);
        const clase = await p.evaluate(() => document.querySelector(".theme-caja-claro") ? "claro" : document.querySelector("main .theme-caja, .theme-caja") ? "oscuro" : "actual");
        const scroll = await p.evaluate(() => document.documentElement.scrollWidth);
        const ok = clase === tema && scroll <= ancho && errores.length === 0;
        if (!ok) fallas++;
        console.log(`${ok ? "OK   " : "FALLA"}  ${nombre} ${tema} ${ancho}px${clase !== tema ? ` (se vio ${clase})` : ""}${scroll > ancho ? ` scroll ${scroll}px` : ""}${errores.length ? " " + errores.join(" | ") : ""}`);
        await p.screenshot({ path: `${SHOTS}${nombre}-${tema}-${ancho}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
} finally {
  await navegador.close();
}
console.log(fallas ? `\n${fallas} capturas con problema` : "\nCapturas listas en screenshots-temas/");
process.exitCode = fallas ? 1 : 0;
