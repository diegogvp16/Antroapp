// Panel del RP: reservas con su estado por consumo. Los datos vienen ya
// calculados de la base (rp_mis_reservas, solo las del RP que llama); aquí
// solo se resumen y se preparan para mostrar.

export type EstadoReservaRp = "consumio" | "llego_sin_consumo" | "no_llego" | "por_llegar";

// Qué ve el RP de cada reserva. Lo decide la base (rp_nivel_visibilidad, un
// solo punto); la pantalla solo respeta lo que llega.
export type NivelVisibilidadRp = "estado" | "estado_monto" | "estado_monto_botellas";

export interface ReservaRpDetalle {
  reservation_id: string;
  cliente_nombre: string;
  cliente_telefono: string | null;
  fecha: string;
  personas: number;
  estado: EstadoReservaRp;
  mesa: string | null;
  consumo_centavos: number | null;
  // Solo con «estado, monto y botellas» y el catálogo de la fase 2 en la
  // base: un renglón por producto (agrupado), sin los conceptos libres.
  renglones: RenglonRp[] | null;
  creada_en: string;
  llego_en: string | null;
  sentado_en: string | null;
  primer_consumo_en: string | null;
  cuadrada_en: string | null;
  comision_centavos: number | null;
  comision_estado: string | null;
  nivel: NivelVisibilidadRp;
  // Con botellas: lo que se capturó sin catálogo (concepto libre). Nulo en
  // los otros niveles o si la base todavía no lo manda.
  otros_centavos?: number | null;
}

// Renglón de consumo que manda rp_mis_reservas. La versión de
// sql/post-junta-2/41 trae producto, categoría y cantidad; la anterior solo
// concepto y monto (por eso todo es opcional menos el monto).
export interface RenglonRp {
  concepto?: string | null;
  producto?: string | null;
  categoria?: string | null;
  cantidad?: number | null;
  monto_centavos: number;
}

export interface BotellaRp {
  producto: string;
  categoria: string | null;
  cantidad: number;
  monto_centavos: number;
}

// Qué botellas se le muestran al RP. Solo con la fase 2 encendida
// (NEXT_PUBLIC_FASE2) y el nivel «estado, monto y botellas»; si no, nulo y
// la pantalla se ve igual que con «estado y monto». La base ya decide qué
// manda; esto evita además mostrar renglones con la bandera apagada.
export function botellasParaRp(
  r: Pick<ReservaRpDetalle, "nivel" | "renglones" | "otros_centavos">,
  fase2Activa: boolean,
): { items: BotellaRp[]; otros: number } | null {
  if (!fase2Activa || r.nivel !== "estado_monto_botellas" || !Array.isArray(r.renglones)) return null;
  const items: BotellaRp[] = [];
  for (const x of r.renglones) {
    const monto = Number(x?.monto_centavos);
    if (!Number.isFinite(monto)) continue;
    const producto = String(x.producto ?? x.concepto ?? "").trim() || "Consumo";
    const cantidad = Number.isInteger(x.cantidad) && Number(x.cantidad) >= 1 ? Number(x.cantidad) : 1;
    items.push({ producto, categoria: x.categoria ?? null, cantidad, monto_centavos: monto });
  }
  const otros = Number(r.otros_centavos ?? 0);
  if (items.length === 0 && !(otros > 0)) return null;
  return { items, otros: otros > 0 ? otros : 0 };
}

export const ESTADOS_RP: readonly EstadoReservaRp[] = ["consumio", "llego_sin_consumo", "no_llego", "por_llegar"];

export const ESTADO_RP: Record<EstadoReservaRp, { etiqueta: string; punto: string; texto: string; barra: string }> = {
  consumio: { etiqueta: "Consumió", punto: "bg-caja-ok", texto: "text-caja-ok", barra: "bg-caja-ok" },
  llego_sin_consumo: { etiqueta: "Llegó, sin consumo", punto: "bg-caja-aviso", texto: "text-caja-aviso", barra: "bg-caja-aviso" },
  no_llego: { etiqueta: "No llegó", punto: "bg-caja-rojo", texto: "text-caja-rojo", barra: "bg-caja-rojo" },
  por_llegar: { etiqueta: "Por llegar", punto: "bg-caja-secundario", texto: "text-caja-secundario", barra: "bg-caja-secundario/60" },
};

