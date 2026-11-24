// Qué hacer con el resultado de verificar el CAPTCHA (reglas puras, sin red).
//
//   valido        → sigue normal.
//   invalido      → se rechaza (token falso, vencido o ya usado).
//   sin_token     → no llegó token y Cloudflare SÍ responde (lo comprueba
//                   el servidor): un bot que no lo manda, o un bloqueador en
//                   el navegador. Se rechaza con un mensaje claro.
//   sin_servicio  → nuestro servidor no pudo hablar con Cloudflare (caído o
//                   lento): se deja pasar en MODO DEGRADADO, con límites de
//                   intentos más estrictos.
// Así una caída de Cloudflare nunca deja a nadie fuera del login, y quien
// llama no puede elegir el modo degradado solo con no mandar el token.

export type ResultadoCaptcha = "valido" | "invalido" | "sin_token" | "sin_servicio";

export type DecisionCaptcha =
  | { permitir: true; degradado: boolean }
  | { permitir: false; error: string };

export const MENSAJE_CAPTCHA_INVALIDO = "No pudimos confirmar que eres una persona. Vuelve a marcar la casilla e intenta de nuevo.";
export const MENSAJE_CAPTCHA_FALTA = "Marca la casilla de verificación y vuelve a intentar. Si no aparece, desactiva el bloqueador de anuncios o recarga la página.";

export function decidirCaptcha(resultado: ResultadoCaptcha): DecisionCaptcha {
  switch (resultado) {
    case "valido":
      return { permitir: true, degradado: false };
    case "invalido":
      return { permitir: false, error: MENSAJE_CAPTCHA_INVALIDO };
    case "sin_token":
      return { permitir: false, error: MENSAJE_CAPTCHA_FALTA };
    default:
      return { permitir: true, degradado: true };
  }
}

// Respuesta de https://challenges.cloudflare.com/turnstile/v0/siteverify.
// Errores de NUESTRA configuración (llave secreta mala) cuentan como
// "sin_servicio" para no dejar a todos fuera por un error de configuración;
// se registran para corregirlos.
export function interpretarSiteverify(cuerpo: unknown): ResultadoCaptcha {
  if (typeof cuerpo !== "object" || cuerpo === null) return "sin_servicio";
  const c = cuerpo as { success?: unknown; "error-codes"?: unknown };
  if (c.success === true) return "valido";
  const codigos = Array.isArray(c["error-codes"]) ? c["error-codes"].map(String) : [];
  if (codigos.some((x) => x === "missing-input-secret" || x === "invalid-input-secret" || x === "internal-error")) {
    return "sin_servicio";
  }
  return "invalido";
}

// Límites del modo degradado (sin CAPTCHA verificado), más estrictos que los
// normales de lib/domain/login.ts y de registro.
export const DEGRADADO_MAX_FALLOS_POR_CORREO_E_IP = 3;
export const DEGRADADO_MAX_FALLOS_POR_IP = 8;
export const REGISTROS_POR_IP_HORA = 5;
export const DEGRADADO_REGISTROS_POR_IP_HORA = 2;
