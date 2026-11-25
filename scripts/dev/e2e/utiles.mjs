// Utilidades de la suite e2e: Playwright, lector de QR (el mismo
// html5-qrcode/zxing que usa la app, dentro de una página en blanco), cámara
// falsa hecha con la captura del QR que pintó la app, y el "corredor" de
// flujos y pasos (tiempo, OK/FALLA/NO CORRIÓ, error y captura).
// Solo dev: lo usa scripts/dev/e2e/correr.mjs.

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Playwright, qrcode y pngjs: del proyecto o de PLAYWRIGHT_DESDE (pngjs viene
// con qrcode).
export async function cargarPlaywright(raiz) {
  const req = createRequire(path.join(raiz, "package.json"));
  const desde = process.env.PLAYWRIGHT_DESDE;
  const reqDesde = desde ? createRequire(path.join(desde, "package.json")) : null;
  const tomar = (nombre) => {
    try {
      return req(nombre);
    } catch {
      if (!reqDesde) throw new Error(`falta ${nombre}`);
      return reqDesde(nombre);
    }
  };
  let playwright;
  try {
    playwright = req("playwright");
  } catch {
    if (!desde) {
      console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright, qrcode y pngjs).");
      process.exit(1);
    }
    playwright = await import(pathToFileURL(path.join(desde, "node_modules", "playwright", "index.mjs")).href);
  }
  try {
    return { chromium: playwright.chromium, QRCode: tomar("qrcode"), PNG: tomar("pngjs").PNG };
  } catch (e) {
    console.log(`Falta una dependencia de la suite (${e.message}): instala qrcode en PLAYWRIGHT_DESDE.`);
    process.exit(1);
  }
}

// ---------- QR ----------
// El QR de la app es un QRCodeSVG (qrcode.react): <svg><path shape-rendering="crispEdges">.
// Se busca dentro de `alcance` (la tarjeta del boleto), no "el primer svg".
export const selectorQR = 'svg:has(> path[shape-rendering="crispEdges"])';

// Página en blanco con el lector html5-qrcode del proyecto (el mismo que usa
// el escáner del staff). Se crea una vez por corrida.
export async function abrirLector(nav, raiz) {
  const ctx = await nav.newContext();
  const p = await ctx.newPage();
  await p.setContent('<!doctype html><html><body><div id="lector" style="width:400px;height:400px"></div></body></html>');
  await p.addScriptTag({ path: path.join(raiz, "node_modules", "html5-qrcode", "html5-qrcode.min.js") });
  return { ctx, pagina: p };
}

// Lee el QR que está en pantalla: captura del recuadro blanco que lo
// envuelve (margen incluido) y la decodifica con html5-qrcode. Devuelve el
// texto y el PNG (para usarlo como cámara del staff).
export async function leerQRDePantalla(lector, alcance) {
  const svg = alcance.locator(selectorQR).first();
  await svg.waitFor({ state: "visible" });
  const caja = svg.locator("xpath=..");
  // Si el lector no encuentra el código (p. ej. captura a media animación de
  // entrada), se repite la captura hasta 4 veces. Solo se reintenta el "no
  // se pudo leer": un valor distinto nunca se reintenta, lo compara quien llama.
  let ultimo = null, ultimoPng = null;
  for (let intento = 1; intento <= 4; intento++) {
    const png = await caja.screenshot({ type: "png", animations: "disabled" });
    const texto = await decodificar(lector, png);
    if (!texto.startsWith("ERROR-LECTOR: ")) {
      const i = texto.indexOf("|");
      return { texto: texto.slice(i + 1), variante: texto.slice(0, i) || "original", png, intentos: intento };
    }
    ultimo = texto;
    ultimoPng = png;
    await caja.page().waitForTimeout(400);
  }
  const e = new Error(`no se pudo leer el QR de la pantalla en 4 capturas, ni pasándolas a blanco y negro (${ultimo.slice(14, 120)})`);
  e.png = ultimoPng;
  throw e;
}

