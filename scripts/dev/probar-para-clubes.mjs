// SOLO DEV. Prueba de sql/post-junta-3/50-para-clubes.sql (bloque 5, noche 4):
// banderas de plataforma de /para-clubes y formulario de contacto.
//
//   node scripts/dev/probar-para-clubes.mjs
//
// Casi todo corre en SQL con el rol y los encabezados que pone la API
// (anon/authenticated/service_role, IPs simuladas en cf-connecting-ip, sub de
// cada perfil) dentro de transacciones que se deshacen: no deja datos ni gasta
// el límite de la IP real de nadie. Unas pruebas van por la API de verdad
// (anon key y la sesión del admin), entre ellas la de X-Forwarded-For
// inventado por el gateway real; lo que crean lleva el prefijo t_n4_landing_ y
// se borra al final (también las huellas de la IP real usada). Deja las dos
// banderas APAGADAS.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const PREFIJO = "t_n4_landing_";
const marca = Math.random().toString(36).slice(2, 8);
const correoPrueba = (n) => `${PREFIJO}${marca}_${n}@example.com`;

const db = await conectarDevEscritura();
const resultados = [];
const nota = (t, ok, d = "") => {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`);
};
const LIMITE = /Ya recibimos varios mensajes\. Intenta de nuevo más tarde\./;

// Perfiles por rol (para simular sesiones en SQL con su sub).
const perfiles = {};
for (const [rol, correo] of Object.entries(cred.usuarios)) {
  const [f] = await db.q(`select u.id from auth.users u where u.email = $1`, [correo]);
  if (f) perfiles[rol] = f.id;
}

const valido = (n = 1, extra = {}) => ({
  p_nombre: "Prueba Landing",
  p_club: `${PREFIJO}Antro ${marca}`,
  p_ciudad: "Guadalajara",
  p_correo: correoPrueba(n),
  p_telefono: "33 1234 5678",
  p_mensaje: "Queremos probar AntroApp en nuestro antro.",
  p_sitio_web: null,
  p_ip: null,
  ...extra,
});
// Encabezados como los pone el gateway: cf-connecting-ip es la IP real; el
// primer valor de x-forwarded-for lo puede inventar quien llama.
const cabeceras = (ip, inventada = "1.2.3.4") => (ip ? { "cf-connecting-ip": ip, "x-forwarded-for": `${inventada},${ip}` } : {});

// Corre llamadas como un rol de la API dentro de una transacción que se
// deshace. `antes` prepara datos (como postgres) dentro de la misma transacción.
async function como({ rol = "anon", sub = null, ip = null, bandera = true, captcha = false, antes = null }, fn) {
  await db.q("begin");
  try {
    if (bandera !== null) await db.q(`update public.plataforma_banderas set activa = $1 where clave = 'para_clubes'`, [bandera]);
    await db.q(`update public.plataforma_banderas set activa = $1 where clave = 'contacto_requiere_captcha'`, [captcha]);
    if (antes) await antes();
    const claims = { role: rol, ...(sub ? { sub } : {}) };
    await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await db.q(`select set_config('request.headers', $1, true)`, [JSON.stringify(cabeceras(ip))]);
    await db.q(`set local role ${rol === "service_role" ? "service_role" : rol === "anon" ? "anon" : "authenticated"}`);
    return await fn();
  } finally {
    await db.q("rollback");
  }
}

// Cada llamada en su savepoint: un rechazo no aborta la transacción de la prueba.
async function conSavepoint(fn) {
  await db.q("savepoint paso");
  try {
    const r = await fn();
    await db.q("release savepoint paso");
    return r;
  } catch (e) {
    await db.q("rollback to savepoint paso");
    throw e;
  }
}
async function enviar(a) {
  try {
    const [r] = await conSavepoint(() => db.q(
      `select public.para_clubes_contacto_enviar($1, $2, $3, $4, $5, $6, $7, $8) as r`,
      [a.p_nombre, a.p_club, a.p_ciudad, a.p_correo, a.p_telefono, a.p_mensaje, a.p_sitio_web, a.p_ip],
    ));
    return { ok: true, r: r.r };
  } catch (e) {
    return { ok: false, mensaje: e.message, codigo: e.code };
  }
}
async function intentar(sql, params = []) {
  try {
    return { ok: true, filas: await conSavepoint(() => db.q(sql, params)) };
  } catch (e) {
    return { ok: false, mensaje: e.message, codigo: e.code };
  }
}
// Lo que quedó guardado (como postgres, dentro de la misma transacción).
async function guardado(correo) {
  await db.q("reset role");
  const filas = await db.q(`select * from public.contactos_clubes where correo = $1`, [correo]);
  const intentos = await db.q(`select * from public.contacto_intentos where correo_hash = public.contacto_huella('correo:' || $1)`, [correo]);
  return { filas, intentos };
}
const huellaIp = (ip) => `public.contacto_huella('ip:${ip}')`;

const anonApi = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
// PostgREST recarga su caché de esquema cuando otro carril aplica SQL en dev
// (PGRST002): se reintenta unos segundos.
async function api(fn) {
  for (let i = 0; i < 8; i++) {
    const r = await fn();
    if (r.error?.code !== "PGRST002") return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return fn();
}
async function sesion(rol) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  for (let i = 0; i < 6; i++) {
    const { error } = await c.auth.signInWithPassword({ email: cred.usuarios[rol], password: cred.password });
    if (!error) return c;
    if (!/rate|too many/i.test(error.message)) throw new Error(`login ${rol}: ${error.message}`);
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error(`login ${rol}: límite de Auth`);
}
// Envío por el gateway real con un X-Forwarded-For inventado.
async function enviarPorGateway(datos, xff) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/para_clubes_contacto_enviar`, {
      method: "POST",
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
        "content-type": "application/json",
        "x-forwarded-for": xff,
      },
      body: JSON.stringify(datos),
    });
    const j = await r.json().catch(() => null);
    if (j?.code === "PGRST002") { await new Promise((res) => setTimeout(res, 1500)); continue; }
    return { ok: r.ok, j };
  }
  return { ok: false, j: { message: "PGRST002" } };
}

