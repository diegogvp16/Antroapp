// SOLO DEV. Pantalla «Ventas del POS» (/staff/pos y /dueno/pos) con
// Playwright contra el servidor local de dev y antroapp-dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-pos-pantalla.mjs [http://localhost:3041]
//
// Usa su propio escenario (scripts/dev/pos-escenario-prueba.mjs) y lo borra
// al final. Recorre:
// - gerente (390×844): enlace en su panel solo con la bandera encendida;
//   sube un CSV, revisa el mapeo propuesto, lo guarda, ve la vista previa
//   (error por línea, sin ligar con candidatas), asigna una cuenta, importa
//   y ve la conciliación; asigna un ticket pendiente;
// - dueño (360×740): sube un .xlsx generado en la prueba, importa, intenta
//   el mismo archivo otra vez (bloqueado) y deshace una importación;
// - staff del antro y gerente de un antro con la bandera apagada: sin
//   enlace y con el aviso;
// - sin scroll horizontal, controles de al menos 40 px, sin errores.
// Capturas en screenshots-n4-pos/ (ignorada por Git).

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crearEscenario } from "./pos-escenario-prueba.mjs";
import { crearXlsx } from "./pos-archivos-prueba.mjs";
import { REF_DEV, REF_PROD } from "../db/conexion.mjs";

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
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3041";
const SHOTS = path.join(RAIZ, "screenshots-n4-pos");
mkdirSync(SHOTS, { recursive: true });

let pasan = 0, fallan = 0;
function ok(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK   " : "FALLA"}  ${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}
let nCaptura = 0;
async function captura(p, nombre) {
  const archivo = path.join(SHOTS, `${String(++nCaptura).padStart(2, "0")}-${nombre}.png`);
  await p.screenshot({ path: archivo, fullPage: true });
}

const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
const CSV = [
  ["Folio", "Fecha", "Hora", "Mesa", "Comensal", "Producto", "Cant", "Precio", "Importe", "Forma de pago", "Mesero"],
  ["T1", "07/10/2026", "23:15", "1", "", "Botella", "1", "$1,500.00", "$1,500.00", "Tarjeta", "Ana"],
  ["T2", "08/10/2026", "01:30", "Mesa 1", "", "Cerveza", "4", "$100.00", "$400.00", "Efectivo", "Ana"],
  ["T2", "08/10/2026", "01:30", "Mesa 1", "", "Shots", "4", "$100.00", "$400.00", "Efectivo", "Ana"],
  ["T3", "08/10/2026", "02:00", "01", "Caro t_n4_pos", "Copa", "3", "$150", "$450.00", "", ""],
  ["T4", "08/10/2026", "00:10", "02", "", "Botella", "1", "$1000", "$1,000.00", "", ""],
  ["T5", "07/10/2026", "23:50", "99", "", "Agua", "1", "$50", "$50.00", "", ""],
  ["T6", "08/10/2026", "05:00", "1", "", "Café", "1", "$40", "$40.00", "", ""],
  ["T7", "07/10/2026", "", "3", "", "Sin hora", "1", "$10", "$10.00", "", ""],
  ["", "", "", "", "", "TOTAL", "", "", "$3,840.00", "", ""],
].map((f) => f.map(q).join(",")).join("\r\n");

const sinScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const controlesBajos = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("main button, main a, main select, main input, body > div button, body > div select, body > div input")]
      .filter((e) => e.offsetParent !== null && e.getAttribute("type") !== "hidden")
      .map((e) => {
        const caja = (e.type === "checkbox" ? e.closest("label") ?? e : e).getBoundingClientRect();
        return [e.textContent?.trim().slice(0, 24) || e.getAttribute("aria-label") || e.id || e.tagName, Math.round(caja.height)];
      })
      .filter(([, h]) => h < 40),
  );

