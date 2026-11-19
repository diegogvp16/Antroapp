// Caja por mesa: tipos de las filas y cálculos de presentación.
//
// Todo el dinero de la caja viene de la base en CENTAVOS (bigint). Aquí solo
// se suma lo que ya está registrado para mostrarlo: los montos que importan
// (cuadres, comisiones, cierre de la noche) los calcula siempre la base.
// Diseño completo en docs/caja-por-mesa.md.

import { formatearPesos } from "@/lib/dinero";
import { ZONA_OPERACION } from "@/lib/fechas";

// ---------------------------------------------------------------------------
// Tipos de las filas (columnas que lee /staff/caja).
// ---------------------------------------------------------------------------

export type EstadoNoche = "abierta" | "cerrada";
export type EstadoSesion = "abierta" | "cerrada" | "cuadrada";
export type EstadoMesa = "libre" | EstadoSesion;
export type MetodoPago = "efectivo" | "tarjeta" | "otro";
export type OrigenCuenta = "reserva" | "walk_in";

export interface CajaNoche {
  id: string;
  club_id: string;
  fecha_operacion: string;
  estado: EstadoNoche;
  cerrada_en: string | null;
}

export interface MesaCaja {
  id: string;
  numero: string;
  capacidad: number;
}

export interface MesaSesion {
  id: string;
  mesa_id: string;
  estado: EstadoSesion;
  abierta_por: string | null;
  abierta_en: string;
  cerrada_en: string | null;
  cuadrada_por: string | null;
  cuadrada_en: string | null;
}

export interface MesaCuenta {
  id: string;
  sesion_id: string;
  reservation_id: string | null;
  rp_id: string | null;
  origen: OrigenCuenta;
  cliente_nombre: string;
  personas: number | null;
  creada_en: string;
}

export interface CajaConsumo {
  id: string;
  sesion_id: string;
  cuenta_id: string;
  monto_centavos: number;
  concepto: string | null;
  registrado_por: string;
  registrado_en: string;
  anulado: boolean;
  anulado_por: string | null;
  anulado_en: string | null;
  motivo_anulacion: string | null;
}

export interface CajaPago {
  id: string;
  sesion_id: string;
  cuenta_id: string | null;
  metodo: MetodoPago;
  monto_centavos: number;
  referencia: string | null;
  registrado_por: string;
  registrado_en: string;
  anulado: boolean;
  anulado_por: string | null;
  anulado_en: string | null;
  motivo_anulacion: string | null;
}

export interface CajaCuadre {
  id: string;
  sesion_id: string | null;
  tipo: "mesa" | "noche";
  registrado_centavos: number;
  cobrado_efectivo_centavos: number;
  cobrado_tarjeta_centavos: number;
  cobrado_otro_centavos: number;
  saldo_sin_cobrar_centavos: number;
  contado_efectivo_centavos: number | null;
  contado_tarjeta_centavos: number | null;
  contado_otro_centavos: number | null;
  diferencia_centavos: number | null;
  notas: string | null;
  hecho_por: string;
  hecho_en: string;
}

// Reserva de esta noche con la entrada confirmada, lista para sentarse.
export interface ReservaSentable {
  id: string;
  cliente_nombre: string;
  personas: number;
  source: "organica" | "rp";
  rp_id: string | null;
}

// ---------------------------------------------------------------------------
// Permisos (casillas). La base es quien los hace cumplir; la UI solo esconde.
// ---------------------------------------------------------------------------

export const PERMISOS_CAJA = [
  "abrir_mesa",
  "registrar_consumo",
  "cobrar",
  "cerrar_mesa",
  "reabrir_mesa",
  "anular",
  "cuadrar_mesa",
  "cerrar_noche",
] as const;

export type PermisoCaja = (typeof PERMISOS_CAJA)[number];
export type PermisosCaja = Record<PermisoCaja, boolean>;

export const SIN_PERMISOS: PermisosCaja = {
  abrir_mesa: false,
  registrar_consumo: false,
  cobrar: false,
  cerrar_mesa: false,
  reabrir_mesa: false,
  anular: false,
  cuadrar_mesa: false,
  cerrar_noche: false,
};