let huellaReal = null; // huella de la IP real de esta máquina (para limpiar)
const [{ inicio }] = await db.q("select now() as inicio"); // la bitácora de esta corrida se borra al final
try {
  // ---------- Banderas ----------
  const iniciales = await db.q(`select clave, activa from public.plataforma_banderas order by clave`);
  nota("las dos banderas existen y están apagadas al empezar", iniciales.length === 2 && iniciales.every((b) => b.activa === false), JSON.stringify(iniciales));
  let r = await api(() => anonApi.rpc("para_clubes_activa"));
  nota("el anónimo pregunta por la API si está encendida (false)", !r.error && r.data === false, r.error?.message ?? String(r.data));

  let e = await como({ bandera: false, ip: "203.0.113.20" }, () => enviar(valido(1)));
  nota("bandera apagada: el envío se rechaza", !e.ok && e.codigo === "P0001" && /no está disponible/.test(e.mensaje), e.mensaje ?? "pasó");

  for (const rol of ["dueno", "gerente", "staff", "rp", "cliente"]) {
    e = await como({ rol: "authenticated", sub: perfiles[rol] }, () => intentar(`select public.plataforma_bandera_cambiar('para_clubes', true)`));
    nota(`${rol} no puede encender la página`, !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");
  }
  e = await como({ rol: "authenticated", sub: perfiles.dueno }, () => intentar(`select public.plataforma_bandera_cambiar('contacto_requiere_captcha', false)`));
  nota("dueño no puede quitar el CAPTCHA exigido", !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");
  e = await como({ rol: "authenticated", sub: "00000000-0000-4000-8000-00000000abcd" }, () => intentar(`select public.plataforma_bandera_cambiar('para_clubes', true)`));
  nota("cuenta de Auth sin perfil no puede encenderla", !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");
  e = await como({ rol: "anon" }, () => intentar(`select public.plataforma_bandera_cambiar('para_clubes', true)`));
  nota("el anónimo no puede ni llamar a plataforma_bandera_cambiar", !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
  e = await como({ rol: "authenticated", sub: perfiles.admin }, () => intentar(`select public.plataforma_bandera_cambiar('otra_cosa', true)`));
  nota("una clave que no existe se rechaza", !e.ok && /no existe/.test(e.mensaje ?? ""), e.mensaje ?? "pasó");
  for (const t of ["plataforma_banderas", "para_clubes_bitacora", "contacto_sal"]) {
    e = await como({ rol: "anon" }, () => intentar(`select * from public.${t}`));
    nota(`nadie lee ${t} directo (anon)`, !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
  }
  for (const f of ["contacto_huella('x')", "contacto_intentos_limpiar()"]) {
    e = await como({ rol: "anon" }, () => intentar(`select public.${f}`));
    nota(`el anónimo no llama a ${f.split("(")[0]}`, !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
    e = await como({ rol: "authenticated", sub: perfiles.admin }, () => intentar(`select public.${f}`));
    nota(`ni el admin con sesión llama a ${f.split("(")[0]}`, !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
  }

  // ---------- Envío válido ----------
  e = await como({ ip: "203.0.113.21" }, async () => {
    const x = await enviar(valido(2));
    const g = await guardado(correoPrueba(2));
    const [h] = await db.q(`select ${huellaIp("203.0.113.21")} as h, encode(sha256(convert_to('contacto:203.0.113.21', 'UTF8')), 'hex') as sin_sal`);
    return { ...x, ...g, h };
  });
  nota("envío válido del anónimo: «recibido» y se guarda una fila", e.ok && e.r === "recibido" && e.filas.length === 1, e.mensaje ?? `filas=${e.filas?.length}`);
  nota("se guarda limpio: teléfono solo dígitos, estado nuevo, sin atendido", e.filas?.[0]?.telefono === "3312345678" && e.filas?.[0]?.estado === "nuevo" && e.filas?.[0]?.atendido_por === null);
  nota("la huella de la IP usa la sal secreta (no es el sha256 que se calcula desde fuera)", e.intentos?.[0]?.ip_hash === e.h?.h && e.h?.h !== e.h?.sin_sal && /^[0-9a-f]{64}$/.test(e.h?.h ?? ""));
  nota("ni la IP ni el correo quedan en claro en los intentos", !JSON.stringify(e.intentos).includes("203.0.113.21") && !JSON.stringify(e.intentos).includes(correoPrueba(2)));

  e = await como({ ip: "203.0.113.22" }, async () => {
    const x = await enviar(valido(3, { p_telefono: "", p_mensaje: "   ", p_correo: `  ${correoPrueba(3).toUpperCase()} ` }));
    return { ...x, ...(await guardado(correoPrueba(3))) };
  });
  nota("teléfono y mensaje son opcionales; el correo se guarda en minúsculas", e.ok && e.filas?.[0]?.telefono === null && e.filas?.[0]?.mensaje === null, e.mensaje ?? "");

  // ---------- Validación ----------
  const invalidos = [
    ["nombre de 1 letra", { p_nombre: "A" }, /tu nombre/],
    ["nombre vacío", { p_nombre: "   " }, /tu nombre/],
    ["nombre de 81 letras", { p_nombre: "a".repeat(81) }, /tu nombre/],
    ["antro vacío", { p_club: "" }, /nombre de tu antro/],
    ["ciudad de 61 letras", { p_ciudad: "c".repeat(61) }, /ciudad/],
    ["enlace en el nombre del antro", { p_club: "Visita www.spam.com" }, /enlaces/],
    ["símbolo < en el nombre", { p_nombre: "<script>" }, /enlaces|símbolos/],
    ["correo sin @", { p_correo: "noesuncorreo" }, /correo/],
    ["correo sin dominio", { p_correo: "a@b" }, /correo/],
    ["correo de 121 caracteres", { p_correo: "a".repeat(110) + "@example.com" }, /correo/],
    ["teléfono de 5 dígitos", { p_telefono: "12345" }, /teléfono/],
    ["teléfono de 16 dígitos", { p_telefono: "1234567890123456" }, /teléfono/],
    ["mensaje de 1,001 caracteres", { p_mensaje: "m".repeat(1001) }, /largo/],
    ["mensaje con 3 enlaces", { p_mensaje: "http://a.mx https://b.mx www.c.mx" }, /enlaces/],
  ];
  for (const [t, extra, re] of invalidos) {
    e = await como({ ip: "203.0.113.23" }, () => enviar(valido(4, extra)));
    nota(`inválido: ${t}`, !e.ok && e.codigo === "P0001" && re.test(e.mensaje), e.mensaje ?? "pasó");
  }

  // ---------- Casilla trampa ----------
  e = await como({ ip: "203.0.113.24" }, async () => {
    const x = await enviar(valido(5, { p_sitio_web: "https://bot.example" }));
    const g = await guardado(correoPrueba(5));
    const [{ n }] = await db.q(`select count(*)::int as n from public.contacto_intentos where ip_hash = ${huellaIp("203.0.113.24")}`);
    return { ...x, ...g, n };
  });
  nota("casilla trampa llena: responde «recibido» igual", e.ok && e.r === "recibido", e.mensaje ?? "");
  nota("casilla trampa llena: no guarda el contacto ni deja huella", e.filas?.length === 0 && e.intentos?.length === 0 && e.n === 0);
  e = await como({ ip: "203.0.113.25" }, async () => {
    const res = [];
    for (let i = 0; i < 6; i++) res.push(await enviar(valido(70 + i, { p_sitio_web: "bot" })));
    res.push(await enviar(valido(76)));
    return res;
  });
  nota("6 envíos con la trampa desde una IP no gastan su límite: el siguiente bueno pasa", e.every((x) => x.ok), e.find((x) => !x.ok)?.mensaje ?? "");
  e = await como({
    ip: "203.0.113.26",
    antes: () => db.q(`insert into public.contacto_intentos (ip_hash, correo_hash) select md5('ip' || g), md5('c' || g) from generate_series(1, 59) g`),
  }, async () => {
    const res = [];
    for (let i = 0; i < 5; i++) res.push(await enviar(valido(80 + i, { p_sitio_web: "bot" })));
    res.push(await enviar(valido(85)));
    return res;
  });
  nota("la trampa tampoco cuenta para el tope total: con 59 en la hora, el bueno pasa", e.every((x) => x.ok), e.find((x) => !x.ok)?.mensaje ?? "");

  // ---------- Límites por IP ----------
  e = await como({ ip: "203.0.113.30" }, async () => {
    const res = [];
    for (let i = 0; i < 4; i++) res.push(await enviar(valido(10 + i)));
    return res;
  });
  nota("3 envíos desde la misma IP en una hora pasan", e.slice(0, 3).every((x) => x.ok), e.find((x) => !x.ok)?.mensaje ?? "");
  nota("el 4º desde la misma IP se rechaza con el aviso neutro", !e[3].ok && LIMITE.test(e[3].mensaje), e[3].mensaje ?? "pasó");

  // X-Forwarded-For inventado: cambia el primer valor en cada envío, la IP real no.
  e = await como({}, async () => {
    const res = [];
    for (let i = 0; i < 4; i++) {
      await db.q(`select set_config('request.headers', $1, true)`, [JSON.stringify(cabeceras("203.0.113.35", `9.9.9.${i}`))]);
      res.push(await enviar(valido(14 + i)));
    }
    return res;
  });
  nota("X-Forwarded-For inventado distinto en cada envío: el 4º igual se rechaza", e.slice(0, 3).every((x) => x.ok) && !e[3].ok && LIMITE.test(e[3].mensaje), e.map((x) => (x.ok ? "ok" : x.mensaje)).join(" | "));

  e = await como({
    ip: "203.0.113.31",
    antes: () => db.q(`insert into public.contacto_intentos (ip_hash, correo_hash, creado_en)
                       select ${huellaIp("203.0.113.31")}, md5(g::text), now() - interval '3 hours' from generate_series(1, 10) g`),
  }, () => enviar(valido(20)));
  nota("10 envíos de la misma IP en el día (fuera de la hora): el siguiente se rechaza", !e.ok && LIMITE.test(e.mensaje), e.mensaje ?? "pasó");
  e = await como({
    ip: "203.0.113.32",
    antes: () => db.q(`insert into public.contacto_intentos (ip_hash, correo_hash, creado_en)
                       select ${huellaIp("203.0.113.32")}, md5(g::text), now() - interval '25 hours' from generate_series(1, 10) g`),
  }, () => enviar(valido(21)));
  nota("lo de hace más de un día ya no cuenta", e.ok, e.mensaje ?? "");

  e = await como({ ip: null }, () => enviar(valido(22)));
  nota("sin IP en los encabezados: pasa (aplican los demás límites)", e.ok, e.mensaje ?? "");

  // ---------- Límite por correo ----------
  e = await como({}, async () => {
    const res = [];
    for (let i = 0; i < 4; i++) {
      await db.q(`select set_config('request.headers', $1, true)`, [JSON.stringify(cabeceras(`198.51.100.${40 + i}`))]);
      res.push(await enviar(valido(30)));
    }
    return res;
  });
  nota("el mismo correo desde 3 IPs distintas: pasan", e.slice(0, 3).every((x) => x.ok), e.find((x) => !x.ok)?.mensaje ?? "");
  nota("el 4º con el mismo correo se rechaza con el MISMO aviso neutro (no confirma el correo)", !e[3].ok && LIMITE.test(e[3].mensaje) && !/correo/i.test(e[3].mensaje), e[3].mensaje ?? "pasó");

  // ---------- Límite total ----------
  e = await como({
    ip: "203.0.113.33",
    antes: () => db.q(`insert into public.contacto_intentos (ip_hash, correo_hash) select md5('ip' || g), md5('c' || g) from generate_series(1, 60) g`),
  }, () => enviar(valido(40)));
  nota("60 envíos en la última hora en total: el siguiente se rechaza con un aviso claro", !e.ok && /Intenta de nuevo en una hora/.test(e.mensaje), e.mensaje ?? "pasó");

  // ---------- IP que manda la ruta (p_ip) ----------
  e = await como({ rol: "service_role" }, async () => {
    const x = await enviar(valido(41, { p_ip: "192.0.2.50" }));
    const g = await guardado(correoPrueba(41));
    const [h] = await db.q(`select ${huellaIp("192.0.2.50")} as h`);
    return { ...x, ...g, esperado: h.h };
  });
  nota("service role (ruta con CAPTCHA): usa la IP que manda la ruta", e.ok && e.intentos?.[0]?.ip_hash === e.esperado, e.mensaje ?? "");
  e = await como({ rol: "service_role" }, async () => {
    const x = await enviar(valido(43, { p_ip: "no es una ip; drop table" }));
    return { ...x, ...(await guardado(correoPrueba(43))) };
  });
  nota("service role con p_ip que no es IP: se ignora (sin huella de IP)", e.ok && e.intentos?.[0]?.ip_hash === null, e.mensaje ?? "");
  e = await como({ rol: "anon", ip: "203.0.113.34" }, async () => {
    const x = await enviar(valido(42, { p_ip: "192.0.2.51" }));
    const g = await guardado(correoPrueba(42));
    const [h] = await db.q(`select ${huellaIp("203.0.113.34")} as h`);
    return { ...x, ...g, esperado: h.h };
  });
  nota("anónimo que manda p_ip: se ignora y vale la IP real del gateway", e.ok && e.intentos?.[0]?.ip_hash === e.esperado, e.mensaje ?? "");

  // ---------- CAPTCHA exigido ----------
  e = await como({ rol: "anon", ip: "203.0.113.40", captcha: true }, () => enviar(valido(44)));
  nota("CAPTCHA exigido: el anónimo directo se rechaza", !e.ok && /verificación anti-robots/.test(e.mensaje), e.mensaje ?? "pasó");
  e = await como({ rol: "authenticated", sub: perfiles.cliente, ip: "203.0.113.41", captcha: true }, () => enviar(valido(45)));
  nota("CAPTCHA exigido: una sesión directa (cliente) también se rechaza", !e.ok && /verificación anti-robots/.test(e.mensaje), e.mensaje ?? "pasó");
  e = await como({ rol: "service_role", captcha: true }, () => enviar(valido(46, { p_ip: "192.0.2.52" })));
  nota("CAPTCHA exigido: la ruta de la app (service role) sí guarda", e.ok, e.mensaje ?? "");
  e = await como({ rol: "anon", ip: "203.0.113.42", captcha: true }, () => enviar(valido(47, { p_sitio_web: "bot" })));
  nota("CAPTCHA exigido: ni con la trampa responde «recibido» al anónimo", !e.ok, e.mensaje ?? "pasó");
  e = await como({ rol: "anon", ip: "203.0.113.43", captcha: false }, () => enviar(valido(48)));
  nota("CAPTCHA no exigido: el anónimo directo sí guarda", e.ok, e.mensaje ?? "");

  // ---------- Acceso directo a las tablas ----------
  for (const [rol, sub] of [["anon", null], ["authenticated", perfiles.dueno], ["authenticated", perfiles.admin]]) {
    const quien = sub === perfiles.admin ? "admin" : sub ? "dueño" : "anónimo";
    e = await como({ rol, sub }, () => intentar(`select * from public.contactos_clubes limit 1`));
    nota(`${quien} no lee contactos_clubes directo`, !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
    e = await como({ rol, sub }, () => intentar(`insert into public.contactos_clubes (nombre, club_nombre, ciudad, correo) values ('Bot', 'Bot', 'Bot', 'bot@example.com')`));
    nota(`${quien} no inserta en contactos_clubes directo`, !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
    e = await como({ rol, sub }, () => intentar(`select * from public.contacto_intentos limit 1`));
    nota(`${quien} no lee contacto_intentos`, !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
  }

  // ---------- Solo el admin lee y marca ----------
  const conContactos = (n = 1) => db.q(
    `insert into public.contactos_clubes (nombre, club_nombre, ciudad, correo, creado_en)
     select 'Prueba', $1 || g, 'Guadalajara', $2 || g || '@example.com', now() - g * interval '1 minute' from generate_series(1, $3::int) g`,
    [`${PREFIJO}lectura`, `${PREFIJO}${marca}_lect`, n],
  );
  for (const rol of ["dueno", "gerente", "staff", "rp", "cliente"]) {
    e = await como({ rol: "authenticated", sub: perfiles[rol], antes: () => conContactos() }, () => intentar(`select * from public.contactos_clubes_admin()`));
    nota(`${rol} no lee la bandeja de contactos`, !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");
  }
  e = await como({ rol: "authenticated", sub: perfiles.dueno }, () => intentar(`select * from public.contactos_clubes_conteo()`));
  nota("dueño no ve los conteos de la bandeja", !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");
  e = await como({ rol: "authenticated", sub: "00000000-0000-4000-8000-00000000abcd", antes: () => conContactos() }, () => intentar(`select * from public.contactos_clubes_admin()`));
  nota("cuenta sin perfil no lee la bandeja", !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");
  e = await como({ rol: "anon", antes: () => conContactos() }, () => intentar(`select * from public.contactos_clubes_admin()`));
  nota("el anónimo no puede llamar a la bandeja", !e.ok && e.codigo === "42501", e.mensaje ?? "pasó");
  e = await como({ rol: "authenticated", sub: perfiles.dueno, antes: () => conContactos() }, () => intentar(`select public.contacto_club_marcar('00000000-0000-4000-8000-000000000000', 'atendido')`));
  nota("un dueño no puede marcar contactos", !e.ok && e.codigo === "P0001", e.mensaje ?? "pasó");

  // Paginación y conteos.
  e = await como({
    rol: "authenticated", sub: perfiles.admin,
    antes: async () => { await db.q(`delete from public.contactos_clubes`); await conContactos(3); },
  }, async () => {
    const p1 = await intentar(`select * from public.contactos_clubes_admin(null, 2, 0)`);
    const p2 = await intentar(`select * from public.contactos_clubes_admin(null, 2, 2)`);
    const c = await intentar(`select * from public.contactos_clubes_conteo()`);
    return { p1, p2, c };
  });
  nota("bandeja por páginas: 2 + 1 con total 3", e.p1.filas?.length === 2 && Number(e.p1.filas?.[0]?.total) === 3 && e.p2.filas?.length === 1, `${e.p1.filas?.length}+${e.p2.filas?.length}`);
  nota("conteos por estado para los filtros", Number(e.c.filas?.find((f) => f.estado === "nuevo")?.total) === 3, JSON.stringify(e.c.filas ?? []));

  // Limpieza de huellas viejas al abrir la bandeja.
  e = await como({
    rol: "authenticated", sub: perfiles.admin,
    antes: () => db.q(`insert into public.contacto_intentos (ip_hash, correo_hash, creado_en) values ('viejo', 'viejo', now() - interval '8 days'), ('nuevo', 'nuevo', now() - interval '6 days')`),
  }, async () => {
    await intentar(`select * from public.contactos_clubes_admin()`);
    await db.q("reset role");
    return db.q(`select ip_hash from public.contacto_intentos where ip_hash in ('viejo', 'nuevo')`);
  });
  nota("abrir la bandeja borra las huellas de más de 7 días (y deja las de 6)", e.length === 1 && e[0].ip_hash === "nuevo", JSON.stringify(e));
  e = await como({
    rol: "service_role",
    antes: () => db.q(`insert into public.contacto_intentos (ip_hash, correo_hash, creado_en) values ('viejo2', 'viejo2', now() - interval '8 days')`),
  }, () => intentar(`select public.contacto_intentos_limpiar() as n`));
  nota("la tarea diaria (service role) puede limpiar", e.ok && e.filas?.[0]?.n >= 1, e.mensaje ?? "");

  e = await como({ rol: "authenticated", sub: perfiles.admin, antes: () => conContactos() }, async () => {
    const lista = await intentar(`select * from public.contactos_clubes_admin()`);
    const fila = lista.filas?.find((f) => f.correo === `${PREFIJO}${marca}_lect1@example.com`);
    const marcar = await intentar(`select public.contacto_club_marcar($1, 'atendido')`, [fila?.id]);
    const atendida = (await intentar(`select * from public.contactos_clubes_admin('atendido')`)).filas?.find((f) => f.id === fila?.id);
    const nuevo = await intentar(`select public.contacto_club_marcar($1, 'nuevo')`, [fila?.id]);
    const otraVez = (await intentar(`select * from public.contactos_clubes_admin('nuevo')`)).filas?.find((f) => f.id === fila?.id);
    const malo = await intentar(`select public.contacto_club_marcar($1, 'pagado')`, [fila?.id]);
    const borrar = await intentar(`select public.contacto_club_borrar($1)`, [fila?.id]);
    const yaNo = await intentar(`select public.contacto_club_marcar($1, 'atendido')`, [fila?.id]);
    const cambio = await intentar(`select public.plataforma_bandera_cambiar('para_clubes', true)`);
    await db.q("reset role");
    const bitacora = await db.q(`select accion, detalle, contacto_id, hecho_por from public.para_clubes_bitacora where hecho_por = $1 order by id`, [perfiles.admin]);
    return { lista, fila, marcar, atendida, nuevo, otraVez, malo, borrar, yaNo, cambio, bitacora };
  });
  nota("el admin lee la bandeja (con el contacto)", e.lista.ok && !!e.fila, e.lista.mensaje ?? "");
  nota("el admin marca «atendido»: queda con quién y cuándo", e.marcar.ok && e.atendida?.estado === "atendido" && !!e.atendida?.atendido_por_nombre && !!e.atendida?.atendido_en, e.marcar.mensaje ?? "");
  nota("el admin lo regresa a «nuevo»: se limpia quién y cuándo", e.nuevo.ok && e.otraVez?.atendido_por_nombre === null && e.otraVez?.atendido_en === null);
  nota("estado inválido se rechaza", !e.malo.ok && e.malo.codigo === "P0001", e.malo.mensaje ?? "pasó");
  nota("el admin borra un contacto (derecho de cancelación)", e.borrar.ok && !e.yaNo.ok && /ya no existe/.test(e.yaNo.mensaje ?? ""), e.borrar.mensaje ?? "");
  const acciones = (e.bitacora ?? []).map((b) => `${b.accion}:${b.detalle}`);
  nota("bitácora: marcar, regresar, borrar y cambiar la bandera, con quién", JSON.stringify(acciones) === JSON.stringify(["contacto_estado:atendido", "contacto_estado:nuevo", "contacto_borrado:borrado a petición", "bandera:para_clubes=true"]), JSON.stringify(acciones));
  nota("bitácora sin datos personales (solo el id del contacto borrado)", (e.bitacora ?? []).every((b) => !/@|Prueba|Guadalajara/.test(b.detalle)) && e.bitacora?.[2]?.contacto_id === e.fila?.id);

  // ---------- Por la API de verdad ----------
  const admin = await sesion("admin");
  r = await api(() => admin.rpc("plataforma_bandera_cambiar", { p_clave: "para_clubes", p_activa: true }));
  nota("el admin enciende la página por la API", !r.error && r.data === true, r.error?.message ?? "");
  r = await api(() => anonApi.rpc("para_clubes_activa"));
  nota("el anónimo la ve encendida", !r.error && r.data === true, r.error?.message ?? String(r.data));
  r = await api(() => admin.rpc("plataforma_banderas_estado"));
  nota("el admin ve quién la cambió", !r.error && r.data?.find((b) => b.clave === "para_clubes")?.activa === true && !!r.data?.find((b) => b.clave === "para_clubes")?.cambiado_por_nombre, r.error?.message ?? "");

  const viaApi = valido(60);
  r = await api(() => anonApi.rpc("para_clubes_contacto_enviar", viaApi));
  const [conIp] = await db.q(`select ip_hash from public.contacto_intentos where correo_hash = public.contacto_huella('correo:' || $1)`, [viaApi.p_correo]);
  huellaReal = conIp?.ip_hash ?? null;
  nota("por la API: el anónimo envía y el intento guarda la huella de la IP del gateway", !r.error && r.data === "recibido" && !!huellaReal, r.error?.message ?? JSON.stringify(conIp));

  // X-Forwarded-For inventado por el gateway real (desde cero para esta IP).
  if (huellaReal) await db.q(`delete from public.contacto_intentos where ip_hash = $1`, [huellaReal]);
  const porGateway = [];
  for (let i = 0; i < 4; i++) porGateway.push(await enviarPorGateway(valido(61 + i), `198.18.${i}.${i + 7}`));
  nota("gateway real: 4 envíos con X-Forwarded-For inventado distinto → 3 pasan y el 4º se rechaza",
    porGateway.slice(0, 3).every((x) => x.ok) && !porGateway[3].ok && LIMITE.test(porGateway[3].j?.message ?? ""),
    porGateway.map((x) => (x.ok ? "ok" : x.j?.message)).join(" | "));
  const [{ n: conMiIp }] = await db.q(`select count(*)::int as n from public.contacto_intentos where ip_hash = $1`, [huellaReal]);
  nota("gateway real: los 3 cuentan para la IP real (no para la inventada)", conMiIp === 3, `huellas con la IP real: ${conMiIp}`);

  r = await api(() => anonApi.from("contactos_clubes").select("*"));
  nota("por la API: el anónimo no lee contactos_clubes", r.error?.code === "42501", r.error?.code ?? `${r.data?.length} filas`);
  r = await api(() => anonApi.from("contactos_clubes").insert({ nombre: "Bot", club_nombre: "Bot", ciudad: "Bot", correo: "bot@example.com" }));
  nota("por la API: el anónimo no inserta directo", r.error?.code === "42501", r.error?.code ?? "insertó");
  const dueno = await sesion("dueno");
  r = await api(() => dueno.rpc("contactos_clubes_admin"));
  nota("por la API: el dueño no lee la bandeja", !!r.error && r.error.code === "P0001", r.error?.message ?? "leyó");
  r = await api(() => admin.rpc("contactos_clubes_admin", { p_estado: null, p_limite: 200, p_desde: 0 }));
  nota("por la API: el admin sí la lee", !r.error && (r.data ?? []).some((f) => f.correo === viaApi.p_correo), r.error?.message ?? "");

  // CAPTCHA exigido por la API: la llamada directa del anónimo se rechaza.
  r = await api(() => admin.rpc("plataforma_bandera_cambiar", { p_clave: "contacto_requiere_captcha", p_activa: true }));
  r = await api(() => anonApi.rpc("para_clubes_contacto_enviar", valido(66)));
  nota("por la API: con CAPTCHA exigido, el anónimo directo (sin token) se rechaza", !!r.error && /verificación anti-robots/.test(r.error.message), r.error?.message ?? "pasó");
  r = await api(() => admin.rpc("plataforma_bandera_cambiar", { p_clave: "contacto_requiere_captcha", p_activa: false }));

  r = await api(() => admin.rpc("plataforma_bandera_cambiar", { p_clave: "para_clubes", p_activa: false }));
  r = await api(() => anonApi.rpc("para_clubes_contacto_enviar", valido(67)));
  nota("por la API: apagada, el envío se rechaza", !!r.error && /no está disponible/.test(r.error.message), r.error?.message ?? "pasó");
} finally {
  // Limpieza: lo creado por la API, sus huellas, la bitácora de la prueba y
  // las banderas apagadas.
  await db.q("reset role").catch(() => {});
  await db.q(`update public.plataforma_banderas set activa = false`);
  await db.q(`delete from public.contactos_clubes where correo like $1 or club_nombre like $1`, [`${PREFIJO}%`]);
  for (let n = 0; n <= 90; n++) {
    await db.q(`delete from public.contacto_intentos where correo_hash = public.contacto_huella('correo:' || $1)`, [correoPrueba(n)]);
  }
  if (huellaReal) await db.q(`delete from public.contacto_intentos where ip_hash = $1`, [huellaReal]);
  await db.q(`delete from public.para_clubes_bitacora where hecho_en >= $1`, [inicio]);
  const [{ quedan }] = await db.q(`select count(*)::int as quedan from public.contactos_clubes where correo like $1 or club_nombre like $1`, [`${PREFIJO}%`]);
  const [{ huellas }] = await db.q(`select count(*)::int as huellas from public.contacto_intentos where ip_hash = $1`, [huellaReal ?? ""]);
  const [{ encendidas }] = await db.q(`select count(*) filter (where activa)::int as encendidas from public.plataforma_banderas`);
  nota("limpieza: 0 contactos de prueba, 0 huellas de la IP real y las banderas apagadas", quedan === 0 && huellas === 0 && encendidas === 0, `quedan ${quedan}, huellas ${huellas}, encendidas ${encendidas}`);
  await db.fin();
}

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} pasan`);
process.exit(ok === resultados.length ? 0 : 1);
