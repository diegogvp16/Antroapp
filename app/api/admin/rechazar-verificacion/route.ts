import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { BUCKET_VERIFICACION, validarMotivoRechazo } from "@/lib/verificacion";

// Rechaza la verificación de un antro. Usa la service role key porque tiene
// que borrar archivos del bucket privado y filas de verificacion_documentos
// que ni el admin puede borrar desde el navegador. Por eso, antes de tocar
// nada, verifica QUIÉN llama (sesión por cookie) y que sea admin:
//   sin sesión -> 401;  sesión que no es admin -> 403.
//
// Al rechazar se borran los documentos (archivos y filas) para que el dueño
// tenga que subir documentos nuevos y no pueda reenviar los mismos.

const supabaseAdmin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    // 1) ¿Quién llama? La sesión viaja en la cookie del navegador.
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "Necesitas iniciar sesión." },
        { status: 401 },
      );
    }

    // 2) Su rol, leído en el servidor (nunca desde el body).
    const { data: quienLlama, error: callerError } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (callerError || !quienLlama || quienLlama.role !== "admin") {
      return NextResponse.json(
        { error: "Solo AntroApp puede rechazar una verificación." },
        { status: 403 },
      );
    }

    // 3) Validar la entrada.
    const body: unknown = await request.json().catch(() => null);
    const clubId =
      body && typeof body === "object" && "club_id" in body
        ? body.club_id
        : null;
    const motivo =
      body && typeof body === "object" && "motivo" in body ? body.motivo : null;

    if (typeof clubId !== "string" || !UUID.test(clubId)) {
      return NextResponse.json(
        { error: "Antro inválido." },
        { status: 400 },
      );
    }
    if (typeof motivo !== "string") {
      return NextResponse.json(
        { error: "Escribe el motivo del rechazo." },
        { status: 400 },
      );
    }
    const problemaMotivo = validarMotivoRechazo(motivo);
    if (problemaMotivo) {
      return NextResponse.json({ error: problemaMotivo }, { status: 400 });
    }

    // 4) Solo se rechaza lo que está en revisión.
    const { data: club, error: clubError } = await supabaseAdmin
      .from("clubs")
      .select("id, estado_verificacion")
      .eq("id", clubId)
      .maybeSingle();

    if (clubError) throw clubError;
    if (!club) {
      return NextResponse.json(
        { error: "El antro no existe." },
        { status: 404 },
      );
    }
    if (club.estado_verificacion !== "en_revision") {
      return NextResponse.json(
        { error: "Este antro ya no está en revisión." },
        { status: 409 },
      );
    }

    // 5) Borrar los documentos: primero los archivos de la carpeta del club
    // (incluye los que hubieran quedado sin fila), luego las filas. Si algo
    // falla aquí, el antro sigue en revisión y el admin puede reintentar.
    const { data: archivos, error: listError } = await supabaseAdmin.storage
      .from(BUCKET_VERIFICACION)
      .list(clubId, { limit: 1000 });
    if (listError) throw listError;

    const rutas = (archivos ?? []).map((a) => `${clubId}/${a.name}`);
    if (rutas.length > 0) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(BUCKET_VERIFICACION)
        .remove(rutas);
      if (removeError) throw removeError;
    }

    const { error: docsError } = await supabaseAdmin
      .from("verificacion_documentos")
      .delete()
      .eq("club_id", clubId);
    if (docsError) throw docsError;

    // 6) Marcar rechazado con el motivo que verá el dueño.
    const { error: updateError } = await supabaseAdmin
      .from("clubs")
      .update({
        estado_verificacion: "rechazado",
        motivo_rechazo: motivo.trim(),
        verificado_en: null,
      })
      .eq("id", clubId);
    if (updateError) throw updateError;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Error en /api/admin/rechazar-verificacion:", err);
    return NextResponse.json(
      { error: "Error inesperado del servidor." },
      { status: 500 },
    );
  }
}
