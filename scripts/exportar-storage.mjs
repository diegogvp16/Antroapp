// Exporta TODOS los archivos de TODOS los buckets de Storage a backups/
// (carpeta ignorada por Git), con manifiesto y verificación al terminar.
// Los respaldos de base de datos de Supabase NO incluyen estos archivos
// (solo sus registros): esto es lo que cubre ese hueco (docs/recuperacion.md).
//
//   node scripts/exportar-storage.mjs                    # dev (.env.dev)
//   node scripts/exportar-storage.mjs --env=<archivo>    # otro proyecto que no es producción
//   node scripts/exportar-storage.mjs --env=<archivo> --produccion
//       PRODUCCIÓN: exige --env explícito y --produccion. Descarga también
//       los documentos PRIVADOS de verificacion-docs (identificaciones,
//       comprobantes fiscales): la carpeta queda en backups/ y no se comparte.
//
// Solo LEE: lista buckets, lista objetos y los descarga con la service role
// del archivo de llaves. No crea, no sube, no borra, no cambia nada.
//
// Deja en backups/storage-<AAAA-MM-DD-HH-MM>-<origen>/:
//   archivos/<bucket>/<ruta>   cada objeto, byte por byte
//   manifiesto.json            buckets (config) y, por archivo: ruta, tamaño,
//                              tipo, cache-control, sha256 y ruta local
//   manifiesto.sha256          huella del manifiesto
// Verificación al terminar: vuelve a leer cada archivo del disco y compara
// tamaño y sha256 con el manifiesto; compara el tamaño con el que reporta
// Storage; revisa que no sobren archivos en la carpeta; y vuelve a listar
// Storage para avisar si algo cambió durante la exportación.
// Imprime solo conteos, tamaños y huellas: nunca rutas ni nombres de archivo.
// Restaurar: scripts/dev/importar-storage.mjs.
//
// Está en scripts/ (no en scripts/dev/) a propósito: es la herramienta de
// recuperación de producción, igual que humo-produccion.mjs. Las de
// scripts/dev/ se niegan a correr contra producción.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RAIZ, clienteStorage, descargar, enParalelo, huellaConjunto, listarBucket, mb, rutaLocal, sha256 } from "./storage-comun.mjs";

const args = process.argv.slice(2);
const argEnv = args.find((a) => a.startsWith("--env="));
const archivoEnv = argEnv ? argEnv.slice(6) : ".env.dev";
const produccion = args.includes("--produccion");
const PARALELO = 6;

