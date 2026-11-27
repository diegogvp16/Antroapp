// SOLO DEV. Escáner de respaldo (bandera `escaner_respaldo`) en el navegador
// real, 390×844, contra un build de producción conectado a dev:
//
//   0. Bandera apagada: el escáner es el de siempre (sin código a mano, sin
//      copia, sin base local "antroapp-puerta") y el boleto no muestra código.
//   1. Sin red, cámara: lee el QR contra la copia de la noche, "Confirmar
//      entrada (sin señal)" la deja pendiente; volver a leerla avisa que ya
//      está en el teléfono; código a mano sin red; contador visible; aviso
//      al cerrar sesión; recargar sin red muestra /offline.html con el
//      conteo; al volver la red se envían solas y la base las tiene una vez.
//   2. Dos teléfonos: A (staff, sin red) y B (gerente, con red) confirman la
//      misma reserva; al volver la red, A ve "ya había entrado" y la base
//      tiene UNA entrada, la de B.
//   3. Con red: código corto, enlace pegado y código que no existe.
//   4. Boleto: con la bandera encendida muestra el código corto.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright y qrcode> \
//     node scripts/dev/probar-escaner-respaldo.mjs [http://localhost:3052]
//
// Crea sus reservas (cliente "t_n4_pwa …") en Club Demo Dev y las borra al
// final; enciende la bandera solo en Club Demo Dev y la deja como estaba.
// Los eventos de caja de esas entradas (caja_eventos) no se pueden borrar
// (trigger caja_sin_borrar), como en las otras pruebas de puerta.
// Capturas en screenshots-n4-pwa/.

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
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3052";
const SHOTS = path.join(RAIZ, "screenshots-n4-pwa") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const opc = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opc);
const CLUB = cred.clubs.demo;
const FLAG = "escaner_respaldo";

const resultados = [];
function nota(texto, ok, detalle = "") {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}

// Video .y4m con el QR (Chrome lo repite como cámara).
function videoConQR(texto, ruta) {
  const W = 640, H = 480, MOD = 6;
  const qr = QRCode.create(texto, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const lado = (n + 8) * MOD;
  const x0 = Math.floor((W - lado) / 2), y0 = Math.floor((H - lado) / 2);
  const Y = Buffer.alloc(W * H, 255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules.get(r, c)) continue;
    for (let dy = 0; dy < MOD; dy++) for (let dx = 0; dx < MOD; dx++) Y[(y0 + (r + 4) * MOD + dy) * W + (x0 + (c + 4) * MOD + dx)] = 0;
  }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  const cuadro = Buffer.concat([Buffer.from("FRAME\n"), Y, UV, UV]);
  writeFileSync(ruta, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), cuadro, cuadro, cuadro]));
  return ruta;
}

async function conReintento(f, veces = 5) {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= veces - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// Admin (para la bandera), con reintento por el límite de Auth.
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opc);
await conReintento(async () => {
  const { error } = await admin.auth.signInWithPassword({ email: cred.usuarios.admin, password: cred.password });
  if (error) throw error;
});
const previa = (await svc.from("club_funciones").select("activa").eq("club_id", CLUB).eq("funcion", FLAG).maybeSingle()).data;
// Con reintento: dev es compartido y otro carril puede tener la tabla ocupada.
async function bandera(valor) {
  await conReintento(async () => {
    const { error } = await admin.rpc("funcion_cambiar", { p_club_id: CLUB, p_funcion: FLAG, p_activa: valor });
    if (error) throw new Error("bandera: " + error.message);
  });
}

// Noche operativa (corte 08:00, hora de la Ciudad de México, la zona de Club Demo Dev).
const noche = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const creadas = [];
async function reserva(nombre, fin = null) {
  const r = { id: randomUUID(), cliente_nombre: `t_n4_pwa ${nombre}`, cliente_telefono: "0000000999", personas: 2, status: "confirmada",
    source: "organica", club_id: CLUB, fecha: noche, qr_code: fin ? `antro-${randomUUID().slice(0, 30)}${fin}` : `antro-${randomUUID()}` };
  const ins = await svc.from("reservations").insert(r);
  if (ins.error) throw new Error("reserva: " + ins.error.message);
  creadas.push(r.id);
  return r;
}
const estado = async (r) => (await svc.from("reservations").select("status, puerta_estado, entrada_por").eq("id", r.id).single()).data;
const eventos = async (r, tipo) =>
  (await svc.from("caja_eventos").select("id").eq("club_id", CLUB).eq("tipo", tipo).eq("detalle->>reservation_id", r.id)).data?.length ?? -1;
