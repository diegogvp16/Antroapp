// ¿Quien llama puede administrar la mensualidad de este antro? Solo su dueño
// o el admin (rol y antro leídos de la base, nunca del cuerpo).
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { AVISO_CONTRASENA_TEMPORAL, tieneContrasenaTemporal } from "@/lib/contrasena-temporal";

export type Autorizado =
  | { ok: true; userId: string; email: string | null; esAdmin: boolean; club: { id: string; nombre: string } }
  | { ok: false; status: 400 | 401 | 403; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function autorizarMensualidad(clubId: unknown): Promise<Autorizado> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Necesitas iniciar sesión." };
  if (tieneContrasenaTemporal(user)) return { ok: false, status: 403, error: AVISO_CONTRASENA_TEMPORAL };
  if (typeof clubId !== "string" || !UUID.test(clubId)) return { ok: false, status: 400, error: "Antro inválido." };
  const svc = clienteServicio();
  const { data: perfil } = await svc.from("profiles").select("role, activo").eq("id", user.id).maybeSingle();
  const { data: club } = await svc.from("clubs").select("id, nombre, dueno_id").eq("id", clubId).maybeSingle();
  if (!perfil || perfil.activo === false || !club) return { ok: false, status: 403, error: "No puedes administrar la mensualidad de este antro." };
  const esAdmin = perfil.role === "admin";
  if (!esAdmin && !(perfil.role === "dueno" && club.dueno_id === user.id)) {
    return { ok: false, status: 403, error: "Solo el dueño del antro administra su mensualidad." };
  }
  return { ok: true, userId: user.id, email: user.email ?? null, esAdmin, club: { id: club.id, nombre: club.nombre } };
}

// URL base para regresar de Stripe: la del sitio configurado o la de la petición.
export function origenDe(request: Request): string {
  return (process.env.NEXT_PUBLIC_SITIO_URL || new URL(request.url).origin).replace(/\/$/, "");
}
