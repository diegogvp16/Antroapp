import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { cuentasNuevas, esquemaAltaClub, erroresPorCampo, payloadSql, type CuentaNueva } from "@/lib/domain/alta-club";

// Alta de un antro nuevo con su equipo, desde /admin/alta-antro. SOLO admin.
//
//   1. ¿Quién llama? Sesión por cookie; su rol se lee de la base.
//   2. Valida todo con el mismo esquema que el asistente.
//   3. Crea las cuentas de Auth (no pueden ir dentro de una transacción de
//      Postgres) con contraseñas temporales generadas aquí.
//   4. admin_alta_club() con la sesión del admin: antro, mesas, perfiles,
//      grupo y bitácora en UNA transacción. La función vuelve a exigir admin.
//   5. Si 3 o 4 fallan, borra las cuentas que había creado: no queda nada a
//      medias. Si el proceso muere entre 3 y 4 quedan cuentas de Auth sin
//      perfil (no entran a ningún panel); llevan app_metadata.alta_club
//      para encontrarlas.
//
// Las contraseñas temporales se devuelven UNA vez, para que el admin las
// entregue; no se guardan en ningún lado.

export const maxDuration = 60;

const CONCURRENCIA = 6;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Necesitas iniciar sesión." }, { status: 401 });

  const admin = clienteServicio();
  const { data: perfil } = await admin.from("profiles").select("role, activo").eq("id", user.id).maybeSingle();
  if (perfil?.role !== "admin" || perfil.activo === false) {
    return NextResponse.json({ error: "Solo el admin puede dar de alta antros." }, { status: 403 });
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }
  const r = esquemaAltaClub.safeParse(cuerpo);
  if (!r.success) {
    const campos = erroresPorCampo(r.error);
    return NextResponse.json({ error: Object.values(campos)[0] ?? "Revisa los datos.", campos }, { status: 400 });
  }
  const alta = r.data;

  if (alta.grupo.modo === "existente") {
    const { data: g } = await admin.from("grupos").select("id").eq("id", alta.grupo.grupo_id).maybeSingle();
    if (!g) return NextResponse.json({ error: "El grupo elegido no existe." }, { status: 400 });
  }

  // 3. Cuentas de Auth.
  const cuentas = cuentasNuevas(alta);
  const creadas = new Map<string, string>(); // correo → id
  const credenciales: (CuentaNueva & { password: string })[] = [];
  const borrarCreadas = async () => {
    const ids = [...creadas.values()];
    for (let i = 0; i < ids.length; i += CONCURRENCIA) {
      await Promise.all(ids.slice(i, i + CONCURRENCIA).map((id) => admin.auth.admin.deleteUser(id)));
    }
  };

  for (let i = 0; i < cuentas.length; i += CONCURRENCIA) {
    const tanda = cuentas.slice(i, i + CONCURRENCIA);
    const resultados = await Promise.all(
      tanda.map(async (c) => {
        const password = contrasenaTemporal();
        const res = await admin.auth.admin.createUser({
          email: c.correo,
          password,
          email_confirm: true,
          app_metadata: { alta_club: true },
        });
        if (res.error || !res.data.user) return { c, error: res.error };
        creadas.set(c.correo, res.data.user.id);
        credenciales.push({ ...c, password });
        return { c, error: null };
      }),
    );
    const fallo = resultados.find((x) => x.error);
    if (fallo) {
      await borrarCreadas();
      console.error("alta-club: createUser", fallo.error?.code ?? fallo.error?.message);
      return NextResponse.json({ error: mensajeCuenta(fallo.c.correo, fallo.error) }, { status: 400 });
    }
  }

  // 4. Todo lo de la base, en una transacción, con la sesión del admin.
  const { data, error } = await supabase.rpc("admin_alta_club", { p: payloadSql(alta, creadas) });
  if (error) {
    await borrarCreadas();
    console.error("alta-club: admin_alta_club", error.code);
    const mensaje = error.code === "P0001" ? error.message : "No se pudo dar de alta el antro. No se guardó nada; intenta de nuevo.";
    return NextResponse.json({ error: mensaje }, { status: 400 });
  }

  const orden = new Map(cuentas.map((c, i) => [c.correo, i]));
  credenciales.sort((a, b) => (orden.get(a.correo) ?? 0) - (orden.get(b.correo) ?? 0));
  return NextResponse.json({ ok: true, resultado: data, credenciales });
}

// 14 caracteres legibles: sin 0/O ni 1/l/I, con mayúscula, minúscula y número.
function contrasenaTemporal(): string {
  const letras = "abcdefghijkmnpqrstuvwxyz";
  const todos = letras + letras.toUpperCase().replace(/[IO]/g, "") + "23456789";
  const bytes = randomBytes(14);
  let s = "";
  for (const b of bytes) s += todos[b % todos.length];
  return "Ax" + s.slice(2, 12) + "7" + s.slice(12);
}

function mensajeCuenta(correo: string, error: { code?: string; message?: string } | null): string {
  const codigo = error?.code ?? "";
  const texto = (error?.message ?? "").toLowerCase();
  if (codigo === "email_exists" || codigo === "user_already_exists" || texto.includes("already been registered")) {
    return `Ya existe una cuenta con el correo ${correo}. No se creó nada.`;
  }
  if (codigo === "email_address_invalid") return `El correo ${correo} no es válido. No se creó nada.`;
  return `No se pudo crear la cuenta de ${correo}. No se creó nada; intenta de nuevo.`;
}
