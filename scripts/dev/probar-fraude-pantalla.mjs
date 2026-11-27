// SOLO DEV. Pantalla "Revisión de RPs" (/staff/revision, /dueno/revision)
// contra el servidor local de dev y antroapp-dev, con las cuentas dev_<rol>.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-fraude-pantalla.mjs [http://localhost:3043]
//
// Arma datos t_n4_fraude_* en Club Demo Dev (semana del 5 al 11/10/2026:
// un cliente que pasa de un RP a otro, una ráfaga de 8 reservas y un
// teléfono ilegible), enciende la bandera 'antifraude' de ese antro solo
// mientras corre, y revisa a 390×844 y 360×740: enlace en la navegación del
// gerente, el dueño y el admin; que al abrir solo liste (no busque); el
// botón de búsqueda y su límite de 2 minutos; filtros, «Mostrando X de N»,
// detalle con evidencia enmascarada, nota obligatoria (teléfono
// enmascarado), descartar/confirmar con historial y evidencia de cada
// decisión, «Ya no se cumple», reglas con bitácora; que el staff y el RP no
// la vean; y bandera apagada → sin enlace y aviso. Al final borra todo lo
// que creó y regresa la bandera como estaba.
// Capturas en screenshots-n4-fraude/ (ignorada por Git).
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3043";
const SHOTS = path.join(RAIZ, "screenshots-n4-fraude") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const DEMO = cred.clubs.demo;
const db = await conectarDevEscritura();

