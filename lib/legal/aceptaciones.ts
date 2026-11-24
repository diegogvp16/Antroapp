// Constancia de aceptación de los documentos legales (aceptaciones_legales).
import type { SupabaseClient } from "@supabase/supabase-js";
import { DOCUMENTOS_LEGALES, VERSION_LEGAL } from "@/lib/legal/version";

// Registra que el perfil aceptó la versión vigente de ambos documentos.
// Repetir no es error (ya estaba aceptada).
export async function registrarAceptacion(supabase: SupabaseClient, profileId: string): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from("aceptaciones_legales")
    .upsert(
      DOCUMENTOS_LEGALES.map((documento) => ({ profile_id: profileId, documento, version: VERSION_LEGAL })),
      { onConflict: "profile_id,documento,version", ignoreDuplicates: true },
    );
  return { ok: !error };
}

// ¿Ya aceptó la versión vigente de los dos documentos?
export async function aceptoVersionVigente(supabase: SupabaseClient, profileId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("aceptaciones_legales")
    .select("documento")
    .eq("profile_id", profileId)
    .eq("version", VERSION_LEGAL);
  if (error) return false;
  return DOCUMENTOS_LEGALES.every((d) => (data ?? []).some((x) => x.documento === d));
}
