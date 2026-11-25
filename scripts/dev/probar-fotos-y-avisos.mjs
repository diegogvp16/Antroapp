// SOLO DEV. Pantallas de la corrección del carril c-rls (25/11/2026):
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-fotos-y-avisos.mjs [http://localhost:3026] [--capturas=screenshots-c-rls]
//
//  1. /dueno/panel, fotos (63 + lib/fotos-club.ts): un BMP y una foto de
//     11 MB se rechazan ANTES de subir con su motivo, sin "Intenta de nuevo";
//     una foto válida en el mismo lote que un BMP sí se sube y se avisa del
//     BMP. Storage no recibe los archivos rechazados.
//  2. /cliente/reservar sin cuenta (72/66): con 3 reservas del mismo teléfono
//     ya hechas, la 4a muestra el aviso de la base tal cual.
//
// Crea su propio antro publicado "T rls ui <tag>" y su dueño
// t_rls_<tag>_dueno@example.com; lo borra todo al final (try/finally).
// No toca Club Demo Dev ni los usuarios dev_*.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

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
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3026";
const CAPTURAS = path.join(RAIZ, (process.argv.find((a) => a.startsWith("--capturas=")) ?? "--capturas=screenshots-c-rls").split("=")[1]);
mkdirSync(CAPTURAS, { recursive: true });

const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const TAG = "t_rls_" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const resultados = [];
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
function revisar(nombre, paso, detalle = "") {
  resultados.push({ nombre, paso });
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(60, 0)]);