let pasan = 0, fallan = 0;
function nota(texto, ok, detalle = "") {
  if (ok) pasan++; else fallan++;
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${!ok && detalle ? "  — " + detalle : ""}`);
}

// ---------- Datos ----------
const uid = async (email) => (await db.q(`select id from auth.users where email = $1`, [email]))[0]?.id;
const RP1 = await uid(cred.usuarios.rp), RP2 = await uid("demo_mariana@example.com"), RP3 = await uid("demo_diego@example.com");
if (!RP1 || !RP2 || !RP3) { console.log("Faltan cuentas de dev (sembrar-dev / demo-datos)."); process.exit(1); }
const [flagAntes] = await db.q(`select activa from public.club_funciones where club_id = $1 and funcion = 'antifraude'`, [DEMO]);
const reglasAntes = (await db.q(`select count(*)::int n from public.fraude_reglas where club_id = $1`, [DEMO]))[0].n;
const previas = (await db.q(`select count(*)::int n from public.fraude_alertas where club_id = $1 and ventana_inicio between '2026-10-01' and '2026-10-31'`, [DEMO]))[0].n;
if (previas > 0 || reglasAntes > 0) { console.log("Club Demo Dev ya tiene alertas de octubre o reglas propias: no se corre para no borrar datos ajenos."); process.exit(1); }

async function reserva(rp, tel, fecha, creada) {
  const [r] = await db.q(
    `insert into public.reservations (cliente_nombre, cliente_telefono, rp_id, source, fecha, personas, status, qr_code, club_id, created_at)
     values ('t_n4_fraude_pantalla', $1, $2, $3, $4, 2, 'confirmada', 't_n4_fraude_' || gen_random_uuid(), $5, coalesce($6::timestamptz, now())) returning id`,
    [tel, rp, rp ? "rp" : "organica", fecha, DEMO, creada ?? null]);
  return r.id;
}
async function limpiar() {
  await db.q("begin");
  await db.q(`delete from public.fraude_alertas where club_id = $1 and ventana_inicio between '2026-10-01' and '2026-10-31'`, [DEMO]);
  await db.q(`delete from public.fraude_reglas_cambios where club_id = $1`, [DEMO]);
  await db.q(`delete from public.fraude_reglas where club_id = $1`, [DEMO]);
  await db.q(`delete from public.fraude_detecciones where club_id = $1`, [DEMO]);
  await db.q(`delete from public.reservations where cliente_nombre = 't_n4_fraude_pantalla'`);
  if (flagAntes) await db.q(`update public.club_funciones set activa = $2 where club_id = $1 and funcion = 'antifraude'`, [DEMO, flagAntes.activa]);
  else await db.q(`delete from public.club_funciones where club_id = $1 and funcion = 'antifraude'`, [DEMO]);
  await db.q("commit");
}
const ponerBandera = (activa) => db.q(
  `insert into public.club_funciones (club_id, funcion, activa) values ($1, 'antifraude', $2)
   on conflict (club_id, funcion) do update set activa = excluded.activa`, [DEMO, activa]);
// La base deja una búsqueda cada 2 minutos por antro: entre sesiones de la
// prueba se borra la marca (solo dev).
const permitirBusqueda = () => db.q(`delete from public.fraude_detecciones where club_id = $1`, [DEMO]);

const navegador = await chromium.launch();
async function sesion(email, destino, viewport = { width: 390, height: 844 }) {
  const ctx = await navegador.newContext({ viewport });
  const p = await ctx.newPage();
  const errores = [];
  p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
  p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React/.test(m.text())) errores.push(m.text().slice(0, 140)); });
  for (let intento = 0; intento < 4; intento++) {
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", email);
    await p.fill("#password", cred.password);
    await p.click("button[type=submit]");
    const ok = await p.waitForURL(destino, { timeout: 60000 }).then(() => true).catch(() => false);
    if (ok) break;
    await p.waitForTimeout(3000 * (intento + 1)); // límite de intentos de Auth: esperar y reintentar
  }
  return { ctx, p, errores };
}
const sinScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const texto = (p) => p.locator("body").innerText();
const controlesBajos = (p) => p.evaluate(() => [...document.querySelectorAll("button, a, select, input, textarea, summary")]
  .filter((e) => e.offsetParent !== null && !e.closest("nav[aria-label='Navegación']"))
  // Una casilla dentro de su <label>: el área táctil es la etiqueta completa.
  .map((e) => [e.textContent?.trim().slice(0, 24) || e.getAttribute("aria-label") || e.id || e.tagName,
               Math.round((e.type === "checkbox" && e.closest("label") ? e.closest("label") : e).getBoundingClientRect().height)])
  .filter(([, h]) => h < 40));
const BOTON_BUSCAR = /Buscar alertas nuevas en estas noches/;
const cuantas = (n) => (p) => p.waitForFunction((k) => document.querySelectorAll("[aria-label='Alertas'] > li").length === k, n, { timeout: 30000 }).catch(() => {});
async function abrirOctubre(p) {
  await p.getByRole("heading", { name: /Revisión de RPs/ }).waitFor({ timeout: 60000 });
  await p.locator("#fraude_desde").waitFor({ timeout: 60000 });
  await p.fill("#fraude_desde", "2026-10-05");
  await p.fill("#fraude_hasta", "2026-10-11");
  await p.waitForTimeout(800);
}
async function buscarOctubre(p) {
  await abrirOctubre(p);
  await p.getByRole("button", { name: BOTON_BUSCAR }).click();
  await p.getByText(/Revisado del lun 5 oct al dom 11 oct/).waitFor({ timeout: 60000 });
  await p.waitForTimeout(800);
}

try {
  // Datos de la semana del 5 al 11/10.
  await reserva(RP1, "5512349001", "2026-10-06");
  await reserva(RP2, "+52 55 1234 9001", "2026-10-08");
  await reserva(RP2, "tel 55 12", "2026-10-08"); // ilegible: sale en el resumen
  for (let i = 0; i < 8; i++) await reserva(RP3, `55123491${String(i).padStart(2, "0")}`, "2026-10-10", new Date(Date.UTC(2026, 9, 10, 5, 0) + i * 30_000).toISOString());
  await ponerBandera(true);
  await permitirBusqueda();

  // ---------- Gerente 390 ----------
  {
    const { ctx, p, errores } = await sesion(cred.usuarios.gerente, /staff\/panel/);
    const enlace = p.locator("a[href$=\"/revision\"]", { hasText: "Revisión de RPs" });
    await enlace.waitFor({ timeout: 60000 }).catch(() => {});
    nota("gerente: enlace «Revisión de RPs» en su panel (bandera encendida)", await enlace.isVisible());
    await enlace.click();
    await p.waitForURL(/staff\/revision/, { timeout: 60000 });
    await abrirOctubre(p);
    let t = await texto(p);
    nota("gerente 390: al abrir solo lista (no busca): «Todavía nadie ha buscado» y sin alertas", t.includes("Todavía nadie ha buscado alertas") && t.includes("No hay alertas con estos filtros"), t.slice(0, 400));
    nota("gerente 390: al abrir no se creó ninguna alerta", (await db.q(`select count(*)::int n from public.fraude_alertas where club_id = $1`, [DEMO]))[0].n === 0);
    await p.getByRole("button", { name: BOTON_BUSCAR }).click();
    await p.getByText(/Revisado del lun 5 oct al dom 11 oct/).waitFor({ timeout: 60000 }).catch(() => {});
    await cuantas(2)(p);
    t = await texto(p);
    nota("gerente 390: la búsqueda encuentra 2 alertas nuevas", /2 alerta\(s\) nueva\(s\)/.test(t), t.slice(0, 500));
    nota("gerente 390: avisa del teléfono que no se entiende", t.includes("1 con teléfono que no se entiende"));
    nota("gerente 390: «Última búsqueda … por Gerente Dev»", /Última búsqueda: .* por Gerente Dev/.test(t));
    const tarjetas = p.getByRole("list", { name: "Alertas" }).locator("> li");
    nota("gerente 390: 2 por revisar y «Mostrando 2 de 2»", (await tarjetas.count()) === 2 && t.includes("Mostrando 2 de 2 alerta(s)."));
    nota("gerente 390: el teléfono sale enmascarado en la lista", t.includes("******9001") && !t.includes("5512349001") && !t.includes("1234 9001"));
    nota("gerente 390: ya no hay regla de escaneos", !t.includes("Escaneos duplicados"));
    nota("gerente 390: sin scroll horizontal", await sinScroll(p));
    const bajos = await controlesBajos(p);
    nota("gerente 390: controles de al menos 40 px", bajos.length === 0, JSON.stringify(bajos));
    await p.screenshot({ path: `${SHOTS}lista-gerente-390.png`, fullPage: true });

    // Otra búsqueda enseguida: la base la frena.
    await p.getByRole("button", { name: BOTON_BUSCAR }).click();
    await p.getByText(/hace menos de 2 minutos/).waitFor({ timeout: 30000 }).catch(() => {});
    nota("otra búsqueda enseguida: «hace menos de 2 minutos» y la lista sigue ahí", (await texto(p)).includes("hace menos de 2 minutos") && (await tarjetas.count()) === 2);

    // Filtros
    await p.selectOption("#fraude_regla", "rafaga");
    await cuantas(1)(p);
    nota("filtro por regla: solo la ráfaga", (await tarjetas.count()) === 1 && (await texto(p)).includes("8 reservas creadas en 4 min"));
    await p.selectOption("#fraude_regla", "");
    await cuantas(2)(p);
    const opcionesRp = await p.locator("#fraude_rp option").allInnerTexts();
    nota("filtro por RP: lista los RPs de las alertas", opcionesRp.length === 4, JSON.stringify(opcionesRp));
    await p.selectOption("#fraude_rp", { label: "RP Dev" });
    await cuantas(1)(p);
    nota("filtro por RP (RP Dev): solo el cliente repetido", (await tarjetas.count()) === 1 && (await tarjetas.first().innerText()).includes("Cliente repetido"));
    await p.selectOption("#fraude_rp", "");
    await cuantas(2)(p);

    // Detalle del cliente repetido
    await tarjetas.filter({ hasText: "Cliente repetido" }).getByRole("button", { name: "Ver detalle" }).click();
    await p.getByText("Tu revisión").waitFor({ timeout: 30000 });
    t = await texto(p);
    nota("detalle: «Llegó el jue 8 oct», teléfono enmascarado y los 2 RPs", t.includes("Llegó el jue 8 oct") && t.includes("******9001") && t.includes("2 RPs distintos") && t.includes("RP Dev") && !t.includes("5512349001"));
    nota("detalle: noches de las reservas", t.includes("mar 6 oct") && t.includes("jue 8 oct"));
    nota("detalle: sin scroll horizontal", await sinScroll(p));
    await p.locator("summary", { hasText: "Cómo se calcula" }).click();
    nota("detalle: explica la regla con sus umbrales", (await texto(p)).includes("en los 30 días anteriores ya reservó con otros RPs"));
    const bajosD = await controlesBajos(p);
    nota("detalle: controles de al menos 40 px", bajosD.length === 0, JSON.stringify(bajosD));
    await p.screenshot({ path: `${SHOTS}detalle-gerente-390.png`, fullPage: true });
    await p.getByRole("button", { name: "Descartar" }).click();
    nota("descartar sin nota: pide la nota", await p.getByText("Escribe una nota de al menos 5 caracteres.").isVisible());
    await p.fill("#nota_revision", "Le marqué al 55 1234 9001; es el mismo cliente que cambió de RP");
    await p.getByRole("button", { name: "Descartar" }).click();
    await p.getByRole("button", { name: "Volver a revisar" }).waitFor({ timeout: 30000 });
    t = await texto(p);
    nota("descartada: estado, historial con la nota (teléfono enmascarado) y quién", t.includes("Descartada") && t.includes("Por revisar → Descartada")
      && t.includes("«Le marqué al ******9001; es el mismo cliente que cambió de RP»") && !t.includes("55 1234 9001") && t.includes("Gerente Dev"), t.slice(-500));
    await p.locator("summary", { hasText: "Evidencia con la que se decidió" }).click();
    nota("historial: la evidencia con la que se decidió", (await p.locator("details[open]").last().innerText()).includes("2 RPs distintos"));
    await p.screenshot({ path: `${SHOTS}detalle-descartada-390.png`, fullPage: true });
    await p.getByRole("button", { name: "← Volver a la lista" }).click();
    await cuantas(1)(p);
    nota("lista «Por revisar»: queda 1", (await tarjetas.count()) === 1);
    await p.selectOption("#fraude_estado", "descartada");
    await p.getByText("Revisada por Gerente Dev").waitFor({ timeout: 30000 }).catch(() => {});
    nota("filtro «Descartada»: la del cliente, con quién la revisó", (await tarjetas.count()) === 1 && (await tarjetas.first().innerText()).includes("Revisada por Gerente Dev"));
    await p.selectOption("#fraude_estado", "confirmada");
    await p.getByText("No hay alertas con estos filtros").waitFor({ timeout: 30000 }).catch(() => {});
    nota("estado vacío: «No hay alertas con estos filtros»", await p.getByText("No hay alertas con estos filtros").isVisible());

    // Reglas
    await p.getByRole("tab", { name: "Reglas y umbrales" }).click();
    await p.getByText("Cambios recientes").waitFor({ timeout: 30000 });
    { const tr = await texto(p); nota("reglas: las 3 con su explicación (sin escaneos)", ["Cliente repetido entre RPs", "Ráfaga de reservas", "Consumo atípico"].every((x) => tr.includes(x)) && !tr.includes("Escaneos duplicados") && tr.includes("mediana") && tr.includes("8 o más reservas en 10 minutos")); }
    const tarjetaRafaga = p.locator("#regla_rafaga_minutos").locator("xpath=ancestor::div[contains(@class,'flex-col gap-3')][1]");
    await p.fill("#regla_rafaga_minutos", "1000");
    await tarjetaRafaga.getByRole("button", { name: "Guardar regla" }).click();
    nota("reglas: valor fuera de rango avisa antes de guardar", await p.getByText("«Minutos» debe estar entre 1 y 240.").isVisible());
    await p.fill("#regla_rafaga_minutos", "12");
    await tarjetaRafaga.getByRole("button", { name: "Guardar regla" }).click();
    await p.getByText("Minutos: 10 → 12").waitFor({ timeout: 30000 }).catch(() => {});
    t = await texto(p);
    nota("reglas: guardada y en la bitácora con quién", t.includes("Ráfaga de reservas: Minutos: 10 → 12") && t.includes("Gerente Dev"), t.slice(-300));
    const [guardada] = await db.q(`select parametros from public.fraude_reglas where club_id = $1 and regla = 'rafaga'`, [DEMO]);
    nota("reglas: la base guardó 12 minutos", guardada?.parametros?.minutos === 12);
    nota("reglas: sin scroll horizontal", await sinScroll(p));
    const bajosR = await controlesBajos(p);
    nota("reglas: controles de al menos 40 px", bajosR.length === 0, JSON.stringify(bajosR));
    await p.screenshot({ path: `${SHOTS}reglas-gerente-390.png`, fullPage: true });
    // El aviso de «menos de 2 minutos» es un 400 esperado de la API.
    nota("gerente 390: sin errores en consola (fuera del 400 esperado)", errores.filter((e) => !/status of 400/.test(e)).length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ---------- Gerente 360: «ya no se cumple» ----------
  {
    // La ráfaga deja de cumplirse si se piden 20 reservas.
    await db.q(`update public.fraude_reglas set parametros = parametros || '{"min_reservas": 20}' where club_id = $1 and regla = 'rafaga'`, [DEMO]);
    await permitirBusqueda();
    const { ctx, p, errores } = await sesion(cred.usuarios.gerente, /staff\/panel/, { width: 360, height: 740 });
    await p.goto(BASE + "/staff/revision");
    await buscarOctubre(p);
    await p.selectOption("#fraude_estado", "");
    await cuantas(2)(p);
    let t = await texto(p);
    nota("gerente 360: 2 alertas (todas), sin duplicar; «1 que ya no se cumplen»", (await p.getByRole("list", { name: "Alertas" }).locator("> li").count()) === 2
      && t.includes("0 alerta(s) nueva(s)") && t.includes("1 que ya no se cumplen"), t.slice(0, 600));
    nota("gerente 360: la ráfaga dice «Ya no se cumple»", (await p.getByRole("list", { name: "Alertas" }).locator("> li").filter({ hasText: "Ráfaga" }).innerText()).includes("Ya no se cumple"));
    nota("gerente 360: sin scroll horizontal (lista)", await sinScroll(p));
    await p.screenshot({ path: `${SHOTS}lista-gerente-360.png`, fullPage: true });
    await p.getByRole("list", { name: "Alertas" }).locator("> li").filter({ hasText: "Ráfaga" }).getByRole("button", { name: "Ver detalle" }).click();
    await p.getByText("Tu revisión").waitFor({ timeout: 30000 });
    t = await texto(p);
    nota("gerente 360: el detalle explica que ya no se cumplía y conserva la evidencia", t.includes("esto ya no se cumplía") && t.includes("8 reservas creadas entre 23:00 y 23:03"));
    nota("gerente 360: sin scroll horizontal (detalle)", await sinScroll(p));
    await p.screenshot({ path: `${SHOTS}detalle-ya-no-aplica-360.png`, fullPage: true });
    nota("gerente 360: sin errores en consola", errores.length === 0, errores.join(" | "));
    await ctx.close();
    await db.q(`update public.fraude_reglas set parametros = parametros || '{"min_reservas": 8}' where club_id = $1 and regla = 'rafaga'`, [DEMO]);
    await permitirBusqueda();
  }

  // ---------- Dueño 390 ----------
  {
    const { ctx, p, errores } = await sesion(cred.usuarios.dueno, /dueno\/panel/);
    const enlace = p.locator("a[href$=\"/revision\"]", { hasText: "Revisión de RPs" });
    await enlace.waitFor({ timeout: 60000 }).catch(() => {});
    nota("dueño: enlace «Revisión de RPs» en su panel", await enlace.isVisible());
    await enlace.click();
    await p.waitForURL(/dueno\/revision/, { timeout: 60000 });
    await buscarOctubre(p);
    nota("dueño: sin selector de antro (Tijuana sin bandera)", (await p.locator("#fraude_antro").count()) === 0);
    const tarjetas = p.getByRole("list", { name: "Alertas" }).locator("> li");
    await cuantas(1)(p);
    nota("dueño: la ráfaga vuelve a cumplirse (sin «Ya no se cumple») y es la única por revisar", (await tarjetas.count()) === 1 && !(await tarjetas.first().innerText()).includes("Ya no se cumple"));
    await tarjetas.filter({ hasText: "Ráfaga" }).getByRole("button", { name: "Ver detalle" }).click();
    await p.getByText("Tu revisión").waitFor({ timeout: 30000 });
    nota("dueño: detalle de la ráfaga (8 reservas entre 23:00 y 23:03)", (await texto(p)).includes("8 reservas creadas entre 23:00 y 23:03"));
    await p.fill("#nota_revision", "Capturó reservas falsas, se habló con él");
    await p.getByRole("button", { name: "Confirmar" }).click();
    await p.getByRole("button", { name: "Volver a revisar" }).waitFor({ timeout: 30000 });
    const t = await texto(p);
    nota("dueño: confirmada con nota y su nombre en el historial", t.includes("Confirmada") && t.includes("Por revisar → Confirmada") && t.includes("Dueña Dev"), t.slice(-300));
    const [fila] = await db.q(`select a.estado, (select count(*)::int from public.fraude_alertas_cambios c where c.alerta_id = a.id) n
                                 from public.fraude_alertas a where a.club_id = $1 and a.regla = 'rafaga' and a.ventana_inicio = '2026-10-09'`, [DEMO]);
    nota("dueño: la base tiene la alerta confirmada con 1 cambio", fila?.estado === "confirmada" && fila?.n === 1, JSON.stringify(fila));
    await p.screenshot({ path: `${SHOTS}detalle-dueno-390.png`, fullPage: true });
    nota("dueño: sin scroll horizontal", await sinScroll(p));
    nota("dueño: sin errores en consola", errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ---------- Staff y RP: no la ven ----------
  {
    const { ctx, p } = await sesion(cred.usuarios.staff, /staff\/panel/);
    await p.getByRole("button", { name: "Escanear QR" }).waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(1500);
    nota("staff: sin enlace «Revisión de RPs» en su panel", (await p.locator("a[href$=\"/revision\"]", { hasText: "Revisión de RPs" }).count()) === 0);
    await p.goto(BASE + "/staff/revision");
    await p.getByText("Solo el gerente revisa a los RPs.").waitFor({ timeout: 60000 }).catch(() => {});
    const t = await texto(p);
    nota("staff: /staff/revision dice «Solo el gerente revisa a los RPs.» y no muestra alertas", t.includes("Solo el gerente revisa a los RPs.") && !t.includes("Ráfaga de reservas"));
    await p.screenshot({ path: `${SHOTS}staff-sin-acceso-390.png`, fullPage: true });
    await ctx.close();
  }
  {
    const { ctx, p } = await sesion(cred.usuarios.rp, /rp\/panel/);
    for (const ruta of ["/staff/revision", "/dueno/revision", "/admin/revision"]) {
      await p.goto(BASE + ruta);
      await p.waitForTimeout(4000);
      const t = await texto(p);
      nota(`RP: ${ruta} no le muestra alertas`, !/Ráfaga de reservas|Cliente repetido|Tu revisión/.test(t) && !p.url().endsWith(ruta), p.url());
    }
    await ctx.close();
  }

  // ---------- Admin ----------
  {
    const { ctx, p, errores } = await sesion(cred.usuarios.admin, /\/admin/);
    const enlace = p.locator("a[href$=\"/revision\"]", { hasText: "Revisión de RPs" });
    await enlace.waitFor({ timeout: 60000 }).catch(() => {});
    nota("admin: enlace «Revisión de RPs» junto a «Alertas de reporte»", await enlace.isVisible());
    await p.goto(BASE + "/admin/revision");
    await abrirOctubre(p);
    await p.selectOption("#fraude_estado", "");
    await cuantas(2)(p);
    const t = await texto(p);
    nota("admin: sin buscar, ve las 2 alertas guardadas con su estado (descartada y confirmada)", (await p.getByRole("list", { name: "Alertas" }).locator("> li").count()) === 2
      && t.includes("Descartada") && t.includes("Confirmada") && t.includes("Revisada por Dueña Dev"));
    nota("admin: sin scroll horizontal", await sinScroll(p));
    await p.screenshot({ path: `${SHOTS}lista-admin-390.png`, fullPage: true });
    nota("admin: sin errores en consola", errores.length === 0, errores.join(" | "));
    await ctx.close();
  }

  // ---------- Bandera apagada ----------
  await ponerBandera(false);
  {
    const { ctx, p } = await sesion(cred.usuarios.gerente, /staff\/panel/);
    await p.locator("a[href=\"/staff/nomina\"]").waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(2000);
    nota("bandera apagada: el gerente ya no ve el enlace", (await p.locator("a[href$=\"/revision\"]", { hasText: "Revisión de RPs" }).count()) === 0);
    await p.goto(BASE + "/staff/revision");
    await p.getByText("no está activa").waitFor({ timeout: 60000 }).catch(() => {});
    const t = await texto(p);
    nota("bandera apagada: la pantalla avisa que no está activa (no «sin permiso»)", t.includes("La revisión de RPs no está activa para tu antro.") && !t.includes("no tiene permiso"));
    await p.screenshot({ path: `${SHOTS}inactiva-gerente-390.png` });
    await ctx.close();
  }
} catch (e) {
  nota("la prueba corrió completa", false, e.message);
} finally {
  await navegador.close();
  await limpiar().catch((e) => { console.log("limpieza:", e.message); });
  const [q] = await db.q(`select (select count(*)::int from public.reservations where cliente_nombre like 't_n4_fraude%') r,
    (select count(*)::int from public.fraude_alertas where club_id = $1) a,
    (select count(*)::int from public.fraude_reglas where club_id = $1) g,
    (select count(*)::int from public.fraude_detecciones where club_id = $1) d,
    (select count(*)::int from public.club_funciones where club_id = $1 and funcion = 'antifraude') f`, [DEMO]);
  nota("limpieza: 0 reservas, alertas, reglas y búsquedas de prueba; bandera como estaba", q.r === 0 && q.a === 0 && q.g === 0 && q.d === 0 && q.f === (flagAntes ? 1 : 0), JSON.stringify(q));
  await db.fin();
}
console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exit(fallan ? 1 : 0);
