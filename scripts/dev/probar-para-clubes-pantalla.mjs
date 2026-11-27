// SOLO DEV. Prueba de pantalla de /para-clubes (bloque 5, noche 4), con
// Playwright, contra un servidor local que apunta a antroapp-dev.
//
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-para-clubes-pantalla.mjs [--base=http://localhost:3046]
//
// Recorre: bandera apagada → 404; el admin la enciende desde /admin/funciones;
// la página a 390×844, 360×740 y 1280×800 (capturas, desborde, controles de
// 40 px, etiquetas, contraste, foco con teclado, cambios de diseño al cargar,
// Club Demo con sus datos públicos y nada de antros no publicados); el
// formulario (avisos de validación, envío, aviso de la base con la bandera
// apagada); el admin ve el contacto y lo marca; el admin la apaga → 404.
// Un solo envío real (la base deja 3 por hora por IP). Lo creado lleva el
// prefijo t_n4_landing_ y se borra al final; la bandera queda APAGADA.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conectarDevEscritura } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const BASE = arg("base", "http://localhost:3046").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("--base debe ser un servidor local contra dev");
if (!process.env.PLAYWRIGHT_DESDE) {
  console.log("Falta PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const SALIDA = path.join(RAIZ, "screenshots-n4-landing");
mkdirSync(SALIDA, { recursive: true });
const PREFIJO = "t_n4_landing_";
const CORREO = `${PREFIJO}${Math.random().toString(36).slice(2, 8)}@example.com`;
const CLUB_PRUEBA = `${PREFIJO}Antro Pantalla`;

const db = await conectarDevEscritura();
const [{ inicio }] = await db.q("select now() as inicio"); // la bitácora de esta corrida se borra al final
const resultados = [];
const nota = (t, ok, d = "") => {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`);
};
const bandera = async () => (await db.q(`select activa from public.plataforma_banderas where clave = 'para_clubes'`))[0]?.activa;
// Nombres de antros que NO están publicados: no deben salir en la página.
const noPublicados = (await db.q(`select nombre from public.clubs where not (estado_verificacion = 'verificado' and suscripcion_activa)`)).map((f) => f.nombre);

// Auditoría (la de scripts/dev/auditoria-360.mjs, con una diferencia: el
// grano del tema noche es una imagen de fondo casi transparente; se mide
// contra el color de fondo que lleva debajo en vez de saltarse el texto).
function revisarPagina() {
  const rgba = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const mezclar = (arriba, abajo) => ({ r: arriba.r * arriba.a + abajo.r * (1 - arriba.a), g: arriba.g * arriba.a + abajo.g * (1 - arriba.a), b: arriba.b * arriba.a + abajo.b * (1 - arriba.a), a: 1 });
  const fondo = (el) => {
    const capas = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !cs.backgroundImage.includes("feTurbulence")) return null;
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0) capas.push(c);
      if (c && c.a > 0.9) break;
    }
    let base = capas.length && capas[capas.length - 1].a > 0.9 ? capas.pop() : rgba(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    for (let i = capas.length - 1; i >= 0; i--) base = mezclar(capas[i], base);
    return base;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const cerrado = el.closest("details:not([open])");
    if (cerrado && !el.closest("summary")) return false;
    return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[aria-hidden='true'], [hidden]");
  };
  const nombreDe = (el) => (el.getAttribute("aria-label") || el.innerText || el.textContent || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || el.value || "").trim();
  const corto = (s) => s.replace(/\s+/g, " ").trim().slice(0, 40);
  const h = { desborde: [], tactil: [], contraste: [], etiqueta: [], nombre: [], alt: [], titulos: [] };
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) h.desborde.push(`scrollWidth ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
  const caminante = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const vistos = new Set();
  for (let n = caminante.nextNode(); n; n = caminante.nextNode()) {
    const el = n.parentElement;
    if (!el || vistos.has(el) || !n.textContent.trim()) continue;
    vistos.add(el);
    const cs = getComputedStyle(el);
    if (!visible(el) || Number(cs.opacity) < 0.5) continue;
    if (el.closest("[disabled], [aria-disabled='true'], .sr-only, svg")) continue;
    const c = rgba(cs.color);
    const f = fondo(el);
    if (!c || !f) continue;
    const a = lum(c), b = lum(f);
    const razon = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const grande = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (razon < (grande ? 3 : 4.5)) h.contraste.push(`${razon.toFixed(2)}:1 «${corto(n.textContent)}»`);
  }
  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const tipo = el.tagName === "INPUT" ? el.type : "";
    const enTexto = el.tagName === "A" && el.closest("p, li, dd");
    if (!enTexto && r.height < 40) h.tactil.push(`${Math.round(r.width)}×${Math.round(r.height)} «${corto(nombreDe(el) || el.tagName)}»`);
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && !["submit", "button"].includes(tipo)) {
      const conLabel = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label") || el.getAttribute("aria-label");
      if (!conLabel) h.etiqueta.push(`${el.tagName.toLowerCase()} name=${el.name}`);
    } else if (!nombreDe(el)) h.nombre.push(el.tagName.toLowerCase());
  }
  for (const img of document.querySelectorAll("img")) if (visible(img) && !img.hasAttribute("alt")) h.alt.push(img.getAttribute("src")?.slice(-40) ?? "img");
  // Títulos en orden: un solo h1 y sin saltos (h1 → h3).
  const niveles = [...document.querySelectorAll("h1, h2, h3, h4")].filter(visible).map((e) => Number(e.tagName[1]));
  if (niveles.filter((n) => n === 1).length !== 1) h.titulos.push(`${niveles.filter((n) => n === 1).length} h1`);
  for (let i = 1; i < niveles.length; i++) if (niveles[i] > niveles[i - 1] + 1) h.titulos.push(`h${niveles[i - 1]} → h${niveles[i]}`);
  for (const k of Object.keys(h)) h[k] = [...new Set(h[k])];
  return h;
}

const navegador = await chromium.launch();
async function sesionAdmin(viewport = { width: 390, height: 844 }) {
  const ctx = await navegador.newContext({ viewport });
  const p = await ctx.newPage();
  for (let i = 0; i < 4; i++) {
    await p.goto(BASE + "/admin/login");
    await p.fill("#email", cred.usuarios.admin);
    await p.fill("#password", cred.password);
    await p.click("button[type=submit]");
    const ok = await p.waitForURL(/\/admin$/, { timeout: 90000 }).then(() => true).catch(() => false);
    if (ok) return { ctx, p };
    await p.waitForTimeout(3000 * (i + 1)); // Otros carriles entran a la vez: límite de Auth.
  }
  throw new Error("el admin no pudo entrar");
}
const estado = async (ruta) => (await fetch(BASE + ruta, { redirect: "manual" })).status;

try {
  // ---------- Apagada ----------
  await db.q(`update public.plataforma_banderas set activa = false where clave = 'para_clubes'`);
  nota("apagada: GET /para-clubes responde 404", (await estado("/para-clubes")) === 404);
  {
    const html = await (await fetch(BASE + "/para-clubes")).text();
    const fugas = ["og:title", "og:description", "og:url", "og:locale", 'rel="canonical"', "AntroApp para antros", "Reservas con QR sin cobro"].filter((x) => html.includes(x));
    nota("apagada: el 404 no lleva título, descripción, canonical ni Open Graph de la página", fugas.length === 0, fugas.join(", "));
  }
  {
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    const r = await p.goto(BASE + "/para-clubes");
    nota("apagada: el navegador ve la página 404 (sin formulario)", r?.status() === 404 && (await p.locator("form").count()) === 0, String(r?.status()));
    await ctx.close();
  }
  nota("apagada: la ruta con CAPTCHA no existe (bandera de CAPTCHA apagada)", (await fetch(BASE + "/api/para-clubes/contacto", { method: "POST", body: "{}" })).status === 404);

  // ---------- El admin la enciende ----------
  const admin = await sesionAdmin();
  {
    const { p } = admin;
    const boton = p.locator('a[href="/admin/contactos"]').first();
    await boton.waitFor({ timeout: 60000 }).catch(() => {});
    nota("/admin tiene el botón «Contactos de antros»", await boton.isVisible().catch(() => false));
    await p.goto(BASE + "/admin/funciones");
    const encender = p.getByRole("button", { name: "Encender la página" });
    await encender.waitFor({ timeout: 60000 }).catch(() => {});
    nota("/admin/funciones muestra la bandera apagada con «Encender la página»", await encender.isVisible().catch(() => false));
    const exigir = p.getByRole("button", { name: "Exigir CAPTCHA" });
    nota("sin Turnstile en la app, «Exigir CAPTCHA» está deshabilitado", await exigir.isDisabled().catch(() => false));
    await p.screenshot({ path: path.join(SALIDA, "admin-funciones-apagada-390.png"), fullPage: true });
    await encender.click();
    await p.getByRole("button", { name: "Apagar la página" }).waitFor({ timeout: 30000 }).catch(() => {});
    nota("el admin la enciende desde la pantalla", (await bandera()) === true);
    await p.screenshot({ path: path.join(SALIDA, "admin-funciones-encendida-390.png"), fullPage: false });
  }
  nota("encendida: GET /para-clubes responde 200", (await estado("/para-clubes")) === 200);

  // ---------- La página a 3 tamaños ----------
  const TAMANOS = [
    { nombre: "390", viewport: { width: 390, height: 844 }, movil: true },
    { nombre: "360", viewport: { width: 360, height: 740 }, movil: true },
    { nombre: "1280", viewport: { width: 1280, height: 800 }, movil: false },
  ];
  for (const t of TAMANOS) {
    const ctx = await navegador.newContext({ viewport: t.viewport, deviceScaleFactor: t.movil ? 2 : 1, isMobile: t.movil, hasTouch: t.movil });
    const p = await ctx.newPage();
    const errores = [];
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 120)));
    p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React/.test(m.text())) errores.push(m.text().slice(0, 120)); });
    await p.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    });
    await p.goto(BASE + "/para-clubes", { waitUntil: "networkidle" });
    await p.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
    });
    await p.waitForTimeout(600);
    const h = await p.evaluate(revisarPagina);
    const sufijo = `${t.nombre}`;
    nota(`${sufijo}: sin desborde horizontal`, h.desborde.length === 0, h.desborde.join(" · "));
    nota(`${sufijo}: controles de al menos 40 px de alto`, h.tactil.length === 0, h.tactil.slice(0, 5).join(" · "));
    nota(`${sufijo}: contraste AA en todo el texto`, h.contraste.length === 0, h.contraste.slice(0, 5).join(" · "));
    nota(`${sufijo}: todos los campos con etiqueta y los controles con nombre`, h.etiqueta.length === 0 && h.nombre.length === 0, [...h.etiqueta, ...h.nombre].join(" · "));
    nota(`${sufijo}: imágenes con texto alternativo`, h.alt.length === 0, h.alt.join(" · "));
    nota(`${sufijo}: un solo h1 y títulos sin saltos`, h.titulos.length === 0, h.titulos.join(" · "));
    const cls = await p.evaluate(() => window.__cls);
    nota(`${sufijo}: sin cambios de diseño al cargar (CLS < 0.05)`, cls < 0.05, `CLS ${cls.toFixed(3)}`);
    nota(`${sufijo}: sin errores en la consola`, errores.length === 0, errores.slice(0, 3).join(" · "));
    if (t.nombre === "390") {
      const texto = await p.locator("main").innerText();
      nota("muestra Club Demo Dev con sus datos públicos (ciudad, música)", /Club Demo Dev/.test(texto) && /Guadalajara/.test(texto) && /Reggaetón/.test(texto));
      const fuga = noPublicados.filter((n) => texto.includes(n));
      nota("no aparece ningún antro no publicado", fuga.length === 0, fuga.join(", "));
      const fotos = await p.locator("#ejemplo img").evaluateAll((imgs) => imgs.map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.src })));
      nota("las fotos de Club Demo Dev cargan (bucket público)", fotos.length > 0 && fotos.every((f) => f.ok), `${fotos.length} fotos`);
      nota("sin enlaces para reservar de verdad en el antro de demostración", (await p.locator("a[href*='/cliente/reservar']").count()) === 0);
      const ejemplo = await p.locator("#ejemplo").innerText();
      nota("el ejemplo dice que es de demostración, con datos de ejemplo (no «real», no «lo llenó su dueño»)", /demostración/i.test(ejemplo) && /de ejemplo/.test(ejemplo) && !/real|llenó su dueño/i.test(ejemplo), ejemplo.slice(0, 80));
      nota("preguntas: el cover no se promete en el boleto", !/boleto/i.test(await p.locator("#preguntas").innerText()));
      nota("aviso de datos: huella por 7 días con clave secreta, sin «no tu IP» a secas", /hasta 7 días una huella/.test(texto) && /clave secreta/.test(texto));
      const textoPrecio = await p.locator("#precio").innerText();
      nota("precio «[por definir]» y sin montos en pesos", textoPrecio.includes("[por definir]") && !/\$\s?\d/.test(await p.locator("main").innerText()));
      const prohibidas = ["inventario", "propina", "lista negra", "antifraude", "punto de venta", "PDF", "Stripe", "2,500", "2500"];
      const hallados = prohibidas.filter((w) => texto.toLowerCase().includes(w.toLowerCase()));
      nota("no presenta funciones en prueba ni montos (inventario, propinas, lista negra…)", hallados.length === 0, hallados.join(", "));
      const meta = await p.evaluate(() => ({
        title: document.title,
        desc: document.querySelector('meta[name="description"]')?.content ?? "",
        og: document.querySelector('meta[property="og:title"]')?.content ?? "",
        ogLocale: document.querySelector('meta[property="og:locale"]')?.content ?? "",
      }));
      nota("metadatos: título, descripción y Open Graph", meta.title.includes("AntroApp") && meta.desc.length > 40 && meta.og.length > 0 && meta.ogLocale === "es_MX", JSON.stringify(meta).slice(0, 120));

      // Teclado: el primer Tab llega al logo y el foco se ve.
      await p.keyboard.press("Tab");
      const foco = await p.evaluate(() => {
        const e = document.activeElement;
        const cs = getComputedStyle(e);
        return { texto: e.textContent?.trim(), visible: cs.outlineStyle !== "none" || cs.boxShadow !== "none" };
      });
      nota("teclado: el primer Tab llega al inicio de la página y el foco se ve", foco.texto === "AntroApp" && foco.visible, JSON.stringify(foco));
      await p.locator("#contacto-nombre").focus();
      const focoCampo = await p.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.boxShadow !== "none" || cs.outlineStyle !== "none"; });
      nota("teclado: el campo con foco muestra el anillo", focoCampo);
      const trampa = await p.evaluate(() => { const i = document.getElementById("contacto-sitio-web"); const r = i.getBoundingClientRect(); return { fuera: r.right < 0, tab: i.tabIndex, oculto: !!i.closest("[aria-hidden='true']") }; });
      nota("casilla trampa fuera de la vista, sin Tab y oculta al lector de pantalla", trampa.fuera && trampa.tab === -1 && trampa.oculto, JSON.stringify(trampa));
      // FAQ: se abre con teclado.
      await p.locator("#preguntas summary").first().focus();
      await p.keyboard.press("Enter");
      nota("preguntas: se abren con el teclado", await p.locator("#preguntas details").first().evaluate((d) => d.open));
    }
    await p.screenshot({ path: path.join(SALIDA, `para-clubes-${sufijo}.png`), fullPage: true });
    await p.screenshot({ path: path.join(SALIDA, `para-clubes-${sufijo}-arriba.png`), fullPage: false });
    await ctx.close();
  }

  // ---------- Formulario ----------
  {
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto(BASE + "/para-clubes#contacto", { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Enviar mis datos" }).click();
    const avisos = await p.locator("#contacto [id$='-error']").allInnerTexts();
    const enfocado = await p.evaluate(() => document.activeElement?.getAttribute("name"));
    nota("vacío: avisos en nombre, antro, ciudad y correo", avisos.length === 4 && avisos.some((a) => /tu nombre/.test(a)) && avisos.some((a) => /correo/.test(a)), avisos.join(" | "));
    nota("vacío: el foco va al primer campo con error y queda marcado (aria-invalid)", enfocado === "nombre" && (await p.locator("#contacto-nombre").getAttribute("aria-invalid")) === "true", String(enfocado));
    await p.locator("#contacto").screenshot({ path: path.join(SALIDA, "formulario-avisos-390.png") });
    await p.fill("#contacto-nombre", "Prueba Pantalla");
    await p.fill("#contacto-club", CLUB_PRUEBA);
    await p.fill("#contacto-ciudad", "Guadalajara");
    await p.fill("#contacto-correo", "no-es-correo");
    await p.fill("#contacto-telefono", "123");
    await p.getByRole("button", { name: "Enviar mis datos" }).click();
    const avisos2 = await p.locator("#contacto [id$='-error']").allInnerTexts();
    nota("correo y teléfono mal escritos: sus avisos, y los demás se quitan", avisos2.length === 2 && /correo/.test(avisos2[0]) && /teléfono/.test(avisos2[1]), avisos2.join(" | "));

    // Aviso de la base: con la bandera apagada a media visita.
    await db.q(`update public.plataforma_banderas set activa = false where clave = 'para_clubes'`);
    await p.fill("#contacto-correo", CORREO);
    await p.fill("#contacto-telefono", "33 1234 5678");
    await p.fill("#contacto-mensaje", "Tenemos 30 mesas y 12 RPs.");
    await p.getByRole("button", { name: "Enviar mis datos" }).click();
    const alerta = p.locator("#contacto [role=alert]");
    await alerta.waitFor({ timeout: 20000 }).catch(() => {});
    nota("apagada a media visita: la base rechaza y se muestra su aviso", /no está disponible/.test((await alerta.innerText().catch(() => "")) ?? ""));
    await db.q(`update public.plataforma_banderas set activa = true where clave = 'para_clubes'`);

    await p.getByRole("button", { name: "Enviar mis datos" }).click();
    const ok = p.getByRole("status").filter({ hasText: "Recibimos tus datos" });
    await ok.waitFor({ timeout: 20000 }).catch(() => {});
    nota("envío válido: confirmación «Recibimos tus datos» con el foco en ella", (await ok.isVisible().catch(() => false)) && (await p.evaluate(() => document.activeElement?.getAttribute("role"))) === "status");
    await p.locator("#contacto").screenshot({ path: path.join(SALIDA, "formulario-enviado-390.png") });
    const [fila] = await db.q(`select nombre, club_nombre, ciudad, telefono, mensaje, estado from public.contactos_clubes where correo = $1`, [CORREO]);
    nota("se guardó en la base tal como se escribió (teléfono en dígitos, estado nuevo)", fila?.club_nombre === CLUB_PRUEBA && fila?.telefono === "3312345678" && fila?.estado === "nuevo", JSON.stringify(fila ?? {}));
    await ctx.close();
  }

  // ---------- El admin ve el contacto y lo marca ----------
  {
    const { p } = admin;
    await p.goto(BASE + "/admin/contactos");
    const tarjeta = p.locator("li").filter({ hasText: CLUB_PRUEBA });
    await tarjeta.waitFor({ timeout: 60000 }).catch(() => {});
    nota("el admin ve el contacto en /admin/contactos (Nuevos)", await tarjeta.isVisible().catch(() => false));
    nota("la bandeja dice cuántos muestra de cuántos y cuenta por estado", /Mostrando \d+ de \d+/.test(await p.locator("body").innerText()) && /Nuevos \(\d+\)/.test(await p.locator("body").innerText()));
    nota("con su correo y teléfono para contactarlo", (await tarjeta.innerText().catch(() => "")).includes(CORREO));
    await p.screenshot({ path: path.join(SALIDA, "admin-contactos-390.png"), fullPage: true });

    // Más de una página: 55 contactos viejos de prueba → 50 y «Ver más».
    const [{ antes }] = await db.q(`select count(*)::int as antes from public.contactos_clubes where estado = 'nuevo'`);
    await db.q(`insert into public.contactos_clubes (nombre, club_nombre, ciudad, correo, creado_en)
                select 'Prueba Página', $1 || g, 'Guadalajara', $2 || g || '@example.com', now() - interval '1 day' - g * interval '1 minute'
                  from generate_series(1, 55) g`, [`${PREFIJO}Pagina `, `${PREFIJO}pagina_`]);
    const totalNuevos = antes + 55;
    await p.reload();
    const pie = p.getByText(new RegExp(`Mostrando 50 de ${totalNuevos}`));
    await pie.waitFor({ timeout: 60000 }).catch(() => {});
    nota(`con ${totalNuevos} nuevos: «Mostrando 50 de ${totalNuevos}» y el más nuevo arriba`, (await pie.isVisible().catch(() => false)) && (await p.locator("li").first().innerText()).includes(CLUB_PRUEBA));
    await p.getByRole("button", { name: /^Ver \d+ más$/ }).click();
    const pie2 = p.getByText(`Mostrando ${totalNuevos} de ${totalNuevos}`);
    await pie2.waitFor({ timeout: 30000 }).catch(() => {});
    nota("«Ver más» trae el resto y desaparece", (await pie2.isVisible().catch(() => false)) && (await p.getByRole("button", { name: /^Ver \d+ más$/ }).count()) === 0);
    await db.q(`delete from public.contactos_clubes where club_nombre like $1`, [`${PREFIJO}Pagina %`]);
    await p.reload();
    await tarjeta.waitFor({ timeout: 60000 }).catch(() => {});
    await tarjeta.getByRole("button", { name: "Marcar atendido" }).click();
    await p.getByRole("status").filter({ hasText: "atendido" }).waitFor({ timeout: 20000 }).catch(() => {});
    const [f] = await db.q(`select estado, atendido_por is not null as con_quien from public.contactos_clubes where correo = $1`, [CORREO]);
    nota("lo marca atendido (queda quién lo atendió)", f?.estado === "atendido" && f?.con_quien === true, JSON.stringify(f ?? {}));
    nota("sale de «Nuevos»", (await p.locator("li").filter({ hasText: CLUB_PRUEBA }).count()) === 0);
    await p.getByRole("button", { name: "Atendidos" }).click();
    const enAtendidos = p.locator("li").filter({ hasText: CLUB_PRUEBA });
    await enAtendidos.waitFor({ timeout: 20000 }).catch(() => {});
    nota("aparece en «Atendidos» con quién y cuándo", /Atendido el .* por /.test(await enAtendidos.innerText().catch(() => "")));
    await p.setViewportSize({ width: 360, height: 740 });
    const h = await p.evaluate(revisarPagina);
    nota("/admin/contactos a 360: sin desborde, controles de 40 px", h.desborde.length === 0 && h.tactil.length === 0, [...h.desborde, ...h.tactil].slice(0, 4).join(" · "));
    await p.screenshot({ path: path.join(SALIDA, "admin-contactos-atendido-360.png"), fullPage: true });

    // Otro rol no ve la bandeja.
    const ctxD = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const pd = await ctxD.newPage();
    await pd.goto(BASE + "/cliente/login");
    await pd.fill("#email", cred.usuarios.dueno);
    await pd.fill("#password", cred.password);
    await pd.click("button[type=submit]");
    await pd.waitForURL(/\/dueno\/panel/, { timeout: 90000 }).catch(() => {});
    await pd.goto(BASE + "/admin/contactos");
    await pd.waitForURL(/\/admin\/login/, { timeout: 60000 }).catch(() => {});
    nota("un dueño que abre /admin/contactos termina en /admin/login", /\/admin\/login/.test(pd.url()), pd.url());
    await ctxD.close();

    // El admin la apaga.
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + "/admin/funciones");
    const apagar = p.getByRole("button", { name: "Apagar la página" });
    await apagar.waitFor({ timeout: 60000 }).catch(() => {});
    // Si la carga chocó con una recarga del esquema (otro carril aplicando SQL
    // en dev), se recarga una vez.
    if (!(await apagar.isVisible().catch(() => false))) {
      await p.screenshot({ path: path.join(SALIDA, "admin-funciones-sin-apagar.png"), fullPage: true });
      await p.reload();
      await apagar.waitFor({ timeout: 60000 }).catch(() => {});
    }
    await apagar.click();
    await p.getByRole("button", { name: "Encender la página" }).waitFor({ timeout: 30000 }).catch(() => {});
    nota("el admin la apaga desde la pantalla", (await bandera()) === false);
  }
  nota("apagada otra vez: GET /para-clubes responde 404", (await estado("/para-clubes")) === 404);
} finally {
  await db.q(`update public.plataforma_banderas set activa = false`);
  await db.q(`delete from public.contactos_clubes where correo like $1 or club_nombre like $1`, [`${PREFIJO}%`]);
  await db.q(`delete from public.contacto_intentos where correo_hash = public.contacto_huella('correo:' || $1)`, [CORREO]);
  await db.q(`delete from public.para_clubes_bitacora where hecho_en >= $1`, [inicio]);
  const [{ quedan }] = await db.q(`select count(*)::int as quedan from public.contactos_clubes where correo like $1 or club_nombre like $1`, [`${PREFIJO}%`]);
  nota("limpieza: 0 contactos de prueba y la bandera apagada", quedan === 0 && (await bandera()) === false, `quedan ${quedan}`);
  await navegador.close();
  await db.fin();
}

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} pasan · capturas en screenshots-n4-landing/`);
process.exit(ok === resultados.length ? 0 : 1);
