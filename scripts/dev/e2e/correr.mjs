// Suite de punta a punta de AntroApp (SOLO antroapp-dev).
//
// Uso (desde la raíz del proyecto, con el servidor local contra dev):
//
//   PUERTO=3031 node scripts/dev/servidor-dev.mjs          # en otra terminal
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright y qrcode> \
//     node scripts/dev/e2e/correr.mjs [--base=http://localhost:3031]
//
// Los flujos de la fase 2 (10 y 11) necesitan el servidor con
// NEXT_PUBLIC_FASE2=1 (con la bandera global apagada el catálogo y la
// propina no aparecen y esos flujos fallan). En un worktree, Turbopack no
// arranca: ahí se usa `set -a; . ./.env.dev; set +a; NEXT_PUBLIC_FASE2=1
// npx next dev -p 3061` (webpack) y --base=http://localhost:3061.
//
// Deja el reporte autocontenido en screenshots-e2e/reporte.html (carpeta
// ignorada por Git, regla /screenshots-*/): cada flujo, cada paso, tiempo,
// OK/FALLA/NO CORRIÓ, detalle o error y su captura (embebida una vez; el
// archivo también queda en screenshots-e2e/capturas/). Las comprobaciones en
// la base llevan la pantalla de ese momento como evidencia. Sale con código 0
// solo si todo pasó y esta corrida no dejó datos.
//
// Antes de crear nada se asegura de que --base sea un servidor LOCAL
// (localhost, 127.0.0.1 o ::1) y de que la app que sirve esté conectada a
// antroapp-dev: busca el ref de dev en los JS de /cliente/login y aborta si
// aparece el de producción o no aparece el de dev (un `npm run dev` normal
// usa .env.local, que es producción, y los logins escribirían login_intentos
// allá).
//
// Qué cubre (por la INTERFAZ, Playwright a 390×844 táctil, y verificado
// también en la base con postgres de dev):
//   1) Reserva por RP con QR: el RP entra por /cliente/login, crea la reserva
//      en /rp/panel (3 personas), el QR que PINTA la app se lee de la
//      pantalla (captura + html5-qrcode, el mismo lector del escáner) y debe
//      ser igual al enlace de WhatsApp y al qr_code de la base; el boleto
//      público /r/<código> abre sin sesión y su QR también se lee y compara.
//   2) Reserva directa: cliente con cuenta desde la ficha y reserva sin cuenta
//      en /cliente/reservar?club=<id>, las dos con su QR leído de la pantalla
//      y comparado con la base, y el boleto sin cuenta en /r/<código>. Además
//      el límite por teléfono (3 por antro y noche,
//      sql/post-junta-2/72-reservas-antiabuso.sql): se simulan 3 intentos y
//      la 4ª por la interfaz debe rechazarse; el paso guarda la respuesta de
//      PostgREST (código y mensaje) para distinguirlo del límite por IP o de
//      un error de red, y otro paso revisa que la página muestre ese aviso.
//   3) Check-in: la cámara falsa del staff (video .y4m, como
//      scripts/dev/probar-escaner.mjs) muestra la CAPTURA del QR que pintó el
//      panel del RP; se confirma la entrada. Las reservas directas entran con
//      «Confirmar entrada sin cámara»; en la base, usada/entró y entrada_por.
//   4) Asignación de mesa en /staff/caja: Mesa 1 al cliente del RP, Mesa 2 al
//      directo.
//   5) Consumo y cobro: concepto libre, producto ya vendido esta noche, cobro
//      en tarjeta con DOBLE CLIC (cuenta las llamadas a caja_registrar_pago),
//      reintento real de la misma llamada con la misma clave de idempotencia
//      (debe devolver el mismo pago) y cobro en efectivo; el staff no cuadra.
//   6) Comisión: el gerente cuadra; nace UNA comisión de RP de $175 (regla del
//      antro de prueba: fijo por reserva, sin cuota) y la reserva directa no
//      genera comisión.
//   7) Segundo grupo en la Mesa 1: «Recibir nuevo grupo» con la reserva sin
//      cuenta, consumo, cobro con dos clics simultáneos (dice si lo frenó el
//      candado del botón o la clave de idempotencia), reintento con la misma
//      clave, cuadre; el mapa muestra «2 grupos».
//   8) Cierre de noche: «Cuadre de la noche», conteo con $50 de faltante,
//      «Cerrar la noche»; en la base caja_noches cerrada y diferencia −5000
//      centavos; en el panel del RP su reserva sale «Consumió» y la nómina de
//      la semana muestra $175 (si no, el error trae un diagnóstico calculado
//      en el momento: pantalla, base, lo que ve el RP con su sesión, política
//      y de dónde lee el panel).
//
// Post-junta-3 (scripts/dev/e2e/flujos-n4.mjs). Cada función va detrás de su
// bandera (sql/post-junta-3/00, por antro): primero un paso revisa que con la
// bandera APAGADA no se vea; luego se enciende SOLO para el antro de la
// corrida (como postgres en club_funciones) y se comprueba que funciona, en
// pantalla y en la base. Cada flujo deja su bandera como estaba al terminar.
// El 9 y el 10 necesitan la noche abierta y corren ENTRE el 7 y el 8 (el
// reporte lista los flujos en el orden en que corrieron):
//   9) Escáner de respaldo (escaner_respaldo): apagada, el boleto no trae
//      código corto; encendida, se lee el código de dos boletos /r/<código>,
//      el staff (otro teléfono, cámara que no lee) escribe uno con señal y
//      confirma la entrada, y el otro SIN señal (setOffline): la copia de la
//      noche lo valida, queda pendiente y al volver la red se envía solo; en
//      la base, usada/entró por el staff y un solo evento de cada tipo.
//  10) Inventario y propina en el cobro (inventario + propinas, servidor con
//      NEXT_PUBLIC_FASE2=1): apagadas, el panel del gerente no enlaza a la
//      fase 2; encendidas, el gerente da de alta un producto con 10 piezas
//      (producto_guardar con su sesión), el staff sienta un walk-in en la
//      Mesa 3, vende 2 del catálogo (existencias 10 → 8 y bitácora ligada al
//      consumo), cobra $300 en tarjeta con $50 de propina aparte y el gerente
//      cuadra. El 8 suma esos $300 a la tarjeta esperada. Si el flujo se
//      corta con la Mesa 3 abierta, se cobra y cuadra por la API para no
//      dejar sin probar el cierre.
// Después del cierre:
//  11) Reparto de propinas: «Propinas de la noche» → «Ver cómo queda» →
//      «Repartir $50»; en la base un reparto cuyas líneas suman $50.
//  12) POS (pos_ventas): apagada, sin enlace; encendida, el gerente sube un
//      CSV con un ticket por mesa a la hora de la caja (Mesa 2 se liga sola;
//      Mesa 1, con dos grupos, se asigna a mano a la cuenta del RP), importa
//      y concilia; en la base cada venta en su cuenta y la caja y las
//      comisiones sin cambio.
//  13) Reportes PDF (reportes_pdf): apagada, /grupo sin enlace; encendida,
//      se descarga el PDF de la noche (sin hoja de compartir) y sus textos
//      traen antro, consumo, cobrado por método, «Faltan $50.00» y
//      comisiones, calculados de la base.
//  14) Lista negra (lista_negra): apagada, sin «Clientes y mensajes»;
//      encendida, el gerente bloquea un teléfono y la reserva sin cuenta con
//      ese teléfono la rechaza la base (P0001) con el mensaje neutro, sin
//      guardar reserva ni intento.
//  15) WhatsApp (whatsapp): apagada, el staff no ve «Clientes y mensajes»;
//      encendida, en «Mañana» la reserva trae Confirmación y Recordatorio; el
//      enlace es wa.me/52<teléfono> con nombre, antro, personas, boleto y el
//      aviso del QR; tocarlo abre wa.me (simulado) y no escribe nada.
//  17) Antifraude (antifraude; corre entre el 15 y el 16): apagada, el
//      gerente no ve «Revisión de RPs»; con 8 reservas del RP de la corrida
//      creadas seguidas (para mañana, service role), el gerente pulsa
//      «Buscar alertas nuevas en estas noches» y sale UNA «Ráfaga de
//      reservas» (en la base: rafaga, por revisar, con las 8 en la
//      evidencia y la búsqueda registrada); la confirma con nota (estado
//      confirmada y bitácora revisar → confirmada con nota y evidencia). El
//      staff no tiene enlace y /staff/revision le dice «Solo el gerente…»;
//      al RP la página lo saca y fraude_alertas_listar se lo niega.
//  16) /para-clubes (bandera de PLATAFORMA para_clubes, global en dev: se
//      cambia solo mientras dura el flujo y se deja como estaba, también si
//      la corrida se corta): apagada 404; encendida 200, el contacto se
//      guarda y lo ve el admin de la corrida en /admin/contactos.
//   B) Banderas restauradas: el antro sin banderas propias y para_clubes como
//      antes de la corrida.
//
//   Si un paso falla, el resto de su flujo sale como «NO CORRIÓ»; un flujo
//   cuyos requisitos no se cumplieron sale OMITIDO con el motivo.
//
// Datos: crea los suyos con la service role, todos con la marca
// "t_e2e_<hora en base 36><4 hex>" (antro "T e2e <fecha> <marca>" publicado,
// zona America/Mexico_City, 3 mesas, cuentas staff/gerente/RP/cliente con
// contraseña aleatoria que solo vive en memoria y no se imprime) y los borra
// al final aunque algo falle, incluida la caja (permiso de pruebas
// antroapp.borrado_pruebas, como limpiarCajaDev), con una conexión nueva y
// hasta 3 intentos. También limpia con Ctrl+C / SIGTERM. Mientras corre deja
// un testigo con sus ids (screenshots-e2e/en-curso/<marca>.json, sin
// contraseña): si el proceso muere sin limpiar (p. ej. taskkill /F), la
// siguiente corrida lo detecta (su pid ya no existe) y borra esos datos sola.
// El chequeo final «L» cuenta solo lo de ESTA corrida (incluidas
// reserva_intentos, login_intentos, app_errores y aceptaciones_legales); el
// conteo global de la marca t_e2e_ antes/después sale aparte, informativo,
// porque otra corrida puede ir a la mitad en otro worktree. No toca Club Demo
// Dev ni corre sembrar-dev/demo-datos. Usa una sola reserva sin cuenta real
// por corrida (el cupo de 20 por IP y hora es compartido).
//
// Tarda ~3 min (112 pasos; unos 180 s el 27/11/2026) con el servidor ya
// compilado (la primera vez el servidor compila cada ruta y puede tardar
// más). Si otro carril edita el árbol a media corrida, la recarga del
// servidor puede tumbar un paso: repetir.
//
// Opciones:
//   --base=<url>         servidor local (por defecto http://localhost:3031)
//   --limpiar-restos     antes de empezar, borra antros/usuarios t_e2e_ de
//                        corridas de hace MÁS DE 1 HORA (nunca una reciente,
//                        que puede estar corriendo en otro worktree)
//   --headed             abre los navegadores a la vista

