// Fase 2: catálogo, existencias y propinas. Funciones puras (sin React ni
// Supabase). Dinero en centavos.

import type { CajaPago, MetodoPago, Producto } from "@/lib/domain/caja";

// Existencias en o bajo el mínimo (incluye negativas: se vendió más de lo
// que el conteo decía). Un mínimo de 0 solo avisa cuando ya no hay.
export function bajoStock(p: Pick<Producto, "existencias" | "existencias_minimas">): boolean {
  return p.existencias <= p.existencias_minimas;
}

export function textoExistencias(p: Pick<Producto, "existencias">): string {
  if (p.existencias < 0) return `Faltan ${-p.existencias} (revisa el conteo)`;
  if (p.existencias === 0) return "Agotado";
  return `Quedan ${p.existencias}`;
}

// Categorías en orden alfabético, sin repetir (sin importar mayúsculas).
export function categorias(productos: Producto[]): string[] {
  const vistas = new Map<string, string>();
  for (const p of productos) {
    const k = p.categoria.trim().toLowerCase();
    if (!vistas.has(k)) vistas.set(k, p.categoria.trim());
  }
  return [...vistas.values()].sort((a, b) => a.localeCompare(b, "es"));
}

// Búsqueda sin acentos ni mayúsculas, por nombre o categoría.
function normal(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function filtrarCatalogo(productos: Producto[], categoria: string | null, busqueda: string): Producto[] {
  const b = normal(busqueda);
  return productos
    .filter((p) => p.activo)
    .filter((p) => !categoria || normal(p.categoria) === normal(categoria))
    .filter((p) => !b || normal(p.nombre).includes(b) || normal(p.categoria).includes(b))
    .sort((a, b2) => a.nombre.localeCompare(b2.nombre, "es"));
}

// Propinas vigentes (sin anulados), por forma de pago y en total.
export function propinas(pagos: CajaPago[]): { total: number; porMetodo: Record<MetodoPago, number> } {
  const porMetodo: Record<MetodoPago, number> = { efectivo: 0, tarjeta: 0, otro: 0 };
  for (const p of pagos) {
    if (p.anulado) continue;
    porMetodo[p.metodo] += p.propina_centavos ?? 0;
  }
  return { total: porMetodo.efectivo + porMetodo.tarjeta + porMetodo.otro, porMetodo };
}
