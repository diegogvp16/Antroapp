// Conteos y estados de producción para preparar una junta o un pase, SIN
// datos personales y en solo lectura (conectarProdConteos: consultas fijas).
//
//   node scripts/db/conteos-prod.mjs
//
// Imprime solo números, estados y "tiene / no tiene" de Club Demo y del total
// de antros. Nunca correos, nombres ni teléfonos.

import { conectarProdConteos } from "./conexion.mjs";

const db = await conectarProdConteos();
try {
  for (const nombre of db.nombres) {
    const filas = await db.consultar(nombre);
    console.log(`\n== ${nombre}`);
    for (const f of filas) console.log("  " + JSON.stringify(f));
  }
} finally {
  await db.fin();
}
