import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// Esta ruta crea cuentas con la service role key, así que antes de tocar
// nada verifica QUIÉN llama (sesión por cookie) y si tiene permiso para
// crear ese rol en ese club. Sin esto, cualquiera con la URL podía darse de
// alta staff, gerente o RP en el club que quisiera.
//
// Matriz de permisos:
//   admin           -> staff | gerente | rp, en cualquier club
//   dueno           -> staff | gerente | rp, solo en clubes que le pertenecen
//   staff, gerente  -> rp, solo en su propio club
//   resto / anónimo -> 403

const supabaseAdmin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const ROLES_CREABLES = ["staff", "gerente", "rp"] as const;
type RolCreable = (typeof ROLES_CREABLES)[number];

const ROLES_PERMITIDOS_POR_ROL: Record<string, readonly RolCreable[]> = {
  admin: ROLES_CREABLES,
  dueno: ROLES_CREABLES,
  staff: ["rp"],
  gerente: ["rp"],
};

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

    // 2) Su rol y club, leídos en el servidor (nunca desde el body).
    const { data: quienLlama, error: callerError } = await supabaseAdmin
      .from("profiles")
      .select("role, club_id")
      .eq("id", user.id)
      .maybeSingle();

    if (callerError || !quienLlama) {
      return NextResponse.json(
        { error: "No pudimos verificar tu cuenta." },
        { status: 403 },
      );
    }

    const { email, password, nombre, role, club_id } = await request.json();

    if (!email || !password || !nombre || !role || !club_id) {
      return NextResponse.json(
        { error: "Faltan campos requeridos." },
        { status: 400 },
      );
    }
    if (!ROLES_CREABLES.includes(role)) {
      return NextResponse.json(
        { error: "El rol debe ser 'staff', 'gerente' o 'rp'." },
        { status: 400 },
      );
    }

    // 3) ¿Su rol puede crear ESE rol?
    const rolesPermitidos = ROLES_PERMITIDOS_POR_ROL[quienLlama.role];
    if (!rolesPermitidos) {
      return NextResponse.json(
        { error: "Tu cuenta no puede crear usuarios." },
        { status: 403 },
      );
    }
    if (!rolesPermitidos.includes(role)) {
      return NextResponse.json(
        { error: `Tu cuenta no puede crear usuarios con el rol '${role}'.` },
        { status: 403 },
      );
    }

    // 4) ¿Puede crearlo en ESE club?
    if (quienLlama.role === "dueno") {
      // El dueño que se auto-registra no guarda club_id en su perfil: el
      // vínculo vive en clubs.dueno_id, así que se valida por ahí.
      const { data: club } = await supabaseAdmin
        .from("clubs")
        .select("id")
        .eq("id", club_id)
        .eq("dueno_id", user.id)
        .maybeSingle();

      if (!club) {
        return NextResponse.json(
          { error: "Solo puedes crear cuentas en tu propio antro." },
          { status: 403 },
        );
      }
    } else if (quienLlama.role === "staff" || quienLlama.role === "gerente") {
      if (!quienLlama.club_id || quienLlama.club_id !== club_id) {
        return NextResponse.json(
          { error: "Solo puedes crear cuentas en tu propio antro." },
          { status: 403 },
        );
      }
    } else if (quienLlama.role === "admin") {
      // Admin puede en cualquier club, pero el club debe existir: si no, se
      // crearía un perfil colgando de un club_id inventado.
      const { data: club } = await supabaseAdmin
        .from("clubs")
        .select("id")
        .eq("id", club_id)
        .maybeSingle();

      if (!club) {
        return NextResponse.json(
          { error: "El antro indicado no existe." },
          { status: 400 },
        );
      }
    }

    // 5) Autorizado: ahora sí, crear con el service role.
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
      // Si el perfil no se pudo crear, no dejamos la cuenta de auth huérfana.
      await supabaseAdmin.auth.admin.deleteUser(userData.user.id);
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
