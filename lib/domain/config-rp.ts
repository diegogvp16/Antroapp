// Configuración por antro de los RPs (sql/post-junta/07-config-rp.sql):
// textos y validación de la regla de comisión. Sin React ni Supabase; no
// importa nada con "@/" para que las pruebas lo carguen con Node.

export type NivelVisibilidad = "estado" | "estado_monto" | "estado_monto_botellas";
export type TipoRegla = "porcentaje" | "fijo" | "cuota";

export interface Regla {
  tipo: TipoRegla;
  cuota: number;
  porcentaje_bp: number | null;
  monto_centavos: number | null;
}

export const OPCIONES_VISIBILIDAD: ReadonlyArray<{ valor: NivelVisibilidad; titulo: string; detalle: string }> = [
  { valor: "estado", titulo: "Solo el estado", detalle: "Si su cliente llegó, consumió o no llegó. Sin montos." },
  { valor: "estado_monto", titulo: "Estado y monto", detalle: "Además, cuánto consumió la mesa de su cliente." },
  { valor: "estado_monto_botellas", titulo: "Estado, monto y botellas", detalle: "Además, qué se pidió (cada renglón de consumo)." },
];

const pesos = (centavos: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: centavos % 100 === 0 ? 0 : 2 }).format(centavos / 100);
const porcentaje = (bp: number) => `${(bp / 100).toLocaleString("es-MX", { maximumFractionDigits: 2 })} %`;

// "10 % del consumo" · "$150 por reserva que consume" ·
// "Las primeras 4 de la semana no pagan; desde la 5.ª, $200 cada una".
export function describirRegla(r: Regla): string {
  if (r.tipo === "porcentaje") return `${porcentaje(r.porcentaje_bp ?? 0)} del consumo de cada reserva`;
  if (r.tipo === "fijo") return `${pesos(r.monto_centavos ?? 0)} por cada reserva que consume`;
  return `Las primeras ${r.cuota} reservas de la semana no pagan; desde la ${r.cuota + 1}.ª, ${pesos(r.monto_centavos ?? 0)} cada una`;
}

// "12.5" → 1250 puntos base (sin flotantes en la base). Nulo si no es válido.
export function porcentajeABp(texto: string): number | null {
  const t = texto.trim().replace(",", ".").replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp >= 1 && bp <= 10000 ? bp : null;
}

// Valida lo que se va a mandar; devuelve el mensaje de error o null.
export function validarRegla(r: Regla): string | null {
  if (r.tipo === "porcentaje") return r.porcentaje_bp && r.porcentaje_bp >= 1 && r.porcentaje_bp <= 10000 ? null : "Escribe un porcentaje entre 0.01 y 100.";
  if (!r.monto_centavos || r.monto_centavos < 1 || r.monto_centavos > 10_000_000) return "Escribe un monto entre $0.01 y $100,000.";
  if (r.tipo === "cuota" && !(Number.isInteger(r.cuota) && r.cuota >= 1 && r.cuota <= 100)) return "La cuota va de 1 a 100 reservas.";
  return null;
}
