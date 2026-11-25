import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { AVISO_CONTRASENA_TEMPORAL, tieneContrasenaTemporal } from "@/lib/contrasena-temporal";
import { cuentasNuevas, esquemaAltaClub, erroresPorCampo, payloadSql, type CuentaNueva } from "@/lib/domain/alta-club";

// Alta de un antro nuevo con su equipo, desde /admin/alta-antro. SOLO admin.
//
//   1. ¿Quién llama? Sesión por cookie; rol y estado se leen de la base.
//   2. Valida todo con el mismo esquema que el asistente.
//   3. Crea las cuentas de Auth (no pueden ir dentro de una transacción de
//      Postgres) con contraseña temporal generada aquí y marcadas con
//      app_metadata.alta_club (la base solo acepta cuentas así y recientes).
//   4. admin_alta_club() con la sesión del admin: antro, mesas, perfiles,
//      grupo y bitácora en UNA transacción, con una clave de idempotencia
//      (alta_id). La función vuelve a exigir admin.
//   5. Si 3 o 4 fallan, borra las cuentas que había creado. Antes de borrar
//      por un error que no es de validación (por ejemplo, se perdió la
//      respuesta), revisa con la clave si la base sí guardó: en ese caso
//      responde como éxito y no borra nada.
//   Si el proceso muere entre 3 y 4 quedan cuentas de Auth sin perfil (no
//   entran a ningún panel): scripts/limpiar-altas-huerfanas.mjs las
//   encuentra y las borra.
//
// Las contraseñas temporales se devuelven UNA vez (sin caché), para que el
// admin las entregue; no se guardan en ningún lado.

export const maxDuration = 60;

