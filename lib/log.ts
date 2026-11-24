// Registro de errores en el servidor SIN datos personales: solo etiqueta,
// código y tipo. El mensaje de un error de la base o de Auth puede traer
// valores (por ejemplo "Key (email)=(…) already exists"), así que no se
// imprime. Los logs de Vercel los ve cualquiera con acceso al proyecto.
import "server-only";

export function registrarError(etiqueta: string, error: unknown): void {
  const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; status?: unknown; name?: unknown };
  console.error(etiqueta, {
    codigo: typeof e.code === "string" || typeof e.code === "number" ? e.code : null,
    estado: typeof e.status === "number" ? e.status : null,
    tipo: typeof e.name === "string" ? e.name : typeof error,
  });
}
