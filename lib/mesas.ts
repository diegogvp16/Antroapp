// Prueba de auto-deploy desde GitHub (19/11/2026); este comentario no cambia nada.
// Orden "natural" de mesas: 1, 2, 3 … 10, 11, y después las de nombre
// (VIP 1, VIP 2…), en vez del orden de texto de la base (1, 10, 11, 2…).
const comparador = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

export function ordenarMesas<T extends { numero: string | number }>(mesas: T[]): T[] {
  return [...mesas].sort((a, b) => comparador.compare(String(a.numero), String(b.numero)));
}
