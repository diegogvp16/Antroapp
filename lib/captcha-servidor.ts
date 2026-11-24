// Verificación del token de Turnstile en el servidor (modo "app").
// Solo para rutas de servidor: usa TURNSTILE_SECRET_KEY.
import "server-only";
import { interpretarSiteverify, type ResultadoCaptcha } from "@/lib/domain/captcha";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIEMPO_MAXIMO_MS = 4000;

// Sin token: ¿es porque Cloudflare no responde (falla de ellos → modo
// degradado) o porque quien llama no lo mandó (bot → se rechaza)? Lo decide
// el servidor preguntándole a Cloudflare, no el que llama.
async function cloudflareResponde(secreto: string): Promise<boolean> {
  try {
    const r = await fetch(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret: secreto, response: "sin-token" }),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function verificarTurnstile(token: unknown, ip: string): Promise<ResultadoCaptcha> {
  const secreto = process.env.TURNSTILE_SECRET_KEY;
  if (typeof token !== "string" || !token || token.length > 2048) {
    if (!secreto) return "sin_servicio";
    return (await cloudflareResponde(secreto)) ? "sin_token" : "sin_servicio";
  }
  if (!secreto) {
    console.error("captcha: falta TURNSTILE_SECRET_KEY (modo degradado)");
    return "sin_servicio";
  }
  try {
    const cuerpo = new URLSearchParams({ secret: secreto, response: token });
    if (ip && ip !== "desconocida") cuerpo.set("remoteip", ip);
    const r = await fetch(SITEVERIFY, { method: "POST", body: cuerpo, signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS), cache: "no-store" });
    if (!r.ok) {
      console.error("captcha: siteverify respondió", r.status);
      return "sin_servicio";
    }
    const resultado = interpretarSiteverify(await r.json());
    if (resultado === "sin_servicio") console.error("captcha: error de configuración en siteverify");
    return resultado;
  } catch {
    console.error("captcha: sin respuesta de siteverify (modo degradado)");
    return "sin_servicio";
  }
}
