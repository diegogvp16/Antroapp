// CAPTCHA (Cloudflare Turnstile) detrás de una bandera, APAGADA por defecto.
//
// Se enciende solo si en Vercel están las tres variables:
//   NEXT_PUBLIC_CAPTCHA_TURNSTILE=1
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY=<llave pública del sitio>
//   TURNSTILE_SECRET_KEY=<llave secreta>          (solo servidor)
// Con la bandera apagada (o sin llave del sitio) la app se comporta
// exactamente como antes: no se carga nada de Cloudflare ni se pide token.
//
// NEXT_PUBLIC_CAPTCHA_MODO:
//   "app" (por defecto): nuestro servidor verifica el token con Cloudflare.
//          Si Cloudflare no responde, deja pasar con límites más estrictos
//          (falla segura: nadie se queda sin entrar por una caída ajena).
//   "supabase": el token se le pasa a Supabase Auth, que lo verifica (hay
//          que activar CAPTCHA en el panel de Supabase con la misma llave
//          secreta). Cubre también a quien llame a Supabase directo, pero si
//          Cloudflare cae nadie entra: ver docs/captcha.md.
// Pasos para crear las llaves y encenderlo: docs/captcha.md.

export type ModoCaptcha = "app" | "supabase";

export function captchaActivo(): boolean {
  return process.env.NEXT_PUBLIC_CAPTCHA_TURNSTILE === "1" && !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
}

export function llaveSitioTurnstile(): string {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
}

export function modoCaptcha(): ModoCaptcha {
  return process.env.NEXT_PUBLIC_CAPTCHA_MODO === "supabase" ? "supabase" : "app";
}
