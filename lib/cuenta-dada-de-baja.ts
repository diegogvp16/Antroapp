// Cuenta de trabajo (RP, staff o gerente) dada de baja con la sesión
// abierta: se cierra la sesión y el login muestra el aviso. La base ya no le
// deja ver nada (current_role_name() es nulo para un perfil dado de baja);
// esto solo evita que vea una pantalla vacía.
import type { SupabaseClient } from "@supabase/supabase-js";

export const AVISO_CUENTA_DADA_DE_BAJA = "Tu cuenta ha sido desactivada, contacta al antro.";

export async function cerrarSesionDadoDeBaja(
  supabase: SupabaseClient,
  router: { replace: (url: string) => void },
): Promise<void> {
  await supabase.auth.signOut();
  router.replace("/cliente/login?baja=1");
}
