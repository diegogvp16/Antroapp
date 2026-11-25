// Cuenta con contraseña temporal sin cambiar (alta de antros: el admin la
// generó y la vio). Hasta que la cambie, la base no le da rol
// (current_role_name() es nulo) y las rutas de servidor que leen el rol con
// la service role tampoco deben dejarla hacer nada (auditoría c-rls).
import type { User } from "@supabase/supabase-js";

export const AVISO_CONTRASENA_TEMPORAL = "Primero cambia tu contraseña temporal.";

export function tieneContrasenaTemporal(user: Pick<User, "app_metadata"> | null | undefined): boolean {
  return user?.app_metadata?.debe_cambiar === true;
}
