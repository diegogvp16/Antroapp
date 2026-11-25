// Pruebas de los correos en modo "archivo" (B7) contra antroapp-dev.
// Requiere sql/post-junta-2/20-correos-salida.sql en dev.
//
//   node scripts/dev/probar-correos.mjs
//       reglas puras, procesarCorreo con la base real y un fetch falso (nunca
//       sale un correo), RLS por rol y purga.
//   node scripts/dev/probar-correos.mjs --base=http://localhost:3022
//       además la ruta GET /api/admin/correos (401/403/200, sin secretos).
//   ... --alertas
//       además una alerta de punta a punta: el servidor debe levantarse con
//       ALERTAS_CORREO=1 ALERTAS_PARA=t_equipo_alertas@example.com
//       CORREO_MODO=enviar RESEND_API_KEY=re_falsa_prueba
//       CORREO_DE=t_equipo_de@example.com (local = no producción: se archiva).
//   ... --modo=enviar   modo con el que se levantó el servidor (por defecto
//       archivo, o enviar con --alertas)
//   ... --pantalla   (con PLAYWRIGHT_DESDE)
//       además /admin/correos con Playwright a 390×844 y 360×740.
//
// Solo crea filas y cuentas con prefijo t_equipo_ y las borra al final,
// aunque algo falle. Usa dev_<rol>@example.com sin cambiarles nada.

import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";
import { leerConfigCorreo, decidirEnvio, prepararCorreo, procesarCorreo, normalizarCorreo, resumenModo } from "../../lib/domain/correo.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const BASE = arg("base")?.replace(/\/$/, "") ?? null;
const ALERTAS = process.argv.includes("--alertas");
const PANTALLA = process.argv.includes("--pantalla");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

let pasan = 0, fallan = 0;
const revisar = (c, t, d = "") => { if (c) pasan++; else fallan++; console.log((c ? "OK     " : "FALLA  ") + t + (c || !d ? "" : "  — " + d)); };
const sufijo = randomUUID().slice(0, 8);
const PLANTILLA = `t_equipo_prueba_${sufijo}`;
const para = (n) => `t_equipo_${n}_${sufijo}@example.com`;
const inicio = new Date().toISOString();
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

// fetch falso: cuenta las llamadas y responde lo que se le pida.
function fetchFalso(respuesta) {
  const f = async (url, init) => {
    f.llamadas.push({ url, cuerpo: JSON.parse(init.body), headers: init.headers });
    if (respuesta === "lanza") throw new Error("timeout simulado");
    return new Response(JSON.stringify(respuesta.cuerpo ?? {}), { status: respuesta.status ?? 200 });
  };
  f.llamadas = [];
  return f;
}
const errores = [];
const deps = (cfg, f) => ({ svc, cfg, fetch: f, registrarError: (e) => errores.push(e), timeoutMs: 2000 });
const fila = async (id) => (await svc.from("correos_salida").select("*").eq("id", id).maybeSingle()).data;

const URL_PROD_FALSA = "https://abcdefghijklmnopqrst.supabase.co";
const cuentas = []; // ids de Auth creadas aquí

async function clienteDe(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error("login " + email + ": " + error.message);
  return c;
}
async function cuentaPropia(nombre, { perfil, appMeta } = {}) {
  const email = para(nombre);
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: appMeta ?? {} });
  if (error) throw new Error("crear " + nombre + ": " + error.message);
  cuentas.push(data.user.id);
  if (perfil) {
    const r = await svc.from("profiles").insert({ id: data.user.id, nombre: "T equipo " + nombre, ...perfil });
    if (r.error) throw new Error("perfil " + nombre + ": " + r.error.message);
  }
  return { email, password, id: data.user.id };
}

