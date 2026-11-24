// Genera los iconos de la app instalable a partir de un SVG (marca: negro
// obsidiana #0B0A0A, oro latón #C9A227; ver CLAUDE.md, "Temas visuales").
//
//   node scripts/generar-iconos.mjs
//
// Escribe en public/ (cliente) y public/iconos/ (Staff, RP y Dueño):
//   *-192.png, *-512.png         propósito "any"
//   *-maskable-512.png           propósito "maskable": la marca dentro del
//                                círculo seguro (80 % centrado) de Android
//   apple-touch-icon.png         180 px, sin transparencia
//   app/favicon.ico              32 px (ICO con PNG dentro)
// Usa sharp (ya viene con Next.js). No necesita red.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = createRequire(path.join(RAIZ, "package.json"))("sharp");

const NEGRO = "#0B0A0A";
const ORO = "#C9A227";
const TEXTO = "#F2EFE9";

// La "A" de AntroApp: dos trazos y travesaño, con remate horizontal (sin
// fuentes: todo son trazos, se ve igual en cualquier máquina). escala 1 = la
// marca ocupa ~46 % del lado; para maskable se achica para caber en el
// círculo seguro.
function svg({ etiqueta = null, escala = 1 }) {
  const c = 256;
  const alto = 236 * escala;
  const ancho = 200 * escala;
  const grosor = 26 * escala;
  const sube = etiqueta ? 34 * escala : 0; // deja lugar a la etiqueta
  const ap = { x: c, y: c - alto / 2 - sube };
  const base = c + alto / 2 - sube;
  const izq = c - ancho / 2;
  const der = c + ancho / 2;
  const barraY = base - alto * 0.34;
  const t = (y) => (y - ap.y) / (base - ap.y);
  const xIzq = (y) => ap.x + (izq - ap.x) * t(y);
  const xDer = (y) => ap.x + (der - ap.x) * t(y);
  const remate = 22 * escala;
  const texto = etiqueta
    ? `<text x="${c}" y="${base + 78 * escala}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${46 * escala}" letter-spacing="${10 * escala}" fill="${TEXTO}">${etiqueta}</text>`
    : "";
  // Las piernas se prolongan y se recortan en la línea base: el corte queda
  // horizontal, sin la punta diagonal del trazo.
  const extra = grosor * 1.5;
  const pie = grosor * 0.62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><clipPath id="base"><rect x="0" y="0" width="512" height="${base}"/></clipPath></defs>
  <rect width="512" height="512" fill="${NEGRO}"/>
  <g clip-path="url(#base)" stroke="${ORO}" stroke-width="${grosor}" stroke-linejoin="miter" stroke-miterlimit="10" fill="none">
    <polyline points="${xIzq(base + extra)},${base + extra} ${ap.x},${ap.y} ${xDer(base + extra)},${base + extra}"/>
    <line x1="${xIzq(barraY)}" y1="${barraY}" x2="${xDer(barraY)}" y2="${barraY}"/>
  </g>
  <rect x="${izq - remate}" y="${base - pie}" width="${remate * 2 + grosor * 0.4}" height="${pie}" fill="${ORO}"/>
  <rect x="${der - remate - grosor * 0.4}" y="${base - pie}" width="${remate * 2 + grosor * 0.4}" height="${pie}" fill="${ORO}"/>
  ${texto}
</svg>`;
}

async function png(svgTexto, lado) {
  return sharp(Buffer.from(svgTexto)).resize(lado, lado).png({ compressionLevel: 9 }).toBuffer();
}

// ICO con un PNG dentro (válido desde Windows Vista y en todos los navegadores).
function ico(pngBuffer, lado) {
  const cab = Buffer.alloc(6);
  cab.writeUInt16LE(0, 0);
  cab.writeUInt16LE(1, 2);
  cab.writeUInt16LE(1, 4);
  const dir = Buffer.alloc(16);
  dir.writeUInt8(lado >= 256 ? 0 : lado, 0);
  dir.writeUInt8(lado >= 256 ? 0 : lado, 1);
  dir.writeUInt8(0, 2);
  dir.writeUInt8(0, 3);
  dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(pngBuffer.length, 8);
  dir.writeUInt32LE(22, 12);
  return Buffer.concat([cab, dir, pngBuffer]);
}

const PUBLICO = path.join(RAIZ, "public");
const ICONOS = path.join(PUBLICO, "iconos");
mkdirSync(ICONOS, { recursive: true });

const escribir = (ruta, buf) => {
  writeFileSync(ruta, buf);
  console.log("escrito", path.relative(RAIZ, ruta), `${Math.round(buf.length / 1024)} KB`);
};

// Cliente (la app de siempre).
escribir(path.join(PUBLICO, "icon-192.png"), await png(svg({}), 192));
escribir(path.join(PUBLICO, "icon-512.png"), await png(svg({}), 512));
escribir(path.join(PUBLICO, "icon-maskable-512.png"), await png(svg({ escala: 0.78 }), 512));
escribir(path.join(PUBLICO, "apple-touch-icon.png"), await png(svg({}), 180));
escribir(path.join(RAIZ, "app", "favicon.ico"), ico(await png(svg({}), 32), 32));

// Apps de trabajo: la misma marca con su etiqueta.
for (const [clave, etiqueta] of [["staff", "STAFF"], ["rp", "RP"], ["dueno", "DUEÑO"]]) {
  escribir(path.join(ICONOS, `${clave}-192.png`), await png(svg({ etiqueta }), 192));
  escribir(path.join(ICONOS, `${clave}-512.png`), await png(svg({ etiqueta }), 512));
  escribir(path.join(ICONOS, `${clave}-maskable-512.png`), await png(svg({ etiqueta, escala: 0.74 }), 512));
  escribir(path.join(ICONOS, `${clave}-apple-180.png`), await png(svg({ etiqueta }), 180));
}
