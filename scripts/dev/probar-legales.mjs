// Pruebas de los documentos legales y las casillas de aceptación
// (bandera NEXT_PUBLIC_LEGALES, sql/post-junta/05-legales.sql), contra
// antroapp-dev con dos servidores locales:
//   apagada:   node scripts/dev/servidor-dev.mjs                                  (3001)
//   encendida: NEXT_DIST_DIR=.next-banderas PUERTO=3003 NEXT_PUBLIC_LEGALES=1 node scripts/dev/servidor-dev.mjs
//
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-legales.mjs [--sin=…] [--con=…]

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const arg = (n, def) => (process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? def).replace(/\/$/, "");
const SIN = arg("sin", "http://localhost:3001");
const CON = arg("con", "http://localhost:3003");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const VERSION = /VERSION_LEGAL = "([^"]+)"/.exec(readFileSync(path.join(RAIZ, "lib/legal/version.ts"), "utf8"))[1];
const SHOTS = path.join(RAIZ, "screenshots-post-junta", "legales");
mkdirSync(SHOTS, { recursive: true });

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const sufijo = randomUUID().slice(0, 8);
const PASS = "Prueba-" + randomUUID();
const ids = [];
async function cuenta(clave, role, club_id = null) {
  const email = `legal_${clave}_${sufijo}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  ids.push(u.data.user.id);
  await svc.from("profiles").insert({ id: u.data.user.id, nombre: `Legal ${clave}`, role, club_id });
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  await c.auth.signInWithPassword({ email, password: PASS });
  return { id: u.data.user.id, email, c };
}

try {
  // 0. Las páginas muestran exactamente lo de docs/legal.
  const rev = spawnSync(process.execPath, [path.join(RAIZ, "scripts/legal-a-paginas.mjs"), "--revisar"], { encoding: "utf8" });
  revisar(rev.status === 0, "lib/legal/textos.ts coincide con docs/legal/*.md");

  // 1. Bandera apagada.
  for (const ruta of ["/terminos", "/privacidad"]) {
    const s = (await fetch(SIN + ruta)).status;
    revisar(s === 404, `apagada: ${ruta} → 404`, String(s));
  }
  // 2. Bandera encendida.
  const terminos = await (await fetch(CON + "/terminos")).text();
  revisar(/Términos de uso de AntroApp/.test(terminos) && /no garantiza la entrada/.test(terminos) && /Borrador en revisión/.test(terminos), "encendida: /terminos con política del QR y aviso de borrador");
  const privacidad = await (await fetch(CON + "/privacidad")).text();
  revisar(/Aviso de privacidad integral/.test(privacidad) && /ARCO/.test(privacidad), "encendida: /privacidad con derechos ARCO");

  // 3. RLS de aceptaciones_legales.
  const a = await cuenta("cli_a", "cliente");
  const b = await cuenta("cli_b", "cliente");
  const fila = (pid, extra = {}) => ({ profile_id: pid, documento: "terminos", version: VERSION, ...extra });
  revisar(!(await a.c.from("aceptaciones_legales").insert(fila(a.id, { aceptado_en: "2020-01-01T00:00:00Z" }))).error, "cada quien registra su aceptación");
  const { data: propia } = await a.c.from("aceptaciones_legales").select("aceptado_en").eq("profile_id", a.id);
  revisar(propia?.length === 1 && propia[0].aceptado_en.startsWith(new Date().getUTCFullYear().toString()), "la fecha la pone la base (no la del navegador)");
  revisar(!!(await a.c.from("aceptaciones_legales").insert(fila(b.id))).error, "no puede registrar la aceptación de otro");
  revisar(((await b.c.from("aceptaciones_legales").select("id").eq("profile_id", a.id)).data ?? []).length === 0, "no lee la aceptación de otro");
  await a.c.from("aceptaciones_legales").update({ version: "otra" }).eq("profile_id", a.id);
  await a.c.from("aceptaciones_legales").delete().eq("profile_id", a.id);
  const { data: sigue } = await svc.from("aceptaciones_legales").select("version").eq("profile_id", a.id);
  revisar(sigue?.length === 1 && sigue[0].version === VERSION, "no se puede modificar ni borrar la constancia");
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  revisar(!!(await anon.from("aceptaciones_legales").insert(fila(a.id))).error, "anónimo no inserta");
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  await admin.auth.signInWithPassword({ email: cred.usuarios.admin, password: cred.password });
  revisar(((await admin.from("aceptaciones_legales").select("id").eq("profile_id", a.id)).data ?? []).length === 1, "el admin sí la ve");

  // 4. Pantallas.
  if (process.env.PLAYWRIGHT_DESDE) {
    const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    const nav = await chromium.launch();
    try {
      const rp = await cuenta("rp", "rp", cred.clubs.demo);
      const entrar = async (base, email) => {
        const p = await nav.newPage({ viewport: { width: 390, height: 844 } });
        await p.goto(base + "/cliente/login");
        await p.fill("#email", email);
        await p.fill("#password", PASS);
        await p.click("button[type=submit]");
        return p;
      };
      // Apagada: el RP entra directo a su panel.
      let p = await entrar(SIN, rp.email);
      const directo = await p.getByRole("button", { name: "Turnos" }).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
      revisar(directo && (await p.getByText("Antes de empezar").count()) === 0, "apagada: el RP entra directo, sin casilla");
      await p.close();
      // Encendida: primero acepta.
      p = await entrar(CON, rp.email);
      const pide = await p.getByText("Antes de empezar").waitFor({ timeout: 90000 }).then(() => true, () => false);
      revisar(pide, "encendida: la primera entrada del RP pide aceptar");
      await p.screenshot({ path: path.join(SHOTS, "390-rp-aceptar.png") });
      await p.getByRole("button", { name: "Aceptar y continuar" }).click();
      revisar((await p.getByText("Marca la casilla para continuar.").count()) === 1, "sin marcar la casilla no avanza");
      await p.check("#acepto-rp");
      await p.getByRole("button", { name: "Aceptar y continuar" }).click();
      const panel = await p.getByRole("button", { name: "Turnos" }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      revisar(panel, "al aceptar entra a su panel");
      const { data: filas } = await svc.from("aceptaciones_legales").select("documento").eq("profile_id", rp.id).eq("version", VERSION);
      revisar(filas?.length === 2, "quedan 2 constancias (términos y privacidad) con la versión vigente");
      await p.reload();
      const segunda = await p.getByRole("button", { name: "Turnos" }).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
      revisar(segunda && (await p.getByText("Antes de empezar").count()) === 0, "la segunda vez ya no se pide");
      await p.close();

      // Registro del cliente.
      for (const [base, conBandera] of [[SIN, false], [CON, true]]) {
        const q = await nav.newPage({ viewport: { width: 390, height: 844 } });
        await q.goto(base + "/cliente/signup");
        await q.waitForSelector("button[type=submit]", { timeout: 60000 });
        const casillas = await q.locator("#acepto-cliente").count();
        if (!conBandera) revisar(casillas === 0, "apagada: el registro del cliente no tiene casilla");
        else {
          revisar(casillas === 1, "encendida: el registro del cliente tiene la casilla con enlaces");
          await q.screenshot({ path: path.join(SHOTS, "390-registro-cliente.png"), fullPage: true });
          const enlaces = await q.locator('label[for="acepto-cliente"] a').evaluateAll((as) => as.map((x) => x.getAttribute("href")));
          revisar(enlaces.join(",") === "/terminos,/privacidad", "los enlaces llevan a /terminos y /privacidad");
        }
        await q.close();
      }
      const t = await nav.newPage({ viewport: { width: 390, height: 844 } });
      await t.goto(CON + "/privacidad");
      await t.screenshot({ path: path.join(SHOTS, "390-privacidad.png") });
      const ancho = await t.evaluate(() => document.documentElement.scrollWidth);
      revisar(ancho <= 390, `/privacidad sin scroll horizontal a 390 px (${ancho})`);
      await t.close();
    } finally {
      await nav.close();
    }
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  if (ids.length) {
    await svc.from("profiles").delete().in("id", ids);
    for (const id of ids) await svc.auth.admin.deleteUser(id);
  }
  console.log(`\nLimpieza: ${ids.length} cuentas de prueba borradas.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
