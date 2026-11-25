// Alertas por correo al admin (picos de errores, cobros fallidos), detrás
// de una bandera APAGADA por defecto. Se generan solo con:
//   ALERTAS_CORREO=1
//   ALERTAS_PARA=<correo del admin>
// y salen por el punto único de correos (lib/correo.ts): con CORREO_MODO
// "archivo" (por defecto) se quedan en /admin/correos sin mandarse; para
// que lleguen hace falta además CORREO_MODO=enviar, RESEND_API_KEY y
// CORREO_DE (o ALERTAS_DE), y solo en producción. Pasos: docs/operacion.md.
//
// Cada tipo de alerta sale como máximo una vez por hora (alertas_enviadas),
// y una falla al mandar nunca rompe lo que la provocó. Los correos no llevan
// datos personales: solo conteos, rutas y el nombre del antro.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enviarCorreo } from "@/lib/correo";
import { registrarError } from "@/lib/log";

const UNA_HORA_MS = 3_600_000;

export function alertasActivas(): boolean {
  return process.env.ALERTAS_CORREO === "1" && !!process.env.ALERTAS_PARA;
}

export async function enviarAlerta(
  svc: SupabaseClient,
  tipo: string,
  asunto: string,
  texto: string,
  clubId?: string | null,
): Promise<"enviada" | "archivada" | "omitida" | "fallo"> {
  if (!alertasActivas()) return "omitida";
  try {
    // Una por tipo por hora: se reserva el turno insertando; si ya hay una
    // reciente, no se manda.
    const { data: reciente } = await svc
      .from("alertas_enviadas")
      .select("id")
      .eq("tipo", tipo)
      .gte("enviado_en", new Date(Date.now() - UNA_HORA_MS).toISOString())
      .limit(1);
    if (reciente?.length) return "omitida";
    const ins = await svc.from("alertas_enviadas").insert({ tipo });
    if (ins.error) return "omitida";

    const r = await enviarCorreo(svc, {
      plantilla: `alerta:${tipo.split(":")[0]}`,
      para: process.env.ALERTAS_PARA ?? "",
      asunto: `[AntroApp] ${asunto}`,
      texto,
      clubId,
    });
    if (r.estado === "enviado") return "enviada";
    if (r.estado === "archivado") return "archivada";
    if (r.estado === "apagado") return "omitida";
    return "fallo";
  } catch (e) {
    registrarError("alertas: envío", e);
    return "fallo";
  }
}

// ¿Hay un pico de errores? 10 o más avisos de error en 10 minutos.
export const PICO_ERRORES = 10;
export async function revisarPicoErrores(svc: SupabaseClient): Promise<void> {
  if (!alertasActivas()) return;
  const desde = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, count } = await svc.from("app_errores").select("ruta", { count: "exact" }).gte("creado_en", desde).limit(200);
  if ((count ?? 0) < PICO_ERRORES) return;
  const porRuta = new Map<string, number>();
  for (const f of data ?? []) porRuta.set(f.ruta ?? "(sin ruta)", (porRuta.get(f.ruta ?? "(sin ruta)") ?? 0) + 1);
  const rutas = [...porRuta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `  ${n} × ${r}`).join("\n");
  await enviarAlerta(
    svc,
    "pico_errores",
    `${count} errores en 10 minutos`,
    `La app registró ${count} errores en los últimos 10 minutos.\n\nRutas con más errores:\n${rutas}\n\nRevisa /admin → «Errores recientes» y los logs de Vercel (docs/operacion.md, «Si algo se cae»).`,
  );
}