async function idDe(correo) {
  const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  return data.users.find((u) => u.email === correo)?.id;
}
const idStaff = await idDe(cred.usuarios.staff);
const idGerente = await idDe(cred.usuarios.gerente);
const corto = (r) => r.qr_code.slice(-6).toUpperCase().replace(/^(...)/, "$1 ");

async function entrar(p, clave) {
  await conReintento(async () => {
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", cred.usuarios[clave]);
    await p.fill("#password", cred.password);
    await p.click("button[type=submit]");
    await p.waitForURL(/staff\/panel/, { timeout: 60000 });
  }, 3);
}
// Cuenta las cámaras que abre la página (revisión, punto 1): llamadas a
// getUserMedia, pistas de video vivas y elementos <video>.
function contarCamaras() {
  window.__gum = 0;
  window.__streams = [];
  const md = navigator.mediaDevices;
  if (!md) return;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    window.__gum++;
    const st = await orig(c);
    window.__streams.push(st);
    return st;
  };
}
const camaras = (p) =>
  p.evaluate(() => ({
    gum: window.__gum,
    vivas: window.__streams.flatMap((st) => st.getTracks()).filter((t) => t.readyState === "live").length,
    videos: document.querySelectorAll("video").length,
  }));
// Llamadas a puerta_escanear (la de la cámara, no la del código).
function contarEscaneos(p) {
  const n = { v: 0 };
  p.on("request", (r) => {
    if (/\/rpc\/puerta_escanear(\?|$)/.test(r.url())) n.v++;
  });
  return n;
}
async function nuevoContexto(nav, extra = {}) {
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["camera"], ...extra });
  await ctx.addInitScript(contarCamaras);
  return ctx;
}
const lanzar = (video) =>
  chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(video ? [`--use-file-for-fake-video-capture=${video}`] : [])],
  });
async function captura(p, nombre) {
  await p.screenshot({ path: SHOTS + `${nombre}-390.png` });
  await p.setViewportSize({ width: 360, height: 740 });
  await p.screenshot({ path: SHOTS + `${nombre}-360.png` });
  await p.setViewportSize({ width: 390, height: 844 });
}
const visible = (loc, ms = 20000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const hayBaseLocal = (p) => p.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "antroapp-puerta"));

