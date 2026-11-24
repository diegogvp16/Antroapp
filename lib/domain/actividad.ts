// Registro de actividad del antro (actividad_club en la base): cómo se
// nombra cada tipo de movimiento y qué texto lleva. Sin React ni Supabase.

export type TipoActividad =
  | "cuadrar_mesa"
  | "anular_consumo"
  | "anular_pago"
  | "reabrir_mesa"
  | "cerrar_mesa"
  | "cerrar_noche"
  | "nomina_cambiar_estado"
  | "personal_baja"
  | "personal_reactivacion";

export interface FilaActividad {
  hecho_en: string;
  tipo: string;
  mesa: string | null;
  monto_centavos: number | null;
  motivo: string | null;
  quien: string;
  quien_rol: string | null;
  persona: string | null;
}

export const ETIQUETA_ACTIVIDAD: Record<TipoActividad, string> = {
  cuadrar_mesa: "Cuadró mesa",
  anular_consumo: "Anuló consumo",
  anular_pago: "Anuló pago",
  reabrir_mesa: "Reabrió mesa",
  cerrar_mesa: "Cerró mesa",
  cerrar_noche: "Cerró la noche",
  nomina_cambiar_estado: "Cambió la nómina",
  personal_baja: "Dio de baja",
  personal_reactivacion: "Reactivó",
};

// Movimientos que conviene revisar (anulaciones, reaperturas y bajas).
const DE_CUIDADO = new Set(["anular_consumo", "anular_pago", "reabrir_mesa", "personal_baja"]);
export const esDeCuidado = (tipo: string) => DE_CUIDADO.has(tipo);

export const FILTROS_ACTIVIDAD = [
  { valor: "todo", etiqueta: "Todo" },
  { valor: "cuidado", etiqueta: "Anulaciones y reaperturas" },
  { valor: "cuadres", etiqueta: "Cuadres y cierres" },
  { valor: "personal", etiqueta: "Personal" },
] as const;
export type FiltroActividad = (typeof FILTROS_ACTIVIDAD)[number]["valor"];

export function pasaFiltro(tipo: string, filtro: FiltroActividad): boolean {
  switch (filtro) {
    case "cuidado":
      return tipo === "anular_consumo" || tipo === "anular_pago" || tipo === "reabrir_mesa";
    case "cuadres":
      return tipo === "cuadrar_mesa" || tipo === "cerrar_mesa" || tipo === "cerrar_noche";
    case "personal":
      return tipo === "personal_baja" || tipo === "personal_reactivacion";
    default:
      return true;
  }
}

export function etiquetaActividad(tipo: string): string {
  return tipo in ETIQUETA_ACTIVIDAD ? ETIQUETA_ACTIVIDAD[tipo as TipoActividad] : tipo;
}

// "Anuló consumo · Mesa 4" / "Dio de baja · Ana López"
export function tituloActividad(f: FilaActividad): string {
  const objeto = f.persona ?? (f.mesa ? `Mesa ${f.mesa}` : null);
  return objeto ? `${etiquetaActividad(f.tipo)} · ${objeto}` : etiquetaActividad(f.tipo);
}
