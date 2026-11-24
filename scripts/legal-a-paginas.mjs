// Copia el texto de los documentos legales (docs/legal/*.md, la fuente para el
// abogado) a lib/legal/textos.ts, que es lo que muestran /terminos y
// /privacidad. docs/ no se sube a Vercel, por eso se copia.
//
//   node scripts/legal-a-paginas.mjs            # regenera lib/legal/textos.ts
//   node scripts/legal-a-paginas.mjs --revisar  # falla si no coinciden

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leer = (f) => readFileSync(path.join(RAIZ, "docs/legal", f), "utf8").replace(/\r/g, "").trim();
const textos = {
  TEXTO_TERMINOS: leer("terminos.md"),
  TEXTO_RESERVAS_QR: leer("reservas-y-qr.md"),
  TEXTO_PRIVACIDAD: leer("privacidad.md"),
};
const salida =
  "// GENERADO por scripts/legal-a-paginas.mjs a partir de docs/legal/*.md.\n" +
  "// No se edita a mano: edita el .md y vuelve a correr el script.\n" +
  "// BORRADORES: requieren revisión de un abogado.\n\n" +
  Object.entries(textos).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};\n`).join("\n");
const destino = path.join(RAIZ, "lib/legal/textos.ts");
if (process.argv.includes("--revisar")) {
  let actual = "";
  try { actual = readFileSync(destino, "utf8").replace(/\r/g, ""); } catch { /* no existe */ }
  if (actual !== salida) {
    console.log("lib/legal/textos.ts NO coincide con docs/legal/*.md: corre node scripts/legal-a-paginas.mjs");
    process.exitCode = 1;
  } else console.log("Textos legales al día.");
} else {
  writeFileSync(destino, salida);
  console.log("lib/legal/textos.ts actualizado.");
}
