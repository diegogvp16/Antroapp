// Pruebas del CAPTCHA (Turnstile), del límite de registros y del cambio de
// contraseña obligatorio. Usa las LLAVES DE PRUEBA PÚBLICAS de Cloudflare
// (documentadas por Cloudflare para pruebas; no son llaves reales):
//   sitio  1x00000000000000000000AA          (siempre pasa)
//   secreta 1x0000000000000000000000000000000AA (siempre pasa)
//   secreta 2x0000000000000000000000000000000AA (siempre falla)
//
// Dos servidores locales contra antroapp-dev:
//   bandera apagada:   node scripts/dev/servidor-dev.mjs                      (3001)
//   bandera encendida: NEXT_DIST_DIR=.next-captcha PUERTO=3003 \
//     NEXT_PUBLIC_CAPTCHA_TURNSTILE=1 NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA \
//     TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA node scripts/dev/servidor-dev.mjs
//
//   node scripts/dev/probar-captcha.mjs [--sin=http://localhost:3001] [--con=http://localhost:3003]
//   (con PLAYWRIGHT_DESDE=<carpeta> además revisa las pantallas)

import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";
import { decidirCaptcha, interpretarSiteverify } from "../../lib/domain/captcha.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const arg = (n, def) => (process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? def).replace(/\/$/, "");
const SIN = arg("sin", "http://localhost:3001");
const CON = arg("con", "http://localhost:3003");
const TOKEN_PRUEBA = "XXXX.DUMMY.TOKEN.XXXX"; // token de prueba que aceptan las secretas 1x/2x
const hash = (t) => createHash("sha256").update(t).digest("hex");

let pasan = 0, fallan = 0, saltadas = 0;
// Dev tiene la confirmación por correo encendida y Supabase limita esos
// correos por hora: si el registro choca con ese límite no es una falla de
// la ruta, pero tampoco se pudo probar.
const limiteCorreos = (r) => r.status === 429 && /correos de confirmación/.test(r.cuerpo.error ?? "");
function saltar(texto) {
  saltadas++;
  console.log("SALTADA " + texto + "  — límite de correos de confirmación de Supabase en dev; repetir en una hora");
}
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const sufijo = randomUUID().slice(0, 8);
const PASS = "Prueba-" + randomUUID();
const ips = [];
const nuevaIp = () => { const ip = `203.0.113.${Math.floor(Math.random() * 250)}`; ips.push(ip); return ip; };
async function post(base, ruta, cuerpo, ip, galletas) {
  const r = await fetch(base + ruta, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(galletas ? { cookie: galletas } : {}) }, body: JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})), galletas: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const usuarios = [];
const correos = [];

