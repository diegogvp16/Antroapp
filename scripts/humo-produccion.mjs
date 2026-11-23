// Prueba de humo de SOLO LECTURA contra una URL base (producción, vista
// previa o local). No inicia sesión, no escribe nada, no usa llaves.
//
//   node scripts/humo-produccion.mjs https://antroapp.vercel.app
//   node scripts/humo-produccion.mjs http://localhost:3002
//   node scripts/humo-produccion.mjs <url-de-vista-previa> --vercel-curl
//       (vista previa protegida: pide cada ruta con `vercel curl`, que usa el
//        acceso de la sesión de Vercel de quien lo corre; sin redirecciones de navegador)
//   PLAYWRIGHT_DESDE=<carpeta> node scripts/humo-produccion.mjs <url> --navegador
//       (además abre las rutas protegidas en un navegador sin sesión y revisa
//        que terminen en el login; el navegador aborta cualquier petición
//        que no sea GET)
//
// Revisa: rutas públicas y logins (cliente/RP, dueño, admin) en 200; rutas
// protegidas sin sesión; cabeceras de seguridad; manifests, iconos, service
// worker y página sin conexión; que las rutas de API no respondan a GET; y
// que ninguna página muestre errores técnicos ni nombres de tablas. Sale con
// código 1 si algo falla.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:\/\//.test(a)) ?? "").replace(/\/$/, "");
if (!BASE) {
  console.log("Uso: node scripts/humo-produccion.mjs <url-base> [--vercel-curl] [--navegador]");
  process.exit(2);
}
const VIA_VERCEL = args.includes("--vercel-curl");
const CON_NAVEGADOR = args.includes("--navegador");
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Pedir una ruta con GET. Devuelve { estado, cabeceras (minúsculas), cuerpo, destino }.
// ---------------------------------------------------------------------------
async function pedir(ruta) {
  if (!VIA_VERCEL) {
    const r = await fetch(BASE + ruta, { method: "GET", redirect: "manual", headers: { "user-agent": "antroapp-humo/1.0" } });
    const cabeceras = Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v]));
    const tipo = cabeceras["content-type"] ?? "";
    const cuerpo = /text|json|javascript|xml|manifest/.test(tipo) ? await r.text() : (await r.arrayBuffer(), "");
    return { estado: r.status, cabeceras, cuerpo, destino: cabeceras.location ?? null };
  }
  // vercel curl -- -s -i: cabeceras + cuerpo. Un GET por ruta.
  const salida = execFileSync("npx", ["vercel", "curl", ruta, "--deployment", BASE, "--scope", "antroapp", "--", "-s", "-i", "-A", "antroapp-humo/1.0"], {
    cwd: RAIZ,
    encoding: "latin1",
    shell: process.platform === "win32",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 50 * 1024 * 1024,
  });
  const bloques = salida.split(/\r?\n\r?\n/);
  // Puede haber varias cabeceras si hubo 100-continue; se toma la última HTTP.
  let i = 0;
  while (i + 1 < bloques.length && /^HTTP\/\S+ 1\d\d/.test(bloques[i]) && /^HTTP\//.test(bloques[i + 1])) i++;
  const lineas = bloques[i].split(/\r?\n/);
  const estado = Number((lineas[0].match(/^HTTP\/\S+ (\d{3})/) ?? [])[1] ?? 0);
  const cabeceras = {};
  for (const l of lineas.slice(1)) {
    const k = l.indexOf(":");
    if (k > 0) cabeceras[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim();
  }
  const cuerpo = Buffer.from(bloques.slice(i + 1).join("\n\n"), "latin1").toString("utf8");
  return { estado, cabeceras, cuerpo, destino: cabeceras.location ?? null };
}

// ---------------------------------------------------------------------------
// Resultados.
// ---------------------------------------------------------------------------
const resultados = [];
function nota(grupo, texto, ok, detalle = "") {
  resultados.push({ grupo, texto, ok });
  console.log(`${ok ? "OK   " : "FALLA"}  [${grupo}] ${texto}${detalle ? "  — " + detalle : ""}`);
}

// Lo que no debe aparecer en el HTML ni en una respuesta de error: textos
// técnicos de Postgres/PostgREST/Next y nombres de tablas internas.
const TECNICO = /PGRST\d|permission denied|violates|duplicate key|relation "|syntax error at|ECONNREFUSED|Unhandled Runtime Error|at Object\.<anonymous>|node_modules\/|SUPABASE_SERVICE_ROLE|service_role/i;
const TABLAS = /\b(caja_consumos|caja_pagos|caja_cuadres|mesa_sesiones|mesa_cuentas|rp_pagos_dia|rp_comision_overrides|login_intentos|app_errores|verificacion_documentos|consumption_entries|profiles_legacy)\b/;
function revisarCuerpo(grupo, ruta, cuerpo) {
  const t = cuerpo.match(TECNICO);
  const tb = cuerpo.match(TABLAS);
  nota(grupo, `${ruta}: sin errores técnicos ni nombres de tablas`, !t && !tb, t ? `aparece "${t[0]}"` : tb ? `aparece la tabla "${tb[0]}"` : "");
}

const CABECERAS = [
  ["strict-transport-security", (v) => /max-age=\d+/.test(v)],
  ["x-content-type-options", (v) => v.toLowerCase() === "nosniff"],
  ["referrer-policy", (v) => /strict-origin|no-referrer|same-origin/.test(v)],
  ["x-frame-options", (v) => /deny|sameorigin/i.test(v)],
  ["content-security-policy", (v) => /frame-ancestors/.test(v)],
  ["permissions-policy", (v) => /camera=/.test(v)],
];

try {
  console.log(`Humo de solo lectura contra ${BASE}${VIA_VERCEL ? " (vercel curl)" : ""}\n`);

  // ---------- Rutas públicas y logins ----------
  const PUBLICAS = [
    ["/", "inicio"],
    ["/cliente", "explorar antros"],
    ["/acceso-negocios", "acceso para negocios"],
    ["/cliente/login", "login de cliente y RP (unificado)"],
    ["/cliente/signup", "registro de cliente"],
    ["/dueno/login", "login de dueño"],
    ["/dueno/signup", "registro de dueño"],
    ["/admin/login", "login de admin"],
    ["/recuperar-contrasena", "recuperar contraseña"],
  ];
  let inicio = null;
  for (const [ruta, que] of PUBLICAS) {
    const r = await pedir(ruta);
    nota("públicas", `${ruta} (${que}) responde 200`, r.estado === 200, String(r.estado));
    if (r.estado === 200) revisarCuerpo("públicas", ruta, r.cuerpo);
    if (ruta === "/") inicio = r;
  }

  // Boleto público con un código que no existe: página normal, sin errores técnicos.
  const boleto = await pedir("/r/antro-00000000-0000-4000-8000-000000000000");
  nota("públicas", "/r/<código inexistente> responde sin error de servidor", boleto.estado === 200 || boleto.estado === 404, String(boleto.estado));
  revisarCuerpo("públicas", "/r/<código inexistente>", boleto.cuerpo);

  const noExiste = await pedir("/esta-ruta-no-existe-humo");
  nota("públicas", "una ruta que no existe responde 404", noExiste.estado === 404, String(noExiste.estado));
  revisarCuerpo("públicas", "404", noExiste.cuerpo);

  // ---------- Rutas protegidas, sin sesión ----------
  // Las pantallas son de cliente: el servidor entrega la página vacía (200) y
  // es el navegador el que, sin sesión, manda al login. Sin --navegador se
  // revisa que no entreguen datos ni errores; con --navegador, que terminen en el login.
  const PROTEGIDAS = ["/staff/panel", "/staff/caja", "/staff/nomina", "/rp/panel", "/dueno/panel", "/dueno/nomina", "/grupo", "/admin", "/cliente/perfil"];
  for (const ruta of PROTEGIDAS) {
    const r = await pedir(ruta);
    const aLogin = r.estado >= 300 && r.estado < 400 && /login/.test(r.destino ?? "");
    nota("protegidas", `${ruta} sin sesión: no responde error`, r.estado === 200 || aLogin, aLogin ? `redirige a ${r.destino}` : String(r.estado));
    if (r.estado === 200) revisarCuerpo("protegidas", ruta, r.cuerpo);
  }

  // ---------- API: no responden a GET ni filtran detalles ----------
  for (const ruta of ["/api/auth/login", "/api/admin/create-staff", "/api/admin/rechazar-verificacion"]) {
    const r = await pedir(ruta);
    nota("api", `GET ${ruta} no hace nada (405 o 404)`, r.estado === 405 || r.estado === 404, String(r.estado));
    revisarCuerpo("api", ruta, r.cuerpo);
  }

  // ---------- Cabeceras de seguridad ----------
  for (const [nombre, valida] of CABECERAS) {
    const v = inicio?.cabeceras[nombre];
    nota("cabeceras", `${nombre}`, !!v && valida(v), v ? v.slice(0, 80) : "falta");
  }
  nota("cabeceras", "sin x-powered-by", !inicio?.cabeceras["x-powered-by"], inicio?.cabeceras["x-powered-by"] ?? "");

  // ---------- App instalable ----------
  const MANIFESTS = [
    ["/manifest.webmanifest", "/"],
    ["/staff.webmanifest", "/staff/panel"],
    ["/rp.webmanifest", "/rp/panel"],
    ["/dueno.webmanifest", "/dueno/panel"],
  ];
  const iconos = new Set();
  for (const [ruta, inicioEsperado] of MANIFESTS) {
    const r = await pedir(ruta);
    let m = null;
    try {
      m = JSON.parse(r.cuerpo);
    } catch {
      m = null;
    }
    nota("instalable", `${ruta} carga y abre en ${inicioEsperado}`, r.estado === 200 && m?.start_url === inicioEsperado && m?.display === "standalone", r.estado === 200 ? `${m?.name ?? "JSON inválido"} · ${m?.start_url ?? ""}` : String(r.estado));
    for (const i of m?.icons ?? []) iconos.add(i.src);
  }
  for (const src of iconos) {
    const r = await pedir(src);
    nota("instalable", `icono ${src}`, r.estado === 200 && /image\//.test(r.cabeceras["content-type"] ?? ""), `${r.estado} ${r.cabeceras["content-type"] ?? ""}`);
  }
  for (const [ruta, que, tipo] of [["/sw.js", "service worker", /javascript/], ["/offline.html", "página sin conexión", /html/], ["/apple-touch-icon.png", "icono de iPhone", /image\//], ["/favicon.ico", "favicon", /image|icon/]]) {
    const r = await pedir(ruta);
    nota("instalable", `${ruta} (${que})`, r.estado === 200 && tipo.test(r.cabeceras["content-type"] ?? ""), `${r.estado} ${r.cabeceras["content-type"] ?? ""}`);
  }
  const sw = await pedir("/sw.js");
  nota("instalable", "el service worker no guarda páginas ni datos (solo /offline.html)", /OFFLINE = "\/offline\.html"/.test(sw.cuerpo) && !/cache\.put\(/.test(sw.cuerpo), "");

  // ---------- Navegador: rutas protegidas terminan en el login ----------
  if (CON_NAVEGADOR) {
    if (VIA_VERCEL) {
      nota("navegador", "rutas protegidas con navegador", false, "no disponible con --vercel-curl (la vista previa pide iniciar sesión en Vercel)");
    } else {
      const req = createRequire(path.join(RAIZ, "package.json"));
      let pw;
      try {
        pw = req("playwright");
      } catch {
        pw = process.env.PLAYWRIGHT_DESDE
          ? await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href)
          : null;
      }
      if (!pw) {
        nota("navegador", "rutas protegidas con navegador", false, "falta Playwright (PLAYWRIGHT_DESDE)");
      } else {
        const nav = await pw.chromium.launch();
        const ctx = await nav.newContext({ viewport: { width: 390, height: 844 } });
        let noGet = 0;
        // Solo lectura: cualquier petición que no sea GET (ni HEAD/OPTIONS) se aborta y se cuenta.
        await ctx.route("**/*", (route) => {
          const m = route.request().method();
          if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.continue();
          noGet++;
          return route.abort();
        });
        const p = await ctx.newPage();
        for (const ruta of PROTEGIDAS) {
          await p.goto(BASE + ruta, { waitUntil: "domcontentloaded" });
          await p.waitForURL(/login/, { timeout: 20000 }).catch(() => {});
          const final = new URL(p.url()).pathname;
          nota("navegador", `${ruta} sin sesión termina en el login`, /login/.test(final), final);
        }
        nota("navegador", "el navegador no intentó escribir nada (0 peticiones que no sean GET)", noGet === 0, `${noGet}`);
        await nav.close();
      }
    }
  }
} catch (e) {
  nota("ejecución", "sin excepciones", false, e.message.split("\n")[0]);
}

// ---------- Resumen ----------
const grupos = [...new Set(resultados.map((r) => r.grupo))];
console.log(`\nResumen para ${BASE}`);
for (const g of grupos) {
  const de = resultados.filter((r) => r.grupo === g);
  const ok = de.filter((r) => r.ok).length;
  console.log(`  ${ok === de.length ? "APROBADO" : "FALLÓ   "}  ${g}: ${ok}/${de.length}`);
}
const fallas = resultados.filter((r) => !r.ok);
console.log(fallas.length ? `\nFALLÓ: ${fallas.length} de ${resultados.length} revisiones.` : `\nAPROBADO: ${resultados.length}/${resultados.length} revisiones.`);
process.exitCode = fallas.length ? 1 : 0;
