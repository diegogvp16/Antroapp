// Clave de idempotencia de un movimiento de caja (uuid v4). La app la crea
// una vez por captura y la repite en cada reintento: si la base ya guardó
// ese movimiento, devuelve el mismo y no lo duplica
// (sql/2026-11-21-caja-idempotencia.sql).
export function nuevaClave(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  // randomUUID solo existe en contexto seguro (https o localhost); en otro
  // caso se arma igual con getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