import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura, REF_DEV, REF_PROD, verificarEnvDev } from "../../db/conexion.mjs";
import { abrirLector, cargarPlaywright, Corredor } from "./utiles.mjs";
import {
  borrarTestigo, contarDeCorrida, contarMarcaGlobal, crearEscenario, escribirTestigo, limpiarEscenario,
  ponerBanderaPlataforma, restosViejos, testigosHuerfanos, totalRestos,
} from "./datos.mjs";
import { correrFlujos } from "./flujos.mjs";
import { armarReporte } from "./reporte.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const BASE = (arg("base") ?? "http://localhost:3031").replace(/\/$/, "");
const HEADLESS = !process.argv.includes("--headed");
const CARPETA = path.join(RAIZ, "screenshots-e2e");
const CAPTURAS = path.join(CARPETA, "capturas");
const TESTIGOS = path.join(CARPETA, "en-curso");

// ---------- Candado: solo un servidor local conectado a dev ----------
let host;
try {
  host = new URL(BASE).hostname;
} catch {
  console.log(`ABORTO: --base no es una URL válida (${BASE}).`);
  process.exit(1);
}
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  console.log(`ABORTO: la suite solo corre contra un servidor local (localhost/127.0.0.1), no contra ${host}.`);
  process.exit(1);
}

