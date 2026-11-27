// Lista negra y no-show por antro (bandera 'lista_negra',
// sql/post-junta-3/40-lista-negra.sql). La base decide todo (quién bloquea,
// si una reserva se rechaza, cuántos no-shows hay); aquí solo los textos,
// las validaciones de los formularios y una copia del conteo para las
// pruebas (scripts/dev/probar-clientes-dominio.mjs). Funciones puras.

// Lo que ve quien reserva (cliente o sin cuenta) si el teléfono está
// bloqueado en ese antro: neutro, sin "bloqueado", sin motivo.
export const MENSAJE_RECHAZO_CLIENTE =
  "No pudimos apartar tu lugar en este antro. Comunícate directamente con el antro.";
// Lo que ve el RP: más claro, también sin motivo.
export const MENSAJE_RECHAZO_RP =
  "Este cliente no puede reservar en este antro por ahora. Si crees que es un error, habla con tu gerente.";

export type EstadoReserva = "consumio" | "llego_sin_consumo" | "no_llego" | "por_llegar";

// Misma definición que rp_mis_reservas y que _clientes_estado en la base.
export function estadoReserva(r: {
  fecha: string; // YYYY-MM-DD (noche de la reserva)
  entro: boolean; // puerta_estado 'entro' o status 'usada'
  consumoCentavos: number; // consumo no anulado en caja
  nocheCerrada: boolean; // caja de esa noche cerrada
  hoy: string; // noche operativa del antro (corte 08:00)
}): EstadoReserva {
  if (r.consumoCentavos > 0) return "consumio";
  if (r.entro) return "llego_sin_consumo";
  if (r.fecha < r.hoy || r.nocheCerrada) return "no_llego";
  return "por_llegar";
}

export const esNoShow = (r: Parameters<typeof estadoReserva>[0]) => estadoReserva(r) === "no_llego";

// No-shows por teléfono (clave ya normalizada) desde una noche (incluida).
// Copia de _lista_negra_noshows (sin el "perdón" por desbloqueo):
//   no_shows = NOCHES distintas sin llegar (tres reservas de una noche = 1);
//   cuentan  = noches distintas de reservas con cuenta o de RP (las sin
//              cuenta no cuentan para el bloqueo automático).
export function contarNoShows(
  reservas: (Parameters<typeof estadoReserva>[0] & { telefono: string | null; verificada?: boolean })[],
  desde: string,
): Map<string, { no_shows: number; cuentan: number }> {
  const noches = new Map<string, { todas: Set<string>; verificadas: Set<string> }>();
  for (const r of reservas) {
    if (!r.telefono || r.fecha < desde || r.fecha > r.hoy) continue;
    if (!esNoShow(r)) continue;
    const n = noches.get(r.telefono) ?? { todas: new Set<string>(), verificadas: new Set<string>() };
    n.todas.add(r.fecha);
    if (r.verificada) n.verificadas.add(r.fecha);
    noches.set(r.telefono, n);
  }
  return new Map([...noches].map(([t, n]) => [t, { no_shows: n.todas.size, cuentan: n.verificadas.size }]));
}

export interface PoliticaNoShow {
  avisar_desde: number;
  ventana_dias: number;
  bloquear_desde: number | null; // null = sin bloqueo automático
}

export const POLITICA_FABRICA: PoliticaNoShow = { avisar_desde: 2, ventana_dias: 90, bloquear_desde: null };

// Mismas reglas que lista_negra_politica_guardar.
export function validarPolitica(p: PoliticaNoShow): string[] {
  const e: string[] = [];
  const entero = (n: unknown) => typeof n === "number" && Number.isInteger(n);
  if (!entero(p.avisar_desde) || p.avisar_desde < 1 || p.avisar_desde > 20) e.push("El aviso va de 1 a 20 no-shows.");
  if (!entero(p.ventana_dias) || p.ventana_dias < 7 || p.ventana_dias > 365) e.push("La ventana va de 7 a 365 días.");
  if (p.bloquear_desde !== null) {
    if (!entero(p.bloquear_desde) || p.bloquear_desde < 1 || p.bloquear_desde > 50 || p.bloquear_desde < p.avisar_desde) {
      e.push("El bloqueo automático va de 1 a 50 no-shows y no puede ser menor que el aviso.");
    }
  }
  return e;
}

export function validarMotivo(motivo: string): string | null {
  const m = motivo.trim();
  if (m.length < 3) return "Escribe el motivo (mínimo 3 letras).";
  if (m.length > 300) return "El motivo es muy largo (máximo 300).";
  return null;
}

export const VENCIMIENTOS: { dias: number | null; etiqueta: string }[] = [
  { dias: null, etiqueta: "Sin vencimiento" },
  { dias: 30, etiqueta: "30 días" },
  { dias: 90, etiqueta: "90 días" },
  { dias: 365, etiqueta: "1 año" },
];

export function textoNoShows(n: number, ventanaDias: number): string {
  if (n <= 0) return `Sin no-shows en los últimos ${ventanaDias} días`;
  return `${n} ${n === 1 ? "noche" : "noches"} sin llegar en los últimos ${ventanaDias} días`;
}

export const ESTADO_BLOQUEO: Record<string, string> = {
  activo: "Activo",
  vencido: "Vencido",
  desbloqueado: "Desbloqueado",
};

export const TIPO_EVENTO: Record<string, string> = {
  bloqueo: "Bloqueo",
  desbloqueo: "Desbloqueo",
  ver_telefono: "Vio el teléfono completo",
  politica: "Cambio de política",
  tachado: "Motivo tachado (admin)",
};
