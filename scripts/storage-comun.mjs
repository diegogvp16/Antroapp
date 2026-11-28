// Piezas compartidas por scripts/exportar-storage.mjs y
// scripts/dev/importar-storage.mjs (respaldo y restauración de Storage).
// No ejecuta nada al importarse.
//
// Solo usa la API de Storage (listar, descargar y, en el importador, subir):
// `storage.objects` no se toca por SQL (Supabase no lo permite y RLS no
// aplica a la service role).

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leerEnv, refDeLlave, REF_DEV, REF_PROD } from "./db/conexion.mjs";

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export { REF_DEV, REF_PROD };

const require = createRequire(path.join(RAIZ, "package.json"));

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Ref del proyecto según la URL (https://<ref>.supabase.co); null si es un
// dominio propio.
export function refDeUrl(url) {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i.exec(String(url ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

// Lee un archivo de llaves y devuelve el cliente con service role y el ref.
// Falla si la URL y la llave son de proyectos distintos. Nunca imprime llaves.
export function clienteStorage(archivoEnv) {
  const env = leerEnv(archivoEnv);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const llave = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !llave) throw new Error(`${archivoEnv} no trae NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY`);
  const refLlave = refDeLlave(llave);
  const refUrl = refDeUrl(url);
  if (!refLlave) throw new Error(`la service role de ${archivoEnv} no es una llave JWT legible (se necesita para saber a qué proyecto apunta)`);
  if (refUrl && refUrl !== refLlave) throw new Error(`en ${archivoEnv} la URL y la service role son de proyectos distintos`);
  const { createClient } = require("@supabase/supabase-js");
  const svc = createClient(url, llave, { auth: { persistSession: false, autoRefreshToken: false } });
  // "Prueba de fuego" contra prod: cualquiera de los dos refs lo delata.
  const esProd = refLlave === REF_PROD || refUrl === REF_PROD || url.includes(REF_PROD);
  return { svc, ref: refLlave, esProd, esDev: refLlave === REF_DEV && !esProd };
}

// Lista TODOS los objetos de un bucket, a cualquier profundidad, paginando.
// Devuelve [{ ruta, bytes, tipo, cacheControl, etag, actualizado }].
// Las carpetas (id null) no son objetos: se recorren.
export async function listarBucket(svc, bucket) {
  const objetos = [];
  const pendientes = [""];
  while (pendientes.length) {
    const prefijo = pendientes.shift();
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await svc.storage.from(bucket).list(prefijo, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`no se pudo listar un prefijo del bucket ${bucket}: ${error.message}`);
      for (const e of data ?? []) {
        const ruta = prefijo ? `${prefijo}/${e.name}` : e.name;
        if (e.id === null || e.id === undefined) pendientes.push(ruta);
        else
          objetos.push({
            ruta,
            bytes: e.metadata?.size ?? null,
            tipo: e.metadata?.mimetype ?? null,
            cacheControl: e.metadata?.cacheControl ?? null,
            etag: e.metadata?.eTag ?? null,
            actualizado: e.updated_at ?? e.created_at ?? null,
          });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return objetos.sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));
}

// Descarga un objeto como Buffer, con reintentos ante fallas de red.
// `cacheNonce` evita la caché del CDN de Storage: sin él, un objeto recién
// reemplazado (upsert) se descarga con el contenido VIEJO hasta que vence su
// cache-control (visto en dev el 27/11/2026).
export async function descargar(svc, bucket, ruta, intentos = 3) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    const { data, error } = await svc.storage.from(bucket).download(ruta, { cacheNonce: randomUUID() });
    if (!error && data) return Buffer.from(await data.arrayBuffer());
    ultimo = error;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw new Error(`no se pudo descargar un objeto de ${bucket}: ${ultimo?.message ?? "sin detalle"}`);
}

// Huella de un conjunto de archivos: sha256 de las líneas "bucket/ruta sha"
// ordenadas. Dos exportaciones (o exportación e importación) con el mismo
// contenido dan la misma huella, sin importar el orden de descarga.
export function huellaConjunto(archivos, nombreBucket = (b) => b) {
  const lineas = archivos.map((a) => `${nombreBucket(a.bucket)}/${a.ruta} ${a.sha256}`).sort();
  return sha256(Buffer.from(lineas.join("\n"), "utf8"));
}

// Ruta local segura en Windows y en Linux para una ruta de Storage. Se
// codifican con %XX los caracteres que Windows no acepta, el propio "%" y
// los puntos o espacios al final de un segmento; los nombres reservados de
// Windows llevan "_" delante. El manifiesto guarda las dos rutas, así que no
// hace falta decodificar.
const RESERVADOS = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export function rutaLocal(bucket, ruta) {
  const seg = (s) => {
    let x = s.replace(/[%<>:"\\|?*\u0000-\u001f]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase());
    x = x.replace(/[. ]+$/, (m) => [...m].map((c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).join(""));
    if (RESERVADOS.test(x)) x = "_" + x;
    return x || "%00";
  };
  return [seg(bucket), ...ruta.split("/").map(seg)].join("/");
}

// Corre `fn` sobre `items` con a lo más `n` a la vez.
export async function enParalelo(items, n, fn) {
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(trabajadores);
}

export const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
