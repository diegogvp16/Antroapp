import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { registrarError } from "@/lib/log";
import { esquemaReemitirLote, type ResultadoImportarPersonal } from "@/lib/domain/importar-personal";
import { emitirYEnviarLote } from "../enviar-lote";

// «Volver a sacar los enlaces» de un lote (sql/post-junta-2/24): para cuando
// la respuesta del lote se perdió (mala señal) o fallaron los tokens.
//
//   1. Con la SESIÓN de quien llama, invitaciones_reemitir_lote decide si
//      puede (solo quien importó, con permiso todavía, dentro de 24 h, hasta
//      3 veces por lote, dentro de los cupos) y limpia el token de las
//      pendientes del lote: los enlaces anteriores dejan de servir.
//   2. Con la service role, se emiten y se mandan otra vez (enviar-lote.ts).
//   El antro y el rol salen del lote en la base; del cuerpo solo la clave.

export const maxDuration = 60;

const NO_CACHE = { "Cache-Control": "no-store" };
const responder = (cuerpo: object, status = 200) => NextResponse.json(cuerpo, { status, headers: NO_CACHE });

export async function POST(request: Request) {
  const inicio = Date.now();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return responder({ error: "Necesitas iniciar sesión." }, 401);
    if (user.app_metadata?.debe_cambiar === true) {
      return responder({ error: "Primero cambia tu contraseña temporal." }, 403);
    }

    let cuerpo: unknown;
    try {
      cuerpo = await request.json();
    } catch {
      return responder({ error: "Datos inválidos." }, 400);
    }
    const r = esquemaReemitirLote.safeParse(cuerpo);
    if (!r.success) return responder({ error: r.error.issues[0]?.message ?? "Revisa los datos." }, 400);
    const loteId = r.data.lote_id;

    const re = await supabase.rpc("invitaciones_reemitir_lote", { p_lote_id: loteId });
    if (re.error) {
      if (re.error.code === "P0001") return responder({ error: re.error.message }, 403);
      registrarError("reemitir lote: base", re.error);
      return responder({ error: "No se pudieron preparar los enlaces. Intenta de nuevo." }, 500);
    }

    const svc = clienteServicio();
    const { data: lote } = await svc.from("invitacion_lotes").select("club_id, total").eq("id", loteId).maybeSingle();
    if (!lote) {
      registrarError("reemitir lote: leer", { code: "sin_lote" });
      return responder({ error: "No se pudieron preparar los enlaces. Intenta de nuevo." }, 500);
    }
    const envio = await emitirYEnviarLote({
      svc,
      loteId,
      clubId: lote.club_id,
      quienId: user.id,
      origen: new URL(request.url).origin,
      inicio,
    });
    if (!envio) {
      return responder({ error: "No se pudieron preparar los enlaces. Intenta de nuevo en unos minutos." }, 500);
    }
    const salida: ResultadoImportarPersonal = { ok: true, lote_id: loteId, creadas: lote.total, repetido: false, reemitido: true, ...envio };
    return responder(salida);
  } catch (e) {
    registrarError("reemitir lote: inesperado", e);
    return responder({ error: "Error inesperado del servidor." }, 500);
  }
}
