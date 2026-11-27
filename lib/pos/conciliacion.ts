// Conciliación de una noche: caja contra POS. Puro (sin "@/").
// Las filas salen de pos_conciliacion (sql/post-junta-3/10-pos-ventas.sql);
// aquí solo se agrupan por mesa y se resume la noche.

export type EstadoConciliacion = "coincide" | "diferencia" | "solo_pos" | "solo_caja";
export type NivelConciliacion = "cuenta" | "mesa_sin_cuenta" | "sin_mesa";

export interface FilaConciliacion {
  nivel: NivelConciliacion;
  mesa_id: string | null;
  mesa_numero: string | null;
  sesion_id: string | null;
  sesion_abierta_en: string | null;
  sesion_estado: string | null;
  cuenta_id: string | null;
  cliente_nombre: string | null;
  caja_centavos: number;
  pos_centavos: number;
  pos_lineas: number;
  pos_tickets: number;
  estado: EstadoConciliacion;
}

export const ESTADO_CONCILIACION: Record<EstadoConciliacion, { etiqueta: string; tono: "ok" | "warn" | "err" | "neutral" }> = {
  coincide: { etiqueta: "Coincide", tono: "ok" },
  diferencia: { etiqueta: "Diferencia", tono: "err" },
  solo_pos: { etiqueta: "Solo POS", tono: "warn" },
  solo_caja: { etiqueta: "Solo caja", tono: "warn" },
};

/** La misma regla que la base: hay POS y caja → coincide o diferencia. */
export function estadoDe(cajaCentavos: number, posCentavos: number, hayPos: boolean): EstadoConciliacion {
  if (!hayPos) return "solo_caja";
  if (cajaCentavos === 0) return "solo_pos";
  return cajaCentavos === posCentavos ? "coincide" : "diferencia";
}

export function normalizarFila(x: Record<string, unknown>): FilaConciliacion {
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
  const nivel = (["cuenta", "mesa_sin_cuenta", "sin_mesa"] as const).find((k) => k === x.nivel) ?? "sin_mesa";
  const estado = (["coincide", "diferencia", "solo_pos", "solo_caja"] as const).find((k) => k === x.estado) ?? "solo_pos";
  return {
    nivel,
    mesa_id: s(x.mesa_id),
    mesa_numero: s(x.mesa_numero),
    sesion_id: s(x.sesion_id),
    sesion_abierta_en: s(x.sesion_abierta_en),
    sesion_estado: s(x.sesion_estado),
    cuenta_id: s(x.cuenta_id),
    cliente_nombre: s(x.cliente_nombre),
    caja_centavos: n(x.caja_centavos),
    pos_centavos: n(x.pos_centavos),
    pos_lineas: n(x.pos_lineas),
    pos_tickets: n(x.pos_tickets),
    estado,
  };
}

export interface MesaConciliada {
  clave: string;
  mesa: string;
  /** Sin mesa reconocida en la caja (texto del POS o «Sin mesa»). */
  fueraDeCaja: boolean;
  filas: FilaConciliacion[];
  caja: number;
  pos: number;
  estado: EstadoConciliacion;
}

const comparaMesa = (a: string, b: string) => a.localeCompare(b, "es-MX", { numeric: true, sensitivity: "base" });

export function agruparPorMesa(filas: readonly FilaConciliacion[]): MesaConciliada[] {
  const mapa = new Map<string, MesaConciliada>();
  for (const f of filas) {
    const fuera = f.nivel === "sin_mesa" && !f.mesa_id;
    const clave = fuera ? `pos:${(f.mesa_numero ?? "").toLowerCase()}` : `mesa:${f.mesa_id ?? ""}`;
    const m = mapa.get(clave) ?? {
      clave,
      mesa: f.mesa_numero ?? "Sin mesa",
      fueraDeCaja: fuera,
      filas: [],
      caja: 0,
      pos: 0,
      estado: "coincide" as EstadoConciliacion,
    };
    m.filas.push(f);
    m.caja += f.caja_centavos;
    m.pos += f.pos_centavos;
    mapa.set(clave, m);
  }
  const salida = [...mapa.values()];
  for (const m of salida) m.estado = estadoDe(m.caja, m.pos, m.filas.some((f) => f.pos_lineas > 0));
  return salida.sort((a, b) => Number(a.fueraDeCaja) - Number(b.fueraDeCaja) || comparaMesa(a.mesa, b.mesa));
}

export interface ResumenNoche {
  caja: number;
  pos: number;
  diferencia: number;
  porEstado: Record<EstadoConciliacion, number>;
}

export function resumirNoche(mesas: readonly MesaConciliada[]): ResumenNoche {
  const porEstado: Record<EstadoConciliacion, number> = { coincide: 0, diferencia: 0, solo_pos: 0, solo_caja: 0 };
  let caja = 0;
  let pos = 0;
  for (const m of mesas) {
    caja += m.caja;
    pos += m.pos;
    porEstado[m.estado]++;
  }
  return { caja, pos, diferencia: pos - caja, porEstado };
}

/** Por qué una venta quedó sin cuenta, en palabras. */
export const MOTIVO_SIN_LIGAR: Record<string, string> = {
  varias_cuentas: "La mesa tenía varias cuentas a esa hora: elige cuál.",
  varias_sesiones: "Esa mesa tuvo varios grupos cerca de esa hora (o el ticket cae en dos): elige cuál.",
  sin_cuenta: "La mesa estaba abierta, pero sin cuentas.",
  sin_sesion: "La mesa no estaba abierta en caja a esa hora.",
  sin_noche: "No hay caja abierta para esa noche.",
  mesa_desconocida: "Esa mesa no existe en el antro.",
  mesa_ambigua: "El nombre de la mesa se parece a dos mesas del antro.",
  sin_mesa: "La venta no trae mesa.",
  desligada: "Se quitó la cuenta a mano.",
  caja_borrada: "La cuenta de caja a la que estaba ligada ya no existe.",
  ligada: "Ligada.",
};
