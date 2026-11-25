import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { enviarCorreo } from "@/lib/correo";
import { registrarError } from "@/lib/log";
import {
  avisoEnvio,
  enlaceInvitacion,
  esquemaInvitar,
  textoCorreoInvitacion,
  urlPublica,
  type RolInvitable,
} from "@/lib/domain/invitaciones";

// Invitar (o reenviar la invitación) a staff, gerentes y RPs por correo.
//
// Quién puede invitar qué rol en qué antro lo decide la BASE: esta ruta
// llama invitacion_crear / invitacion_reenviar con la SESIÓN de quien llama
// (cookie), no con la service role. Una cuenta sin perfil, dada de baja o
// con contraseña temporal no tiene rol en la base y no pasa. El club del
// cuerpo solo dice a dónde; el rol y el club quedan fijos en la invitación.
//
// Luego, con la service role, se emite el token (la base guarda solo su
// hash) y el correo sale por lib/correo.ts. El enlace va en `ocultar`: si el
// correo se manda, en la bandeja queda "[oculto]"; si solo se archiva (sin
// SMTP todavía), queda completo para que el admin lo haga llegar.

const NO_CACHE = { "Cache-Control": "no-store" };
const responder = (cuerpo: object, status = 200) => NextResponse.json(cuerpo, { status, headers: NO_CACHE });

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return responder({ error: "Necesitas iniciar sesión." }, 401);

    let cuerpo: unknown;
    try {
      cuerpo = await request.json();
    } catch {
      return responder({ error: "Datos inválidos." }, 400);
    }
    const r = esquemaInvitar.safeParse(cuerpo);
    if (!r.success) return responder({ error: r.error.issues[0]?.message ?? "Revisa los datos." }, 400);
    const d = r.data;

    // 1) La base autoriza y registra (con la sesión de quien llama).
    const paso =
      d.accion === "crear"
        ? await supabase.rpc("invitacion_crear", { p_club_id: d.club_id, p_rol: d.rol, p_correo: d.correo, p_nombre: d.nombre })
        : await supabase.rpc("invitacion_reenviar", { p_id: d.id });
    if (paso.error || typeof paso.data !== "string") {
      if (paso.error?.code === "P0001") return responder({ error: paso.error.message }, 403);
      registrarError("invitar: base", paso.error);
      return responder({ error: "No se pudo guardar la invitación. Intenta de nuevo." }, 500);
    }
    const id: string = paso.data;

    // 2) Token (solo el servidor lo ve) y datos para el correo.
    const svc = clienteServicio();
    const tok = await svc.rpc("invitacion_emitir_token", { p_id: id });
    if (tok.error || typeof tok.data !== "string") {
      registrarError("invitar: token", tok.error);
      return responder({ error: "La invitación se guardó, pero no se pudo preparar el enlace. Usa «Reenviar» en unos minutos." }, 500);
    }
    const token: string = tok.data;
    const { data: inv } = await svc.from("invitaciones").select("correo, nombre, rol, club_id, expira_en").eq("id", id).single();
    const [{ data: club }, { data: quien }] = await Promise.all([
      svc.from("clubs").select("nombre").eq("id", inv?.club_id ?? "").maybeSingle(),
      svc.from("profiles").select("nombre").eq("id", user.id).maybeSingle(),
    ]);
    if (!inv) {
      registrarError("invitar: leer", { code: "sin_fila" });
      return responder({ error: "No se pudo preparar el correo. Usa «Reenviar» en unos minutos." }, 500);
    }

    // 3) Correo por el punto único (lib/correo.ts).
    const enlace = enlaceInvitacion(urlPublica(process.env, new URL(request.url).origin), token);
    const correo = textoCorreoInvitacion({
      nombre: inv.nombre,
      rol: inv.rol as RolInvitable,
      club: club?.nombre ?? "tu antro",
      invita: quien?.nombre ?? null,
      enlace,
      expiraEn: inv.expira_en,
    });
    const envio = await enviarCorreo(svc, {
      plantilla: d.accion === "crear" ? "invitacion" : "invitacion:reenvio",
      para: inv.correo,
      asunto: correo.asunto,
      texto: correo.texto,
      clubId: inv.club_id,
      ocultar: [enlace, token],
      mostrarSiSeArchiva: true,
    });

    return responder({ ok: true, id, correo: envio.estado, aviso: avisoEnvio(envio.estado, d.accion === "reenviar") });
  } catch (e) {
    registrarError("invitar: inesperado", e);
    return responder({ error: "Error inesperado del servidor." }, 500);
  }
}
