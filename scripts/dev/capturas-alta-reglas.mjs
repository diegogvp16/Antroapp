// Pantallas del paso «Reglas de comisión y RPs» del alta, en el navegador,
// a 390×844 y 360×740, y un alta completa por la interfaz (a 390 px): del
// asistente a la base. Mide desborde horizontal, controles de menos de 40 px
// y errores de la página. Capturas en screenshots-b-alta/ (no van a Git).
//
//   PUERTO=3021 node scripts/dev/servidor-dev.mjs        # en otra terminal
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/capturas-alta-reglas.mjs [http://localhost:3021]
//
// Usa dev_admin (no le cambia nada). El antro que crea («T alta UI …», sin
// cuentas) se borra al final aunque algo falle.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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
    if (process.env.PLAYWRIGHT_DESDE) return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
    process.exit(1);
  }
}
const { chromium } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const BASE = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3021").replace(/\/$/, "");
const { password: PASS_DEV } = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const SALIDA = path.join(RAIZ, "screenshots-b-alta");
mkdirSync(SALIDA, { recursive: true });

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const sufijo = randomUUID().slice(0, 8);
const NOMBRE = `T alta UI ${sufijo}`;

// Desborde y controles chicos (el área táctil de una casilla es su <label>).
async function medir(p) {
  return p.evaluate(() => {
    const desborde = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const chicos = [];
    for (const el of document.querySelectorAll("main button, main a, main input, main select, main textarea, button, input")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      const objetivo = el.matches("input[type=radio], input[type=checkbox]") ? el.closest("label") : el;
      const h = objetivo ? objetivo.getBoundingClientRect().height : r.height;
      if (h < 40 && !el.closest(".sr-only")) chicos.push((el.getAttribute("aria-label") || el.textContent || el.id || el.tagName).trim().slice(0, 40) + ` (${Math.round(h)} px)`);
    }
    return { desborde, chicos: [...new Set(chicos)] };
  });
}

