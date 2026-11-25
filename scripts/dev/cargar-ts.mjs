// Deja que Node (con su "type stripping") cargue módulos de lib/domain que se
// importan entre sí SIN extensión (`import … from "./lector-csv"`), como los
// escribe Next. Node, a diferencia de Next, exige la extensión: este gancho
// prueba con ".ts" cuando la importación relativa sale de un archivo .ts.
//
// Uso (las importaciones ESTÁTICAS se resuelven antes de que corra el
// gancho, así que los módulos se cargan con import() después):
//
//   import { importarTs } from "./cargar-ts.mjs";
//   const { leerMesasCsv } = await importarTs("../../lib/domain/importar-mesas.ts", import.meta.url);

import { registerHooks } from "node:module";

let registrado = false;
function registrar() {
  if (registrado) return;
  registrado = true;
  registerHooks({
    resolve(especificador, contexto, siguiente) {
      try {
        return siguiente(especificador, contexto);
      } catch (e) {
        const desdeTs = contexto.parentURL?.endsWith(".ts") ?? false;
        if (desdeTs && /^\.\.?\//.test(especificador) && !/\.[cm]?[jt]s$/.test(especificador)) {
          return siguiente(especificador + ".ts", contexto);
        }
        throw e;
      }
    },
  });
}

export async function importarTs(ruta, base) {
  registrar();
  return import(new URL(ruta, base).href);
}