const e = await crearEscenario();
const A = e.clubs.A;
const navegador = await chromium.launch();
async function sesion(email, destino, viewport) {
  const ctx = await navegador.newContext({ viewport });
  const p = await ctx.newPage();
  const errores = [];
  p.on("pageerror", (x) => errores.push(x.message.slice(0, 140)));
  p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React/.test(m.text())) errores.push(m.text().slice(0, 160)); });
  p.on("response", (r) => { if (r.status() >= 400 && !/favicon|_next\/webpack-hmr/.test(r.url())) errores.push(`HTTP ${r.status()} ${r.url().slice(0, 100)}`); });
  for (let intento = 0; intento < 4; intento++) {
    await p.goto(BASE + "/cliente/login", { timeout: 120000 });
    await p.fill("#email", email);
    await p.fill("#password", e.PASS);
    await p.click("button[type=submit]");
    const llego = await p.waitForURL(destino, { timeout: 90000 }).then(() => true, () => false);
    if (llego) break;
    const texto = await p.locator("body").innerText();
    if (!/intentos|límite|espera/i.test(texto)) break;
    console.log("(límite de inicio de sesión; espero 30 s)");
    await p.waitForTimeout(30000);
  }
  return { ctx, p, errores };
}
const encenderBandera = (activa) =>
  activa
    ? e.db.q("insert into public.club_funciones (club_id, funcion, activa) values ($1, 'pos_ventas', true) on conflict (club_id, funcion) do update set activa = true", [A])
    : e.db.q("delete from public.club_funciones where club_id = $1 and funcion = 'pos_ventas'", [A]);

