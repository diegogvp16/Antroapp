// Sube una exportación de scripts/exportar-storage.mjs a un proyecto de
// Supabase que NO sea producción (dev, o el proyecto nuevo de una
// restauración). Se niega si la URL o la service role son de producción.
//
//   node scripts/dev/importar-storage.mjs backups/storage-<fecha>-<origen>
//       Simula (por defecto): revisa las huellas de la exportación y dice qué haría.
//   node scripts/dev/importar-storage.mjs <dir> --env=<archivo> --si
//       Sube. Crea los buckets que falten con la misma configuración
//       (público/privado, límite de tamaño, tipos permitidos).
//   … --sobrescribir
//       Reemplaza los objetos que ya existan con otro contenido o que la base
//       registre sin archivo (pasa si la base restaurada trae storage.objects).
//   … --prefijo=<texto>
//       Sube a "<texto><bucket>" en lugar de "<bucket>".
//   node scripts/dev/importar-storage.mjs <dir> --prueba-temporal
//       ENSAYO sin tocar los buckets reales: crea buckets temporales
//       "tmp-rest-<hora>-<bucket>", importa, compara huellas, los vacía y los
//       borra (aunque algo falle). Además compara los buckets reales antes y
//       después para confirmar que quedaron igual.
//
// Por defecto --env=.env.dev. Verificación al terminar: descarga cada objeto
// del destino y compara su sha256 con el manifiesto. Imprime solo conteos,
// tamaños y huellas, nunca rutas ni nombres de archivo.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RAIZ, clienteStorage, descargar, enParalelo, huellaConjunto, listarBucket, mb, sha256 } from "../storage-comun.mjs";

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith("--"));
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const archivoEnv = opt("env") ?? ".env.dev";
const pruebaTemporal = args.includes("--prueba-temporal");
const si = args.includes("--si") || pruebaTemporal;
const sobrescribir = args.includes("--sobrescribir");
const hora = new Date().toISOString().replace(/\D/g, "").slice(4, 12); // MMDDHHmm
const prefijo = pruebaTemporal ? `tmp-rest-${hora}-` : (opt("prefijo") ?? "");
const PARALELO = 6;