try {
  const R = {
    apagada: await reserva("apagada"),
    camara: await reserva("camara sin red"),
    codigo: await reserva("codigo sin red"),
    doble: await reserva("dos telefonos"),
    enLinea: await reserva("codigo con red"),
    enlace: await reserva("enlace pegado"),
    boleto: await reserva("boleto"),
    camaraEnLinea: await reserva("camara con red"),
  };
  const finComun = randomUUID().slice(-6);
  R.amb1 = await reserva("Ana Gomez", finComun);
  R.amb2 = await reserva("Beto Ruiz", finComun);

  // ---------- 0. Bandera apagada ----------
  await bandera(false);
  {
    const nav = await lanzar(videoConQR(R.apagada.qr_code, SHOTS + "qr-apagada.y4m"));
    try {
      const ctx = await nuevoContexto(nav);
      const p = await ctx.newPage();
      const escaneos = contarEscaneos(p);
      await entrar(p, "staff");
      await p.getByRole("button", { name: "Escanear QR" }).first().waitFor();
      await p.waitForTimeout(2500);
      nota("apagada: el panel no muestra la copia sin señal", (await p.locator("[data-prueba=copia-puerta]").count()) === 0);
      await p.getByRole("button", { name: "Escanear QR" }).first().click();
      const leyo = await visible(p.getByRole("button", { name: "Confirmar entrada" }), 25000);
      nota("apagada: el escáner de siempre lee el QR", leyo);
      await p.waitForTimeout(3000);
      const cam0 = await camaras(p);
      nota(
        "apagada: una sola cámara (1 getUserMedia, 1 pista viva, a lo más 1 video) y un solo escaneo",
        cam0.gum === 1 && cam0.vivas === 1 && cam0.videos <= 1 && escaneos.v === 1,
        `${JSON.stringify(cam0)} escaneos=${escaneos.v}`,
      );
      nota("apagada: sin campo de código a mano", (await p.locator("#codigo-boleto").count()) === 0);
      await captura(p, "0-apagada-escaner");
      if (leyo) {
        await p.getByRole("button", { name: "Confirmar entrada" }).click();
        await visible(p.getByText(/Entrada confirmada/));
        const e = await estado(R.apagada);
        nota("apagada: confirma la entrada como hoy", e.status === "usada" && e.puerta_estado === "entro");
      }
      nota("apagada: no se crea la base local del escáner de respaldo", !(await hayBaseLocal(p)));
      const anon = await nav.newContext({ viewport: { width: 390, height: 844 } });
      const pb = await anon.newPage();
      await pb.goto(BASE + "/r/" + R.boleto.qr_code);
      await pb.locator("[data-prueba=qr-boleto]").waitFor({ timeout: 30000 }).catch(() => {});
      await pb.waitForTimeout(1500);
      nota("apagada: el boleto no muestra el código corto", (await pb.locator("[data-prueba=codigo-respaldo]").count()) === 0);
      await anon.close();
      await ctx.close();
    } finally {
      await nav.close();
    }
  }

  // ---------- 1. Sin red: cámara y código a mano ----------
  await bandera(true);
  {
    const nav = await lanzar(videoConQR(R.camara.qr_code, SHOTS + "qr-camara.y4m"));
    try {
      const ctx = await nuevoContexto(nav);
      const p = await ctx.newPage();
      const dialogos = [];
      // confirm() de cerrar sesión: se cancela. beforeunload (recargar con
      // pendientes): se anota y se acepta, para seguir con la prueba.
      const salidas = [];
      p.on("dialog", (d) => {
        if (d.type() === "beforeunload") {
          salidas.push(d.type());
          void d.accept();
          return;
        }
        dialogos.push(d.message());
        void d.dismiss();
      });
      await entrar(p, "staff");
      const copia = await visible(p.locator("[data-prueba=copia-puerta]", { hasText: "copia de las" }), 30000);
      nota("encendida: el panel baja la copia de la noche", copia, copia ? await p.locator("[data-prueba=copia-puerta]").innerText() : "");
      // Lo que guarda el teléfono: sin QR ni teléfono.
      const guardado = await p.evaluate(
        () =>
          new Promise((ok) => {
            const r = indexedDB.open("antroapp-puerta");
            r.onsuccess = () => {
              const g = r.result.transaction("copias", "readonly").objectStore("copias").getAll();
              g.onsuccess = () => ok(JSON.stringify(g.result));
            };
            r.onerror = () => ok("");
          }),
      );
      nota(
        "la copia del teléfono no trae QR ni teléfonos",
        guardado.includes(R.camara.id) && !guardado.includes(R.camara.qr_code) && !guardado.includes("0000000999") && !guardado.includes("antro-"),
        `${guardado.length} bytes`,
      );
      await p.waitForTimeout(1500); // el lector de QR (html5-qrcode) se termina de bajar
      await ctx.setOffline(true);
      await p.getByRole("button", { name: "Escanear QR" }).first().click();
      nota("sin red: el escáner avisa que valida con la copia", await visible(p.locator("[data-prueba=puerta-sin-senal]", { hasText: "copia de las" })));
      const ficha = await visible(p.locator("[data-prueba=ficha-sin-senal]"), 25000);
      nota("sin red, cámara: lee el QR y muestra la ficha de la copia", ficha && (await p.getByText(R.camara.cliente_nombre).count()) > 0);
      await captura(p, "1-sin-red-ficha");
      await p.getByRole("button", { name: "Confirmar entrada (sin señal)" }).click();
      nota("sin red: queda «pendiente de enviar»", await visible(p.locator("[data-prueba=entrada-pendiente]")));
      nota("contador visible: 1 pendiente", await visible(p.locator("[data-prueba=puerta-pendientes]", { hasText: "1 entrada pendiente" })));
      nota("…y la base todavía no la tiene", (await estado(R.camara)).status === "confirmada");
      await captura(p, "1-sin-red-pendiente");
      await p.getByRole("button", { name: "Escanear siguiente" }).click();
      nota(
        "sin red: volver a leer el mismo QR avisa que ya está en el teléfono",
        await visible(p.getByText(/Ya la registraste en este teléfono/), 25000),
      );
      await p.getByRole("button", { name: "Escanear siguiente" }).click();
      await p.fill("#codigo-boleto", corto(R.codigo));
      await p.getByRole("button", { name: "Buscar" }).click();
      const fichaCodigo = await visible(p.locator("[data-prueba=ficha-sin-senal]"));
      nota("sin red, código a mano: encuentra la reserva en la copia", fichaCodigo && (await p.getByText(R.codigo.cliente_nombre).count()) > 0);
      await p.getByRole("button", { name: "Confirmar entrada (sin señal)" }).click();
      nota("contador: 2 pendientes", await visible(p.locator("[data-prueba=puerta-pendientes]", { hasText: "2 entradas pendientes" })));
      await p.getByRole("button", { name: "Escanear siguiente" }).click();
      await p.fill("#codigo-boleto", "ABC 12");
      await p.getByRole("button", { name: "Buscar" }).click();
      nota("código incompleto: lo dice sin buscar", await visible(p.getByText(/Escribe los 6 caracteres/)));
      await p.fill("#codigo-boleto", "000 000");
      await p.getByRole("button", { name: "Buscar" }).click();
      nota("sin red, código que no está en la copia: lo dice", await visible(p.getByText(/No está en la copia de esta noche/)));
      await captura(p, "1-sin-red-no-esta");
      // Cerrar sesión con pendientes: avisa (y se cancela).
      await p.getByRole("button", { name: "Cerrar escáner" }).click();
      await p.getByRole("button", { name: "Cerrar sesión" }).click();
      await p.waitForTimeout(1500);
      nota(
        "cerrar sesión con pendientes: avisa antes",
        dialogos.some((m) => /2 entradas de la puerta sin enviar/.test(m)) && /staff\/panel/.test(p.url()),
        dialogos.join(" | ").slice(0, 120),
      );
      // Recargar sin red: página propia con el conteo.
      await p.reload().catch(() => {});
      const pagina = await visible(p.getByRole("heading", { name: "Sin conexión" }), 15000);
      nota("recargar con pendientes: el navegador pregunta antes de salir", salidas.length > 0);
      nota(
        "recargar sin red: «Sin conexión» con las entradas guardadas",
        pagina && (await visible(p.locator("#puerta", { hasText: "2 entradas de la puerta" }), 5000)),
      );
      await captura(p, "1-offline-html");
      // Vuelve la red: offline.html recarga, el panel manda la cola.
      await ctx.setOffline(false);
      await p.waitForURL(/staff\/panel/, { timeout: 30000 }).catch(() => {});
      const enviadas = await visible(p.getByText(/se enviaron 2 entradas/), 45000);
      nota("al volver la red se envían solas", enviadas);
      // El panel recarga su lista al llegar las entradas (sin tocar «Actualizar»).
      const tarjeta = p.locator("div", { hasText: R.camara.cliente_nombre }).filter({ hasText: "Usada" });
      nota("la lista de la noche del panel ya las muestra como «Usada»", await visible(tarjeta, 15000));
      await captura(p, "1-enviadas");
      const [e1, e2] = [await estado(R.camara), await estado(R.codigo)];
      nota("la base las tiene, con la cuenta del staff", e1.status === "usada" && e2.status === "usada" && e1.entrada_por === idStaff && e2.entrada_por === idStaff);
      nota(
        "cada una entró una sola vez (un evento de confirmación y uno de diferida)",
        (await eventos(R.camara, "puerta_confirmar_entrada")) === 1 && (await eventos(R.camara, "puerta_entrada_diferida")) === 1 &&
          (await eventos(R.codigo, "puerta_confirmar_entrada")) === 1 && (await eventos(R.codigo, "puerta_entrada_diferida")) === 1,
      );
      await ctx.close();
    } finally {
      await nav.close();
    }
  }

  // ---------- 2. Dos teléfonos, la misma reserva ----------
  // ---------- 3. Con red: código corto, enlace pegado, código que no existe ----------
  {
    const nav = await lanzar(null); // cámara falsa sin QR
    try {
      const ctxA = await nuevoContexto(nav);
      const a = await ctxA.newPage();
      await entrar(a, "staff");
      await visible(a.locator("[data-prueba=copia-puerta]", { hasText: "copia de las" }), 30000);
      await ctxA.setOffline(true);
      await a.getByRole("button", { name: "Escanear QR" }).first().click();
      await a.fill("#codigo-boleto", corto(R.doble));
      await a.getByRole("button", { name: "Buscar" }).click();
      await visible(a.locator("[data-prueba=ficha-sin-senal]"));
      await a.getByRole("button", { name: "Confirmar entrada (sin señal)" }).click();
      nota("teléfono A (sin red): la guarda pendiente", await visible(a.locator("[data-prueba=entrada-pendiente]")));

      const ctxB = await nuevoContexto(nav);
      const b = await ctxB.newPage();
      await entrar(b, "gerente");
      await visible(b.locator("[data-prueba=copia-puerta]"), 30000);
      await b.getByRole("button", { name: "Escanear QR" }).first().click();
      await b.fill("#codigo-boleto", corto(R.doble));
      await b.getByRole("button", { name: "Buscar" }).click();
      await visible(b.getByRole("button", { name: "Confirmar entrada" }));
      nota("teléfono B (con red): el código corto va a la base (sin marca de copia)", (await b.locator("[data-prueba=ficha-sin-senal]").count()) === 0);
      await b.getByRole("button", { name: "Confirmar entrada" }).click();
      nota("teléfono B: entrada confirmada", await visible(b.getByText(/Entrada confirmada/)));

      await ctxA.setOffline(false);
      a.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {});
      const dup = await visible(a.locator("[data-prueba=puerta-duplicadas]", { hasText: "otro teléfono u otra persona" }), 45000);
      nota("teléfono A al volver la red: «ya había entrado», no error", dup, dup ? (await a.locator("[data-prueba=puerta-duplicadas]").innerText()).replace(/\s+/g, " ").slice(0, 160) : "");
      await captura(a, "2-duplicada");
      const e = await estado(R.doble);
      nota(
        "la base tiene UNA entrada, la del teléfono B",
        e.status === "usada" && e.entrada_por === idGerente && (await eventos(R.doble, "puerta_confirmar_entrada")) === 1 &&
          (await eventos(R.doble, "puerta_entrada_diferida")) === 0,
      );
      await a.getByRole("button", { name: "Entendido" }).first().click();
      nota("«Entendido» quita el aviso", await a.locator("[data-prueba=puerta-duplicadas]").waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false));

      // 3. Con red en A.
      await a.getByRole("button", { name: "Escanear siguiente" }).click().catch(() => {});
      await a.fill("#codigo-boleto", corto(R.enLinea).toLowerCase());
      await a.getByRole("button", { name: "Buscar" }).click();
      const fichaEnLinea = await visible(a.getByRole("button", { name: "Confirmar entrada" }));
      nota("con red, código corto en minúsculas: ficha de la base", fichaEnLinea && (await a.getByText(R.enLinea.cliente_nombre).count()) > 0);
      await captura(a, "3-codigo-con-red");
      await a.getByRole("button", { name: "Confirmar entrada" }).click();
      await visible(a.getByText(/Entrada confirmada/));
      const e3 = await estado(R.enLinea);
      nota("con red, código corto: entra con la cuenta del staff", e3.status === "usada" && e3.entrada_por === idStaff);
      await a.getByRole("button", { name: "Escanear siguiente" }).click();
      await a.fill("#codigo-boleto", `${BASE}/r/${R.enlace.qr_code}`);
      await a.getByRole("button", { name: "Buscar" }).click();
      nota("con red, enlace del boleto pegado: ficha", (await visible(a.getByRole("button", { name: "Confirmar entrada" }))) && (await a.getByText(R.enlace.cliente_nombre).count()) > 0);
      await a.getByRole("button", { name: "Escanear siguiente" }).click();
      await a.fill("#codigo-boleto", "000000");
      await a.getByRole("button", { name: "Buscar" }).click();
      nota("con red, código que no existe: lo dice la base", await visible(a.getByText(/No hay ninguna reserva de esta noche/)));
      await a.getByRole("button", { name: "Escanear siguiente" }).click();
      await a.fill("#codigo-boleto", corto(R.enLinea));
      await a.getByRole("button", { name: "Buscar" }).click();
      nota("con red, código de una que ya entró: «ya entró a las…»", await visible(a.getByText(/Esta reserva ya entró a las/)));
      // Cerrar sesión borra la copia del teléfono.
      await a.getByRole("button", { name: "Cerrar escáner" }).click();
      await a.getByRole("button", { name: "Cerrar sesión" }).click();
      await a.waitForURL(/cliente\/login/, { timeout: 20000 }).catch(() => {});
      const copias = await a.evaluate(
        () =>
          new Promise((ok) => {
            const r = indexedDB.open("antroapp-puerta");
            r.onsuccess = () => {
              const g = r.result.transaction("copias", "readonly").objectStore("copias").getAll();
              g.onsuccess = () => ok(g.result.length);
            };
            r.onerror = () => ok(-1);
          }),
      );
      nota("cerrar sesión borra la copia de la noche del teléfono", copias === 0, String(copias));
      await ctxA.close();
      await ctxB.close();
    } finally {
      await nav.close();
    }
  }

  // ---------- 5. Encendida, con red: una sola cámara y un solo escaneo por QR ----------
  // ---------- 6. La bandera llega con el escáner ya abierto ----------
  {
    const nav = await lanzar(videoConQR(R.camaraEnLinea.qr_code, SHOTS + "qr-camara-con-red.y4m"));
    try {
      const ctx = await nuevoContexto(nav);
      const p = await ctx.newPage();
      const escaneos = contarEscaneos(p);
      await entrar(p, "staff");
      await visible(p.locator("[data-prueba=copia-puerta]", { hasText: "copia de las" }), 30000);
      await p.getByRole("button", { name: "Escanear QR" }).first().click();
      const leyo = await visible(p.getByRole("button", { name: "Confirmar entrada" }), 25000);
      await p.waitForTimeout(3000);
      const cam = await camaras(p);
      nota(
        "encendida: una sola cámara (1 getUserMedia, 1 pista viva, 1 video) y un solo escaneo por QR",
        leyo && cam.gum === 1 && cam.vivas === 1 && cam.videos === 1 && escaneos.v === 1,
        `${JSON.stringify(cam)} escaneos=${escaneos.v}`,
      );
      await ctx.close();

      // La respuesta de las banderas tarda 6 s: el escáner de siempre ya se
      // abrió cuando llega "encendida" y cambia al de respaldo.
      const ctx2 = await nuevoContexto(nav);
      await ctx2.route("**/rest/v1/rpc/mis_funciones*", async (ruta) => {
        await new Promise((ok) => setTimeout(ok, 6000));
        await ruta.continue().catch(() => {});
      });
      const p2 = await ctx2.newPage();
      await entrar(p2, "staff");
      await p2.getByRole("button", { name: "Escanear QR" }).first().click();
      const antes = (await p2.locator("#codigo-boleto").count()) === 0;
      const cambio = await visible(p2.locator("#codigo-boleto"), 20000);
      await p2.waitForTimeout(4000);
      const cam2 = await camaras(p2);
      nota(
        "bandera que llega con el escáner abierto: cambia al de respaldo y queda UNA cámara viva y un video",
        antes && cambio && cam2.vivas === 1 && cam2.videos === 1,
        `${JSON.stringify(cam2)} (antes de la bandera: escáner de siempre=${antes})`,
      );
      await ctx2.close();
    } finally {
      await nav.close();
    }
  }

  // ---------- 7. Sin respuesta de las banderas: la copia no se borra ----------
  // ---------- 8. Con red, código repetido: elegir de la lista ----------
  // ---------- 9. Barrido: otra cuenta en el mismo teléfono ----------
  {
    const nav = await lanzar(null);
    try {
      const ctx = await nuevoContexto(nav);
      const p = await ctx.newPage();
      await entrar(p, "staff");
      await visible(p.locator("[data-prueba=copia-puerta]", { hasText: "copia de las" }), 30000);
      await ctx.route("**/rest/v1/rpc/mis_funciones*", (ruta) => ruta.abort("failed"));
      await p.reload();
      await p.getByRole("button", { name: "Escanear QR" }).first().waitFor({ timeout: 30000 });
      await p.waitForTimeout(5000);
      const copiasTrasError = await p.evaluate(
        () =>
          new Promise((ok) => {
            const r = indexedDB.open("antroapp-puerta");
            r.onsuccess = () => {
              const g = r.result.transaction("copias", "readonly").objectStore("copias").getAll();
              g.onsuccess = () => ok(g.result.length);
            };
            r.onerror = () => ok(-1);
          }),
      );
      nota("banderas sin respuesta: la copia del teléfono NO se borra", copiasTrasError === 1, String(copiasTrasError));
      nota("…el panel la sigue mostrando", await visible(p.locator("[data-prueba=copia-puerta]", { hasText: "copia de las" }), 5000));
      await p.getByRole("button", { name: "Escanear QR" }).first().click();
      nota("…y el escáner sigue siendo el de respaldo", await visible(p.locator("#codigo-boleto"), 15000));
      await ctx.unroute("**/rest/v1/rpc/mis_funciones*");

      await p.fill("#codigo-boleto", corto(R.amb1));
      await p.getByRole("button", { name: "Buscar" }).click();
      const lista = p.locator("[data-prueba=opciones-codigo]");
      const hayLista = await visible(lista);
      const textoLista = hayLista ? (await lista.innerText()).replace(/\s+/g, " ") : "";
      nota(
        "con red, código repetido: lista con nombres recortados para elegir",
        hayLista && textoLista.includes("t_n4_pwa A.") && textoLista.includes("t_n4_pwa B.") && !textoLista.includes("Gomez"),
        textoLista.slice(0, 160),
      );
      await captura(p, "8-codigo-repetido");
      await lista.getByRole("button", { name: /t_n4_pwa B\./ }).click();
      nota(
        "…al elegir, la base devuelve la ficha de esa reserva",
        (await visible(p.getByRole("button", { name: "Confirmar entrada" }))) && (await p.getByText(R.amb2.cliente_nombre).count()) > 0,
      );
      const e8 = await estado(R.amb2);
      nota("…queda «en puerta» solo la elegida", e8.puerta_estado === "en_puerta" && (await estado(R.amb1)).puerta_estado === null);

      // Cerrar sesión y dejar en el teléfono restos como los de una salida sin
      // borrar (copia vigente, pendientes vigente y vencida, una resuelta).
      await p.getByRole("button", { name: "Cerrar escáner" }).click();
      await p.getByRole("button", { name: "Cerrar sesión" }).click();
      await p.waitForURL(/cliente\/login/, { timeout: 20000 }).catch(() => {});
      const ahora = Date.now();
      await p.evaluate(
        ({ staff, club, ahora }) =>
          new Promise((ok, mal) => {
            const r = indexedDB.open("antroapp-puerta");
            r.onsuccess = () => {
              const t = r.result.transaction(["copias", "entradas"], "readwrite");
              const iso = (ms) => new Date(ms).toISOString();
              t.objectStore("copias").put({ clave: `${staff}:${club}`, usuarioId: staff, clubId: club, noche: "x", generadaEn: iso(ahora),
                venceEn: iso(ahora + 6 * 3600e3), truncada: false, total: 0, reservas: [] });
              const base = { usuarioId: staff, clubId: club, reservationId: "r", clienteNombre: "t_n4_pwa inyectada", personas: 1, origen: "codigo",
                escaneadoEn: iso(ahora - 3600e3), intentos: 0 };
              t.objectStore("entradas").put({ ...base, clave: "vigente", venceEn: iso(ahora + 6 * 3600e3), estado: "pendiente" });
              t.objectStore("entradas").put({ ...base, clave: "vencida", venceEn: iso(ahora - 60e3), estado: "pendiente" });
              t.objectStore("entradas").put({ ...base, clave: "resuelta", venceEn: iso(ahora + 6 * 3600e3), estado: "enviada", resueltoEn: iso(ahora) });
              t.oncomplete = () => ok();
              t.onerror = () => mal(t.error);
            };
          }),
        { staff: idStaff, club: CLUB, ahora },
      );
      await conReintento(async () => {
        await p.goto(BASE + "/cliente/login");
        await p.fill("#email", cred.usuarios.cliente);
        await p.fill("#password", cred.password);
        await p.click("button[type=submit]");
        await p.waitForURL((u) => /^\/cliente\/?$/.test(new URL(u).pathname), { timeout: 60000 });
      }, 3);
      await p.waitForTimeout(5000);
      const quedan = await p.evaluate(
        () =>
          new Promise((ok) => {
            const r = indexedDB.open("antroapp-puerta");
            r.onsuccess = () => {
              const t = r.result.transaction(["copias", "entradas"], "readonly");
              const c = t.objectStore("copias").getAll();
              const e = t.objectStore("entradas").getAllKeys();
              t.oncomplete = () => ok({ copias: c.result.length, entradas: e.result.map(String).sort() });
            };
          }),
      );
      nota(
        "barrido con otra cuenta (cliente) en el teléfono: borra la copia del staff, su pendiente vencida y su resuelta; deja la pendiente vigente",
        quedan.copias === 0 && JSON.stringify(quedan.entradas) === JSON.stringify(["vigente"]),
        JSON.stringify(quedan),
      );
      await ctx.close();
    } finally {
      await nav.close();
    }
  }

  // ---------- 4. Boleto con la bandera encendida ----------
  {
    const nav = await chromium.launch();
    try {
      const ctx = await nav.newContext({ viewport: { width: 390, height: 844 } });
      const p = await ctx.newPage();
      await p.goto(BASE + "/r/" + R.boleto.qr_code);
      const hay = await visible(p.locator("[data-prueba=codigo-respaldo]"), 30000);
      const texto = hay ? await p.locator("[data-prueba=codigo-respaldo]").innerText() : "";
      nota("boleto: muestra el código corto debajo del QR", hay && texto.includes(corto(R.boleto)), texto.replace(/\s+/g, " "));
      await captura(p, "4-boleto-codigo");
      await ctx.close();
    } finally {
      await nav.close();
    }
  }
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  try {
    await bandera(previa ? previa.activa : null);
    const ahora = (await svc.from("club_funciones").select("activa").eq("club_id", CLUB).eq("funcion", FLAG).maybeSingle()).data;
    console.log(`Bandera ${FLAG} en Club Demo Dev: ${ahora ? ahora.activa : "sin valor propio (apagada)"}`);
  } catch (e) {
    console.log("NO SE PUDO RESTAURAR LA BANDERA: " + e.message);
  }
  if (creadas.length) {
    const { error } = await svc.from("reservations").delete().in("id", creadas);
    console.log(error ? `No se pudieron borrar las reservas de prueba: ${error.message}` : `Reservas de prueba borradas: ${creadas.length}`);
    const quedan = (await svc.from("reservations").select("id").like("cliente_nombre", "t_n4_pwa%")).data?.length;
    console.log(`Quedan reservas t_n4_pwa: ${quedan}`);
  }
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exitCode = pasan === resultados.length ? 0 : 1;