try {
  // ---------- 1. Reglas puras ----------
  const base = { NEXT_PUBLIC_SUPABASE_URL: URL_PROD_FALSA, RESEND_API_KEY: "re_x", CORREO_DE: "a@b.mx" };
  revisar(leerConfigCorreo({}).modo === "archivo", "sin CORREO_MODO: modo archivo");
  const raro = leerConfigCorreo({ CORREO_MODO: "mandar" });
  revisar(raro.modo === "archivo" && raro.avisos.length === 1, "CORREO_MODO desconocido: archivo, con aviso");
  revisar(leerConfigCorreo({ CORREO_MODO: " APAGADO " }).modo === "apagado", "modo apagado (sin importar mayúsculas ni espacios)");
  const cfgProd = leerConfigCorreo({ ...base, CORREO_MODO: "enviar", VERCEL_ENV: "production" });
  revisar(cfgProd.esProduccion && decidirEnvio(cfgProd, "x@y.mx").accion === "enviar", "enviar en producción con llave y remitente: se manda");
  const cfgProdDev = leerConfigCorreo({ ...base, NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, CORREO_MODO: "enviar", VERCEL_ENV: "production" });
  revisar(!cfgProdDev.esProduccion && decidirEnvio(cfgProdDev, "x@y.mx").accion === "archivar", "VERCEL_ENV=production con la base de dev: NO es producción, se archiva");
  for (const v of ["preview", "development", undefined]) {
    const c = leerConfigCorreo({ ...base, CORREO_MODO: "enviar", VERCEL_ENV: v });
    revisar(decidirEnvio(c, "x@y.mx").accion === "archivar", `enviar en ${v ?? "local"} sin lista blanca: se archiva`);
  }
  const cfgLista = leerConfigCorreo({ ...base, CORREO_MODO: "enviar", VERCEL_ENV: "preview", CORREO_LISTA_BLANCA: "Diego@Example.com, otro@example.com;mal" });
  revisar(cfgLista.listaBlanca.length === 2 && decidirEnvio(cfgLista, "diego@example.com").accion === "enviar" && decidirEnvio(cfgLista, "x@y.mx").accion === "archivar", "vista previa con lista blanca: solo a los de la lista (sin importar mayúsculas)");
  const sinLlave = leerConfigCorreo({ CORREO_MODO: "enviar", VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: URL_PROD_FALSA });
  revisar(decidirEnvio(sinLlave, "x@y.mx").accion === "archivar" && sinLlave.avisos.length === 1, "enviar sin llave ni remitente: se archiva, con aviso");
  revisar(leerConfigCorreo({ ...base, CORREO_DE: undefined, ALERTAS_DE: "alertas@b.mx" }).remitente === "alertas@b.mx", "ALERTAS_DE sirve de remitente si falta CORREO_DE");
  revisar(decidirEnvio(leerConfigCorreo({ ...base, CORREO_MODO: "apagado", VERCEL_ENV: "production" }), "x@y.mx").accion === "nada", "apagado: ni se manda ni se guarda");
  revisar(!JSON.stringify(resumenModo(cfgProd)).includes("re_x"), "el resumen del modo no trae la llave");
  revisar(normalizarCorreo("a@b.mx, c@d.mx") === null && normalizarCorreo("x <a@b.mx>") === null && normalizarCorreo(" A@B.MX ") === "a@b.mx", "destinatario: uno solo, sin nombres ni listas");
  const p = prepararCorreo({ plantilla: "x", para: "a@b.mx", asunto: "Hola\r\nBcc: otro@x.mx", texto: "enlace https://x/t/SECRETO123 fin", ocultar: ["https://x/t/SECRETO123"] });
  revisar(!("error" in p) && !/[\r\n]/.test(p.asunto) && p.cuerpoArchivado === "enlace [oculto] fin" && p.cuerpo.includes("SECRETO123"), "asunto en una línea; el secreto se manda pero no se archiva");
  revisar("error" in prepararCorreo({ plantilla: "Con Espacios", para: "a@b.mx", asunto: "x", texto: "" }), "plantilla inválida: se rechaza");
  revisar(!("error" in p) && prepararCorreo({ plantilla: "x", para: "a@b.mx", asunto: "x".repeat(500), texto: "y".repeat(30000) }).cuerpo.length === 20000, "cuerpo con tope de 20,000");

  // ---------- 2. procesarCorreo con la base real y fetch falso ----------
  const datos = (n, extra = {}) => ({ plantilla: PLANTILLA, para: para(n), asunto: `Prueba ${n}`, texto: `Cuerpo ${n}`, ...extra });
  {
    const f = fetchFalso({});
    const r = await procesarCorreo(deps(leerConfigCorreo({}), f), datos("archivo"));
    const x = r.id && (await fila(r.id));
    revisar(r.estado === "archivado" && f.llamadas.length === 0 && x?.estado === "archivado" && x.entorno === "local" && /archivo/i.test(x.motivo), "modo archivo: queda en la bandeja y no se llama al proveedor", JSON.stringify(r));
  }
  {
    const f = fetchFalso({});
    const r = await procesarCorreo(deps(leerConfigCorreo({ ...base, CORREO_MODO: "enviar", VERCEL_ENV: "preview" }), f), datos("preview"));
    const x = r.id && (await fila(r.id));
    revisar(r.estado === "archivado" && f.llamadas.length === 0 && x?.entorno === "preview" && /lista blanca/.test(x.motivo), "vista previa con CORREO_MODO=enviar: se archiva, 0 llamadas al proveedor");
  }
  {
    const f = fetchFalso({});
    const r = await procesarCorreo(deps(cfgProdDev, f), datos("proddev"));
    revisar(r.estado === "archivado" && f.llamadas.length === 0, "\"producción\" con la base de dev: se archiva, 0 llamadas");
  }
  {
    const cfg = leerConfigCorreo({ ...base, CORREO_MODO: "enviar", VERCEL_ENV: "preview", CORREO_LISTA_BLANCA: para("blanca") });
    const f = fetchFalso({ cuerpo: { id: "resend-falso-1" } });
    const r = await procesarCorreo(deps(cfg, f), datos("blanca"));
    const x = r.id && (await fila(r.id));
    revisar(r.estado === "enviado" && f.llamadas.length === 1 && f.llamadas[0].cuerpo.subject.startsWith("[Prueba] ") && f.llamadas[0].cuerpo.to[0] === para("blanca"), "lista blanca en vista previa: 1 llamada, asunto con [Prueba]");
    revisar(x?.estado === "enviado" && x.proveedor_id === "resend-falso-1" && !!x.enviado_en && f.llamadas[0].headers["Idempotency-Key"] === `correo-${r.id}`, "queda enviado con el id del proveedor y clave de idempotencia");
  }
  {
    const f = fetchFalso({ cuerpo: { id: "resend-falso-2" } });
    const r = await procesarCorreo(deps(cfgProd, f), datos("prod", { texto: "Tu enlace: https://antro.app/i/TOKEN-SECRETO-999", ocultar: ["https://antro.app/i/TOKEN-SECRETO-999"] }));
    const x = r.id && (await fila(r.id));
    revisar(r.estado === "enviado" && f.llamadas[0].cuerpo.text.includes("TOKEN-SECRETO-999") && !f.llamadas[0].cuerpo.subject.startsWith("[Prueba]"), "producción: se manda el texto completo, sin [Prueba]");
    revisar(x && !x.cuerpo.includes("TOKEN-SECRETO") && x.cuerpo.includes("[oculto]") && x.motivo === null, "la bandeja guarda el cuerpo sin el secreto");
  }
  {
    const f = fetchFalso({ status: 500 });
    const r = await procesarCorreo(deps(cfgProd, f), datos("falla"));
    const x = r.id && (await fila(r.id));
    revisar(r.estado === "fallido" && x?.estado === "fallido" && /500/.test(x.motivo), "el proveedor responde 500: queda fallido con el código, sin lanzar");
  }
  {
    const f = fetchFalso("lanza");
    const r = await procesarCorreo(deps(cfgProd, f), datos("timeout"));
    const x = r.id && (await fila(r.id));
    revisar(r.estado === "fallido" && /Sin respuesta/.test(x?.motivo ?? ""), "el proveedor no responde: queda fallido, sin lanzar");
  }
  {
    const f = fetchFalso({});
    const r = await procesarCorreo(deps(leerConfigCorreo({ CORREO_MODO: "apagado" }), f), datos("apagado"));
    const { count } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).eq("destinatario", para("apagado"));
    revisar(r.estado === "apagado" && count === 0 && f.llamadas.length === 0, "modo apagado: ni fila ni llamada");
  }
  {
    const f = fetchFalso({});
    const r = await procesarCorreo(deps(cfgProd, f), datos("x", { para: "no-es-correo" }));
    revisar(r.estado === "invalido" && f.llamadas.length === 0, "destinatario inválido: no se guarda ni se manda");
  }
  {
    // Sin bandeja (tabla con otro nombre): en modo enviar se manda igual.
    const svcRoto = { from: () => svc.from("correos_salida_no_existe") };
    const f = fetchFalso({ cuerpo: { id: "x" } });
    const r = await procesarCorreo({ ...deps(cfgProd, f), svc: svcRoto }, datos("sinbandeja"));
    revisar(r.estado === "enviado" && r.id === null && f.llamadas.length === 1, "si la bandeja falla, lo que debía salir sale igual");
    const r2 = await procesarCorreo({ ...deps(leerConfigCorreo({}), f), svc: svcRoto }, datos("sinbandeja2"));
    revisar(r2.estado === "fallido", "si la bandeja falla en modo archivo, se reporta fallido");
  }
  revisar(errores.every((e) => typeof e === "string"), "los errores se registran solo con etiqueta (sin datos)");

  // ---------- 3. RLS por rol ----------
  const { count: mias } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).eq("plantilla", PLANTILLA);
  const intentar = async (c, quien) => {
    const sel = await c.from("correos_salida").select("id").eq("plantilla", PLANTILLA);
    const ins = await c.from("correos_salida").insert({ plantilla: PLANTILLA, destinatario: para("intruso"), asunto: "x", cuerpo: "x", estado: "enviado", entorno: "local" });
    const upd = await c.from("correos_salida").update({ estado: "enviado" }).eq("plantilla", PLANTILLA).select("id");
    const del = await c.from("correos_salida").delete().eq("plantilla", PLANTILLA).select("id");
    const pur = await c.rpc("correos_purgar", { p_dias: 7 });
    return { leidas: sel.data?.length ?? 0, insertó: !ins.error, actualizó: upd.data?.length ?? 0, borró: del.data?.length ?? 0, purgó: !pur.error, quien };
  };
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const sujetos = [["anónimo", anon]];
  for (const rol of ["cliente", "rp", "staff", "gerente", "dueno"]) sujetos.push([rol, await clienteDe(cred.usuarios[rol], cred.password)]);
  const sinPerfil = await cuentaPropia("sinperfil");
  sujetos.push(["cuenta sin perfil", await clienteDe(sinPerfil.email, sinPerfil.password)]);
  const adminBaja = await cuentaPropia("adminbaja", { perfil: { role: "admin", activo: false } });
  sujetos.push(["admin dado de baja", await clienteDe(adminBaja.email, adminBaja.password)]);
  const adminTemp = await cuentaPropia("admintemp", { perfil: { role: "admin" }, appMeta: { debe_cambiar: true } });
  sujetos.push(["admin con contraseña temporal", await clienteDe(adminTemp.email, adminTemp.password)]);
  for (const [quien, c] of sujetos) {
    const r = await intentar(c, quien);
    revisar(r.leidas === 0 && !r.insertó && r.actualizó === 0 && r.borró === 0 && !r.purgó, `${quien}: no lee, no escribe, no borra ni purga`, JSON.stringify(r));
  }
  const admin = await clienteDe(cred.usuarios.admin, cred.password);
  const ra = await intentar(admin, "admin");
  revisar(ra.leidas === mias && mias > 0 && !ra.insertó && ra.actualizó === 0 && ra.borró === 0 && !ra.purgó, `admin: lee las ${mias} filas y no puede escribir, borrar ni purgar desde el navegador`, JSON.stringify(ra));
  const { count: mias2 } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).eq("plantilla", PLANTILLA);
  revisar(mias2 === mias, "nadie cambió la bandeja");

  // ---------- 4. Purga ----------
  const vieja = await svc.from("correos_salida").insert({ plantilla: PLANTILLA, destinatario: para("vieja"), asunto: "vieja", cuerpo: "x", estado: "archivado", entorno: "local", creado_en: new Date(Date.now() - 40 * 86_400_000).toISOString() }).select("id").single();
  const pr = await svc.rpc("correos_purgar", { p_dias: 30 });
  const sigue = await fila(vieja.data.id);
  const { count: mias3 } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).eq("plantilla", PLANTILLA);
  revisar(!pr.error && pr.data >= 1 && !sigue && mias3 === mias, `purga a 30 días: borra la de hace 40 días (${pr.data}) y deja las recientes`);
  const malos = await Promise.all([svc.rpc("correos_purgar", { p_dias: 3 }), svc.rpc("correos_purgar", { p_dias: null })]);
  revisar(malos.every((m) => m.error?.code === "P0001"), "purga con menos de 7 días o nula: se rechaza");

  // ---------- 5. Ruta del modo ----------
  if (BASE) {
    const sesion = async (email, password) => {
      const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ email, password }) });
      return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    };
    const modo = async (galletas) => {
      const r = await fetch(BASE + "/api/admin/correos", { headers: galletas ? { cookie: galletas } : {} });
      return { status: r.status, cc: r.headers.get("cache-control") ?? "", cuerpo: await r.json().catch(() => ({})) };
    };
    revisar((await modo(null)).status === 401, "ruta del modo: sin sesión, 401");
    for (const rol of ["cliente", "staff", "gerente", "dueno"]) {
      const r = await modo(await sesion(cred.usuarios[rol], cred.password));
      revisar(r.status === 403, `ruta del modo: ${rol}, 403`, String(r.status));
    }
    const rt = await modo(await sesion(adminTemp.email, adminTemp.password));
    revisar(rt.status === 403 || rt.status === 401, `ruta del modo: admin con contraseña temporal, ${rt.status}`);
    const r = await modo(await sesion(cred.usuarios.admin, cred.password));
    const esperado = arg("modo") ?? (ALERTAS ? "enviar" : "archivo"); // --modo=… si el servidor se levantó con otro CORREO_MODO
    revisar(r.status === 200 && r.cuerpo.modo === esperado && r.cuerpo.esProduccion === false && r.cc.includes("no-store"), `ruta del modo: admin, 200, modo ${r.cuerpo.modo}, no producción, sin caché`, JSON.stringify(r.cuerpo));
    revisar(!/re_falsa|t_equipo_de|eyJ/.test(JSON.stringify(r.cuerpo)), "ruta del modo: sin llave ni remitente en la respuesta");
  }

  // ---------- 6. Alerta de punta a punta ----------
  if (BASE && ALERTAS) {
    const marca = `t_equipo_pico_${sufijo}`;
    const { count: previas } = await svc.from("alertas_enviadas").select("id", { count: "exact", head: true }).eq("tipo", "pico_errores").gte("enviado_en", new Date(Date.now() - 3_600_000).toISOString());
    if (previas) {
      revisar(false, "alerta: ya hay una de pico_errores en la última hora (otra prueba); no se puede probar ahora");
    } else {
      const unaIp = ip();
      for (let i = 0; i < 11; i++) {
        await fetch(BASE + "/api/errores", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": unaIp }, body: JSON.stringify({ mensaje: `${marca} error ${i}`, ruta: "/t-equipo/prueba" }) });
      }
      const { data: a } = await svc.from("correos_salida").select("*").eq("plantilla", "alerta:pico_errores").eq("destinatario", "t_equipo_alertas@example.com").gte("creado_en", inicio);
      revisar(a?.length === 1, `alerta de pico: 1 correo en la bandeja tras 11 errores (${a?.length ?? 0})`);
      revisar(a?.[0]?.estado === "archivado" && /Fuera de producción \(local\)/.test(a[0].motivo) && a[0].asunto.startsWith("[AntroApp]"), "con CORREO_MODO=enviar y llave falsa en local: archivado, no se mandó", a?.[0]?.motivo);
      revisar(a?.[0] && !/@/.test(a[0].cuerpo), "el cuerpo de la alerta no trae correos");
    }
  }

  // ---------- 7. Pantalla ----------
  if (BASE && PANTALLA) {
    const pw = process.env.PLAYWRIGHT_DESDE
      ? await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href)
      : req("playwright");
    const SHOTS = path.join(RAIZ, "screenshots-b-equipo");
    mkdirSync(SHOTS, { recursive: true });
    const nav = await pw.chromium.launch();
    try {
      for (const [w, h] of [[390, 844], [360, 740]]) {
        const ctx = await nav.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, extraHTTPHeaders: { "x-forwarded-for": ip() } });
        const pg = await ctx.newPage();
        const fallos = [];
        pg.on("pageerror", (e) => fallos.push(e.message.slice(0, 120)));
        await pg.goto(BASE + "/cliente/login");
        await pg.fill("#email", cred.usuarios.admin);
        await pg.fill("#password", cred.password);
        await pg.click("button[type=submit]");
        await pg.waitForURL(/\/admin/, { timeout: 90000 });
        await pg.getByText("Bandeja de correos", { exact: true }).waitFor({ timeout: 60000 });
        revisar(true, `${w}px: el panel admin enlaza la bandeja`);
        await pg.getByText("Bandeja de correos", { exact: true }).click();
        await pg.waitForURL(/\/admin\/correos/, { timeout: 60000 });
        await pg.getByText("Modo de envío:").waitFor({ timeout: 60000 });
        await pg.getByText(`Prueba blanca`).first().waitFor({ timeout: 30000 });
        await pg.waitForTimeout(800);
        revisar(await pg.getByText("Supabase", { exact: false }).first().isVisible(), `${w}px: avisa que los correos de Supabase no están`);
        await pg.screenshot({ path: path.join(SHOTS, `correos-lista-${w}.png`), fullPage: false });
        await pg.getByRole("button", { name: /^Prueba prod Enviado/ }).click();
        await pg.getByText("[oculto]", { exact: false }).waitFor({ timeout: 30000 });
        revisar(true, `${w}px: el detalle muestra el cuerpo (con el secreto oculto)`);
        await pg.screenshot({ path: path.join(SHOTS, `correos-detalle-${w}.png`), fullPage: false });
        await pg.getByRole("button", { name: "Fallidos" }).click();
        await pg.locator('button[aria-pressed="true"]', { hasText: "Fallidos" }).waitFor({ timeout: 30000 });
        await pg.getByText("Prueba falla").first().waitFor({ timeout: 30000 });
        await pg.getByText("Prueba blanca").first().waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
        const soloFallidos = !(await pg.getByText("Prueba blanca").count()) && (await pg.getByText("Prueba timeout").count()) === 1;
        revisar(soloFallidos, `${w}px: el filtro Fallidos solo deja los fallidos`);
        const ancho = await pg.evaluate(() => document.documentElement.scrollWidth);
        revisar(ancho <= w, `${w}px: sin scroll horizontal (${ancho})`);
        // Fuera el botón de Next en modo desarrollo (sin turbopack queda fuera del shadow DOM; no existe en producción).
        const chicos = await pg.$$eval("main button, main a, button, a", (els) => els.filter((e) => e.offsetParent && !e.hasAttribute("data-nextjs-dev-tools-button")).map((e) => ({ t: e.textContent.trim().slice(0, 30), h: e.getBoundingClientRect().height })).filter((x) => x.h < 40));
        revisar(chicos.length === 0, `${w}px: controles de 40 px o más`, JSON.stringify(chicos));
        await pg.screenshot({ path: path.join(SHOTS, `correos-fallidos-${w}.png`), fullPage: true });
        revisar(fallos.length === 0, `${w}px: sin errores de página`, fallos.join(" | "));
        await ctx.close();
      }
    } finally {
      await nav.close();
    }
  }
} catch (err) {
  revisar(false, "error inesperado: " + err.message);
} finally {
  await svc.from("correos_salida").delete().eq("plantilla", PLANTILLA);
  await svc.from("correos_salida").delete().like("destinatario", "t\\_equipo\\_%");
  if (ALERTAS) {
    await svc.from("alertas_enviadas").delete().eq("tipo", "pico_errores").gte("enviado_en", inicio);
    await svc.from("app_errores").delete().like("mensaje", `t_equipo_pico_${sufijo}%`);
  }
  for (const id of cuentas) {
    await svc.from("profiles").delete().eq("id", id);
    await svc.auth.admin.deleteUser(id);
  }
  const { count: quedan } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).like("destinatario", "t\\_equipo\\_%");
  console.log(`\nLimpieza: ${cuentas.length} cuentas t_equipo_ borradas, ${quedan ?? "?"} correos t_equipo_ quedan.`);
  console.log(`${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
