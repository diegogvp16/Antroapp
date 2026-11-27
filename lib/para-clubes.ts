// /para-clubes (página para dueños de antro). Solo servidor.
//
// La página va detrás de una bandera de PLATAFORMA guardada en la base
// (sql/post-junta-3/50-para-clubes.sql), APAGADA por defecto: la enciende el
// admin desde /admin/funciones. Se lee con la anon key y sin cookies, como la
// vería cualquier visitante. Si la función no existe (base sin el SQL 50, p. ej.
// producción antes del pase) o falla, la página se comporta como apagada (404).
import "server-only";
import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import type { CoverModo } from "@/types";

function clienteAnonimo() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// cache: los metadatos y la página preguntan una sola vez por visita.
export const paraClubesActiva = cache(async (): Promise<boolean> => {
  try {
    const { data, error } = await clienteAnonimo().rpc("para_clubes_activa");
    // Se anota el código (sin datos): así una base caída no pasa por
    // «apagada» sin dejar rastro en los registros de Vercel.
    if (error) console.error("para-clubes: para_clubes_activa falló", error.code ?? "sin código");
    return !error && data === true;
  } catch (e) {
    console.error("para-clubes: para_clubes_activa sin respuesta", e instanceof Error ? e.name : "error");
    return false;
  }
});

export interface ClubDemoPublico {
  id: string;
  nombre: string;
  ciudad: string | null;
  horario: string | null;
  ambiente: string | null;
  tipo_musica: string | null;
  codigo_vestimenta: string | null;
  edad_minima: number | null;
  cover_modo: CoverModo;
  cover_monto: number | null;
  fotos: { url: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sin NEXT_PUBLIC_CLUB_DEMO_ID se busca por nombre: «Club Demo» en producción,
// «Club Demo Dev» en antroapp-dev.
const NOMBRES_DEMO = ["Club Demo", "Club Demo Dev"];
// Solo columnas de la ficha pública (nada de comisiones ni configuración).
const COLUMNAS = "id, nombre, ciudad, horario, ambiente, tipo_musica, codigo_vestimenta, edad_minima, cover_modo, cover_monto";

// El antro de ejemplo, con lo que el anónimo ya puede leer: la base solo le
// deja ver antros publicados (verificados y con suscripción activa) y sus
// fotos, así que un borrador nunca aparece aunque se configure su id.
export async function clubDemoPublico(): Promise<ClubDemoPublico | null> {
  try {
    const supabase = clienteAnonimo();
    const id = process.env.NEXT_PUBLIC_CLUB_DEMO_ID?.trim() ?? "";
    const consulta = supabase.from("clubs").select(COLUMNAS);
    const { data: club, error } = await (UUID.test(id)
      ? consulta.eq("id", id)
      : consulta.in("nombre", NOMBRES_DEMO).order("nombre")
    )
      .limit(1)
      .maybeSingle();
    if (error) console.error("para-clubes: no se pudo leer el antro de ejemplo", error.code ?? "sin código");
    if (error || !club) return null;
    const { data: fotos } = await supabase
      .from("club_photos")
      .select("url")
      .eq("club_id", club.id)
      .order("orden", { ascending: true })
      .limit(3);
    return {
      ...(club as Omit<ClubDemoPublico, "fotos">),
      fotos: (fotos ?? []).filter((f): f is { url: string } => typeof f.url === "string" && f.url.startsWith("https://")),
    };
  } catch {
    return null;
  }
}