// Todo va dentro de main(): en Windows, process.exit() con peticiones
// abiertas tumba Node (assertion de libuv); se sale con return y exitCode.
async function main() {
  const DIR = dirArg ? path.resolve(RAIZ, dirArg) : null;
  if (!DIR || !existsSync(path.join(DIR, "manifiesto.json"))) {
    console.log("Uso: node scripts/dev/importar-storage.mjs backups/storage-<fecha>-<origen> [--env=<archivo>] [--si] [--sobrescribir] [--prefijo=<texto>] [--prueba-temporal]");
    return void (process.exitCode = 1);
  }
  if (prefijo && !/^[a-z0-9-]+$/.test(prefijo)) {
    console.log("ABORTO: --prefijo solo admite minúsculas, números y guiones.");
    return void (process.exitCode = 1);
  }

  let cliente;
  try {
    cliente = clienteStorage(archivoEnv);
  } catch (e) {
    console.log("ABORTO: " + e.message);
    return void (process.exitCode = 1);
  }
  const { svc, esProd, esDev, ref } = cliente;
  if (esProd) {
    console.log("ABORTO: las llaves son de PRODUCCIÓN. Este script nunca sube a producción.");
    return void (process.exitCode = 1);
  }
  console.log(`Destino: ${esDev ? "antroapp-dev" : `proyecto ${ref.slice(0, 6)}… (no es dev ni producción)`}${prefijo ? `, buckets con prefijo "${prefijo}"` : ""}`);

  const t0 = performance.now();
  const textoManifiesto = readFileSync(path.join(DIR, "manifiesto.json"), "utf8");
  const manifiesto = JSON.parse(textoManifiesto);
  const huellaGuardada = existsSync(path.join(DIR, "manifiesto.sha256")) ? readFileSync(path.join(DIR, "manifiesto.sha256"), "utf8").split(/\s+/)[0] : null;
  if (huellaGuardada && huellaGuardada !== sha256(Buffer.from(textoManifiesto, "utf8"))) {
    console.log("ABORTO: el manifiesto no coincide con manifiesto.sha256 (¿se editó o se corrompió?).");
    return void (process.exitCode = 1);
  }

  // 1. La exportación está íntegra antes de subir nada.
  const contenido = new Map();
  let malos = 0;
  for (const a of manifiesto.archivos) {
    try {
      const buf = readFileSync(path.join(DIR, ...a.archivo.split("/")));
      if (buf.length !== a.bytes || sha256(buf) !== a.sha256) malos++;
      else contenido.set(a, buf);
    } catch {
      malos++;
    }
  }
  if (malos) {
    console.log(`ABORTO: ${malos} archivos de la exportación no coinciden con el manifiesto. No se subió nada.`);
    return void (process.exitCode = 1);
  }
  console.log(`Exportación íntegra: ${manifiesto.archivos.length} archivos, ${mb(manifiesto.total.bytes)} MB, de ${manifiesto.origen} (${manifiesto.fecha.slice(0, 16)}).`);

  const destino = (b) => prefijo + b;
  const { data: existentes, error: errB } = await svc.storage.listBuckets();
  if (errB) {
    console.log("ABORTO: no se pudieron listar los buckets del destino: " + errB.message);
    return void (process.exitCode = 1);
  }
  const yaHay = new Map(existentes.map((b) => [b.id, b]));
  if (pruebaTemporal) {
    const choque = manifiesto.buckets.filter((b) => yaHay.has(destino(b.id)));
    if (choque.length) {
      console.log("ABORTO: ya existen buckets con el nombre temporal; espera un minuto.");
      return void (process.exitCode = 1);
    }
  }

  // Foto de los buckets reales (solo en la prueba temporal) para comparar al final.
  async function fotoReales() {
    const { data } = await svc.storage.listBuckets();
    const ids = (data ?? []).map((b) => b.id).filter((id) => !id.startsWith(prefijo || "\u0000")).sort();
    const lineas = [];
    for (const id of ids) for (const o of await listarBucket(svc, id)) lineas.push(`${id}/${o.ruta} ${o.bytes} ${o.etag}`);
    const b = (data ?? []).filter((x) => ids.includes(x.id)).map((x) => `${x.id}:${x.public}:${x.file_size_limit}:${(x.allowed_mime_types ?? []).join(",")}`).sort();
    return { buckets: ids.length, objetos: lineas.length, huella: sha256(Buffer.from([...b, ...lineas.sort()].join("\n"), "utf8")) };
  }
  const antes = pruebaTemporal ? await fotoReales() : null;

  const plan = manifiesto.buckets.map((b) => ({ ...b, destino: destino(b.id), existe: yaHay.has(destino(b.id)) }));
  for (const p of plan) {
    const d = yaHay.get(p.destino);
    const distinto =
      d && (!!d.public !== p.publico || (d.file_size_limit ?? null) !== p.limite_bytes || JSON.stringify(d.allowed_mime_types ?? null) !== JSON.stringify(p.tipos_permitidos));
    console.log(`  ${p.id} → ${p.existe ? "bucket existente" : "bucket nuevo"}${distinto ? " (AVISO: su configuración es distinta a la exportada)" : ""}: ${p.archivos} archivos, ${mb(p.bytes)} MB`);
  }
  if (!si) {
    console.log("\nSimulación: no se subió nada. Para importar agrega --si (o --prueba-temporal para el ensayo).");
    return void (process.exitCode = 0);
  }

  const creados = [];
  const fallas = [];
  const cuenta = { subidos: 0, iguales: 0, reemplazados: 0 };
  let verificacion = { ok: 0, total: 0 };
  let huellaDestino = null;
  try {
    // 2. Buckets que faltan, con la misma configuración.
    for (const p of plan.filter((x) => !x.existe)) {
      const { error } = await svc.storage.createBucket(p.destino, {
        public: p.publico,
        fileSizeLimit: p.limite_bytes ?? undefined,
        allowedMimeTypes: p.tipos_permitidos ?? undefined,
      });
      if (error) throw new Error(`no se pudo crear el bucket ${p.destino}: ${error.message}`);
      creados.push(p.destino);
    }

    // 3. Subir. Lo que ya existe se compara por huella antes de decidir.
    const enDestino = new Map();
    for (const p of plan.filter((x) => x.existe)) enDestino.set(p.destino, new Set((await listarBucket(svc, p.destino)).map((o) => o.ruta)));
    await enParalelo(manifiesto.archivos, PARALELO, async (a) => {
      const bucket = destino(a.bucket);
      const buf = contenido.get(a);
      const opciones = { contentType: a.tipo ?? "application/octet-stream", upsert: false };
      const segundos = /(\d+)/.exec(a.cache_control ?? "")?.[1];
      if (segundos) opciones.cacheControl = segundos;
      if (enDestino.get(bucket)?.has(a.ruta)) {
        let igual = false;
        try {
          igual = sha256(await descargar(svc, bucket, a.ruta, 1)) === a.sha256;
        } catch {
          igual = false; // registro sin archivo, o no se pudo leer
        }
        if (igual) return void cuenta.iguales++;
        if (!sobrescribir) return void fallas.push(`${bucket}: un objeto ya existe con otro contenido (o sin archivo); usa --sobrescribir`);
        opciones.upsert = true;
      }
      const { error } = await svc.storage.from(bucket).upload(a.ruta, buf, opciones);
      if (error) fallas.push(`${bucket}: no se pudo subir un objeto (${a.bytes} bytes, ${a.tipo}): ${error.message}`);
      else if (opciones.upsert) cuenta.reemplazados++;
      else cuenta.subidos++;
    });

    // 4. Verificación: cada objeto del destino, descargado, contra su huella.
    const verificados = [];
    await enParalelo(manifiesto.archivos, PARALELO, async (a) => {
      verificacion.total++;
      try {
        const h = sha256(await descargar(svc, destino(a.bucket), a.ruta));
        if (h === a.sha256) {
          verificacion.ok++;
          verificados.push({ bucket: a.bucket, ruta: a.ruta, sha256: h });
        }
      } catch {
        /* cuenta como no verificado */
      }
    });
    huellaDestino = huellaConjunto(verificados);
    if (verificacion.ok !== verificacion.total) fallas.push(`${verificacion.total - verificacion.ok} objetos del destino no coinciden con su huella`);
    if (huellaDestino !== manifiesto.huella_conjunto) fallas.push("la huella del conjunto en el destino no es la de la exportación");
    // Objetos de más en el destino (solo puede pasar en un bucket que ya existía).
    for (const p of plan) {
      const n = (await listarBucket(svc, p.destino)).length;
      if (n !== p.archivos) console.log(`  AVISO: ${p.destino} tiene ${n} objetos y la exportación ${p.archivos} (había otros antes)`);
    }
  } catch (e) {
    fallas.push(e.message);
  } finally {
    // 5. Prueba temporal: vaciar y borrar SOLO los buckets que creó esta corrida.
    if (pruebaTemporal) {
      for (const id of creados) {
        if (!id.startsWith(prefijo)) continue;
        try {
          for (let vuelta = 0; vuelta < 5; vuelta++) {
            const rutas = (await listarBucket(svc, id)).map((o) => o.ruta);
            if (!rutas.length) break;
            for (let i = 0; i < rutas.length; i += 100) {
              const { error } = await svc.storage.from(id).remove(rutas.slice(i, i + 100));
              if (error) throw new Error(error.message);
            }
          }
          const { error } = await svc.storage.deleteBucket(id);
          if (error) throw new Error(error.message);
        } catch (e) {
          fallas.push(`no se pudo borrar el bucket temporal ${id}: ${e.message} (bórralo a mano en Storage)`);
        }
      }
      const { data: quedan } = await svc.storage.listBuckets();
      const sobran = (quedan ?? []).filter((b) => b.id.startsWith(prefijo)).length;
      if (sobran) fallas.push(`quedaron ${sobran} buckets temporales sin borrar`);
      const despues = await fotoReales();
      console.log(
        `\nBuckets reales antes/después: ${antes.buckets}/${despues.buckets} buckets, ${antes.objetos}/${despues.objetos} objetos, huella ${antes.huella.slice(0, 12)}…/${despues.huella.slice(0, 12)}… ${
          antes.huella === despues.huella ? "(iguales)" : "(DISTINTOS)"
        }`,
      );
      if (antes.huella !== despues.huella) fallas.push("los buckets reales cambiaron durante la prueba (¿otro proceso subió algo?)");
      console.log(`Buckets temporales creados y borrados: ${creados.length}; quedan: ${sobran}`);
    }
  }

  const seg = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nImportación: ${cuenta.subidos} subidos, ${cuenta.iguales} ya estaban iguales, ${cuenta.reemplazados} reemplazados, en ${seg} s`);
  console.log(`Verificación en el destino: ${verificacion.ok}/${verificacion.total} huellas OK; huella del conjunto ${huellaDestino ? huellaDestino.slice(0, 16) + "…" : "—"} (exportación ${manifiesto.huella_conjunto.slice(0, 16)}…)`);
  if (fallas.length) {
    console.log("\nFALLA:\n  " + [...new Set(fallas)].slice(0, 20).join("\n  "));
    process.exitCode = 1;
  } else console.log("\nOK: importación completa y verificada.");
}

await main();
