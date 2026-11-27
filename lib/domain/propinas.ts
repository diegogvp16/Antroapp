// Propinas (bloque 8, sql/post-junta-3/81-propinas.sql). Funciones puras,
// sin React ni Supabase. Dinero en centavos. Todo con la bandera «propinas».
//
// Las propinas van APARTE del consumo y del cobro: no cambian el saldo, ni
// el cuadre, ni la comisión del RP. Dos orígenes: la que se captura al
// cobrar (caja_pagos.propina_centavos) y la propina suelta (caja_propinas).

import type { CajaPago, MetodoPago } from "@/lib/domain/caja";

export interface CajaPropina {
  id: string;
  sesion_id: string | null;
  cuenta_id: string | null;
  metodo: MetodoPago;
  monto_centavos: number;
  nota: string | null;
  registrado_por: string;
  registrado_en: string;
  anulado: boolean;
  motivo_anulacion: string | null;
}

export const COLUMNAS_PROPINA =
  "id, sesion_id, cuenta_id, metodo, monto_centavos, nota, registrado_por, registrado_en, anulado, motivo_anulacion";

export type PorMetodo = Record<MetodoPago, number>;

// Total vigente (sin anuladas) de las dos fuentes, por forma de pago. La
// propina de un cobro también puede estar anulada sola (propinas_cobro_anuladas):
// esos cobros vienen en cobrosAnulados.
export function totalPropinas(
  pagos: Pick<CajaPago, "id" | "anulado" | "metodo" | "propina_centavos">[],
  sueltas: Pick<CajaPropina, "anulado" | "metodo" | "monto_centavos">[],
  cobrosAnulados: ReadonlySet<string> = new Set(),
): { total: number; porMetodo: PorMetodo } {
  const porMetodo: PorMetodo = { efectivo: 0, tarjeta: 0, otro: 0 };
  for (const p of pagos) if (!p.anulado && !cobrosAnulados.has(p.id)) porMetodo[p.metodo] += Number(p.propina_centavos ?? 0);
  for (const s of sueltas) if (!s.anulado) porMetodo[s.metodo] += Number(s.monto_centavos);
  return { total: porMetodo.efectivo + porMetodo.tarjeta + porMetodo.otro, porMetodo };
}

export interface ConfigPropinas {
  pct_personal: number;
  pct_rp: number;
  pct_casa: number;
  incluye_gerente: boolean;
}

export const CONFIG_POR_DEFECTO: ConfigPropinas = { pct_personal: 100, pct_rp: 0, pct_casa: 0, incluye_gerente: false };

// Mismas reglas que propinas_config_guardar: enteros de 0 a 100 que suman 100.
export function errorConfig(c: Pick<ConfigPropinas, "pct_personal" | "pct_rp" | "pct_casa">): string | null {
  const v = [c.pct_personal, c.pct_rp, c.pct_casa];
  if (v.some((x) => !Number.isInteger(x) || x < 0 || x > 100)) return "Cada porcentaje es un entero de 0 a 100.";
  const suma = v[0] + v[1] + v[2];
  if (suma !== 100) return `Los porcentajes deben sumar 100 (suman ${suma}).`;
  return null;
}

// "70 % al personal · 20 % al RP de la cuenta · 10 % a la casa".
export function describirRegla(c: ConfigPropinas): string {
  const partes = [`${c.pct_personal} % al personal${c.incluye_gerente ? " (con gerente)" : ""}`];
  if (c.pct_rp > 0) partes.push(`${c.pct_rp} % al RP de la cuenta`);
  if (c.pct_casa > 0) partes.push(`${c.pct_casa} % a la casa`);
  return partes.join(" · ");
}

export interface PersonaReparto {
  id: string;
  nombre: string;
  rol: string;
  trabajo: boolean;
}

// Sugerencia de quién entra al reparto: quien trabajó en la caja esa noche.
export function sugerirParticipantes(personal: PersonaReparto[]): string[] {
  return personal.filter((p) => p.trabajo).map((p) => p.id);
}

export interface LineaReparto {
  tipo: "personal" | "rp" | "casa";
  profile_id: string | null;
  nombre: string;
  monto_centavos: number;
}

// Suma de las líneas (la base garantiza que es el total de propinas).
export function sumaLineas(lineas: Pick<LineaReparto, "monto_centavos">[]): number {
  return lineas.reduce((s, l) => s + Number(l.monto_centavos), 0);
}

export const TIPO_LINEA_LABEL: Record<LineaReparto["tipo"], string> = { personal: "Personal", rp: "RP", casa: "Casa" };

// Orden para mostrar: personal, RPs y la casa al final; dentro, por nombre.
export function ordenarLineas<T extends Pick<LineaReparto, "tipo" | "nombre">>(lineas: T[]): T[] {
  const peso = { personal: 0, rp: 1, casa: 2 } as const;
  return [...lineas].sort((a, b) => peso[a.tipo] - peso[b.tipo] || a.nombre.localeCompare(b.nombre, "es"));
}

// Porcentaje escrito por una persona ("70", " 70 "): entero de 0 a 100 o null.
export function leerPorcentaje(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 100 ? n : null;
}