try {
  // ============ Gerente con la bandera APAGADA: sin enlace ============
  const g = await sesion(e.usuarios.gerente.email, /staff\/panel/, { width: 390, height: 844 });
  {
    await g.p.locator(`a[href="/staff/exportar"]`).waitFor({ timeout: 90000 }).catch(() => {});
    await g.p.waitForTimeout(1500);
    ok(!(await g.p.locator(`a[href="/staff/pos"]`).isVisible()), "bandera apagada: el panel del gerente no enlaza a «Ventas del POS»");
    // El JS servido es el de dev, nunca el de producción.
    const refs = await g.p.evaluate(async ([dev, prod]) => {
      const urls = performance.getEntriesByType("resource").map((r) => r.name).filter((u) => u.includes("/_next/") && u.endsWith(".js"));
      let hayDev = false, hayProd = false;
      for (const u of urls) {
        const t = await (await fetch(u)).text();
        if (t.includes(dev)) hayDev = true;
        if (t.includes(prod)) hayProd = true;
      }
      return { hayDev, hayProd, n: urls.length };
    }, [REF_DEV, REF_PROD]);
    ok(refs.hayDev && !refs.hayProd, "el JS servido trae el ref de dev y no el de producción", JSON.stringify(refs));
    await g.p.goto(BASE + "/staff/pos");
    await g.p.getByText("no están activas para tu antro").waitFor({ timeout: 60000 }).catch(() => {});
    ok(await g.p.getByText("no están activas para tu antro").isVisible(), "bandera apagada: /staff/pos dice que no está activa");
  }

  // ============ Gerente con la bandera ENCENDIDA: CSV ============
  await encenderBandera(true);
  {
    const { p, errores } = g;
    await p.goto(BASE + "/staff/panel");
    const enlace = p.locator(`a[href="/staff/pos"]`);
    const hayEnlace = await enlace.waitFor({ timeout: 90000 }).then(() => true, () => false);
    ok(hayEnlace, "bandera encendida: el panel del gerente enlaza a «Ventas del POS»", p.url());
    if (!hayEnlace) {
      await captura(p, "fallo-enlace-gerente");
      throw new Error("sin enlace; texto: " + (await p.locator("body").innerText()).slice(0, 400) + " | " + errores.join(" | "));
    }
    const alto = await enlace.evaluate((x) => x.getBoundingClientRect().height);
    ok(alto >= 40, "el enlace mide al menos 40 px", String(alto));
    await captura(p, "gerente-panel-enlace");
    await enlace.click();
    await p.waitForURL(/staff\/pos/, { timeout: 60000 });
    await p.locator("#pos-archivo").waitFor({ timeout: 60000 });
    await captura(p, "gerente-paso1-archivo");
    await p.setInputFiles("#pos-archivo", { name: "ventas-noche.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
    await p.locator("#pos-campo-ticket").waitFor({ timeout: 30000 });
    const sel = async (campo) => p.locator(`#pos-campo-${campo}`).inputValue();
    ok((await sel("ticket")) === "Folio" && (await sel("fecha")) === "Fecha" && (await sel("hora")) === "Hora" && (await sel("mesa")) === "Mesa" && (await sel("total")) === "Importe" && (await sel("cuenta")) === "Comensal",
      "mapeo propuesto por los encabezados");
    ok(await p.getByText("Ej.: T1 · T2").isVisible(), "el mapeo muestra ejemplos de cada columna");
    const montos = await p.locator("#pos-formato-montos option").first().innerText();
    ok(/Automático: punto decimal/.test(montos), "formato de montos detectado por la columna: punto decimal", montos);
    ok(!(await p.getByText(/parece la hora de CIERRE/).isVisible()), "con «Hora» (no de cierre) no hay aviso de cierre");
    ok(await sinScroll(p), "paso de mapeo: sin scroll horizontal (390)");
    ok((await controlesBajos(p)).length === 0, "paso de mapeo: controles de al menos 40 px", JSON.stringify(await controlesBajos(p)));
    await captura(p, "gerente-paso2-mapeo");
    await p.fill("#pos-nombre-mapeo", "POS de prueba");
    await p.getByRole("button", { name: "Guardar", exact: true }).click();
    ok(await p.getByText("Mapeo «POS de prueba» guardado").waitFor({ timeout: 30000 }).then(() => true, () => false), "guarda el mapeo");
    await p.getByRole("button", { name: "3. Revisar ventas" }).click();
    await p.getByTestId("pos-resumen").waitFor({ timeout: 60000 });
    const resumen = await p.getByTestId("pos-resumen").innerText();
    ok(/Ventas nuevas\s*7/.test(resumen) && /Con error \(no entran\)\s*1/.test(resumen) && /\$3,840/.test(resumen), "vista previa: 7 nuevas, 1 con error, $3,840", resumen.replace(/\n/g, " | "));
    ok(await p.getByText("Línea 9").isVisible() && await p.getByText(/falta la hora/).isVisible(), "el error dice la línea y el motivo");
    ok(await p.getByText("Se ignora 1 fila de totales").isVisible(), "la fila TOTAL se ignora con aviso");
    const importarBtn = p.getByRole("button", { name: /^Importar 7 ventas$/ });
    ok(await importarBtn.isDisabled(), "con líneas con error, importar pide confirmar que se omiten");
    await captura(p, "gerente-paso3-errores");
    await p.getByRole("tab", { name: /Sin ligar/ }).click();
    const selT2 = p.getByLabel("Cuenta para el ticket T2");
    ok(await selT2.isVisible(), "T2 (01:30, entre dos grupos de la mesa 1) ofrece elegir cuenta");
    const opciones = await selT2.locator("option").allInnerTexts();
    ok(["Ana", "Beto", "Caro"].every((n) => opciones.some((o) => o.includes(n))), "candidatas de los dos grupos: Ana, Beto y Caro", JSON.stringify(opciones));
    await selT2.selectOption({ label: opciones.find((o) => /Beto/.test(o)) });
    ok(/Ligadas a caja\s*5/.test(await p.getByTestId("pos-resumen").innerText()), "al elegir a Beto, ligadas sube de 3 a 5");
    ok(await sinScroll(p), "vista previa: sin scroll horizontal (390)");
    ok((await controlesBajos(p)).length === 0, "vista previa: controles de al menos 40 px", JSON.stringify(await controlesBajos(p)));
    await captura(p, "gerente-paso3-sin-ligar");
    await p.getByRole("checkbox").check();
    await importarBtn.click();
    await p.getByTestId("pos-resultado").waitFor({ timeout: 60000 });
    const res = await p.getByTestId("pos-resultado").innerText();
    ok(/7 ventas nuevas por \$3,840/.test(res) && /5 ligadas/.test(res) && /2 sin ligar/.test(res), "importado: 7 nuevas, 5 ligadas, 2 sin ligar", res);
    await captura(p, "gerente-importado");
    await p.getByRole("button", { name: /Ver la conciliación/ }).click();
    await p.getByTestId("pos-mesas").locator("li").first().waitFor({ timeout: 60000 });
    ok((await p.locator("#pos-noche").inputValue()) === "2026-10-07", "abre la noche de las ventas (07/10)");
    const totales = await p.getByTestId("pos-totales").innerText();
    ok(/Caja\s*\$4,500/.test(totales) && /POS\s*\$3,840/.test(totales), "totales de la noche: caja $4,500 y POS $3,840", totales.replace(/\n/g, " | "));
    const mesas = await p.getByTestId("pos-mesas").innerText();
    ok(/Mesa 1[\s\S]*Ana[\s\S]*Coincide/.test(mesas) && /Mesa 3[\s\S]*Solo caja/.test(mesas) && /mesa «99»[\s\S]*Solo POS/.test(mesas) && /Diferencia/.test(mesas),
      "por mesa: coincide, diferencia, solo caja y solo POS", mesas.slice(0, 500).replace(/\n/g, " | "));
    ok(await sinScroll(p), "conciliación: sin scroll horizontal (390)");
    ok((await controlesBajos(p)).length === 0, "conciliación: controles de al menos 40 px", JSON.stringify(await controlesBajos(p)));
    await captura(p, "gerente-conciliacion");
    // Asignar el pendiente T6 a Ana desde la conciliación.
    const selT6 = p.getByLabel("Cuenta para el ticket T6");
    const ops = await selT6.locator("option").allInnerTexts();
    await selT6.selectOption({ label: ops.find((o) => /Ana/.test(o)) });
    await p.locator("li", { has: selT6 }).getByRole("button", { name: "Asignar" }).click();
    ok(await p.getByText("Ticket T6 asignado.").waitFor({ timeout: 30000 }).then(() => true, () => false), "asigna el ticket T6 a Ana desde la conciliación");
    await p.waitForTimeout(800);
    ok(/POS\s*\$3,840/.test(await p.getByTestId("pos-totales").innerText()) && !(await p.getByLabel("Cuenta para el ticket T6").isVisible()), "T6 ya no está pendiente; el total del POS no cambia");
    // Reasignar y quitar la cuenta de un ticket que se ligó solo (T3: Caro).
    await p.getByRole("tab", { name: /^Todos/ }).click();
    const selT3 = p.getByLabel("Cuenta para el ticket T3");
    ok(await selT3.isVisible(), "en «Todos» se ven también los tickets ligados");
    const itemT3 = p.getByTestId("pos-tickets").locator("li", { has: selT3 });
    ok(/Cuenta: Caro/.test(await itemT3.innerText()), "T3 dice su cuenta (Caro)");
    const opsT3 = await selT3.locator("option").allInnerTexts();
    await selT3.selectOption({ label: opsT3.find((o) => /Beto/.test(o)) });
    await itemT3.getByRole("button", { name: "Reasignar" }).click();
    ok(await p.getByText("Ticket T3 reasignado.").waitFor({ timeout: 30000 }).then(() => true, () => false), "reasigna T3 a Beto");
    const [t3] = await e.db.q("select cuenta_id, liga from public.pos_ventas where club_id = $1 and ticket = 'T3'", [A]);
    ok(t3.cuenta_id === e.cuentas.C2 && t3.liga === "manual", "en la base: T3 con Beto, a mano");
    await p.getByTestId("pos-tickets").locator("li", { has: p.getByLabel("Cuenta para el ticket T3") }).getByRole("button", { name: "Quitar cuenta" }).click();
    ok(await p.getByText("Ticket T3: se le quitó la cuenta.").waitFor({ timeout: 30000 }).then(() => true, () => false), "quita la cuenta de T3");
    const [t3b] = await e.db.q("select cuenta_id, estado_liga from public.pos_ventas where club_id = $1 and ticket = 'T3'", [A]);
    ok(t3b.cuenta_id === null && t3b.estado_liga === "desligada", "en la base: T3 sin cuenta («desligada»)");
    ok(await sinScroll(p), "tickets: sin scroll horizontal (390)");
    ok((await controlesBajos(p)).length === 0, "tickets: controles de al menos 40 px", JSON.stringify(await controlesBajos(p)));
    await captura(p, "gerente-tickets-reasignar");
    const [caja] = await e.db.q("select count(*)::int n, coalesce(sum(monto_centavos), 0)::int s from public.caja_consumos where club_id = $1", [A]);
    ok(caja.n === 6 && caja.s === 549999, "la caja del antro sigue igual (6 consumos, uno anulado)", JSON.stringify(caja));
    ok(errores.length === 0, "gerente: sin errores en consola ni HTTP", errores.join(" | "));
    await g.ctx.close();
  }

  // ============ Dueño a 360: Excel ============
  {
    const d = await sesion(e.usuarios.dueno.email, /dueno\/panel/, { width: 360, height: 740 });
    const { p, errores } = d;
    const enlace = p.locator(`a[href="/dueno/pos"]`);
    ok(await enlace.waitFor({ timeout: 90000 }).then(() => true, () => false), "el panel del dueño enlaza a «Ventas del POS»");
    await captura(p, "dueno-panel-enlace");
    await enlace.click();
    await p.waitForURL(/dueno\/pos/, { timeout: 60000 });
    await p.locator("#pos-archivo").waitFor({ timeout: 60000 });
    const libro = await crearXlsx([
      ["Reporte de ventas"],
      [],
      ["No. Ticket", "Fecha de cierre", "No. Mesa", "Artículo", "Cantidad", "Importe", "Mesero"],
      ["X-1", { fecha: "2026-10-07 23:40" }, 3, "Champaña", 1, { num: 700 }, "Luis"],
      ["X-2", { fecha: "2026-10-08 00:15" }, "VIP 1", "Shots", 2, { num: 160.5 }, "Luis"],
    ]);
    await p.setInputFiles("#pos-archivo", { name: "ventas.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(libro) });
    await p.locator("#pos-campo-ticket").waitFor({ timeout: 30000 });
    ok((await p.locator("#pos-campo-ticket").inputValue()) === "No. Ticket" && (await p.locator("#pos-campo-fecha").inputValue()) === "Fecha de cierre" && (await p.locator("#pos-campo-mesa").inputValue()) === "No. Mesa",
      "Excel: encabezados debajo del título y mapeo propuesto");
    ok(await p.getByText(/«Fecha de cierre» parece la hora de CIERRE/).isVisible(), "solo hay fecha de cierre: se usa, con aviso de que puede ligar al grupo equivocado");
    ok(await p.getByText("Los encabezados están en la fila 3").isVisible(), "avisa en qué fila están los encabezados");
    ok(await sinScroll(p), "Excel, mapeo: sin scroll horizontal (360)");
    ok((await controlesBajos(p)).length === 0, "Excel, mapeo: controles de al menos 40 px (360)", JSON.stringify(await controlesBajos(p)));
    await captura(p, "dueno-xlsx-mapeo-360");
    await p.getByRole("button", { name: "3. Revisar ventas" }).click();
    await p.getByTestId("pos-resumen").waitFor({ timeout: 60000 });
    const resumen = await p.getByTestId("pos-resumen").innerText();
    ok(/Ventas nuevas\s*2/.test(resumen) && /\$860\.50/.test(resumen) && /Ligadas a caja\s*1/.test(resumen), "Excel: 2 nuevas por $860.50, 1 ligada (mesa 3)", resumen.replace(/\n/g, " | "));
    ok(await sinScroll(p), "Excel, vista previa: sin scroll horizontal (360)");
    await captura(p, "dueno-xlsx-revision-360");
    await p.getByRole("button", { name: /^Importar 2 ventas$/ }).click();
    await p.getByTestId("pos-resultado").waitFor({ timeout: 60000 });
    ok(/2 ventas nuevas por \$860\.50/.test(await p.getByTestId("pos-resultado").innerText()), "Excel importado");
    // El mismo archivo otra vez: la vista previa lo detecta y no deja importar.
    await p.getByRole("button", { name: "Importar otro archivo" }).click();
    await p.setInputFiles("#pos-archivo", { name: "ventas.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(libro) });
    await p.getByRole("button", { name: "3. Revisar ventas" }).click();
    await p.getByText("Este mismo archivo ya se importó").waitFor({ timeout: 60000 });
    ok(await p.getByRole("button", { name: /^Importar 0 ventas$/ }).isDisabled(), "el mismo Excel otra vez: aviso y botón desactivado (0 nuevas)");
    await captura(p, "dueno-xlsx-repetido-360");
    // Importaciones: deshacer la del Excel.
    await p.getByRole("tab", { name: "Importaciones" }).click();
    const item = p.locator("li", { hasText: "ventas.xlsx" });
    await item.waitFor({ timeout: 30000 });
    ok(await p.locator("li", { hasText: "ventas-noche.csv" }).isVisible(), "importaciones: se ven las dos (CSV del gerente y Excel)");
    await item.getByRole("button", { name: "Deshacer" }).click();
    await item.getByLabel("Motivo").fill("Prueba de deshacer");
    await item.getByRole("button", { name: /Deshacer \(2 ventas se borran\)/ }).click();
    ok(await p.getByText("Importación deshecha: 2 ventas borradas.").waitFor({ timeout: 30000 }).then(() => true, () => false), "deshacer dice cuántas borró");
    ok(await item.getByText("Deshecha").waitFor({ timeout: 30000 }).then(() => true, () => false), "deshacer: la importación queda marcada");
    ok(await sinScroll(p), "importaciones: sin scroll horizontal (360)");
    ok((await controlesBajos(p)).length === 0, "importaciones: controles de al menos 40 px (360)", JSON.stringify(await controlesBajos(p)));
    await captura(p, "dueno-importaciones-360");
    await p.getByRole("tab", { name: "Conciliar" }).click();
    await p.fill("#pos-noche", "2026-10-07");
    // Cambiar de noche con otra carga en camino: debe quedar la noche elegida
    // (antes, la respuesta vieja pisaba a la nueva).
    await p.getByTestId("pos-totales").filter({ hasText: "$3,840" }).waitFor({ timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(1500);
    ok(/POS\s*\$3,840/.test(await p.getByTestId("pos-totales").innerText()), "tras deshacer el Excel, el POS vuelve a $3,840 (y una respuesta vieja no pisa la noche elegida)");
    await captura(p, "dueno-conciliacion-360");
    ok(errores.length === 0, "dueño: sin errores en consola ni HTTP", errores.join(" | "));
    await d.ctx.close();
  }

  // ============ Staff del antro y gerente de un antro con la bandera apagada ============
  {
    const s = await sesion(e.usuarios.staff.email, /staff\/panel/, { width: 390, height: 844 });
    await s.p.getByText("Caja y mesas de la noche").waitFor({ timeout: 90000 }).catch(() => {}); await s.p.waitForTimeout(2500);
    ok(!(await s.p.locator(`a[href="/staff/pos"]`).isVisible()), "staff: sin enlace (aunque la bandera esté encendida)");
    await s.p.goto(BASE + "/staff/pos");
    ok(await s.p.getByText("son para el gerente y el dueño").waitFor({ timeout: 60000 }).then(() => true, () => false), "staff: /staff/pos muestra el aviso");
    await captura(s.p, "staff-sin-acceso");
    await s.ctx.close();
    const b = await sesion(e.usuarios.gerente_b.email, /staff\/panel/, { width: 390, height: 844 });
    await b.p.locator(`a[href="/staff/exportar"]`).waitFor({ timeout: 90000 }).catch(() => {}); await b.p.waitForTimeout(2500);
    ok(!(await b.p.locator(`a[href="/staff/pos"]`).isVisible()), "gerente de otro antro (bandera apagada): sin enlace");
    await b.p.goto(BASE + "/staff/pos");
    ok(await b.p.getByText("no están activas para tu antro").waitFor({ timeout: 60000 }).then(() => true, () => false), "gerente de otro antro: «no están activas»");
    await b.ctx.close();
  }
} catch (x) {
  ok(false, "la prueba terminó sin excepción", x.stack);
} finally {
  await navegador.close();
  await encenderBandera(false).catch(() => {});
  const { errores, resto } = await e.limpiar();
  ok(errores.length === 0, "limpieza sin errores", errores.join(" | "));
  ok(resto.usuarios === 0 && resto.clubs === 0 && resto.cuentas === 0 && resto.ventas === 0, "0 restos de prueba", JSON.stringify(resto));
  writeFileSync(path.join(SHOTS, "resultado.txt"), `${pasan}/${pasan + fallan}\n`);
}
console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exit(fallan ? 1 : 0);
