import { NextResponse } from "next/server";
import { clienteServicio, hashTexto, ipDe } from "@/lib/supabase/servicio";
import { registrarError } from "@/lib/log";
import { ACEPTACIONES_POR_IP_HORA, CONSULTAS_POR_IP_HORA, esquemaAceptar } from "@/lib/domain/invitaciones";

// Página pública /invitacion/<token>: consultar la invitación y aceptarla.
//
//   consultar -> nombre del antro, rol, nombre y correo invitados y estado.
//   aceptar   -> crea la cuenta de Auth con el correo DE LA INVITACIÓN y la
//                contraseña elegida, y la base (invitacion_aceptar) crea el
//                perfil con el rol y el club DE LA INVITACIÓN, en una sola
//                transacción y una sola vez. Si la base dice que no, se borra
//                la cuenta recién creada. Nunca se liga una cuenta que ya
//                existía: si el correo ya tiene cuenta, se rechaza sin tocarla.
//
// Sin sesión. Límite por IP (consultar 30/h, aceptar 10/h). Cualquier otro
// campo del cuerpo (rol, club_id, correo…) se ignora.

const NO_CACHE = { "Cache-Control": "no-store" };
const responder = (cuerpo: object, status = 200) => NextResponse.json(cuerpo, { status, headers: NO_CACHE });

type Invitacion = {
  id: string;
  estado: "pendiente" | "aceptada" | "vencida" | "revocada";
  correo: string;
  nombre: string;
  rol: string;
  club_nombre: string;
  expira_en: string;
};

const NO_SIRVE: Record<Exclude<Invitacion["estado"], "pendiente">, string> = {
  aceptada: "Esta invitación ya se usó. Inicia sesión con tu correo.",
  vencida: "Esta invitación venció. Pide que te la reenvíen.",
  revocada: "Esta invitación fue cancelada. Pide una nueva a quien te invitó.",
};

export async function POST(request: Request) {
  try {
    let cuerpo: unknown;
    try {
      cuerpo = await request.json();
    } catch {
      return responder({ error: "Datos inválidos." }, 400);
    }
    const r = esquemaAceptar.safeParse(cuerpo);
    if (!r.success) return responder({ error: r.error.issues[0]?.message ?? "El enlace no es válido." }, 400);
    const d = r.data;

    // 1) Límite por IP: primero se anota y luego se cuenta (con este), para
    //    que varias peticiones al mismo tiempo no pasen todas.
    const svc = clienteServicio();
    const ipHash = hashTexto(ipDe(request));
    await svc.from("invitacion_intentos").insert({ ip_hash: ipHash, accion: d.accion });
    const { count, error: errCuenta } = await svc
      .from("invitacion_intentos")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .eq("accion", d.accion)
      .gte("creado_en", new Date(Date.now() - 3_600_000).toISOString());
    if (errCuenta) {
      registrarError("invitacion: contar intentos", errCuenta);
      return responder({ error: "No pudimos revisar la invitación. Intenta de nuevo." }, 500);
    }
    const tope = d.accion === "consultar" ? CONSULTAS_POR_IP_HORA : ACEPTACIONES_POR_IP_HORA;
    if ((count ?? 0) > tope) return responder({ error: "Demasiados intentos desde esta conexión. Intenta de nuevo en una hora." }, 429);

    // 2) La invitación (solo por el hash del token).
    const consulta = await svc.rpc("invitacion_consultar", { p_token: d.token });
    if (consulta.error) {
      registrarError("invitacion: consultar", consulta.error);
      return responder({ error: "No pudimos revisar la invitación. Intenta de nuevo." }, 500);
    }
    const inv = consulta.data as Invitacion | null;
    if (!inv) return responder({ error: "Esta invitación no existe o ya no sirve." }, 404);

    if (d.accion === "consultar") {
      return responder({
        invitacion: { estado: inv.estado, correo: inv.correo, nombre: inv.nombre, rol: inv.rol, club: inv.club_nombre, expira_en: inv.expira_en },
      });
    }
    if (inv.estado !== "pendiente") return responder({ error: NO_SIRVE[inv.estado], estado: inv.estado }, 410);

    // 3) Cuenta nueva con el correo de la invitación (nunca uno del cuerpo).
    const creada = await svc.auth.admin.createUser({
      email: inv.correo,
      password: d.password,
      email_confirm: true,
      app_metadata: { invitacion_id: inv.id },
    });
    if (creada.error || !creada.data.user) {
      const e = creada.error;
      const texto = (e?.message ?? "").toLowerCase();
      // Dos envíos del mismo formulario a la vez (doble toque, reintento con
      // mala señal): el otro ya creó la cuenta. Se espera un momento y, si la
      // invitación ya quedó aceptada, se dice eso y no «error» ni «ya existe».
      if (e?.code !== "weak_password") {
        await new Promise((r) => setTimeout(r, 1500));
        const otra = await svc.rpc("invitacion_consultar", { p_token: d.token });
        const ahora = otra.data as Invitacion | null;
        if (!otra.error && ahora && ahora.estado !== "pendiente") return responder({ error: NO_SIRVE[ahora.estado], estado: ahora.estado }, 410);
      }
      if (e?.code === "email_exists" || e?.code === "user_already_exists" || texto.includes("already been registered")) {
        return responder(
          {
            error:
              "Ese correo ya tiene una cuenta en AntroApp, así que no se puede usar esta invitación. Pide a quien te invitó que use otro correo o que lo revise con soporte.",
            yaExiste: true,
          },
          409,
        );
      }
      if (e?.code === "weak_password" || texto.includes("password")) {
        return responder({ error: "Esa contraseña es muy común o muy corta. Elige otra." }, 400);
      }
      registrarError("invitacion: createUser", e);
      return responder({ error: "No pudimos crear tu cuenta. Si ya la habías creado, inicia sesión; si no, intenta de nuevo." }, 500);
    }
    const nuevo = creada.data.user.id;

    // 4) Perfil con el rol y club de la invitación, en la base, una vez.
    const acepta = await svc.rpc("invitacion_aceptar", { p_token: d.token, p_user_id: nuevo });
    if (acepta.error) {
      const borrar = await svc.auth.admin.deleteUser(nuevo);
      if (borrar.error) registrarError("invitacion: deshacer cuenta", borrar.error);
      if (acepta.error.code === "P0001") return responder({ error: acepta.error.message }, 410);
      registrarError("invitacion: aceptar", acepta.error);
      return responder({ error: "No pudimos crear tu cuenta. Intenta de nuevo." }, 500);
    }
    const datos = acepta.data as { rol: string; correo: string };
    return responder({ ok: true, rol: datos.rol, correo: datos.correo });
  } catch (e) {
    registrarError("invitacion: inesperado", e);
    return responder({ error: "Error inesperado del servidor." }, 500);
  }
}