// ---------------------------------------------------------------------------
// Etiquetas.
// ---------------------------------------------------------------------------

export const METODOS_PAGO: readonly MetodoPago[] = ["efectivo", "tarjeta", "otro"];

export const METODO_LABEL: Record<MetodoPago, string> = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  otro: "Otro",
};

export const ESTADO_MESA_LABEL: Record<EstadoMesa, string> = {
  libre: "Libre",
  abierta: "Abierta",
  cerrada: "Cerrada",
  cuadrada: "Cuadrada",
};

// Variante de Badge por estado (el color solo marca estados).
export const ESTADO_MESA_BADGE: Record<EstadoMesa, "neutral" | "ok" | "warn" | "outline"> = {
  libre: "neutral",
  abierta: "ok",
  cerrada: "warn",
  cuadrada: "outline",
};

// ---------------------------------------------------------------------------
// Estado de una mesa en la noche.
// ---------------------------------------------------------------------------

const PRIORIDAD_SESION: Record<EstadoSesion, number> = {
  abierta: 0,
  cerrada: 1,
  cuadrada: 2,
};

// Sesiones de una mesa ordenadas para mostrar: primero la abierta, luego las
// cerradas pendientes de cuadrar y al final las cuadradas; dentro de cada
// grupo, la más reciente primero.
export function ordenarSesiones(sesiones: MesaSesion[]): MesaSesion[] {
  return [...sesiones].sort((a, b) => {
    const p = PRIORIDAD_SESION[a.estado] - PRIORIDAD_SESION[b.estado];
    if (p !== 0) return p;
    return b.abierta_en.localeCompare(a.abierta_en);
  });
}

export interface EstadoMesaNoche {
  estado: EstadoMesa;
  // Sesión que se muestra para la mesa (nula si nunca se abrió esta noche).
  sesion: MesaSesion | null;
  // Se le puede abrir una sesión nueva: no tiene una abierta ni una cerrada
  // pendiente de cuadrar.
  sePuedeAbrir: boolean;
}

// "libre" no se guarda en la base: una mesa está libre si esta noche no tiene
// una sesión abierta ni una cerrada pendiente. Si su última sesión ya está
// cuadrada se muestra como cuadrada, pero se puede abrir otra.
export function estadoMesa(sesionesDeLaMesa: MesaSesion[]): EstadoMesaNoche {
  const [sesion] = ordenarSesiones(sesionesDeLaMesa);
  if (!sesion) {
    return { estado: "libre", sesion: null, sePuedeAbrir: true };
  }
  return {
    estado: sesion.estado,
    sesion,
    sePuedeAbrir: sesion.estado === "cuadrada",
  };
}

// ---------------------------------------------------------------------------
// Totales (solo lo vigente: lo anulado no cuenta).
// ---------------------------------------------------------------------------

export function sumarVigentes(filas: { monto_centavos: number; anulado: boolean }[]): number {
  let total = 0;
  for (const f of filas) {
    if (!f.anulado) total += f.monto_centavos;
  }
  return total;
}

export type TotalesPorMetodo = Record<MetodoPago, number>;

export function cobradoPorMetodo(pagos: CajaPago[]): TotalesPorMetodo {
  const totales: TotalesPorMetodo = { efectivo: 0, tarjeta: 0, otro: 0 };
  for (const p of pagos) {
    if (!p.anulado) totales[p.metodo] += p.monto_centavos;
  }
  return totales;
}

export function sumaMetodos(t: TotalesPorMetodo): number {
  return t.efectivo + t.tarjeta + t.otro;
}

export interface ResumenCaja {
  consumido: number;
  cobrado: number;
  porMetodo: TotalesPorMetodo;
  // Consumido - cobrado. Negativo si se cobró de más.
  saldo: number;
}

export function resumen(consumos: CajaConsumo[], pagos: CajaPago[]): ResumenCaja {
  const consumido = sumarVigentes(consumos);
  const porMetodo = cobradoPorMetodo(pagos);
  const cobrado = sumaMetodos(porMetodo);
  return { consumido, cobrado, porMetodo, saldo: consumido - cobrado };
}

