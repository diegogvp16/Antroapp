// Ventas del POS: tipos compartidos por los adaptadores, el mapeo y la
// pantalla. Puro: sin React, sin Supabase y sin imports con "@/" (las
// pruebas lo cargan con Node: scripts/dev/probar-pos-dominio.mjs).
//
// Flujo: archivo (bytes) → adaptador (CSV o Excel) → TablaPos (celdas de
// texto) → mapeo de columnas → VentaPos[] (forma normalizada) → base.
// Detalle de la forma normalizada y de los formatos: docs/pos.md.

export type FormatoPos = "csv" | "xlsx";

/** Una fila del archivo tal cual: `n` es el número de fila que ve la
 *  persona en su archivo (línea del CSV o fila de Excel, desde 1). */
export interface FilaCruda {
  n: number;
  celdas: string[];
}

/** Lo que devuelve un adaptador: todas las filas, sin decidir encabezado. */
export interface TablaCruda {
  filas: FilaCruda[];
  avisos: string[];
}

/** Tabla con su fila de encabezado ya elegida. */
export interface TablaPos {
  encabezados: string[];
  /** Número de fila del encabezado en el archivo. */
  filaEncabezado: number;
  filas: FilaCruda[];
  avisos: string[];
}

/** Un adaptador lee un tipo de archivo y lo vuelve filas de texto. No
 *  interpreta montos ni fechas: eso lo hace el mapeo, igual para todos. */
export interface AdaptadorPos {
  formato: FormatoPos;
  nombre: string;
  extensiones: readonly string[];
  /** ¿Estos bytes son de este formato? (por contenido, no solo extensión). */
  reconoce(bytes: Uint8Array, nombreArchivo: string): boolean;
  leer(bytes: Uint8Array): Promise<TablaCruda>;
}

/** Forma normalizada de una línea de venta, igual venga del POS que venga. */
export interface VentaPos {
  /** Fila del archivo (para los mensajes «Línea N»). */
  linea: number;
  /** Ticket, folio o número de cuenta del POS. Requerido. */
  ticket: string;
  /** Fecha y hora local del antro, «AAAA-MM-DDTHH:MM:SS». Requerida. */
  fechaHora: string;
  /** Mesa como la escribe el POS («5», «Mesa 5», «VIP 1»). */
  mesa: string | null;
  /** Etiqueta de cuenta o comensal dentro de la mesa, si el POS la trae. */
  cuenta: string | null;
  /** Producto o concepto. Si el archivo es por ticket, «(sin detalle)». */
  producto: string;
  /** Cantidad, hasta 3 decimales; 1 si no viene. Negativa = devolución. */
  cantidad: number;
  precioUnitarioCentavos: number | null;
  /** Total de la línea en centavos (entero). Negativo = devolución. */
  totalCentavos: number;
  metodoPago: string | null;
  mesero: string | null;
}

/** Datos que se pueden mapear desde una columna del archivo. */
export type CampoPos =
  | "ticket"
  | "fecha"
  | "hora"
  | "mesa"
  | "cuenta"
  | "producto"
  | "cantidad"
  | "precio_unitario"
  | "total"
  | "metodo_pago"
  | "mesero";

export type FormatoFecha = "dmy" | "mdy";

/** Mapeo guardado por antro (pos_mapeos.config). */
export interface MapeoPos {
  columnas: Partial<Record<CampoPos, string>>;
  formato_fecha?: FormatoFecha;
  /** Separador decimal de montos y cantidades. Sin él, se decide por columna. */
  formato_montos?: "punto" | "coma";
}

export interface DefCampo {
  campo: CampoPos;
  etiqueta: string;
  /** requerido: sin él no se importa. recomendado: sin él se importa, pero no se liga o se pierde detalle. */
  nivel: "requerido" | "recomendado" | "opcional";
  ayuda: string;
}

export const CAMPOS_POS: readonly DefCampo[] = [
  { campo: "ticket", etiqueta: "Ticket o folio", nivel: "requerido", ayuda: "Número de ticket, folio o cuenta del POS." },
  { campo: "fecha", etiqueta: "Fecha", nivel: "requerido", ayuda: "Fecha de la venta; puede traer la hora en la misma columna." },
  { campo: "hora", etiqueta: "Hora de la venta", nivel: "recomendado", ayuda: "Solo si la hora viene en otra columna. Mejor la de la venta o apertura que la de cierre. Sin hora no se importa." },
  { campo: "total", etiqueta: "Total de la línea", nivel: "requerido", ayuda: "Importe de la línea. Si no hay, se calcula con cantidad × precio." },
  { campo: "mesa", etiqueta: "Mesa", nivel: "recomendado", ayuda: "Sin mesa la venta se guarda, pero no se liga a la caja." },
  { campo: "producto", etiqueta: "Producto", nivel: "recomendado", ayuda: "Si el archivo es un renglón por ticket, se guarda «(sin detalle)»." },
  { campo: "cantidad", etiqueta: "Cantidad", nivel: "opcional", ayuda: "Si no viene, cuenta como 1." },
  { campo: "precio_unitario", etiqueta: "Precio unitario", nivel: "opcional", ayuda: "Se usa para calcular el total si no hay columna de total." },
  { campo: "cuenta", etiqueta: "Cuenta o comensal", nivel: "opcional", ayuda: "Si coincide con el nombre de la cuenta en caja, ayuda a ligar." },
  { campo: "metodo_pago", etiqueta: "Forma de pago", nivel: "opcional", ayuda: "Solo informativo." },
  { campo: "mesero", etiqueta: "Mesero", nivel: "opcional", ayuda: "Solo informativo." },
];

export const esCampoPos = (v: unknown): v is CampoPos => typeof v === "string" && CAMPOS_POS.some((c) => c.campo === v);

// Límites (los mismos que revisa la base, sql/post-junta-3/10-pos-ventas.sql).
export const MAX_LINEAS_POS = 5000;
export const MAX_BYTES_POS = 10_000_000;
export const MAX_CENTAVOS_POS = 100_000_000;
export const MAX_CANTIDAD_POS = 10_000;
export const LARGO = { ticket: 60, mesa: 60, cuenta: 60, producto: 120, metodo_pago: 40, mesero: 80 } as const;
export const PRODUCTO_SIN_DETALLE = "(sin detalle)";