async function refDelServidor() {
  const r = await fetch(BASE + "/cliente/login", { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let dev = html.includes(REF_DEV), prod = html.includes(REF_PROD);
  for (const s of srcs) {
    const t = await (await fetch(new URL(s, BASE), { signal: AbortSignal.timeout(120_000) })).text();
    dev ||= t.includes(REF_DEV);
    prod ||= t.includes(REF_PROD);
  }
  return { dev, prod, scripts: srcs.length };
}
try {
  const ref = await refDelServidor();
  if (ref.prod || !ref.dev) {
    console.log(`ABORTO: la app de ${BASE} ${ref.prod ? "trae el ref de PRODUCCIÓN" : "no trae el ref de dev"} en sus ${ref.scripts} scripts. Levántala con: PUERTO=3031 node scripts/dev/servidor-dev.mjs`);
    process.exit(1);
  }
} catch (e) {
  console.log(`El servidor ${BASE} no responde (${e.message}). Levántalo con: PUERTO=3031 node scripts/dev/servidor-dev.mjs`);
  process.exit(1);
}

rmSync(CAPTURAS, { recursive: true, force: true });
mkdirSync(CAPTURAS, { recursive: true });

const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { chromium, QRCode, PNG } = await cargarPlaywright(RAIZ);

// ---------- Restos ----------
// 1) Testigos de corridas de este worktree cuyo proceso murió sin limpiar.
for (const t of testigosHuerfanos(TESTIGOS)) {
  const r = await limpiarEscenario(svc, { club: t.club ? { id: t.club } : null, usuarios: t.usuarios ?? {} });
  console.log(`Corrida interrumpida ${t.tag} (pid ${t.pid}): ${r.errores.length ? "errores al borrar: " + r.errores.join("; ") : "borrada"}.`);
  if (!r.errores.length) borrarTestigo(TESTIGOS, t.tag);
}
// 2) Con --limpiar-restos: marcas t_e2e_ de hace más de 1 hora.
if (process.argv.includes("--limpiar-restos")) {
  const viejos = await restosViejos();
  for (const t of viejos) {
    const r = await limpiarEscenario(svc, t);
    console.log(`Resto viejo ${t.tag}: ${r.errores.length ? "errores: " + r.errores.join("; ") : "borrado"}.`);
  }
  console.log(`Restos de más de 1 h: ${viejos.length}.`);
}

const inicio = new Date();
const conteoGlobal = async () => {
  const db = await conectarDevEscritura();
  try {
    return await contarMarcaGlobal(db);
  } finally {
    await db.fin();
  }
};
const globalAntes = await conteoGlobal();

const corredor = new Corredor({ carpetaCapturas: CAPTURAS });
const c = {
  base: BASE, raiz: RAIZ, svc, corredor, chromium, QRCode, PNG, headless: HEADLESS, carpeta: CARPETA, contextos: [], erroresConsola: [],
  // Sesión de Supabase de una cuenta de la corrida (para diagnósticos).
  sesionDe: async (usuario) => {
    const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error } = await sb.auth.signInWithPassword({ email: usuario.email, password: c.esc.password });
    if (error) throw new Error(error.message);
    return sb;
  },
};
let esc = null;
let errorPreparacion = null;
let limpieza = null;

// Cierre y limpieza, una sola vez (fin normal, error o señal).
let limpiando = null;
function cerrarYLimpiar() {
  limpiando ??= (async () => {
    for (const ctx of c.contextos) await ctx.close().catch(() => {});
    await c.lector?.ctx.close().catch(() => {});
    await c.nav?.close().catch(() => {});
    await c.navCam?.close().catch(() => {});
    for (const nav of c.navegadoresExtra ?? []) await nav.close().catch(() => {});
    // /para-clubes (flujo 16): su bandera es de TODA la plataforma en dev;
    // si la corrida se cortó a la mitad, se deja como estaba.
    if (c.paraClubesPrevio !== undefined && c.paraClubesPrevio !== null) {
      const db = await conectarDevEscritura().catch(() => null);
      if (db) {
        await ponerBanderaPlataforma(db, "para_clubes", c.paraClubesPrevio).catch((e) => console.log("NO SE PUDO RESTAURAR para_clubes: " + e.message));
        await db.fin().catch(() => {});
      }
    }
    await c.db?.fin().catch(() => {});
    if (esc) {
      limpieza = await limpiarEscenario(svc, esc).catch((e) => ({ errores: ["limpieza: " + e.message] }));
      if (!limpieza.errores.length) borrarTestigo(TESTIGOS, esc.tag);
    }
    rmSync(path.join(CARPETA, "qr-rp.y4m"), { force: true });
  })();
  return limpiando;
}
for (const senal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(senal, async () => {
    console.log(`\n${senal}: interrumpida; borrando los datos de esta corrida…`);
    await cerrarYLimpiar().catch(() => {});
    console.log(limpieza?.errores?.length ? `Quedaron errores: ${limpieza.errores.join("; ")} (el testigo sigue en ${TESTIGOS})` : "Datos de la corrida borrados.");
    process.exit(130);
  });
}

try {
  try {
    esc = await crearEscenario(svc, { alCrear: (e) => escribirTestigo(TESTIGOS, e) });
    escribirTestigo(TESTIGOS, esc);
  } catch (e) {
    esc = e.escenario ?? null;
    if (esc) escribirTestigo(TESTIGOS, esc);
    throw e;
  }
  c.esc = esc;
  c.db = await conectarDevEscritura();
  console.log(`Escenario ${esc.tag}: antro ${esc.club.id.slice(0, 8)}…, noche ${esc.noche}, ${esc.mesas.length} mesas, ${Object.keys(esc.usuarios).length} cuentas.`);
  c.nav = await chromium.launch({ headless: HEADLESS });
  c.lector = await abrirLector(c.nav, RAIZ);
  await correrFlujos(c);
} catch (e) {
  errorPreparacion = String(e?.message ?? e).split("\n")[0];
  console.log("ERROR: " + errorPreparacion);
} finally {
  await cerrarYLimpiar();
}

const dbFinal = await conectarDevEscritura();
const deCorrida = esc ? await contarDeCorrida(dbFinal, esc) : {};
await dbFinal.fin();
const globalDespues = await conteoGlobal();

const flujos = corredor.flujos;
if (errorPreparacion) {
  flujos.push({ id: "!", titulo: "Preparación / ejecución", estado: "FALLA", ms: 0, motivo: null, pasos: [{ nombre: "Crear datos o correr la suite", estado: "FALLA", ms: 0, error: errorPreparacion, captura: null }] });
}
const sinRestos = totalRestos(deCorrida) === 0 && !(limpieza?.errores?.length);
flujos.push({
  id: "L", titulo: "Limpieza de los datos de esta corrida", estado: sinRestos ? "OK" : "FALLA", ms: 0, motivo: null,
  pasos: [{ nombre: `No queda ninguna fila de la corrida ${esc?.tag ?? ""} (marca, ids, antro, hash de correos; con reserva_intentos, login_intentos, app_errores y aceptaciones_legales)`, estado: sinRestos ? "OK" : "FALLA", ms: 0,
    detalle: `de esta corrida después: ${JSON.stringify(deCorrida)} · marca t_e2e_ en toda dev (informativo, incluye otras corridas): antes ${JSON.stringify(globalAntes)}, después ${JSON.stringify(globalDespues)}`,
    error: limpieza?.errores?.length ? limpieza.errores.join("\n") : null, captura: null }],
});

const meta = {
  "Servidor": BASE,
  "Inicio": inicio.toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
  "Duración": `${((Date.now() - inicio.getTime()) / 1000).toFixed(1)} s`,
  "Marca de la corrida": esc?.tag ?? "—",
  "Noche operativa": esc?.noche ?? "—",
  "Antro de prueba": esc?.club?.nombre ?? "—",
  "Filas de esta corrida después de limpiar": deCorrida,
  "Marca t_e2e_ en dev antes (todas las corridas)": globalAntes,
  "Marca t_e2e_ en dev después (todas las corridas)": globalDespues,
  "Errores de consola del navegador": c.erroresConsola.length ? c.erroresConsola.slice(0, 30).join(" | ") : "ninguno",
};
writeFileSync(path.join(CARPETA, "reporte.html"), armarReporte({ flujos, meta }));

const pasos = flujos.flatMap((f) => f.pasos);
const malos = pasos.filter((p) => p.estado !== "OK").length + flujos.filter((f) => f.estado === "OMITIDO").length;
console.log(`\nLimpieza: de esta corrida quedan ${totalRestos(deCorrida)} filas · marca t_e2e_ en dev: antes ${totalRestos(globalAntes)}, después ${totalRestos(globalDespues)}${limpieza?.errores?.length ? " · errores: " + limpieza.errores.join("; ") : ""}`);
console.log(`Resultado: ${pasos.filter((p) => p.estado === "OK").length}/${pasos.length} pasos OK, ${flujos.filter((f) => f.estado === "OK").length}/${flujos.length} flujos OK`);
console.log(`Reporte: ${path.join(CARPETA, "reporte.html")}`);
process.exitCode = malos === 0 ? 0 : 1;