export type FiltroRp = "todas" | "consumio" | "llego_sin_consumo" | "no_llego";

export const FILTROS_RP: { id: FiltroRp; etiqueta: string }[] = [
  { id: "todas", etiqueta: "Todas" },
  { id: "consumio", etiqueta: "Consumieron" },
  { id: "llego_sin_consumo", etiqueta: "Sin consumo" },
  { id: "no_llego", etiqueta: "No llegaron" },
];

export function filtrar(reservas: ReservaRpDetalle[], filtro: FiltroRp): ReservaRpDetalle[] {
  return filtro === "todas" ? reservas : reservas.filter((r) => r.estado === filtro);
}

export function contarEstados(reservas: ReservaRpDetalle[]): Record<EstadoReservaRp, number> {
  const c: Record<EstadoReservaRp, number> = { consumio: 0, llego_sin_consumo: 0, no_llego: 0, por_llegar: 0 };
  for (const r of reservas) c[r.estado]++;
  return c;
}

export function consumoTotal(reservas: ReservaRpDetalle[]): number | null {
  if (reservas.some((r) => r.consumo_centavos === null)) return null; // el nivel no incluye montos
  return reservas.reduce((s, r) => s + (r.consumo_centavos ?? 0), 0);
}

export const ESTADO_COMISION_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  en_revision: "En revisión",
  validada: "Validada",
  pagada: "Pagada",
  anulada: "Anulada",
};

export interface PasoTiempo {
  etiqueta: string;
  instante: string | null; // nulo = todavía no pasa
}

export function lineaDeTiempo(r: ReservaRpDetalle): PasoTiempo[] {
  return [
    { etiqueta: "Reserva creada", instante: r.creada_en },
    { etiqueta: "Llegó", instante: r.llego_en },
    { etiqueta: r.mesa ? `Ocupó la mesa ${r.mesa}` : "Ocupó mesa", instante: r.sentado_en },
    { etiqueta: "Consumo registrado", instante: r.primer_consumo_en },
    { etiqueta: "Mesa cuadrada", instante: r.cuadrada_en },
  ];
}

// Enlace de WhatsApp a un teléfono mexicano: 52 + 10 dígitos. Mismas formas
// que numeroWhatsApp (lib/domain/whatsapp.ts): 10; 52/521/044/045/01 + 10.
// Cualquier otro número (de otro país, con dígitos de más): null, y quien
// llama usa el enlace de compartir sin destinatario. Antes "044 55…" daba
// wa.me/0445512345678 (no sirve) y un +1 de EE. UU. se mandaba tal cual.
export function enlaceWhatsApp(telefono: string | null, mensaje: string): string | null {
  const d = (telefono ?? "").replace(/\D/g, "");
  const diez = /^\d{10}$/.test(d)
    ? d
    : /^52\d{10}$/.test(d) || /^01\d{10}$/.test(d)
      ? d.slice(2)
      : /^521\d{10}$/.test(d) || /^04[45]\d{10}$/.test(d)
        ? d.slice(3)
        : null;
  return diez ? `https://wa.me/52${diez}?text=${encodeURIComponent(mensaje)}` : null;
}

// Regla con cuota (hoy: desbloqueo semanal). Lo devuelve rp_progreso_cuota.
export type ProgresoCuota =
  | { tiene_cuota: false }
  | {
      tiene_cuota: true;
      cuota: number;
      llevas: number;
      semana_desde: string;
      semana_hasta: string;
      tipo: "fijo" | "porcentaje";
      monto: number;
      siguiente_paga: boolean;
    };

export function leerProgreso(data: unknown): ProgresoCuota {
  if (typeof data !== "object" || data === null) return { tiene_cuota: false };
  const d = data as Record<string, unknown>;
  if (d.tiene_cuota !== true) return { tiene_cuota: false };
  return {
    tiene_cuota: true,
    cuota: Number(d.cuota),
    llevas: Number(d.llevas),
    semana_desde: String(d.semana_desde),
    semana_hasta: String(d.semana_hasta),
    tipo: d.tipo === "porcentaje" ? "porcentaje" : "fijo",
    monto: Number(d.monto),
    siguiente_paga: d.siguiente_paga === true,
  };
}