try {
  // ---------- 1. Reglas puras ----------
  revisar(decidirCaptcha("valido").permitir && !decidirCaptcha("valido").degradado, "token válido: pasa normal");
  revisar(!decidirCaptcha("invalido").permitir, "token inválido: se rechaza");
  revisar(decidirCaptcha("sin_token").permitir && decidirCaptcha("sin_token").degradado, "sin token: pasa en modo degradado");
  revisar(decidirCaptcha("sin_servicio").permitir && decidirCaptcha("sin_servicio").degradado, "Cloudflare sin respuesta: pasa en modo degradado");
  revisar(interpretarSiteverify({ success: false, "error-codes": ["invalid-input-secret"] }) === "sin_servicio", "llave secreta mal configurada no deja fuera a nadie");
  revisar(interpretarSiteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }) === "invalido", "token repetido o vencido: inválido");
  revisar(interpretarSiteverify("basura") === "sin_servicio", "respuesta rara de Cloudflare: degradado");

  // Respuestas reales de Cloudflare con las secretas de prueba.
  const sv = async (secret) => {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret, response: TOKEN_PRUEBA }) });
    return interpretarSiteverify(await r.json());
  };
  revisar((await sv("1x0000000000000000000000000000000AA")) === "valido", "Cloudflare real, secreta de prueba «pasa» → válido");
  revisar((await sv("2x0000000000000000000000000000000AA")) === "invalido", "Cloudflare real, secreta de prueba «falla» → inválido");

  // ---------- 2. Bandera APAGADA (3001): todo como antes ----------
  const correoCliente = `captcha_cli_${sufijo}@example.com`;
  correos.push(correoCliente);
  const u = await svc.auth.admin.createUser({ email: correoCliente, password: PASS, email_confirm: true });
  usuarios.push(u.data.user.id);
  await svc.from("profiles").insert({ id: u.data.user.id, nombre: "Cliente Captcha", role: "cliente" });
  revisar((await post(SIN, "/api/auth/login", { email: correoCliente, password: PASS }, nuevaIp())).status === 200, "apagada: login sin token funciona igual (200)");
  revisar((await post(SIN, "/api/auth/registro", { tipo: "cliente", nombre: "X", email: `x_${sufijo}@example.com`, password: PASS }, nuevaIp())).status === 404, "apagada: la ruta de registro no existe (404)");

  // ---------- 3. Bandera ENCENDIDA (3003) ----------
  const ok = await post(CON, "/api/auth/login", { email: correoCliente, password: PASS, captchaToken: TOKEN_PRUEBA }, nuevaIp());
  revisar(ok.status === 200, "encendida: login con token válido → 200", JSON.stringify(ok.cuerpo));
  const ipDeg = nuevaIp();
  const sinToken = await post(CON, "/api/auth/login", { email: correoCliente, password: PASS }, ipDeg);
  revisar(sinToken.status === 200, "encendida: sin token (CAPTCHA no cargó) → entra en modo degradado");
  for (let i = 0; i < 3; i++) await post(CON, "/api/auth/login", { email: correoCliente, password: "mala" + i }, ipDeg);
  const bloq = await post(CON, "/api/auth/login", { email: correoCliente, password: PASS }, ipDeg);
  revisar(bloq.status === 429, "modo degradado: 3 fallos del correo desde la misma IP bloquean (en vez de 5)", String(bloq.status));
  const ipNormal = nuevaIp();
  for (let i = 0; i < 3; i++) await post(CON, "/api/auth/login", { email: correoCliente, password: "mala" + i, captchaToken: TOKEN_PRUEBA }, ipNormal);
  revisar((await post(CON, "/api/auth/login", { email: correoCliente, password: PASS, captchaToken: TOKEN_PRUEBA }, ipNormal)).status === 200, "con CAPTCHA válido: 3 fallos todavía no bloquean");

  // Registro por el servidor.
  const ipReg = nuevaIp();
  const regCli = { tipo: "cliente", nombre: "Cliente Registro", telefono: "0000000777", email: `captcha_reg_${sufijo}@example.com`, password: PASS, captchaToken: TOKEN_PRUEBA };
  correos.push(regCli.email);
  const r1 = await post(CON, "/api/auth/registro", regCli, ipReg);
  if (limiteCorreos(r1)) {
    saltar("registro de cliente y de dueño por el servidor (4 chequeos)");
    revisar(true, "límite de correos de Supabase → 429 con mensaje claro (no 500)");
  } else {
  revisar(r1.status === 200 && r1.cuerpo.ok, "registro de cliente por el servidor", JSON.stringify(r1.cuerpo));
  const { data: perfilCli } = await svc.from("profiles").select("id, role, telefono").eq("nombre", "Cliente Registro");
  perfilCli?.forEach((p) => usuarios.push(p.id));
  revisar(perfilCli?.length === 1 && perfilCli[0].role === "cliente" && perfilCli[0].telefono === "0000000777", "perfil de cliente creado con su teléfono");
  const dup = await post(CON, "/api/auth/registro", regCli, ipReg);
  revisar(dup.status === 409 && dup.cuerpo.emailTaken, "correo repetido → 409");
  const regDueno = { tipo: "dueno", nombre: "Dueño Registro", email: `captcha_dueno_${sufijo}@example.com`, password: PASS, captchaToken: TOKEN_PRUEBA, club: { nombre: `Antro Captcha ${sufijo}`, direccion: "Calle 1", horario: "Vie 10pm" } };
  correos.push(regDueno.email);
  const r2 = await post(CON, "/api/auth/registro", regDueno, ipReg);
  const { data: club } = await svc.from("clubs").select("id, estado_verificacion, suscripcion_activa, dueno_id").eq("nombre", regDueno.club.nombre).maybeSingle();
  const { data: pd } = await svc.from("profiles").select("id").eq("nombre", "Dueño Registro");
  pd?.forEach((p) => usuarios.push(p.id));
  revisar(r2.status === 200 && club && club.estado_verificacion === "borrador" && !club.suscripcion_activa && club.dueno_id === pd?.[0]?.id, "registro de dueño: cuenta + antro en borrador, ligado");
  if (club) await svc.from("clubs").delete().eq("id", club.id);
  }
  const malo = await post(CON, "/api/auth/registro", { ...regCli, email: `captcha_malo_${sufijo}@example.com`, nombre: "" }, ipReg);
  revisar(malo.status === 400, "datos incompletos → 400");
  for (let i = 0; i < 3; i++) await post(CON, "/api/auth/registro", { ...regCli, email: `captcha_lim${i}_${sufijo}@example.com`, nombre: "Límite " + i }, ipReg).then(() => correos.push(`captcha_lim${i}_${sufijo}@example.com`));
  const limite = await post(CON, "/api/auth/registro", { ...regCli, email: `captcha_lim9_${sufijo}@example.com`, nombre: "Límite 9" }, ipReg);
  revisar(limite.status === 429, "6.º registro desde la misma IP en una hora → 429", String(limite.status));
  const ipRegDeg = nuevaIp();
  const sinTok = { ...regCli, captchaToken: null };
  await post(CON, "/api/auth/registro", { ...sinTok, email: `captcha_deg1_${sufijo}@example.com`, nombre: "Degradado 1" }, ipRegDeg);
  await post(CON, "/api/auth/registro", { ...sinTok, email: `captcha_deg2_${sufijo}@example.com`, nombre: "Degradado 2" }, ipRegDeg);
  correos.push(`captcha_deg1_${sufijo}@example.com`, `captcha_deg2_${sufijo}@example.com`);
  revisar((await post(CON, "/api/auth/registro", { ...sinTok, email: `captcha_deg3_${sufijo}@example.com`, nombre: "Degradado 3" }, ipRegDeg)).status === 429, "registro sin CAPTCHA (degradado): el 3.º desde la misma IP → 429");

  // ---------- 4. Cambio de contraseña obligatorio ----------
  const correoTemp = `captcha_temp_${sufijo}@example.com`;
  correos.push(correoTemp);
  const t = await svc.auth.admin.createUser({ email: correoTemp, password: PASS, email_confirm: true, app_metadata: { alta_club: true, debe_cambiar: true } });
  usuarios.push(t.data.user.id);
  await svc.from("profiles").insert({ id: t.data.user.id, nombre: "Temporal", role: "cliente" });
  const lt = await post(SIN, "/api/auth/login", { email: correoTemp, password: PASS }, nuevaIp());
  revisar(lt.status === 200 && lt.cuerpo.debeCambiar === true, "cuenta con contraseña temporal: el login avisa que debe cambiarla");
  const corta = await post(SIN, "/api/auth/cambiar-contrasena", { nueva: "corta" }, nuevaIp(), lt.galletas);
  revisar(corta.status === 400, "contraseña nueva de menos de 8 → 400");
  const NUEVA = "Nueva-" + randomUUID();
  const cambio = await post(SIN, "/api/auth/cambiar-contrasena", { nueva: NUEVA }, nuevaIp(), lt.galletas);
  revisar(cambio.status === 200, "cambia la contraseña", JSON.stringify(cambio.cuerpo));
  revisar((await post(SIN, "/api/auth/login", { email: correoTemp, password: PASS }, nuevaIp())).status === 401, "la temporal ya no sirve");
  const ln = await post(SIN, "/api/auth/login", { email: correoTemp, password: NUEVA }, nuevaIp());
  revisar(ln.status === 200 && !ln.cuerpo.debeCambiar, "con la nueva entra y ya no se le pide cambiarla");
  revisar((await post(SIN, "/api/auth/cambiar-contrasena", { nueva: NUEVA + "x" }, nuevaIp(), ln.galletas)).status === 409, "sin la marca, la ruta no cambia contraseñas (409)");
  revisar((await post(SIN, "/api/auth/cambiar-contrasena", { nueva: NUEVA }, nuevaIp())).status === 401, "sin sesión → 401");

  // ---------- 5. Pantallas (opcional, con Playwright) ----------
  if (process.env.PLAYWRIGHT_DESDE) {
    const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    const nav = await chromium.launch();
    try {
      for (const [base, conBandera] of [[SIN, false], [CON, true]]) {
        const p = await nav.newPage({ viewport: { width: 390, height: 844 } });
        const aCloudflare = [];
        p.on("request", (r) => { if (r.url().includes("challenges.cloudflare.com")) aCloudflare.push(r.url()); });
        await p.goto(base + "/cliente/login");
        await p.waitForTimeout(conBandera ? 6000 : 3000);
        // Turnstile dibuja su iframe en un shadow DOM cerrado: se revisa por
        // lo que pidió el navegador a Cloudflare.
        const cargoScript = aCloudflare.some((u) => u.includes("/turnstile/v0/api.js"));
        const cargoReto = aCloudflare.some((u) => u.includes("/cdn-cgi/challenge-platform/"));
        if (!conBandera) revisar(aCloudflare.length === 0, "apagada: /cliente/login no carga nada de Cloudflare");
        else {
          revisar(cargoScript && cargoReto, "encendida: /cliente/login carga la casilla de Turnstile", aCloudflare.slice(0, 3).join(" "));
          await p.fill("#email", correoCliente);
          await p.fill("#password", PASS);
          await p.click("button[type=submit]");
          const entro = await p.waitForURL(/\/cliente$/, { timeout: 30000 }).then(() => true, () => false);
          revisar(entro, "encendida: el cliente entra con la casilla resuelta (llave de prueba)");
          await p.screenshot({ path: path.join(RAIZ, "screenshots-post-junta", "captcha-login.png") }).catch(() => {});
        }
        await p.close();
      }
    } finally {
      await nav.close();
    }
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  const { data: lista } = await svc.auth.admin.listUsers({ perPage: 1000 });
  const extra = (lista?.users ?? []).filter((x) => (x.email ?? "").includes(sufijo)).map((x) => x.id);
  const todos = [...new Set([...usuarios, ...extra])];
  if (todos.length) await svc.from("profiles").delete().in("id", todos);
  await svc.from("clubs").delete().like("nombre", `Antro Captcha ${sufijo}%`);
  for (const id of todos) await svc.auth.admin.deleteUser(id);
  await svc.from("registro_intentos").delete().in("ip_hash", ips.map(hash));
  await svc.from("login_intentos").delete().in("email_hash", correos.map((c) => hash(c)));
  console.log(`\nLimpieza: ${todos.length} cuentas de prueba borradas.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan${saltadas ? `, ${saltadas} saltadas` : ""}`);
  if (fallan) process.exitCode = 1;
}
