import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { registrarError } from "@/lib/log";
import { esquemaImportarPersonal, revisarFilasPersonal, type ResultadoImportarPersonal } from "@/lib/domain/importar-personal";
import { emitirYEnviarLote } from "./enviar-lote";

// RPs y staff en lote (B1b): una invitación de B12 por cada fila del CSV.
//
//   1. ¿Quién llama? Sesión por cookie. La BASE decide si puede invitar ese
//      rol en ese antro (invitacion_puede, la matriz de create-staff con
//      coalesce): esta ruta llama todo con la sesión de quien importa, no
//      con la service role. Una cuenta sin perfil, dada de baja o con
//      contraseña temporal no tiene rol en la base y no pasa.
//   2. invitaciones_importar: todas las filas en UNA transacción (todo o
//      nada), con la clave de idempotencia lote_id que manda la pantalla, y
//      el lote entero cuenta para los cupos por persona y por antro
//      (sql/post-junta-2/24).
//   3. Con la service role: tokens de todo el lote (la base guarda solo su
//      hash) y un correo por persona por lib/correo.ts (enviar-lote.ts).
//   4. A quien importa se le devuelven, UNA vez y sin caché, los enlaces de
//      las personas cuyo correo NO salió (modo archivo, apagado, falla o sin
//      tiempo), para que se los haga llegar (WhatsApp). No es un permiso
//      nuevo: ese mismo rol ya podía crear esas cuentas con create-staff y
//      una contraseña que él conocía; con el enlace, la persona elige la suya.
//   Si la respuesta se pierde (o fallan los tokens), el reintento responde
//   «repetido» y la pantalla ofrece «Volver a sacar los enlaces»
//   (POST /api/equipo/importar/reemitir).

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
    const r = esquemaImportarPersonal.safeParse(cuerpo);
    if (!r.success) return responder({ error: r.error.issues[0]?.message ?? "Revisa los datos." }, 400);
    const d = r.data;
    const revisadas = revisarFilasPersonal(d.filas);
    if ("error" in revisadas) return responder({ error: revisadas.error }, 400);

    // 1) ¿Puede? (la base, con la sesión de quien llama)
    const puede = await supabase.rpc("invitacion_puede", { p_club_id: d.club_id, p_rol: d.rol });
    if (puede.error) {
      registrarError("importar personal: permiso", puede.error);
      return responder({ error: "No se pudo revisar tu permiso. Intenta de nuevo." }, 500);
    }
    if (puede.data !== true) return responder({ error: "No puedes invitar a alguien con ese rol en este antro." }, 403);

    // 2) Todo o nada, en la base.
    const imp = await supabase.rpc("invitaciones_importar", {
      p_club_id: d.club_id,
      p_rol: d.rol,
      p_lote_id: d.lote_id,
      p_filas: revisadas.filas.map((f) => ({ linea: f.linea, nombre: f.nombre, correo: f.correo, telefono: f.telefono })),
    });
    if (imp.error) {
      if (imp.error.code === "P0001") return responder({ error: imp.error.message }, 400);
      registrarError("importar personal: base", imp.error);
      return responder({ error: "No se pudo importar la lista. No se guardó nada; intenta de nuevo." }, 500);
    }
    const res = imp.data as { creadas: number; repetido: boolean };
    if (res.repetido) {
      // La misma lista ya se había guardado (reintento): los enlaces no se
      // vuelven a dar aquí; la pantalla ofrece «Volver a sacar los enlaces».
      const salida: ResultadoImportarPersonal = {
        ok: true,
        lote_id: d.lote_id,
        creadas: res.creadas,
        repetido: true,
        correos: { enviados: 0, archivados: 0, fallidos: 0, sinIntentar: 0 },
        enlaces: [],
      };
      return responder(salida);
    }

    // 3) Tokens y correos (service role).
    const envio = await emitirYEnviarLote({
      svc: clienteServicio(),
      loteId: d.lote_id,
      clubId: d.club_id,
      quienId: user.id,
      origen: new URL(request.url).origin,
      inicio,
      // En el orden del archivo (todas las del lote tienen la misma hora).
      orden: new Map(revisadas.filas.map((f, i) => [f.correo, i])),
    });
    if (!envio) {
      return responder(
        {
          error: `Se guardaron ${res.creadas} invitaciones, pero no se pudieron preparar los enlaces. Toca «Volver a sacar los enlaces» en unos minutos.`,
          lote_id: d.lote_id,
          guardado: true,
        },
        500,
      );
    }
    const salida: ResultadoImportarPersonal = { ok: true, lote_id: d.lote_id, creadas: res.creadas, repetido: false, ...envio };
    return responder(salida);
  } catch (e) {
    registrarError("importar personal: inesperado", e);
    return responder({ error: "Error inesperado del servidor." }, 500);
  }
}