// Todo va dentro de main(): en Windows, process.exit() con peticiones
// abiertas tumba Node (assertion de libuv); se sale con return y exitCode.
async function main() {
  let cliente;
  try {
    cliente = clienteStorage(archivoEnv);
  } catch (e) {
    console.log("ABORTO: " + e.message);
    return void (process.exitCode = 1);
  }
  const { svc, ref, esProd, esDev } = cliente;

  if (esProd) {
    if (!argEnv || !produccion) {
      console.log("ABORTO: las llaves son de PRODUCCIÓN. Para exportar producción hay que pedirlo explícito:");
      console.log("  node scripts/exportar-storage.mjs --env=<archivo de llaves de prod> --produccion");
      return void (process.exitCode = 1);
    }
    console.log("AVISO: exportando PRODUCCIÓN (solo lectura). Esto descarga también los documentos");
    console.log("privados de verificación (identificaciones y comprobantes fiscales). La carpeta queda");
    console.log("en backups/ (ignorada por Git): no se sube a ningún lado ni se comparte.");
  } else if (!esDev && !argEnv) {
    console.log("ABORTO: .env.dev no apunta a dev; revisa el archivo.");
    return void (process.exitCode = 1);
  } else if (produccion) {
    console.log("ABORTO: --produccion pero las llaves no son de producción.");
    return void (process.exitCode = 1);
  }
  const origen = esProd ? "prod" : esDev ? "dev" : `ref-${ref.slice(0, 6)}`;

  const t0 = performance.now();
  const fecha = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const DIR = path.join(RAIZ, "backups", `storage-${fecha}-${origen}`);
  if (existsSync(DIR)) {
    console.log("ABORTO: ya existe una exportación con esa fecha; espera un minuto y vuelve a correrlo.");
    return void (process.exitCode = 1);
  }
  const DIR_ARCH = path.join(DIR, "archivos");
  mkdirSync(DIR_ARCH, { recursive: true });

  const { data: buckets, error: errB } = await svc.storage.listBuckets();
  if (errB) {
    console.log("ABORTO: no se pudieron listar los buckets: " + errB.message);
    return void (process.exitCode = 1);
  }

  const manifiesto = {
    herramienta: "scripts/exportar-storage.mjs",
    fecha: new Date().toISOString(),
    origen,
    ref,
    buckets: [],
    archivos: [],
  };
  const fallas = [];
  const avisos = [];
  const listados = {};

  for (const b of [...buckets].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const objetos = await listarBucket(svc, b.id);
    listados[b.id] = objetos;
    manifiesto.buckets.push({
      id: b.id,
      nombre: b.name,
      publico: !!b.public,
      limite_bytes: b.file_size_limit ?? null,
      tipos_permitidos: b.allowed_mime_types ?? null,
      archivos: objetos.length,
      bytes: 0,
    });
  }

  // Choques de nombre local (dos rutas que en disco quedarían en el mismo archivo).
  const locales = new Map();
  for (const [bucket, objetos] of Object.entries(listados))
    for (const o of objetos) {
      const local = rutaLocal(bucket, o.ruta);
      const clave = local.toLowerCase(); // Windows no distingue mayúsculas
      if (locales.has(clave)) fallas.push(`dos objetos de ${bucket} chocan en el mismo nombre local`);
      locales.set(clave, true);
    }
  if (fallas.length) {
    console.log("ABORTO: " + fallas.join("; "));
    return void (process.exitCode = 1);
  }

  const tareas = Object.entries(listados).flatMap(([bucket, objetos]) => objetos.map((o) => ({ bucket, ...o })));
  let hechos = 0;
  await enParalelo(tareas, PARALELO, async (o) => {
    try {
      const buf = await descargar(svc, o.bucket, o.ruta);
      const local = rutaLocal(o.bucket, o.ruta);
      const destino = path.join(DIR_ARCH, ...local.split("/"));
      mkdirSync(path.dirname(destino), { recursive: true });
      writeFileSync(destino, buf);
      manifiesto.archivos.push({
        bucket: o.bucket,
        ruta: o.ruta,
        archivo: `archivos/${local}`,
        bytes: buf.length,
        bytes_storage: o.bytes,
        tipo: o.tipo,
        cache_control: o.cacheControl,
        etag: o.etag,
        actualizado: o.actualizado,
        sha256: sha256(buf),
      });
    } catch (e) {
      fallas.push(`descarga (${o.bucket}): ${e.message}`);
    }
    hechos++;
    if (hechos % 50 === 0) console.log(`  … ${hechos}/${tareas.length}`);
  });

  manifiesto.archivos.sort((a, b) => (a.bucket + "/" + a.ruta < b.bucket + "/" + b.ruta ? -1 : 1));
  for (const mb_ of manifiesto.buckets) mb_.bytes = manifiesto.archivos.filter((a) => a.bucket === mb_.id).reduce((s, a) => s + a.bytes, 0);
  manifiesto.total = { archivos: manifiesto.archivos.length, bytes: manifiesto.archivos.reduce((s, a) => s + a.bytes, 0) };
  manifiesto.huella_conjunto = huellaConjunto(manifiesto.archivos);
  const textoManifiesto = JSON.stringify(manifiesto, null, 2);
  writeFileSync(path.join(DIR, "manifiesto.json"), textoManifiesto);
  const huellaManifiesto = sha256(Buffer.from(textoManifiesto, "utf8"));
  writeFileSync(path.join(DIR, "manifiesto.sha256"), `${huellaManifiesto}  manifiesto.json\n`);

  // ---------------- Verificación ----------------
  const verif = { releidos: 0, malos: 0, tamano_storage_distinto: 0, sobrantes: 0 };
  const leido = JSON.parse(readFileSync(path.join(DIR, "manifiesto.json"), "utf8"));
  for (const a of leido.archivos) {
    const p = path.join(DIR, ...a.archivo.split("/"));
    let ok = false;
    try {
      const buf = readFileSync(p);
      ok = buf.length === a.bytes && sha256(buf) === a.sha256;
    } catch {
      ok = false;
    }
    verif.releidos++;
    if (!ok) verif.malos++;
    if (a.bytes_storage !== null && a.bytes_storage !== a.bytes) verif.tamano_storage_distinto++;
  }
  const enDisco = [];
  const recorrer = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) recorrer(p);
      else enDisco.push(path.relative(DIR, p).split(path.sep).join("/"));
    }
  };
  recorrer(DIR_ARCH);
  const esperados = new Set(leido.archivos.map((a) => a.archivo));
  verif.sobrantes = enDisco.filter((p) => !esperados.has(p)).length;
  if (verif.malos) fallas.push(`${verif.malos} archivos no coinciden con su huella al releerlos`);
  if (verif.tamano_storage_distinto) fallas.push(`${verif.tamano_storage_distinto} archivos con tamaño distinto al que reporta Storage`);
  if (verif.sobrantes) fallas.push(`${verif.sobrantes} archivos en la carpeta que no están en el manifiesto`);
  if (leido.archivos.length !== tareas.length) fallas.push(`se listaron ${tareas.length} objetos y se exportaron ${leido.archivos.length}`);

  // ¿Cambió Storage mientras se exportaba? (aviso, no falla: la foto es del inicio)
  let cambios = 0;
  for (const b of manifiesto.buckets) {
    const ahora = await listarBucket(svc, b.id);
    const antes = new Map(listados[b.id].map((o) => [o.ruta, o.bytes]));
    const despues = new Map(ahora.map((o) => [o.ruta, o.bytes]));
    for (const [r, s] of despues) if (antes.get(r) !== s) cambios++;
    for (const r of antes.keys()) if (!despues.has(r)) cambios++;
  }
  const { data: bucketsDespues } = await svc.storage.listBuckets();
  if ((bucketsDespues ?? []).length !== buckets.length) cambios++;
  if (cambios) avisos.push(`${cambios} objetos o buckets cambiaron durante la exportación (la exportación es la foto del inicio; vuelve a correrla si importa)`);

  const seg = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nExportación de Storage (${origen}) en ${path.relative(RAIZ, DIR)}`);
  for (const b of manifiesto.buckets) console.log(`  ${b.id}${b.publico ? " (público)" : " (privado)"}: ${b.archivos} archivos, ${mb(b.bytes)} MB`);
  console.log(`  Total: ${manifiesto.total.archivos} archivos, ${mb(manifiesto.total.bytes)} MB en ${seg} s`);
  console.log(`  Verificación: ${verif.releidos - verif.malos}/${verif.releidos} huellas OK al releer del disco; sobrantes: ${verif.sobrantes}`);
  console.log(`  Huella del conjunto: ${manifiesto.huella_conjunto.slice(0, 16)}…  Huella del manifiesto: ${huellaManifiesto.slice(0, 16)}…`);
  for (const a of avisos) console.log("  AVISO: " + a);
  if (fallas.length) {
    console.log("\nFALLA:\n  " + [...new Set(fallas)].join("\n  "));
    process.exitCode = 1;
  } else console.log("\nOK: exportación completa y verificada.");
}

await main();
