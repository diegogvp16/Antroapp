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

export function mensajeParaUsuario(
  error: ErrorBase,
  generico = "No se pudo completar. Intenta de nuevo.",
): string {
  if (!error) return generico;
  if (error.code === "P0001" && error.message) return error.message;
  const conocido = error.code ? CODIGOS[error.code] : undefined;
  console.error("Error de la base:", error);
  return conocido ?? generico;
}
