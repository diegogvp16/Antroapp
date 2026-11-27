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

// ---------------------------------------------------------------------------
// Bloque 8 (sql/post-junta-3/80-inventario.sql): entradas, mermas, conteos,
// historial y reporte de la noche. Todo con la bandera «inventario».
// ---------------------------------------------------------------------------

export type TipoMovimiento = "alta" | "ajuste" | "venta" | "anulacion" | "entrada" | "merma" | "conteo";

export const TIPO_MOVIMIENTO_LABEL: Record<TipoMovimiento, string> = {
  alta: "Existencias iniciales",
  ajuste: "Ajuste",
  venta: "Venta",
  anulacion: "Venta anulada",
  entrada: "Entrada",
  merma: "Merma",
  conteo: "Conteo",
};

export const esTipoMovimiento = (v: unknown): v is TipoMovimiento => typeof v === "string" && v in TIPO_MOVIMIENTO_LABEL;

// Mismos límites que la base.
export const MAX_CANTIDAD_MOVIMIENTO = 100_000;
export const MAX_CONTEO = 1_000_000;

// Entero escrito por una persona ("12", " 12 "); null si no es un entero >= 0.
export function leerEntero(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d{1,7}$/.test(t)) return null;
  return Number(t);
}

export type MovimientoCaptura =
  | { tipo: "entrada"; cantidad: string }
  | { tipo: "merma"; cantidad: string; motivo: string }
  | { tipo: "conteo"; contado: string; motivo: string; existencias: number };

// Qué le falta a la captura para poder guardarse (null = lista). La base
// vuelve a revisar todo; esto solo evita mandar algo que sabemos que falla.
export function errorMovimiento(m: MovimientoCaptura): string | null {
  if (m.tipo === "conteo") {
    const contado = leerEntero(m.contado);
    if (contado === null || contado > MAX_CONTEO) return "Escribe cuántas hay (un número entero, 0 o más).";
    if (contado !== m.existencias && m.motivo.trim().length < 3) return "El conteo no coincide: escribe el motivo.";
    return null;
  }
  const cantidad = leerEntero(m.cantidad);
  if (cantidad === null || cantidad < 1 || cantidad > MAX_CANTIDAD_MOVIMIENTO) return "Escribe una cantidad entera de 1 a 100,000.";
  if (m.tipo === "merma" && m.motivo.trim().length < 3) return "Escribe el motivo de la merma.";
  return null;
}

// Diferencia de un conteo contra lo que dice el sistema (positiva: sobran).
export function textoDiferencia(dif: number): string {
  if (dif === 0) return "Cuadra con el sistema";
  return dif > 0 ? `Sobran ${dif}` : `Faltan ${-dif}`;
}

// Fila de inventario_reporte_noche.
export interface FilaReporteInventario {
  producto_id: string;
  nombre: string;
  categoria: string;
  activo: boolean;
  vendidos: number;
  vendido_centavos: number;
  anulados: number;
  entradas: number;
  mermas: number;
  diferencias: number;
  existencias: number;
  existencias_minimas: number;
}

// Totales del reporte (el bigint de la base puede llegar como texto: se
// normaliza con Number).
export function totalesReporteInventario(filas: FilaReporteInventario[]) {
  return filas.reduce(
    (t, f) => ({
      vendidos: t.vendidos + Number(f.vendidos),
      vendido_centavos: t.vendido_centavos + Number(f.vendido_centavos),
      anulados: t.anulados + Number(f.anulados),
      entradas: t.entradas + Number(f.entradas),
      mermas: t.mermas + Number(f.mermas),
      bajos: t.bajos + (f.activo && bajoStock(f) ? 1 : 0),
    }),
    { vendidos: 0, vendido_centavos: 0, anulados: 0, entradas: 0, mermas: 0, bajos: 0 },
  );
}

// Solo lo que se movió esa noche (para no listar todo el catálogo).
export function conMovimiento(f: FilaReporteInventario): boolean {
  return Number(f.vendidos) !== 0 || Number(f.anulados) !== 0 || Number(f.entradas) !== 0 || Number(f.mermas) !== 0 || Number(f.diferencias) !== 0;
}