let clubId = null;
let duenoId = null;
const db = await conectarDevEscritura();
const navegador = await chromium.launch();
try {
  // ---------- Escenario ----------
  clubId = ok(await svc.from("clubs").insert({ nombre: `T rls ui ${TAG}`, direccion: "Calle prueba 1", horario: "22:00-03:00" }).select("id").single(), "antro").id;
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true }).eq("id", clubId), "publicar");
  const email = `${TAG}_dueno@example.com`;
  duenoId = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "cuenta").user.id;
  ok(await svc.from("profiles").upsert({ id: duenoId, nombre: `T rls dueño ${TAG}`, role: "dueno", activo: true }), "perfil");
  ok(await svc.from("clubs").update({ dueno_id: duenoId }).eq("id", clubId), "dueño");
  const archivos = async () => ((await svc.storage.from("club-photos").list(clubId, { limit: 100 })).data ?? []).map((o) => o.name);

  // ---------- 1. Fotos en /dueno/panel ----------
  for (const [ancho, alto] of [[390, 844], [360, 740]]) {
    const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", email);
    await p.fill("#password", PASS);
    await p.waitForFunction(() => { try { return !window.turnstile || !!window.turnstile.getResponse(); } catch { return true; } }, null, { timeout: 20000 }).catch(() => {});
    await p.click("button[type=submit]");
    await p.waitForURL(/\/dueno\/panel/, { timeout: 90000 });
    await p.locator("#photos").waitFor({ state: "attached", timeout: 60000 });
    const alerta = p.locator("[role=alert]").filter({ hasText: /formato no se acepta|máximo es 10 MB/ });
    const sufijo = `${ancho}`;

    if (ancho === 390) {
      const accept = await p.locator("#photos").getAttribute("accept");
      revisar("1a. el selector solo ofrece los tipos que acepta el bucket", accept === "image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,image/gif", accept ?? "");
    }
    await p.locator("#photos").setInputFiles({ name: `plano-${TAG}.bmp`, mimeType: "image/bmp", buffer: BMP });
    await alerta.first().waitFor({ timeout: 15000 });
    let texto = await alerta.first().innerText();
    revisar(`1b. (${ancho}) un BMP se rechaza con su motivo, sin "Intenta de nuevo"`, /formato no se acepta/.test(texto) && !/Intenta de nuevo/.test(texto), texto);
    await p.locator("label[for=photos]").scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(CAPTURAS, `fotos-formato-${sufijo}.png`) });

    await p.locator("#photos").setInputFiles({ name: `grande-${TAG}.jpg`, mimeType: "image/jpeg", buffer: Buffer.alloc(11 * 1024 * 1024, 1) });
    await p.waitForFunction(() => /máximo es 10 MB/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    texto = await alerta.first().innerText();
    revisar(`1c. (${ancho}) una foto de 11 MB se rechaza con su peso y el tope`, /pesa 11\.0 MB y el máximo es 10 MB/.test(texto), texto);
    await p.locator("label[for=photos]").scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(CAPTURAS, `fotos-peso-${sufijo}.png`) });
    revisar(`1d. (${ancho}) Storage no recibió los rechazados`, (await archivos()).length === (ancho === 390 ? 0 : 1), (await archivos()).join(", "));

    if (ancho === 390) {
      await p.locator("#photos").setInputFiles([
        { name: `buena-${TAG}.png`, mimeType: "image/png", buffer: PNG },
        { name: `otra-${TAG}.bmp`, mimeType: "image/bmp", buffer: BMP },
      ]);
      await p.waitForFunction(() => /otra-.*formato no se acepta/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(1500);
      const subidos = await archivos();
      const filas = ok(await svc.from("club_photos").select("id").eq("club_id", clubId), "fotos");
      revisar("1e. lote con una foto buena y un BMP: la buena se sube (Storage y galería)", subidos.length === 1 && subidos[0].includes("buena-") && filas.length === 1, subidos.join(", "));
      texto = await alerta.first().innerText().catch(() => "");
      revisar("1f. …y se avisa cuál no se subió y por qué", /otra-.*formato no se acepta/.test(texto), texto);
      await p.locator("label[for=photos]").scrollIntoViewIfNeeded();
      await p.screenshot({ path: path.join(CAPTURAS, `fotos-lote-${sufijo}.png`), fullPage: false });
    }
    await ctx.close();
  }

  // ---------- 2. Aviso P0001 en /cliente/reservar ----------
  const tieneAntiabuso = (await db.q("select count(*)::int n from pg_trigger where tgname = 'reservations_antiabuso_anon' and not tgisinternal"))[0].n === 1;
  if (!tieneAntiabuso) {
    console.log("(sin el trigger de 72 en dev: se salta el caso 2)");
  } else {
    const manana = (await db.q("select (public.club_fecha_operacion($1, now()) + 1)::text f", [clubId]))[0].f;
    const tel = "55" + String(Date.now()).slice(-8);
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
    for (let i = 0; i < 3; i++) ok(await anon.from("reservations").insert({ cliente_nombre: "Anon Prueba", cliente_telefono: tel, club_id: clubId, source: "organica", fecha: manana, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` }), "reserva previa");
    for (const [ancho, alto] of [[390, 844], [360, 740]]) {
      const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, deviceScaleFactor: 2 });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/cliente/reservar?club=${clubId}`);
      await p.locator("#nombre").waitFor({ timeout: 60000 });
      await p.fill("#nombre", "Anon Prueba");
      await p.fill("#telefono", tel);
      await p.fill("#fecha", manana);
      await p.locator("form button[type=submit]").click();
      // p[role=alert]: Next también pone un role=alert vacío (el anunciador de rutas).
      const alerta = p.locator("p[role=alert]");
      await alerta.first().waitFor({ timeout: 30000 }).catch(() => {});
      const texto = await alerta.first().innerText().catch(() => "(sin aviso)");
      revisar(`2a. (${ancho}) la 4a reserva sin cuenta del mismo teléfono muestra el aviso de la base`, /Ya hay varias reservas con este teléfono/.test(texto) && !/Intenta de nuevo/.test(texto), texto);
      await alerta.first().scrollIntoViewIfNeeded().catch(() => {});
      await p.screenshot({ path: path.join(CAPTURAS, `reservar-tope-${ancho}.png`) });
      await ctx.close();
    }
    revisar("2b. no se guardó una 4a reserva", (await db.q("select count(*)::int n from public.reservations where club_id = $1 and cliente_telefono = $2", [clubId, tel]))[0].n === 3);
  }
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await navegador.close();
  try {
    if (clubId) {
      const l = await svc.storage.from("club-photos").list(clubId, { limit: 1000 });
      const rutas = (l.data ?? []).map((o) => `${clubId}/${o.name}`);
      if (rutas.length) await svc.storage.from("club-photos").remove(rutas);
      await db.q("begin");
      await db.q("set local antroapp.borrado_pruebas = 'on'");
      await db.q("delete from public.club_photos where club_id = $1", [clubId]);
      await db.q("delete from public.reservations where club_id = $1", [clubId]);
      await db.q("delete from public.reserva_intentos where club_id = $1", [clubId]).catch(() => {});
      await db.q("update public.clubs set dueno_id = null where id = $1", [clubId]);
      if (duenoId) await db.q("delete from public.profiles where id = $1", [duenoId]);
      await db.q("delete from public.clubs where id = $1", [clubId]);
      await db.q("commit");
    }
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  if (duenoId) await svc.auth.admin.deleteUser(duenoId);
  const quedan = (await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs, (select count(*) from auth.users where email like $2)::int usuarios,
            (select count(*) from storage.objects where bucket_id = 'club-photos' and name like $3)::int archivos`,
    [`%${TAG}%`, `${TAG}%`, `${clubId ?? "-"}/%`]))[0];
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan)}`);
  if (quedan.clubs || quedan.usuarios || quedan.archivos) revisar("la limpieza no deja restos", false, JSON.stringify(quedan));
  const pasan = resultados.filter((r) => r.paso).length;
  console.log(`Resultado: ${pasan}/${resultados.length} pasan`);
  if (pasan !== resultados.length) process.exitCode = 1;
}
