// Punto ÚNICO de envío de correos de la app (solo servidor). Todo correo
// propio pasa por aquí y deja su fila en la bandeja (correos_salida), que el
// admin revisa en /admin/correos. Reglas y modos: lib/domain/correo.ts.
//
// Variables (Vercel → Environment Variables):
//   CORREO_MODO          archivo (por defecto) | enviar | apagado
//   CORREO_DE            remitente verificado en Resend (o ALERTAS_DE)
//   RESEND_API_KEY       llave de Resend (Sensitive)
//   CORREO_LISTA_BLANCA  correos a los que SÍ se manda fuera de producción
//                        (separados por coma); los demás solo se archivan.
//
// NO pasan por aquí los correos de Supabase Auth (recuperar contraseña,
// confirmar registro): esos los manda Supabase con su propio SMTP.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registrarError } from "@/lib/log";
import { leerConfigCorreo, procesarCorreo, resumenModo, type DatosCorreo, type ResultadoCorreo } from "@/lib/domain/correo";

export function configCorreo() {
  return leerConfigCorreo(process.env);
}

export function modoCorreoActual() {
  return resumenModo(configCorreo());
}

export function enviarCorreo(svc: SupabaseClient, datos: DatosCorreo): Promise<ResultadoCorreo> {
  return procesarCorreo({ svc, cfg: configCorreo(), fetch, registrarError }, datos);
}

// Borra de la bandeja lo de más de `dias` días. Nunca lanza.
export async function purgarCorreos(svc: SupabaseClient, dias = 30): Promise<number | null> {
  try {
    const { data, error } = await svc.rpc("correos_purgar", { p_dias: dias });
    if (error) {
      registrarError("correo: purga", error);
      return null;
    }
    return typeof data === "number" ? data : null;
  } catch (e) {
    registrarError("correo: purga", e);
    return null;
  }
}