const navegador = await chromium.launch();
try {
  for (const [ancho, alto] of [[390, 844], [360, 740]]) {
    const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errores = [];
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
    p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React/.test(m.text())) errores.push(m.text().slice(0, 140)); });
    const foto = async (nombre) => p.screenshot({ path: path.join(SALIDA, `${ancho}-${nombre}.png`), fullPage: true });
    const verificar = async (nombre) => {
      const m = await medir(p);
      revisar(!m.desborde, `${ancho} px · ${nombre}: sin desborde horizontal`);
      revisar(m.chicos.length === 0, `${ancho} px · ${nombre}: ningún control de menos de 40 px`, m.chicos.join(", "));
    };

    await p.goto(BASE + "/admin/login");
    await p.fill("#email", "dev_admin@example.com");
    await p.fill("#password", PASS_DEV);
    await p.click("button[type=submit]");
    await p.waitForURL(/\/admin$/, { timeout: 90000 });
    await p.goto(BASE + "/admin/alta-antro");
    await p.waitForSelector("#alta-nombre", { timeout: 90000 });
    const siguiente = () => p.getByRole("button", { name: "Siguiente" }).click();
    await p.fill("#alta-nombre", NOMBRE);
    await p.fill("#alta-direccion", "Calle Ficticia 11, Centro");
    await p.fill("#alta-ciudad", "Querétaro");
    await p.fill("#alta-horario", "Jue a Sáb 10pm a 3am");
    await siguiente();
    await siguiente(); // cover y políticas por defecto
    await p.getByRole("button", { name: /Agregar 20 mesas/ }).click();
    await siguiente();
    await p.getByRole("heading", { name: "Reglas de comisión y RPs" }).waitFor();
    revisar(true, `${ancho} px · llega al paso 4 de 7, «Reglas de comisión y RPs»`);
    await foto("reglas-inicio");
    await verificar("reglas, al entrar");

    await siguiente();
    const errMonto = await p.getByText("Escribe un monto entre $0.01 y $100,000.").first().isVisible().catch(() => false);
    revisar(errMonto, `${ancho} px · sin monto no deja seguir y lo dice en el campo`);
    await foto("reglas-error");

    await p.getByLabel("Con cuota: las primeras N de la semana no pagan").check();
    await p.fill("#alta-cuota", "3");
    await p.fill("#alta-monto", "200");
    const vista = await p.getByText("Las primeras 3 reservas de la semana no pagan; desde la 4.ª, $200 cada una").isVisible();
    revisar(vista, `${ancho} px · la vista previa describe la regla de cuota`);
    await p.getByLabel("Estado, monto y botellas").check();
    await p.getByLabel("Cambiar los permisos de la plataforma").check();
    await p.getByLabel("Staff: Cobrar").uncheck();
    await p.getByLabel("Gerente: Cerrar la noche").uncheck();
    revisar(await p.getByText("2 cambios respecto de la plataforma.").isVisible(), `${ancho} px · cuenta los permisos cambiados`);
    await foto("reglas-cuota-permisos");
    await verificar("reglas con cuota y permisos");

    await p.getByLabel("Por día trabajado").check();
    await p.fill("#alta-tarifa-0", "300");
    await p.getByRole("button", { name: "Agregar el día 2" }).click();
    await p.fill("#alta-tarifa-1", "450");
    await foto("reglas-por-dia");
    await verificar("reglas por día");

    if (ancho === 390) {
      // Alta completa por la interfaz, con la regla de cuota (sin cuentas).
      await p.getByLabel("Por reserva que consume").check();
      await siguiente();
      await p.getByLabel("Crear la cuenta del dueño ahora").uncheck();
      await siguiente(); // equipo
      await siguiente(); // grupo: independiente
      await p.getByRole("heading", { name: "Resumen" }).waitFor();
      const resumen = await p.locator("body").innerText();
      revisar(/Por reserva: Las primeras 3 reservas/.test(resumen) && /Estado, monto y botellas/.test(resumen) && /Staff no: Cobrar · Gerente no: Cerrar la noche/.test(resumen),
        "el resumen muestra la regla, qué ven los RPs y los permisos cambiados");
      await foto("resumen");
      await verificar("resumen");
      await p.getByRole("button", { name: "Dar de alta en borrador" }).click();
      await p.getByText(`${NOMBRE} quedó dado de alta`).waitFor({ timeout: 60000 });
      await foto("resultado");
      const { data: club } = await svc.from("clubs").select("id, pago_rp_modo").eq("nombre", NOMBRE).maybeSingle();
      const { data: regla } = await svc.from("reglas_comision").select("tipo, cuota, monto_centavos").eq("club_id", club?.id);
      const { data: cfg } = await svc.from("club_config_rp").select("nivel_visibilidad").eq("club_id", club?.id).maybeSingle();
      const { data: perm } = await svc.from("caja_permisos").select("permiso, rol, permitido").eq("club_id", club?.id);
      revisar(club?.pago_rp_modo === "reserva" && regla?.length === 1 && regla[0].tipo === "cuota" && regla[0].cuota === 3 && Number(regla[0].monto_centavos) === 20000,
        "alta por la interfaz: la base tiene la regla de cuota 3, $200", JSON.stringify(regla));
      revisar(cfg?.nivel_visibilidad === "estado_monto_botellas", "…y lo que ven los RPs");
      revisar(perm?.length === 2 && perm.every((x) => x.permitido === false), "…y los 2 permisos quitados", JSON.stringify(perm));
    }
    revisar(errores.length === 0, `${ancho} px · sin errores en la página`, errores.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message.split("\n")[0]);
} finally {
  await navegador.close();
  const { data: clubs } = await svc.from("clubs").select("id").eq("nombre", NOMBRE);
  for (const c of clubs ?? []) {
    await svc.from("caja_permisos").delete().eq("club_id", c.id);
    await svc.from("club_altas").delete().eq("club_id", c.id);
    await svc.from("club_tables").delete().eq("club_id", c.id);
    const { error } = await svc.from("clubs").delete().eq("id", c.id);
    if (error) console.log("Limpieza falló: " + error.message);
  }
  const quedan = ((await svc.from("clubs").select("id").eq("nombre", NOMBRE)).data ?? []).length;
  console.log(quedan ? `\nLimpieza: QUEDÓ el antro ${NOMBRE}.` : `\nLimpieza: ${(clubs ?? []).length} antro de prueba borrado.`);
  console.log(`Capturas en ${SALIDA}`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan || quedan) process.exitCode = 1;
}
