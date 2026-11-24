// Cliente de Stripe para el servidor. Por seguridad SOLO acepta llaves de
// prueba (sk_test_ / rk_test_); una llave de producción (sk_live_) se rechaza
// salvo que STRIPE_PERMITIR_PRODUCCION=1 esté puesta a propósito en Vercel
// (paso final de docs/stripe-mensualidad.md).
import "server-only";
import Stripe from "stripe";
import { mensualidadActiva } from "@/lib/mensualidad/bandera";

export type EstadoStripe = { ok: true; stripe: Stripe; produccion: boolean } | { ok: false; motivo: string };

export function stripeServidor(): EstadoStripe {
  if (!mensualidadActiva()) return { ok: false, motivo: "La mensualidad no está activada." };
  const llave = process.env.STRIPE_SECRET_KEY ?? "";
  if (!llave) return { ok: false, motivo: "Falta STRIPE_SECRET_KEY." };
  const produccion = /^(sk|rk)_live_/.test(llave);
  if (produccion && process.env.STRIPE_PERMITIR_PRODUCCION !== "1") {
    return { ok: false, motivo: "Llave de producción de Stripe sin STRIPE_PERMITIR_PRODUCCION=1." };
  }
  if (!produccion && !/^(sk|rk)_test_/.test(llave)) return { ok: false, motivo: "STRIPE_SECRET_KEY no parece una llave de Stripe." };
  return { ok: true, stripe: new Stripe(llave, { maxNetworkRetries: 2, timeout: 15_000 }), produccion };
}

// Para verificar firmas no hace falta una llave válida: solo el secreto del webhook.
export function verificadorWebhook(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_sin_llave");
}

// ¿Se aceptan eventos de producción (livemode)? Solo con el permiso explícito.
export function aceptaEventosProduccion(): boolean {
  return process.env.STRIPE_PERMITIR_PRODUCCION === "1";
}
