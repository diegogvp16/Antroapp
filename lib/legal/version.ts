// Documentos legales (borradores en docs/legal/, BORRADOR: requieren revisión
// de un abogado) detrás de una bandera APAGADA por defecto:
//   NEXT_PUBLIC_LEGALES=1  → /terminos y /privacidad existen y se piden las
//                             casillas de aceptación (registro del cliente y
//                             primera entrada del RP).
// Con la bandera apagada las páginas dan 404 y nada cambia.
//
// Al cambiar el texto de los documentos, sube VERSION_LEGAL: a quien aceptó
// una versión anterior se le vuelve a pedir (aceptaciones_legales). La nueva
// versión también se publica en la base (versiones_legales), que no acepta
// constancias de versiones que no existen.

export const VERSION_LEGAL = "2026-11-24-borrador";

export const DOCUMENTOS_LEGALES = ["terminos", "privacidad"] as const;
export type DocumentoLegal = (typeof DOCUMENTOS_LEGALES)[number];

export function legalesActivos(): boolean {
  return process.env.NEXT_PUBLIC_LEGALES === "1";
}
