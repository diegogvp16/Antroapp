import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// NOTA DE SEGURIDAD: esta ruta hoy NO verifica que quien la llama sea
// realmente un admin autenticado (no revisa sesión ni rol del caller).
// Cualquiera que conozca esta URL podría crear cuentas de staff/gerente.
// Es deuda técnica pendiente para la fase de seguridad/RLS final — no se
// resuelve en esta tarea, solo queda documentada aquí.

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export async function POST(request: Request) {
  try {
    const { email, password, nombre, role, club_id } = await request.json();

    if (!email || !password || !nombre || !role || !club_id) {
      return NextResponse.json(
        { error: "Faltan campos requeridos." },
        { status: 400 },
      );
    }
    if (role !== "staff" && role !== "gerente" && role !== "rp") {
      return NextResponse.json(
        { error: "El rol debe ser 'staff', 'gerente' o 'rp'." },
        { status: 400 },
      );
    }

    const { data: userData, error: createUserError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (createUserError || !userData.user) {
      return NextResponse.json(
        { error: createUserError?.message ?? "No se pudo crear el usuario." },
        { status: 400 },
      );
    }

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .insert({
        id: userData.user.id,
        nombre,
        role,
        club_id,
      });

    if (profileError) {
      return NextResponse.json(
        { error: profileError.message },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      profile: { id: userData.user.id, nombre, role, club_id },
    });
  } catch (err) {
    console.error("Error en /api/admin/create-staff:", err);
    return NextResponse.json(
      { error: "Error inesperado del servidor." },
      { status: 500 },
    );
  }
}
