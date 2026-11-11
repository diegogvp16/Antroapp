// Reglas de la verificación de antros, sin React ni Supabase, para poder
// usarlas igual en el panel del dueño y, más adelante, en el del admin.

export const ESTADOS_VERIFICACION = [
  "borrador",
  "en_revision",
  "verificado",
  "rechazado",
] as const;
export type EstadoVerificacion = (typeof ESTADOS_VERIFICACION)[number];

export const TIPOS_DOCUMENTO = [
  "comprobante_fiscal",
  "foto_local",
  "identificacion",
] as const;
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number];

export const BUCKET_VERIFICACION = "verificacion-docs";

export const DOCUMENTOS: {
  tipo: TipoDocumento;
  etiqueta: string;
  requerido: boolean;
}[] = [
  {
    tipo: "comprobante_fiscal",
    etiqueta: "Comprobante fiscal o licencia de funcionamiento",
    requerido: true,
  },
  {
    tipo: "foto_local",
    etiqueta: "Foto del local (fachada o interior)",
    requerido: true,
  },
  {
    tipo: "identificacion",
    etiqueta: "Identificación del dueño",
    requerido: false,
  },
];

// Imágenes y PDF. El navegador filtra con `accept`, pero se vuelve a revisar
// porque `accept` es solo una sugerencia del selector de archivos.
export const TIPOS_ARCHIVO_ACEPTADOS = "image/*,application/pdf";
export const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024;

export function esEstadoVerificacion(valor: unknown): valor is EstadoVerificacion {
  return (
    typeof valor === "string" &&
    (ESTADOS_VERIFICACION as readonly string[]).includes(valor)
  );
}

// Solo desde borrador o rechazado se pueden subir documentos y mandar a
// revisión; en revisión y verificado el formulario no se muestra.
export function puedeEditarDocumentos(estado: EstadoVerificacion): boolean {
  return estado === "borrador" || estado === "rechazado";
}

export function faltanRequeridos(subidos: Iterable<TipoDocumento>): TipoDocumento[] {
  const tiene = new Set(subidos);
  return DOCUMENTOS.filter((d) => d.requerido && !tiene.has(d.tipo)).map(
    (d) => d.tipo,
  );
}

export function etiquetaDocumento(tipo: TipoDocumento): string {
  return DOCUMENTOS.find((d) => d.tipo === tipo)?.etiqueta ?? tipo;
}

// Devuelve un mensaje de error en español, o null si el archivo sirve.
export function validarArchivo(archivo: File): string | null {
  const esImagen = archivo.type.startsWith("image/");
  const esPdf = archivo.type === "application/pdf";
  if (!esImagen && !esPdf) {
    return "Solo se aceptan imágenes o PDF.";
  }
  if (archivo.size > TAMANO_MAXIMO_BYTES) {
    return "El archivo pesa más de 10 MB.";
  }
  return null;
}

// Extensión tomada del nombre; si no trae, se deduce del tipo MIME.
export function extensionDeArchivo(archivo: File): string {
  const delNombre = archivo.name.split(".").pop()?.toLowerCase();
  if (delNombre && delNombre !== archivo.name.toLowerCase() && /^[a-z0-9]{1,5}$/.test(delNombre)) {
    return delNombre;
  }
  if (archivo.type === "application/pdf") return "pdf";
  return archivo.type.split("/")[1] ?? "bin";
}

// `${club_id}/${tipo}-${uuid}.${ext}`: la carpeta con el club_id es la que
// usan las políticas del bucket para saber de quién es cada archivo.
export function rutaDocumento(clubId: string, tipo: TipoDocumento, archivo: File): string {
  return `${clubId}/${tipo}-${crypto.randomUUID()}.${extensionDeArchivo(archivo)}`;
}

export function formatearFechaVerificacion(iso: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "long",
    timeZone: "America/Mexico_City",
  }).format(new Date(iso));
}

// ----- Revisión del admin -----

export const MOTIVO_RECHAZO_MAXIMO = 500;

// Las URLs firmadas para que el admin vea un documento duran poco: si se
// filtran (captura, historial), caducan solas.
export const SEGUNDOS_URL_FIRMADA = 5 * 60;

// El motivo se le muestra tal cual al dueño, así que es obligatorio y corto.
// Devuelve un mensaje de error en español, o null si sirve.
export function validarMotivoRechazo(motivo: string): string | null {
  const limpio = motivo.trim();
  if (limpio.length === 0) {
    return "Escribe el motivo del rechazo.";
  }
  if (limpio.length > MOTIVO_RECHAZO_MAXIMO) {
    return `El motivo no puede pasar de ${MOTIVO_RECHAZO_MAXIMO} caracteres.`;
  }
  return null;
}