export function resumenSesion(
  sesionId: string,
  consumos: CajaConsumo[],
  pagos: CajaPago[],
): ResumenCaja {
  return resumen(
    consumos.filter((c) => c.sesion_id === sesionId),
    pagos.filter((p) => p.sesion_id === sesionId),
  );
}

export function consumoDeCuenta(cuentaId: string, consumos: CajaConsumo[]): number {
  return sumarVigentes(consumos.filter((c) => c.cuenta_id === cuentaId));
}

// Diferencia del conteo físico contra lo cobrado (contado - cobrado), igual
// que la calcula la base al cerrar la noche. Negativa = falta dinero.
export function diferenciaConteo(contado: TotalesPorMetodo, cobrado: TotalesPorMetodo): number {
  return sumaMetodos(contado) - sumaMetodos(cobrado);
}

// ---------------------------------------------------------------------------
// Dinero: captura y formato.
// ---------------------------------------------------------------------------

// Tope de un cargo o pago, igual que en la base ($1,000,000.00).
export const MAX_CENTAVOS = 100_000_000;

// Pesos escritos por una persona -> centavos, sin pasar por flotantes.
// Acepta "1250", "1250.5", "1,250.50", "$1,250" y "  1250.50 ".
// La coma solo se acepta como separador de miles (formato es-MX).
// Devuelve null si el texto no es un monto válido.
export function pesosACentavos(texto: string): number | null {
  const limpio = texto.trim().replace(/^\$\s*/, "");
  const valido = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{0,2})?$/.test(limpio);
  if (!valido) return null;
  const [entero, decimales = ""] = limpio.replace(/,/g, "").split(".");
  const pesos = Number.parseInt(entero, 10);
  const centavos = Number.parseInt(decimales.padEnd(2, "0"), 10);
  const total = pesos * 100 + centavos;
  return Number.isSafeInteger(total) ? total : null;
}

// Centavos -> texto editable en pesos (125050 -> "1250.50"), para prellenar
// un campo. Solo enteros no negativos.
export function centavosATexto(centavos: number): string {
  const c = Math.max(0, Math.trunc(centavos));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

// Monto válido para un cargo o un pago: de 1 centavo a $1,000,000.
export function montoValido(centavos: number | null): centavos is number {
  return centavos !== null && centavos >= 1 && centavos <= MAX_CENTAVOS;
}

const formatoConCentavos = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Centavos -> texto en pesos. Los montos cerrados se ven como en el resto de
// la app ("$1,250"); si hay centavos se muestran ("$1,250.50") para que un
// saldo de 50 centavos no se vea como "$1" o "$0".
export function formatearCentavos(centavos: number): string {
  if (centavos % 100 === 0) return formatearPesos(centavos / 100);
  return formatoConCentavos.format(centavos / 100);
}

// ---------------------------------------------------------------------------
// Otros.
// ---------------------------------------------------------------------------

// Mínimo de un motivo de anulación o reapertura (igual que en la base).
export const MIN_MOTIVO = 3;

export function motivoValido(motivo: string): boolean {
  return motivo.trim().length >= MIN_MOTIVO;
}

const formatoHora = new Intl.DateTimeFormat("es-MX", {
  timeZone: ZONA_OPERACION,
  hour: "numeric",
  minute: "2-digit",
});

// Instante -> "11:42 p.m." en hora de México.
export function horaCorta(instante: string): string {
  return formatoHora.format(new Date(instante));
}

export function nombreODefault(
  nombres: Record<string, string>,
  id: string | null,
  porDefecto: string,
): string {
  if (!id) return porDefecto;
  return nombres[id] ?? porDefecto;
}

// ---------------------------------------------------------------------------
// Todo lo que /staff/caja lee de una noche.
// ---------------------------------------------------------------------------

export interface DatosCaja {
  // Nula mientras no se abra la primera mesa de la noche (la crea la base).
  noche: CajaNoche | null;
  mesas: MesaCaja[];
  sesiones: MesaSesion[];
  cuentas: MesaCuenta[];
  consumos: CajaConsumo[];
  pagos: CajaPago[];
  cuadres: CajaCuadre[];
  reservasSentables: ReservaSentable[];
  // Nombres de perfiles (RPs y personal) por id.
  nombres: Record<string, string>;
}
