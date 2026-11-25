import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { modoCorreoActual } from "@/lib/correo";

// GET: en qué modo están los correos de la app (archivo, enviar o apagado),
// el entorno y si hay llave/remitente/lista blanca, SIN valores secretos.
// Solo el admin (rol y estado leídos de la base; con contraseña temporal no).
// La bandeja misma se lee desde el navegador con RLS (solo admin).

const SIN_CACHE = { "Cache-Control": "no-store" };

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Necesitas iniciar sesión." }, { status: 401, headers: SIN_CACHE });
  if (user.app_metadata?.debe_cambiar === true) {
    return NextResponse.json({ error: "Primero cambia tu contraseña." }, { status: 403, headers: SIN_CACHE });
  }
  const { data: perfil } = await clienteServicio().from("profiles").select("role, activo").eq("id", user.id).maybeSingle();
  if (perfil?.role !== "admin" || perfil.activo === false) {
    return NextResponse.json({ error: "Solo el admin puede ver los correos." }, { status: 403, headers: SIN_CACHE });
  }
  return NextResponse.json(modoCorreoActual(), { headers: SIN_CACHE });
}