async function decodificar(lector, png) {
  return lector.pagina.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const original = new File([bytes], "qr.png", { type: "image/png" });
    const leer = async (archivo) => {
      document.getElementById("lector").innerHTML = "";
      const h = new __Html5QrcodeLibrary__.Html5Qrcode("lector", false);
      try {
        return { ok: true, texto: await h.scanFile(archivo, false) };
      } catch (e) {
        return { ok: false, texto: String(e?.message ?? e) };
      } finally {
        try { h.clear(); } catch { /* nada */ }
      }
    };
    // Variante: blanco y negro puro (umbral), con margen blanco y a la escala
    // dada. Quita el grano y el sombreado del tema sin cambiar los módulos.
    const variante = async (escala) => {
      const bmp = await createImageBitmap(original);
      const m = 24, w = Math.round(bmp.width * escala), hh = Math.round(bmp.height * escala);
      const cv = Object.assign(document.createElement("canvas"), { width: w + 2 * m, height: hh + 2 * m });
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = escala !== 1;
      ctx.drawImage(bmp, m, m, w, hh);
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] < 128 ? 0 : 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      return new File([blob], "qr-bn.png", { type: "image/png" });
    };
    let r = await leer(original);
    let como = "";
    for (const escala of [1, 0.5]) {
      if (r.ok) break;
      r = await leer(await variante(escala));
      como = `bn${escala}`;
    }
    return r.ok ? `${como}|${r.texto}` : "ERROR-LECTOR: " + r.texto;
  }, png.toString("base64"));
}

// Video .y4m para la cámara falsa de Chrome hecho con la CAPTURA del QR que
// pintó la app (no con un QR que genere la suite): la cámara del staff ve
// exactamente lo que el cliente mostraría. Escala de grises, centrado en
// 640×480 sobre blanco.
export function videoDesdePNG(PNG, pngBuf, ruta) {
  const W = 640, H = 480;
  const img = PNG.sync.read(pngBuf);
  const escala = Math.min(1, (H - 16) / img.height, (W - 16) / img.width);
  const w = Math.floor(img.width * escala), h = Math.floor(img.height * escala);
  const x0 = Math.floor((W - w) / 2), y0 = Math.floor((H - h) / 2);
  const Y = Buffer.alloc(W * H, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.floor(x / escala)), sy = Math.min(img.height - 1, Math.floor(y / escala));
    const i = (sy * img.width + sx) * 4;
    const a = img.data[i + 3] / 255;
    const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    Y[(y0 + y) * W + (x0 + x)] = Math.round(lum * a + 255 * (1 - a));
  }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  const cuadro = Buffer.concat([Buffer.from("FRAME\n"), Y, UV, UV]);
  writeFileSync(ruta, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), cuadro, cuadro, cuadro]));
  return ruta;
}

// ---------- Corredor ----------
export class Abortado extends Error {}

const recorta = (s, n = 900) => (s.length > n ? s.slice(0, n) + "…" : s);
const limpiaError = (e) => recorta(String(e?.message ?? e).replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(0, 8).join("\n"));

// Cada flujo es una lista de pasos. Un paso que falla queda en FALLA con su
// error y captura y, salvo { continuar: true }, corta el flujo: los pasos
// que siguen se listan como «NO CORRIÓ» (no se ejecutan). Un flujo cuyos
// requisitos faltan queda OMITIDO con el motivo.
export class Corredor {
  constructor({ carpetaCapturas }) {
    this.flujos = [];
    this.carpeta = carpetaCapturas;
    this.n = 0;
    mkdirSync(carpetaCapturas, { recursive: true });
  }

  async captura(pagina, nombre) {
    if (!pagina || pagina.isClosed?.()) return null;
    try {
      // scale "css": 390×844 aunque la página tenga deviceScaleFactor 2.
      const buf = await pagina.screenshot({ type: "jpeg", quality: 60, scale: "css", timeout: 10000 });
      return this.guardar(buf, nombre, "jpg");
    } catch {
      return null;
    }
  }

