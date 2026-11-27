// Pruebas del escritor de PDF sin dependencias (lib/pdf/escritor.ts).
// No toca la base. Usa pdftotext (Xpdf/Poppler, viene con Git para Windows)
// como lector INDEPENDIENTE: si él lee el texto, el PDF abre y los acentos
// salen bien.
//
//   node scripts/dev/probar-pdf-escritor.mjs
//
// Revisa: encabezado y tabla xref (cada desplazamiento apunta a "N 0 obj"),
// que el archivo sea ASCII salvo la marca binaria, acentos y signos del
// español (á é í ó ú ü ñ ¿ ¡ $ — –), partir renglones de nombres largos,
// recortar con "…", varias hojas y caracteres fuera de WinAnsi.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const E = await import(pathToFileURL(path.join(RAIZ, "lib/pdf/escritor.ts")).href);

let pasan = 0;
let fallan = 0;
function revisar(nombre, paso, detalle = "") {
  if (paso) pasan++; else fallan++;
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${!paso && detalle ? "  — " + detalle : ""}`);
}

const dir = mkdtempSync(path.join(tmpdir(), "pdf-escritor-"));
function aTexto(bytes, nombre) {
  const archivo = path.join(dir, nombre);
  writeFileSync(archivo, bytes);
  execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", archivo, archivo + ".txt"]);
  return readFileSync(archivo + ".txt", "utf8");
}

// 1. Estructura.
const ACENTOS = "Áéíóú ÁÉÍÓÚ ñÑ üÜ ¿Qué tal? ¡Salud! $1,234.56 — – «Noche» € ÷ ·";
const d = new E.DocumentoPdf();
d.texto(40, 60, ACENTOS, { tam: 12 });
d.texto(572, 80, "Derecha", { alinear: "der", fuente: "negrita" });
d.rect(40, 100, 200, 20, [0.9, 0.9, 0.9], [0, 0, 0]);
d.linea(40, 130, 572, 130);
d.nuevaPagina();
d.texto(40, 60, "Segunda hoja: Señora Peña", { tam: 10 });
const bytes = d.generar({ titulo: "Prueba · Año Peña", creado: new Date(Date.UTC(2026, 10, 27, 12, 0, 0)) });
const s = Buffer.from(bytes).toString("latin1");
revisar("empieza con %PDF-1.4", s.startsWith("%PDF-1.4\n"));
revisar("termina con %%EOF", s.trimEnd().endsWith("%%EOF"));
const noAscii = [...s.slice(15)].filter((c) => c.charCodeAt(0) > 127).length;
revisar("ASCII puro después de la marca binaria", noAscii === 0, `${noAscii} bytes > 127`);
const inicioXref = Number(/startxref\n(\d+)\n/.exec(s)?.[1]);
revisar("startxref apunta a 'xref'", s.slice(inicioXref, inicioXref + 4) === "xref");
const entradas = s.slice(inicioXref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
const bienPuestas = entradas.every((l, i) => s.slice(Number(l.slice(0, 10))).startsWith(`${i + 1} 0 obj`));
revisar(`xref: ${entradas.length} desplazamientos exactos`, entradas.length > 0 && bienPuestas);
revisar("/Count 2 (dos hojas)", /\/Count 2 /.test(s));
revisar("fuentes WinAnsi", (s.match(/\/Encoding \/WinAnsiEncoding/g) ?? []).length === 2);

// 2. Lector independiente.
const txt = aTexto(bytes, "estructura.pdf");
revisar("pdftotext lee los acentos y signos tal cual", txt.includes(ACENTOS), JSON.stringify(txt.slice(0, 200)));
revisar("pdftotext lee la segunda hoja", txt.includes("Segunda hoja: Señora Peña"));
revisar("salto de hoja (form feed) entre las dos", (txt.match(/\f/g) ?? []).length >= 1);

// 3. Medidas, partir y recortar.
revisar("ancho de 'a' en Helvetica 10 = 5.56", Math.abs(E.anchoTexto("a", "normal", 10) - 5.56) < 1e-9);
revisar("ancho de 'á' = ancho de 'a'", E.anchoTexto("á") === E.anchoTexto("a"));
revisar("negrita más ancha que normal", E.anchoTexto("Comisión", "negrita") > E.anchoTexto("Comisión", "normal"));
const largo = "María Fernanda de los Ángeles Peñaloza Ibáñez-Gutiérrez y Asociados del Bajío";
const renglones = E.partirTexto(largo, 120, "normal", 9);
revisar("nombre largo se parte en varios renglones", renglones.length >= 3, JSON.stringify(renglones));
revisar("cada renglón cabe", renglones.every((r) => E.anchoTexto(r, "normal", 9) <= 120));
revisar("no se pierde ninguna palabra", renglones.join(" ") === largo);
const palabraLarga = "Supercalifragilísticoespialidosoooooooooooooo";
const cortes = E.partirTexto(palabraLarga, 60, "normal", 9);
revisar("una palabra más larga que el renglón se corta por letras", cortes.length > 1 && cortes.join("") === palabraLarga && cortes.every((r) => E.anchoTexto(r, "normal", 9) <= 60));
const rec = E.recortarTexto(largo, 100, "normal", 9);
revisar("recortar termina en … y cabe", rec.endsWith("…") && E.anchoTexto(rec, "normal", 9) <= 100, rec);
revisar("sin recorte si cabe", E.recortarTexto("Corto", 100) === "Corto");

// 4. Fuera de WinAnsi: sin acentos (ź → z) o "?" (Ł no se descompone); espacios de Intl como espacio.
revisar("ő (fuera de WinAnsi) → o", String.fromCharCode(...E.aWinAnsi("ő")) === "o");
const w = (t) => String.fromCharCode(...E.aWinAnsi(t));
revisar("emoji: no se imprime", w("🍸") === "");
revisar("«Ana ❤️» → «Ana » (corazón y selector U+FE0F fuera)", w("Ana ❤️") === "Ana ", JSON.stringify(w("Ana ❤️")));
revisar("familia (emojis unidos con U+200D) → nada", w("👨‍👩‍👧") === "", JSON.stringify(w("👨‍👩‍👧")));
revisar("tono de piel y bandera → nada", w("👍🏽🇲🇽") === "", JSON.stringify(w("👍🏽🇲🇽")));
revisar("marcas de dirección U+200E/U+200F y espacio de ancho cero → nada", w("a‎b‏c​d") === "abcd");
revisar("letras de ancho completo → normales", w("ＡＢＣ１２３") === "ABC123", JSON.stringify(w("ＡＢＣ１２３")));
revisar("ligadura ﬁ → fi", w("ﬁn") === "fin");
revisar("acento combinado (e + U+0301) → é", w("José") === "José");
revisar("letra sin lugar en WinAnsi (Ж, Ł) → ?", w("Ж") === "?" && w("Ł") === "?");
revisar("© ® ™ € se conservan (bytes WinAnsi A9 AE 99 80)", E.aWinAnsi("©®™€").join(",") === [0xa9, 0xae, 0x99, 0x80].join(","));
revisar("caracteres de control → nada", w("ab") === "ab");
revisar("espacio angosto de Intl → espacio", String.fromCharCode(...E.aWinAnsi("1 000")) === "1 000");
revisar("signo menos → guion", String.fromCharCode(...E.aWinAnsi("−50")) === "-50");
const d2 = new E.DocumentoPdf();
d2.texto(40, 60, "Zoë Brontë — Łódź 🍸 ¡Ñandú!");
const t2 = aTexto(d2.generar({ titulo: "x" }), "fuera.pdf");
revisar("pdftotext: fuera de WinAnsi sale legible", /Zoë Brontë — \?ódz +¡Ñandú!/.test(t2), JSON.stringify(t2.trim()));

// 5. Rendimiento: un nombre de 20,000 letras (profiles.nombre no tiene límite).
const enorme = "A".repeat(20000);
let t0 = performance.now();
const partes = E.partirTexto(enorme, 150, "normal", 8.5);
const msPartir = performance.now() - t0;
revisar(`partir 20,000 letras en una pasada (${msPartir.toFixed(0)} ms < 300 ms)`, msPartir < 300 && partes.join("") === enorme && partes.every((r) => E.anchoTexto(r, "normal", 8.5) <= 150));
t0 = performance.now();
const tope = E.partirTexto(enorme + " " + "B".repeat(20000), 150, "normal", 8.5, 3);
const msTope = performance.now() - t0;
revisar(`con tope de 3 renglones: 3, el último con «…» y todos caben (${msTope.toFixed(0)} ms)`, tope.length === 3 && tope[2].endsWith("…") && tope.every((r) => E.anchoTexto(r, "normal", 8.5) <= 150) && msTope < 300);
t0 = performance.now();
const corto = E.recortarTexto(enorme, 100, "negrita", 9);
const msRec = performance.now() - t0;
revisar(`recortar 20,000 letras (${msRec.toFixed(0)} ms < 100 ms) y cabe`, msRec < 100 && corto.endsWith("…") && E.anchoTexto(corto, "negrita", 9) <= 100);
revisar("con tope: texto corto queda igual", JSON.stringify(E.partirTexto("Hola mundo", 200, "normal", 10, 3)) === JSON.stringify(["Hola mundo"]));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pasan} pasan, ${fallan} fallan`);
process.exit(fallan ? 1 : 0);
