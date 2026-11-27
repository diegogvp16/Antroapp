// SOLO DEV. Pantallas de "Clientes y mensajes" (lista negra / no-show y
// WhatsApp) y el rechazo al reservar, con Playwright contra el servidor
// local de dev y antroapp-dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-clientes-pantalla.mjs http://localhost:3044
//
// Enciende un rato 'lista_negra' y 'whatsapp' en Club Demo Dev (y al final
// las deja como estaban), crea un bloqueo y no-shows de prueba (teléfonos
// 559000009x, prefijo t_n4_cli) y revisa a 390×844 y 360×740:
//   - gerente: botón en el panel, pestañas, lista de la noche con aviso y
//     enlaces wa.me, bloquear/ver teléfono/desbloquear, no-show, política,
//     editor de mensajes con validación;
//   - staff: solo la noche, con avisos y sin motivo;
//   - dueño: /dueno/clientes;
//   - sin cuenta: /cliente/reservar con teléfono bloqueado → mensaje neutro;
//   - RP: teléfono bloqueado → mensaje para RP; reserva con no-shows → aviso;
//     detalle de su reserva con aviso y mensajes;
//   - banderas apagadas: no hay botón y la reserva pasa como hoy.
// Sin scroll horizontal y controles de al menos 40 px. Borra todo al final.
// Capturas en screenshots-n4-clientes/ (ignorada por Git).
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";

verificarEnvDev();
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
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3044";
const SHOTS = path.join(RAIZ, "screenshots-n4-clientes") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;
const NEUTRO = "No pudimos apartar tu lugar en este antro. Comunícate directamente con el antro.";
const PARA_RP = "Este cliente no puede reservar en este antro por ahora. Si crees que es un error, habla con tu gerente.";
const BLOQ = "5590000091";
const NS = "5590000092";
const NUEVO = "5590000093";
const TELS = [BLOQ, NS, NUEVO, "5590000094"];