  guardar(buf, nombre, ext) {
    const archivo = `${String(++this.n).padStart(2, "0")}-${nombre.replace(/[^a-z0-9]+/gi, "-").slice(0, 50).toLowerCase()}.${ext}`;
    writeFileSync(path.join(this.carpeta, archivo), buf);
    return { archivo, base64: buf.toString("base64"), tipo: ext === "png" ? "image/png" : "image/jpeg" };
  }

  // requiere: función (puede ser async) que devuelve null si se puede correr
  // o el motivo para omitirlo.
  async flujo(id, titulo, requiere, cuerpo) {
    const f = { id, titulo, pasos: [], estado: "OK", ms: 0, motivo: null, cortado: false };
    this.flujos.push(f);
    console.log(`\n== Flujo ${id}: ${titulo}`);
    let motivo = null;
    try {
      motivo = (await requiere?.()) ?? null;
    } catch (e) {
      motivo = "no se pudo revisar el requisito: " + limpiaError(e);
    }
    if (motivo) {
      f.estado = "OMITIDO";
      f.motivo = motivo;
      console.log(`   OMITIDO  ${motivo}`);
      return f;
    }
    const t0 = Date.now();
    const api = {
      // Paso con interfaz: fn devuelve un detalle (texto) opcional.
      paso: (nombre, fn, opciones = {}) => this.#paso(f, nombre, fn, opciones),
      // Comprobación en la base: fn devuelve { ok, detalle }; FALLA si !ok.
      // Con { pagina } guarda también la pantalla en ese momento.
      verificar: (nombre, fn, opciones = {}) =>
        this.#paso(f, nombre, async () => {
          const r = await fn();
          if (!r.ok) throw new Error(r.detalle ?? "no se cumplió");
          return r.detalle;
        }, opciones),
      // Captura extra (PNG ya tomado) colgada del último paso.
      adjuntar: (buf, nombre) => {
        const ultimo = f.pasos.at(-1);
        if (ultimo) (ultimo.extras ??= []).push(this.guardar(buf, `${f.id}-${nombre}`, "png"));
      },
      get vivo() {
        return !f.cortado;
      },
    };
    try {
      await cuerpo(api);
    } catch (e) {
      f.pasos.push({ nombre: "Error inesperado del script", estado: "FALLA", ms: 0, error: limpiaError(e), captura: null });
    }
    f.ms = Date.now() - t0;
    if (f.pasos.some((p) => p.estado !== "OK")) f.estado = "FALLA";
    return f;
  }

  async #paso(f, nombre, fn, { pagina, continuar = false, capturar = true } = {}) {
    const p = { nombre, estado: "OK", ms: 0, detalle: null, error: null, captura: null };
    f.pasos.push(p);
    if (f.cortado) {
      p.estado = "NO CORRIÓ";
      p.detalle = `no se ejecutó: el flujo se cortó en «${f.cortado}»`;
      console.log(`   ----   ${nombre} (no corrió)`);
      return undefined;
    }
    const t0 = Date.now();
    const pag = typeof pagina === "function" ? pagina() : pagina;
    try {
      const detalle = await fn();
      p.detalle = detalle == null ? null : recorta(String(detalle));
      p.ms = Date.now() - t0;
      if (capturar && pag) p.captura = await this.captura(pag, `${f.id}-${nombre}`);
      console.log(`   OK     ${nombre} (${p.ms} ms)${p.detalle ? "  — " + p.detalle.split("\n")[0].slice(0, 160) : ""}`);
      return detalle;
    } catch (e) {
      p.ms = Date.now() - t0;
      p.estado = "FALLA";
      p.error = limpiaError(e);
      if (pag) p.captura = await this.captura(pag, `${f.id}-FALLA-${nombre}`);
      console.log(`   FALLA  ${nombre} (${p.ms} ms)  — ${p.error.split("\n")[0].slice(0, 300)}`);
      if (!continuar) f.cortado = nombre;
      return undefined;
    }
  }
}

// Afirmación simple para usar dentro de un paso.
export function afirmar(cond, mensaje) {
  if (!cond) throw new Error(mensaje);
}
