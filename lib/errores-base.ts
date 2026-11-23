// Qué error de la base se le muestra a la persona.
//
// Las funciones de la base avisan con `raise exception '…'` (código P0001)
// y un texto en español pensado para quien usa la app ("La mesa ya está
// cuadrada"): ese sí se muestra tal cual. Cualquier otro error (permisos,
// columnas, PostgREST, red) puede traer nombres de tablas o políticas, así
// que se cambia por un mensaje genérico y el detalle va a la consola.

export type ErrorBase = { message: string; code?: string } | null | undefined;

const CODIGOS: Record<string, string> = {
  "42501": "No tienes permiso para hacer esto.",
  "23505": "Eso ya está registrado.",
  PGRST301: "Tu sesión expiró. Vuelve a iniciar sesión.",
};

export const MENSAJE_SIN_CONEXION = "No hubo conexión con el servidor. Revisa la señal e intenta de nuevo.";

// Falla de red: la petición no llegó o la respuesta se perdió. supabase-js
// no lanza: devuelve un error sin código con el texto del fetch del
// navegador ("Failed to fetch" en Chrome, "Load failed" en Safari,
// "NetworkError…" en Firefox). En ese caso NO se sabe si la base guardó.
export function esErrorDeRed(error: ErrorBase | unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!error || typeof error !== "object") return false;
  const { message, code } = error as { message?: unknown; code?: unknown };
  if (typeof message !== "string") return false;
  if (code && code !== "") return false;
  return /failed to fetch|load failed|networkerror|network request failed|fetch failed|timeout|aborted/i.test(message);
}

export function mensajeParaUsuario(
  error: ErrorBase,
  generico = "No se pudo completar. Intenta de nuevo.",
): string {
  if (!error) return generico;
  if (error.code === "P0001" && error.message) return error.message;
  if (esErrorDeRed(error)) return MENSAJE_SIN_CONEXION;
  const conocido = error.code ? CODIGOS[error.code] : undefined;
  console.error("Error de la base:", error);
  return conocido ?? generico;
}
