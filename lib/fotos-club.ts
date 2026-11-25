// Fotos de la galería del antro (bucket público club-photos).
//
// Los mismos límites que pone la base en el bucket
// (sql/post-junta-2/63-bucket-fotos-limites.sql): si cambian allá, cambian
// aquí. Se revisan ANTES de subir para darle al dueño un motivo claro en vez
// de un "Intenta de nuevo" que nunca va a pasar.

export const FOTO_CLUB_MAX_BYTES = 10 * 1024 * 1024;

export const FOTO_CLUB_TIPOS = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/gif",
] as const;

// Para el atributo accept del input de archivo.
export const FOTO_CLUB_ACCEPT = FOTO_CLUB_TIPOS.join(",");

// Algunos navegadores (Chrome en Windows con HEIC, por ejemplo) entregan el
// archivo con type vacío: se deduce por la extensión.
const POR_EXTENSION: Record<string, (typeof FOTO_CLUB_TIPOS)[number]> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  gif: "image/gif",
};

export function tipoFotoClub(archivo: { name: string; type: string }): string | null {
  const tipo = archivo.type.toLowerCase();
  if ((FOTO_CLUB_TIPOS as readonly string[]).includes(tipo)) return tipo;
  if (tipo) return null;
  const ext = archivo.name.split(".").pop()?.toLowerCase() ?? "";
  return POR_EXTENSION[ext] ?? null;
}

// Motivo por el que la foto no se puede subir, o null si está bien.
export function problemaFotoClub(archivo: { name: string; type: string; size: number }): string | null {
  if (!tipoFotoClub(archivo)) {
    return `«${archivo.name}»: ese formato no se acepta. Usa JPG, PNG o WebP.`;
  }
  if (archivo.size > FOTO_CLUB_MAX_BYTES) {
    const mb = (archivo.size / (1024 * 1024)).toFixed(1);
    return `«${archivo.name}» pesa ${mb} MB y el máximo es 10 MB. Reduce la foto e intenta otra vez.`;
  }
  return null;
}

// Traduce el rechazo de Storage (si la foto llegó sin pasar por la revisión
// de arriba, o si el bucket cambió). El texto de Storage viene en inglés.
export function mensajeErrorStorageFoto(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { message, statusCode } = error as { message?: unknown; statusCode?: unknown };
  const texto = typeof message === "string" ? message : "";
  const codigo = String(statusCode ?? "");
  if (codigo === "413" || /maximum allowed size|too large|payload too large/i.test(texto)) {
    return "La foto pesa más de 10 MB. Reduce la foto e intenta otra vez.";
  }
  if (codigo === "415" || /mime type|not supported/i.test(texto)) {
    return "Ese formato no se acepta. Usa JPG, PNG o WebP.";
  }
  return null;
}