const CONCURRENCIA = 6;
const SIN_CACHE = { "Cache-Control": "no-store" };
const responder = (cuerpo: object, status = 200) => NextResponse.json(cuerpo, { status, headers: SIN_CACHE });

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return responder({ error: "Necesitas iniciar sesión." }, 401);
  if (tieneContrasenaTemporal(user)) return responder({ error: AVISO_CONTRASENA_TEMPORAL }, 403);

  const admin = clienteServicio();
  const { data: perfil } = await admin.from("profiles").select("role, activo").eq("id", user.id).maybeSingle();
  if (perfil?.role !== "admin" || perfil.activo === false) {
    return responder({ error: "Solo el admin puede dar de alta antros." }, 403);
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return responder({ error: "Datos inválidos." }, 400);
  }
  const r = esquemaAltaClub.safeParse(cuerpo);
  if (!r.success) {
    const campos = erroresPorCampo(r.error);
    return responder({ error: Object.values(campos)[0] ?? "Revisa los datos.", campos }, 400);
  }
  const alta = r.data;
  const altaId = randomUUID();

  if (alta.grupo.modo === "existente") {
    const { data: g } = await admin.from("grupos").select("id").eq("id", alta.grupo.grupo_id).maybeSingle();
    if (!g) return responder({ error: "El grupo elegido no existe." }, 400);
  }
  // Clon: el origen tiene que existir (la base lo vuelve a revisar y es la
  // que copia su catálogo; aquí solo se evita crear cuentas en vano).
  if (alta.clonar_de) {
    const { data: o } = await admin.from("clubs").select("id").eq("id", alta.clonar_de).maybeSingle();
    if (!o) return responder({ error: "El antro de origen no existe." }, 400);
  }

  // 3. Cuentas de Auth.
  const cuentas = cuentasNuevas(alta);
  const creadas = new Map<string, string>(); // correo → id
  const credenciales: (CuentaNueva & { password: string })[] = [];

  // Deshace las cuentas creadas. Si alguna no se puede borrar se registra
  // (solo cuántas, sin correos) y se avisa: la limpia el script.
  const borrarCreadas = async (): Promise<number> => {
    const lista = [...creadas.values()];
    let fallidas = 0;
    for (let i = 0; i < lista.length; i += CONCURRENCIA) {
      const res = await Promise.all(lista.slice(i, i + CONCURRENCIA).map((id) => admin.auth.admin.deleteUser(id)));
      fallidas += res.filter((x) => x.error).length;
    }
    if (fallidas) console.error(`alta-club ${altaId}: ${fallidas} cuentas sin borrar`);
    return fallidas;
  };
  const avisoHuerfanas = (n: number) =>
    n ? ` Quedaron ${n} cuentas sin perfil (no entran a nada); se limpian con scripts/limpiar-altas-huerfanas.mjs.` : "";

  for (let i = 0; i < cuentas.length; i += CONCURRENCIA) {
    const tanda = cuentas.slice(i, i + CONCURRENCIA);
    const resultados = await Promise.all(
      tanda.map(async (c) => {
        const password = contrasenaTemporal();
        const res = await admin.auth.admin.createUser({
          email: c.correo,
          password,
          email_confirm: true,
          app_metadata: { alta_club: true, alta_id: altaId, debe_cambiar: true },
        });
        if (res.error || !res.data.user) return { c, error: res.error };
        creadas.set(c.correo, res.data.user.id);
        credenciales.push({ ...c, password });
        return { c, error: null };
      }),
    );
    const fallo = resultados.find((x) => x.error);
    if (fallo) {
      const sinBorrar = await borrarCreadas();
      console.error(`alta-club ${altaId}: createUser`, fallo.error?.code ?? fallo.error?.status);
      return responder({ error: mensajeCuenta(fallo.c.correo, fallo.error) + avisoHuerfanas(sinBorrar) }, 400);
    }
  }

  const orden = new Map(cuentas.map((c, i) => [c.correo, i]));
  const exito = (resultado: unknown, aviso?: string) => {
    credenciales.sort((a, b) => (orden.get(a.correo) ?? 0) - (orden.get(b.correo) ?? 0));
    return responder({ ok: true, resultado, credenciales, ...(aviso ? { aviso } : {}) });
  };

  // 4. Todo lo de la base, en una transacción, con la sesión del admin.
  const { data, error } = await supabase.rpc("admin_alta_club", { p: payloadSql(alta, creadas, altaId) });
  if (!error) {
    // La versión de la base que guarda las reglas (sql/post-junta-2/10)
    // responde con la llave "rp". Sin ella (SQL viejo), el antro se creó
    // pero sin reglas: se avisa en vez de callarlo.
    if (data && typeof data === "object" && !("rp" in data)) {
      console.error(`alta-club ${altaId}: la base no guardó las reglas de RPs (falta sql/post-junta-2/10)`);
      return exito(data, "El antro se creó, pero las reglas de RPs y los permisos de caja NO se guardaron (falta actualizar la base). Configúralas en el panel del dueño.");
    }
    // Igual con el clon: la versión que copia el catálogo (post-junta-2/11)
    // responde con la llave "clon".
    if (alta.clonar_de && data && typeof data === "object" && !("clon" in data)) {
      console.error(`alta-club ${altaId}: la base no copió el catálogo (falta sql/post-junta-2/11)`);
      return exito(data, "El antro se creó con la configuración del origen, pero el catálogo de productos NO se copió (falta actualizar la base).");
    }
    return exito(data);
  }

  if (error.code !== "P0001") {
    // ¿Se guardó y solo se perdió la respuesta? Entonces no se deshace nada.
    const { data: guardada } = await admin.from("club_altas").select("club_id").eq("alta_id", altaId).maybeSingle();
    if (guardada) return exito({ club_id: guardada.club_id });
  }
  const sinBorrar = await borrarCreadas();
  console.error(`alta-club ${altaId}: admin_alta_club`, error.code);
  const mensaje = error.code === "P0001" ? error.message : "No se pudo dar de alta el antro. No se guardó nada; intenta de nuevo.";
  return responder({ error: mensaje + avisoHuerfanas(sinBorrar) }, 400);
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
