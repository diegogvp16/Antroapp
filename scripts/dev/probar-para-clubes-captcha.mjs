// SOLO DEV. Formulario de /para-clubes con el CAPTCHA encendido: la ruta
// /api/para-clubes/contacto. Necesita un servidor local contra dev con las
// llaves de PRUEBA públicas de Cloudflare (siempre pasan):
//
//   NEXT_PUBLIC_CAPTCHA_TURNSTILE=1 NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA \
//   TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA NEXT_DIST_DIR=.next-captcha npx next dev -p 3047
//   node scripts/dev/probar-para-clubes-captcha.mjs [--base=http://localhost:3047]
//
// Usa una IP de documentación (192.0.2.x) en x-forwarded-for para no gastar
// el límite de la IP real. Borra lo que crea y deja la bandera APAGADA.
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const BASE = arg("base", "http://localhost:3047").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("--base debe ser un servidor local contra dev");
const PREFIJO = "t_n4_landing_";
const marca = Math.random().toString(36).slice(2, 8);
const IP = `192.0.2.${10 + Math.floor(Math.random() * 200)}`;

const db = await conectarDevEscritura();
const [{ inicio }] = await db.q("select now() as inicio");
const resultados = [];
const nota = (t, ok, d = "") => {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`);
};
const cuerpo = (n, extra = {}) => ({
  p_nombre: "Prueba Captcha",
  p_club: `${PREFIJO}Captcha ${marca}`,
  p_ciudad: "Monterrey",
  p_correo: `${PREFIJO}${marca}_${n}@example.com`,
  p_telefono: null,
  p_mensaje: null,
  p_sitio_web: null,
  ...extra,
});
async function post(datos) {
  const r = await fetch(BASE + "/api/para-clubes/contacto", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": IP },
    body: JSON.stringify(datos),
  });
  return { estado: r.status, j: await r.json().catch(() => ({})) };
}

try {
  await db.q(`update public.plataforma_banderas set activa = true where clave = 'para_clubes'`);
  let r = await post(cuerpo(1));
  nota("sin token (Cloudflare responde): se rechaza con «Marca la casilla…»", r.estado === 400 && /Marca la casilla/.test(r.j.error ?? ""), `${r.estado} ${r.j.error ?? ""}`);
  r = await post({ ...cuerpo(2), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  nota("con token válido (llave de prueba): «ok»", r.estado === 200 && r.j.ok === true, `${r.estado} ${r.j.error ?? ""}`);
  const [h] = await db.q(`select i.ip_hash = public.contacto_huella('ip:' || $2) as misma
                            from public.contacto_intentos i
                           where i.correo_hash = public.contacto_huella('correo:' || $1)`, [cuerpo(2).p_correo, IP]);
  nota("la base cuenta la IP de quien llama (la manda la ruta), no la del servidor", h?.misma === true, JSON.stringify(h ?? {}));
  r = await post({ ...cuerpo(3, { p_correo: "malo" }), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  nota("aviso de la base (correo mal escrito) llega tal cual", r.estado === 400 && /Revisa tu correo/.test(r.j.error ?? ""), `${r.estado} ${r.j.error ?? ""}`);
  r = await post({ ...cuerpo(4, { p_sitio_web: "http://bot" }), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  const [{ n: trampa }] = await db.q(`select count(*)::int as n from public.contactos_clubes where correo = $1`, [cuerpo(4).p_correo]);
  nota("casilla trampa por la ruta: responde ok y no guarda", r.estado === 200 && trampa === 0, `${r.estado} filas=${trampa}`);
  // CAPTCHA exigido en la base: la ruta sigue funcionando y la llamada directa
  // con la llave pública (sin token) se rechaza.
  await db.q(`update public.plataforma_banderas set activa = true where clave = 'contacto_requiere_captcha'`);
  const directo = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/para_clubes_contacto_enviar`, {
    method: "POST",
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(cuerpo(8)),
  });
  const dj = await directo.json().catch(() => ({}));
  nota("CAPTCHA exigido: la llamada directa a la base con la llave pública se rechaza", !directo.ok && /verificación anti-robots/.test(dj.message ?? ""), `${directo.status} ${dj.message ?? ""}`);
  r = await post({ ...cuerpo(5), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  nota("CAPTCHA exigido: por la ruta (con token) sí pasa (2º de la hora: la trampa no contó)", r.estado === 200, `${r.estado} ${r.j.error ?? ""}`);
  r = await post({ ...cuerpo(6), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  nota("3º desde la misma IP en la hora: pasa", r.estado === 200, `${r.estado} ${r.j.error ?? ""}`);
  r = await post({ ...cuerpo(9), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  await db.q(`update public.plataforma_banderas set activa = false where clave = 'contacto_requiere_captcha'`);
  nota("el 4º desde la misma IP se rechaza con el aviso neutro", r.estado === 400 && /Ya recibimos varios mensajes/.test(r.j.error ?? ""), `${r.estado} ${r.j.error ?? ""}`);
  await db.q(`update public.plataforma_banderas set activa = false where clave = 'para_clubes'`);
  r = await post({ ...cuerpo(7), captchaToken: "XXXX.DUMMY.TOKEN.XXXX" });
  nota("bandera apagada: la ruta devuelve el aviso de la base", r.estado === 400 && /no está disponible/.test(r.j.error ?? ""), `${r.estado} ${r.j.error ?? ""}`);
  const p = await fetch(BASE + "/para-clubes");
  nota("bandera apagada: /para-clubes 404 también con CAPTCHA", p.status === 404, String(p.status));
} finally {
  await db.q(`update public.plataforma_banderas set activa = false`);
  await db.q(`delete from public.contactos_clubes where correo like $1`, [`${PREFIJO}%`]);
  await db.q(`delete from public.contacto_intentos where ip_hash = public.contacto_huella('ip:' || $1)`, [IP]);
  await db.q(`delete from public.para_clubes_bitacora where hecho_en >= $1`, [inicio]);
  const [{ quedan }] = await db.q(`select count(*)::int as quedan from public.contactos_clubes where correo like $1`, [`${PREFIJO}%`]);
  nota("limpieza: 0 contactos de prueba, sin intentos de la IP de prueba y la bandera apagada", quedan === 0, `quedan ${quedan}`);
  await db.fin();
}
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} pasan`);
process.exit(ok === resultados.length ? 0 : 1);
