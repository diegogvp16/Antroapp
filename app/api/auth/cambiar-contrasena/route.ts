import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";

// Primer inicio de una cuenta creada con contraseña temporal (alta de antros:
// app_metadata.debe_cambiar). Cambia la contraseña y quita la marca en un
// solo paso, con la API de administración, para que la marca solo se quite
// si la contraseña de verdad cambió. Solo para quien tiene la sesión abierta
// y la marca puesta.

const MINIMO = 8;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Tu sesión venció. Vuelve a iniciar sesión." }, { status: 401 });
  if (user.app_metadata?.debe_cambiar !== true) {
    return NextResponse.json({ error: "Tu contraseña ya está actualizada." }, { status: 409 });
  }

  let nueva = "";
  try {
    const c: unknown = await request.json();
    if (typeof c === "object" && c !== null && typeof (c as { nueva?: unknown }).nueva === "string") nueva = (c as { nueva: string }).nueva;
  } catch {
    // cuerpo inválido: se trata como vacío
  }
  if (nueva.length < MINIMO || nueva.length > 200) {
    return NextResponse.json({ error: `La contraseña debe tener al menos ${MINIMO} caracteres.` }, { status: 400 });
  }

  const admin = clienteServicio();
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password: nueva,
    app_metadata: { ...user.app_metadata, debe_cambiar: false },
  });
  if (error) {
    const debil = error.code === "weak_password" || /password/i.test(error.message);
    console.error("cambiar-contrasena:", error.code ?? error.status);
    return NextResponse.json(
      { error: debil ? "Esa contraseña es muy común o muy corta. Elige otra." : "No pudimos cambiar tu contraseña. Intenta de nuevo." },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
