// Cuenta de trabajo (RP, staff o gerente) dada de baja con la sesión
// abierta: se cierra la sesión y el login muestra el aviso. La base ya no le
// deja ver nada (current_role_name() es nulo para un perfil dado de baja);
// esto solo evita que vea una pantalla vacía.
import type { SupabaseClient } from "@supabase/supabase-js";
import { MOTIVO_CUENTA_BAJA, conLimite } from "@/lib/domain/caja-cola";

export const AVISO_CUENTA_DADA_DE_BAJA = "Tu cuenta ha sido desactivada, contacta al antro.";

export async function cerrarSesionDadoDeBaja(
  supabase: SupabaseClient,
  router: { replace: (url: string) => void },
  // Pantallas de staff: lo que la persona dejó en la cola de caja de este
  // teléfono ya no se va a enviar (la base no se lo acepta). Pasa a
  // rechazado con su motivo para que no se anuncie a la siguiente cuenta
  // como "se envía cuando esa persona vuelva a entrar" (lib/caja-cola.ts).
  opciones: { colaCaja?: boolean } = {},
): Promise<void> {
  if (opciones.colaCaja) {
    try {
      const { data } = await supabase.auth.getSession();
      const id = data.session?.user.id;
      if (id) {
        const { rechazarPendientesDe } = await import("@/lib/caja-cola");
        await conLimite(rechazarPendientesDe(id, MOTIVO_CUENTA_BAJA), 3_000, 0);
      }
    } catch (e) {
      console.error("No se pudo marcar la cola de caja de la cuenta dada de baja:", e);
    }
  }
  await supabase.auth.signOut();
  router.replace("/cliente/login?baja=1");
}