let pasan = 0, fallan = 0;
function nota(texto, ok, detalle = "") {
  if (ok) pasan++; else fallan++;
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}
const db = await conectarDevEscritura();
const flagsAntes = await db.q(`select funcion, activa from public.club_funciones where club_id = $1 and funcion in ('lista_negra','whatsapp')`, [CLUB]);
async function flag(f, on) {
  if (on === null) await db.q(`delete from public.club_funciones where club_id = $1 and funcion = $2`, [CLUB, f]);
  else await db.q(`insert into public.club_funciones (club_id, funcion, activa) values ($1, $2, $3) on conflict (club_id, funcion) do update set activa = excluded.activa`, [CLUB, f, on]);
}
const HOY = (await db.q(`select public.club_fecha_operacion($1)::text d`, [CLUB]))[0].d;
const dia = (n) => { const d = new Date(HOY + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ins = (tel, fecha, nombre, extra = {}) =>
  db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, rp_id, fecha, personas, status, qr_code)
        values ($1, $2, $3, $4, $5, $6, 3, 'pendiente', $7)`, [nombre, tel, CLUB, extra.rp ? "rp" : "organica", extra.rp ?? null, fecha, `antro-t_n4_cli_${randomUUID()}`]);

const navegador = await chromium.launch();
async function sesion(email, destino, viewport) {
  const ctx = await navegador.newContext({ viewport });
  const p = await ctx.newPage();
  const errores = [];
  p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
  // El rechazo de la reserva es un 400 de PostgREST a propósito (P0001): el
  // navegador lo anota como "Failed to load resource"; se revisan las
  // respuestas, y solo ese 400 de /rest/v1/reservations se acepta.
  p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React|Supabase insert error|Failed to load resource/.test(m.text())) errores.push(m.text().slice(0, 140)); });
  p.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url()) && !(r.status() === 400 && /\/rest\/v1\/reservations/.test(r.url()))) errores.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });
  if (email) {
    for (let i = 0; i < 4; i++) {
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", email);
      await p.fill("#password", cred.password);
      await p.click("button[type=submit]");
      const ok = await p.waitForURL(destino, { timeout: 60000 }).then(() => true).catch(() => false);
      if (ok) break;
      await p.waitForTimeout(3000 * (i + 1));
    }
  }
  return { ctx, p, errores };
}
const sinScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const bajos = (p) => p.evaluate(() => [...document.querySelectorAll("main button, main a, main input, main textarea, div button, div a, div input")]
  .filter((e) => e.offsetParent !== null && !(e.type === "checkbox"))
  .filter((e) => !e.closest("nav") && !(e.tagName === "A" && e.closest("p")))
  .map((e) => [e.textContent?.trim().slice(0, 24) || e.getAttribute("aria-label") || e.tagName, Math.round(e.getBoundingClientRect().height)])
  .filter(([, h]) => h < 40));
const texto = (p) => p.locator("body").innerText();
const esperar = (p, t, ms = 60000) => p.getByText(t).first().waitFor({ timeout: ms }).then(() => true).catch(() => false);
async function revisar(p, nombre, w) {
  nota(`${nombre} ${w}: sin scroll horizontal`, await sinScroll(p));
  const b = await bajos(p);
  nota(`${nombre} ${w}: controles de al menos 40 px`, b.length === 0, b.length ? JSON.stringify(b.slice(0, 6)) : "");
  await p.screenshot({ path: `${SHOTS}${nombre}-${w}.png`, fullPage: true });
}

try {
  // ---------- Datos ----------
  await flag("lista_negra", true);
  await flag("whatsapp", true);
  await db.q(`insert into public.club_bloqueos (club_id, telefono, nombre, motivo) values ($1, $2, 'T n4 cli Bloqueado', 't_n4_cli Pleito en la puerta')`, [CLUB, BLOQ]);
  await ins(NS, dia(-1), "T n4 cli Noshow");
  await ins(NS, dia(-2), "T n4 cli Noshow");
  await ins(NS, HOY, "T n4 cli Noshow");
  const ger = (await db.q(`select id from auth.users where email = $1`, [cred.usuarios.rp]))[0].id;
  await ins(NS, HOY, "T n4 cli Del RP", { rp: ger });
  // Nombre con un enlace (lo escribe cualquiera) y un número extranjero.
  await ins("5590000094", HOY, "https://phish.example/x T n4 cli");
  await ins("+1 212 555 1234", HOY, "T n4 cli Extranjero");

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const w = viewport.width;
    // ---------- Gerente ----------
    const g = await sesion(cred.usuarios.gerente, /staff\/panel/, viewport);
    const boton = await esperar(g.p, "Clientes y mensajes");
    nota(`gerente ${w}: el panel muestra «Clientes y mensajes»`, boton);
    await g.p.goto(BASE + "/staff/clientes");
    nota(`gerente ${w}: abre la lista de la noche`, await esperar(g.p, "T n4 cli Noshow"));
    const t1 = await texto(g.p);
    nota(`gerente ${w}: pestañas Noche, No-show, Bloqueados, Política y Mensajes`, ["Noche", "No-show", "Bloqueados", "Política", "Mensajes"].every((x) => t1.includes(x)));
    nota(`gerente ${w}: aviso «2 noches sin llegar antes» en la reserva de esta noche`, t1.includes("2 noches sin llegar antes"));
    nota(`gerente ${w}: dice que abrir WhatsApp no envía nada`, /no envía nada/.test(t1));
    const href = await g.p.locator(`a[href^="https://wa.me/52${NS}?text="]`).first().getAttribute("href").catch(() => null);
    nota(`gerente ${w}: enlace wa.me/52${NS} con el texto de confirmación`, !!href && decodeURIComponent(href).includes("/r/antro-t_n4_cli_"), href?.slice(0, 60));
    const hPhish = await g.p.locator(`a[href^="https://wa.me/525590000094?text="]`).first().getAttribute("href").catch(() => null);
    nota(`gerente ${w}: un nombre con enlace no entra al mensaje`, !!hPhish && !decodeURIComponent(hPhish).includes("phish"), hPhish?.slice(0, 60));
    const filaExt = g.p.locator("li", { hasText: "T n4 cli Extranjero" });
    const hExt = await filaExt.locator("a").first().getAttribute("href").catch(() => null);
    nota(`gerente ${w}: número extranjero → compartir sin destinatario («sin teléfono»)`, !!hExt && hExt.startsWith("https://wa.me/?text=") && (await filaExt.innerText()).includes("sin teléfono"), hExt?.slice(0, 40));
    await revisar(g.p, "gerente-noche", w);
    await g.p.getByRole("tab", { name: "Anoche" }).click();
    nota(`gerente ${w}: anoche, con «Aviso de no-show»`, await esperar(g.p, "Aviso de no-show"));
    await revisar(g.p, "gerente-anoche", w);

    await g.p.getByRole("tab", { name: "Bloqueados" }).click();
    nota(`gerente ${w}: bloqueados con teléfono enmascarado y motivo`, (await esperar(g.p, "***0091")) && (await texto(g.p)).includes("t_n4_cli Pleito en la puerta"));
    nota(`gerente ${w}: el teléfono completo no está en pantalla`, !(await texto(g.p)).includes(BLOQ));
    await revisar(g.p, "gerente-bloqueados", w);
    await g.p.getByRole("button", { name: "Ver teléfono" }).first().click();
    nota(`gerente ${w}: «Ver teléfono» muestra el completo`, await esperar(g.p, BLOQ, 20000));
    if (w === 390) {
      await g.p.getByRole("button", { name: "Bloquear un teléfono" }).click();
      await g.p.getByPlaceholder("10 dígitos").fill("55 9000 0093");
      await g.p.getByPlaceholder("Para reconocerlo en la lista").fill("T n4 cli Nuevo");
      await g.p.getByRole("button", { name: "Bloquear", exact: true }).click();
      nota("gerente 390: sin motivo no bloquea", await esperar(g.p, "Escribe el motivo", 10000));
      await g.p.locator("textarea").first().fill("t_n4_cli Prueba de pantalla");
      await g.p.getByRole("button", { name: "30 días" }).click();
      await revisar(g.p, "gerente-bloquear-form", w);
      await g.p.getByRole("button", { name: "Bloquear", exact: true }).click();
      nota("gerente 390: bloquea un teléfono nuevo", await esperar(g.p, "***0093"));
      const fila = g.p.locator("li", { hasText: "***0093" });
      await fila.getByRole("button", { name: "Desbloquear" }).click();
      await fila.locator("textarea").fill("t_n4_cli Era un error");
      await fila.getByRole("button", { name: "Desbloquear" }).click();
      await g.p.waitForTimeout(2500);
      nota("gerente 390: lo desbloquea con motivo (sale de activos)", !(await texto(g.p)).includes("***0093"));
      await g.p.getByRole("tab", { name: "Historial completo" }).click();
      nota("gerente 390: el historial lo conserva como «Desbloqueado»", (await esperar(g.p, "Era un error")) && (await texto(g.p)).includes("Desbloqueado"));
    }

    await g.p.getByRole("tab", { name: "No-show" }).click();
    nota(`gerente ${w}: no-show de ***0092 con «2 veces»`, (await esperar(g.p, "***0092")) && /2 noches sin llegar/.test(await texto(g.p)));
    await revisar(g.p, "gerente-noshow", w);
    await g.p.getByRole("tab", { name: "Política" }).click();
    nota(`gerente ${w}: política de fábrica (2 en 90 días, sin automático)`, (await esperar(g.p, "Política de no-show")) && (await g.p.locator("input[type=number]").first().inputValue()) === "2");
    await esperar(g.p, "Bloqueo", 10000);
    await revisar(g.p, "gerente-politica", w);
    await g.p.getByRole("tab", { name: "Mensajes" }).click();
    nota(`gerente ${w}: editor de los 3 mensajes`, (await esperar(g.p, "Aviso de no-show")) && (await texto(g.p)).includes("Recordatorio"));
    const area = g.p.locator("textarea").first();
    await area.fill("Hola {nombre}, tu mesa {mesa}");
    nota(`gerente ${w}: variable desconocida → error y no deja guardar`, (await esperar(g.p, "Variable que no existe: {mesa}", 5000)) && (await g.p.getByRole("button", { name: "Guardar" }).first().isDisabled()));
    await area.fill("t_n4_cli Hola {nombre}, te esperamos en {antro} el {fecha}: {enlace_boleto}");
    nota(`gerente ${w}: vista previa con datos de ejemplo`, (await texto(g.p)).includes("Hola Ana, te esperamos en Club Demo Dev"));
    await revisar(g.p, "gerente-mensajes", w);
    if (w === 390) {
      await g.p.getByRole("button", { name: "Guardar" }).first().click();
      nota("gerente 390: guarda una confirmación propia", await esperar(g.p, "Guardado.", 15000));
      await g.p.getByRole("tab", { name: "Noche" }).click();
      await esperar(g.p, "T n4 cli Noshow");
      const h2 = await g.p.locator(`a[href^="https://wa.me/52${NS}?text="]`).first().getAttribute("href").catch(() => null);
      nota("gerente 390: el enlace usa el texto propio", !!h2 && decodeURIComponent(h2).startsWith(`https://wa.me/52${NS}?text=t_n4_cli Hola`), h2?.slice(0, 70));
      await g.p.getByRole("tab", { name: "Mensajes" }).click();
      await g.p.getByRole("button", { name: "Volver al de fábrica" }).first().click();
      nota("gerente 390: vuelve al texto de fábrica", await esperar(g.p, "Volvió al texto de fábrica.", 15000));
    }
    nota(`gerente ${w}: sin errores en consola`, g.errores.length === 0, g.errores.slice(0, 3).join(" | "));
    await g.ctx.close();

    // ---------- Staff ----------
    const s = await sesion(cred.usuarios.staff, /staff\/panel/, viewport);
    nota(`staff ${w}: el panel muestra «Clientes y mensajes»`, await esperar(s.p, "Clientes y mensajes"));
    await s.p.goto(BASE + "/staff/clientes");
    nota(`staff ${w}: ve la noche con el aviso`, (await esperar(s.p, "T n4 cli Noshow")) && (await texto(s.p)).includes("2 noches sin llegar antes"));
    const ts = await texto(s.p);
    nota(`staff ${w}: no ve Bloqueados, Política ni motivos`, !ts.includes("Bloqueados") && !ts.includes("Política") && !ts.includes("Pleito"));
    await revisar(s.p, "staff-noche", w);
    nota(`staff ${w}: sin errores en consola`, s.errores.length === 0, s.errores.slice(0, 3).join(" | "));
    await s.ctx.close();

    // ---------- Dueño ----------
    const d = await sesion(cred.usuarios.dueno, /dueno\/panel/, viewport);
    nota(`dueño ${w}: el panel muestra «Clientes y mensajes»`, await esperar(d.p, "Clientes y mensajes"));
    await d.p.goto(BASE + "/dueno/clientes");
    await d.p.getByRole("tab", { name: "Bloqueados" }).click().catch(() => {});
    nota(`dueño ${w}: ve la lista negra de su antro`, await esperar(d.p, "***0091"));
    await revisar(d.p, "dueno-bloqueados", w);
    await d.ctx.close();
  }

  // ---------- Sin cuenta: /cliente/reservar ----------
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const w = viewport.width;
    const a = await sesion(null, null, viewport);
    await a.p.goto(`${BASE}/cliente/reservar?club=${CLUB}`);
    await a.p.locator("#nombre").waitFor({ timeout: 60000 });
    await a.p.fill("#nombre", "T n4 cli Anónimo");
    await a.p.fill("#telefono", "55 9000 0091");
    await a.p.fill("#fecha", dia(3));
    await a.p.getByRole("button", { name: "Apartar lugar" }).click();
    nota(`sin cuenta ${w}: teléfono bloqueado → mensaje neutro`, await esperar(a.p, NEUTRO, 20000));
    const ta = await texto(a.p);
    nota(`sin cuenta ${w}: no dice «bloqueado» ni el motivo`, !/bloquead|Pleito|lista negra/i.test(ta));
    await a.p.screenshot({ path: `${SHOTS}reservar-rechazo-${w}.png`, fullPage: true });
    nota(`sin cuenta ${w}: sin scroll horizontal`, await sinScroll(a.p));
    await a.ctx.close();
  }

  // ---------- RP ----------
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const w = viewport.width;
    const r = await sesion(cred.usuarios.rp, /rp\/panel/, viewport);
    await r.p.getByRole("button", { name: "+ Nueva reserva" }).click({ timeout: 60000 });
    await r.p.fill("#cliente_nombre", "T n4 cli Bloqueado RP");
    await r.p.fill("#cliente_telefono", BLOQ);
    await r.p.fill("#fecha", dia(4));
    await r.p.getByRole("button", { name: "Crear reserva" }).click();
    nota(`RP ${w}: teléfono bloqueado → mensaje para RP (sin motivo)`, await esperar(r.p, PARA_RP, 20000));
    await r.p.screenshot({ path: `${SHOTS}rp-rechazo-${w}.png`, fullPage: true });
    if (w === 390) {
      await r.p.fill("#cliente_telefono", NS);
      await r.p.fill("#cliente_nombre", "T n4 cli Con no-shows");
      await r.p.getByRole("button", { name: "Crear reserva" }).click();
      nota("RP 390: crea la reserva y ve el aviso de no-shows", (await esperar(r.p, "¡Reserva creada!", 20000)) && (await esperar(r.p, "2 noches sin llegar", 20000)));
      await revisar(r.p, "rp-creada-aviso", w);
      await r.p.getByRole("button", { name: "Crear otra reserva" }).click();
    }
    await r.p.reload();
    const fila = r.p.getByRole("button", { name: "T n4 cli Del RP, Por llegar" });
    await fila.waitFor({ timeout: 60000 }).catch(() => {});
    await fila.click().catch(() => {});
    nota(`RP ${w}: detalle de su reserva con aviso de no-shows`, await esperar(r.p, "2 noches sin llegar", 20000));
    nota(`RP ${w}: mensajes de confirmación y recordatorio`, (await esperar(r.p, "Recordatorio", 20000)) && (await r.p.locator(`a[href^="https://wa.me/52${NS}?text="]`).count()) >= 2);
    await r.p.screenshot({ path: `${SHOTS}rp-detalle-${w}.png`, fullPage: true });
    nota(`RP ${w}: sin scroll horizontal`, await sinScroll(r.p));
    nota(`RP ${w}: sin errores en consola`, r.errores.length === 0, r.errores.slice(0, 3).join(" | "));
    await r.ctx.close();
  }

  // ---------- Banderas apagadas: como hoy ----------
  await flag("lista_negra", false);
  await flag("whatsapp", false);
  const g = await sesion(cred.usuarios.gerente, /staff\/panel/, { width: 390, height: 844 });
  await esperar(g.p, "Caja y mesas de la noche");
  await g.p.waitForTimeout(3000);
  nota("apagadas: el panel del gerente no muestra «Clientes y mensajes»", !(await texto(g.p)).includes("Clientes y mensajes"));
  await g.ctx.close();
  const a = await sesion(null, null, { width: 390, height: 844 });
  await a.p.goto(`${BASE}/cliente/reservar?club=${CLUB}`);
  await a.p.locator("#nombre").waitFor({ timeout: 60000 });
  await a.p.fill("#nombre", "T n4 cli Anónimo");
  await a.p.fill("#telefono", "55 9000 0091");
  await a.p.fill("#fecha", dia(5));
  await a.p.getByRole("button", { name: "Apartar lugar" }).click();
  nota("apagada: el mismo teléfono bloqueado aparta lugar como hoy", await esperar(a.p, "Lugar apartado", 20000));
  await a.ctx.close();
} finally {
  await navegador.close().catch(() => {});
  for (const f of ["lista_negra", "whatsapp"]) {
    const antes = flagsAntes.find((x) => x.funcion === f);
    await flag(f, antes ? antes.activa : null);
  }
  await db.q("begin");
  await db.q(`set local antroapp.borrado_pruebas = 'on'`);
  await db.q(`delete from public.lista_negra_eventos where club_id = $1 and (telefono = any($2) or detalle ->> 'motivo' like 't_n4_cli%')`, [CLUB, TELS]);
  await db.q(`delete from public.club_bloqueos where club_id = $1 and telefono = any($2)`, [CLUB, TELS]);
  await db.q(`delete from public.whatsapp_plantillas_cambios where club_id = $1 and (texto like 't_n4_cli%' or (texto is null and hecho_en > now() - interval '2 hours'))`, [CLUB]);
  await db.q(`delete from public.club_whatsapp_plantillas where club_id = $1 and texto like 't_n4_cli%'`, [CLUB]);
  await db.q(`delete from public.reservations where club_id = $1 and (qr_code like 'antro-t_n4_cli_%' or cliente_nombre like 'T n4 cli%')`, [CLUB]);
  await db.q(`delete from public.reserva_intentos where club_id = $1 and telefono_hash = any(select encode(sha256(convert_to(t, 'UTF8')), 'hex') from unnest($2::text[]) t)`, [CLUB, TELS]);
  await db.q("commit");
  const q = (await db.q(`select (select count(*) from public.reservations where cliente_nombre like 'T n4 cli%' or qr_code like 'antro-t_n4_cli_%')::int r,
      (select count(*) from public.club_bloqueos where telefono = any($1))::int b,
      (select count(*) from public.club_whatsapp_plantillas where texto like 't_n4_cli%')::int w,
      (select count(*) from public.reserva_intentos where telefono_hash = any(select encode(sha256(convert_to(t, 'UTF8')), 'hex') from unnest($1::text[]) t))::int i`, [TELS]))[0];
  nota("limpieza: 0 reservas, bloqueos, plantillas e intentos de prueba; banderas como estaban", q.r === 0 && q.b === 0 && q.w === 0 && q.i === 0, JSON.stringify(q));
  await db.fin();
}
console.log(`\nResultado: ${pasan}/${pasan + fallan}  (capturas en screenshots-n4-clientes/)`);
process.exit(fallan ? 1 : 0);
