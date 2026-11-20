// Límite de intentos de login: reglas puras (sin Supabase), para poder
// probarlas sin red.

export const VENTANA_MINUTOS = 15;
// Bloqueo estricto por correo + IP: frena a quien adivina desde un equipo.
export const MAX_FALLOS_POR_CORREO_E_IP = 5;
// Bloqueo holgado por correo (de cualquier IP): con 5 bastaría que alguien
// fallara a propósito para dejar fuera al dueño de la cuenta toda la noche.
export const MAX_FALLOS_POR_CORREO = 30;
export const MAX_FALLOS_POR_IP = 20;

export interface Intento {
  exito: boolean;
  creado_en: string; // ISO
}

// Fallos seguidos desde el último éxito (los intentos vienen del más
// reciente al más viejo, todos dentro de la ventana).
export function fallosDesdeUltimoExito(intentos: Intento[]): Intento[] {
  const fallos: Intento[] = [];
  for (const i of intentos) {
    if (i.exito) break;
    fallos.push(i);
  }
  return fallos;
}

// Minutos que faltan para volver a intentar, o 0 si no está bloqueado.
export function minutosDeBloqueo(
  fallos: Intento[],
  maximo: number,
  ahora: Date = new Date(),
): number {
  if (fallos.length < maximo) return 0;
  // El bloqueo dura la ventana completa contada desde el fallo que llegó al
  // límite (el N-ésimo más reciente).
  const llave = fallos[maximo - 1];
  const libreEn = Date.parse(llave.creado_en) + VENTANA_MINUTOS * 60_000;
  return Math.max(0, Math.ceil((libreEn - ahora.getTime()) / 60_000));
}

export function mensajeBloqueo(minutos: number): string {
  return `Demasiados intentos. Espera ${minutos} ${minutos === 1 ? "minuto" : "minutos"} e intenta de nuevo.`;
}
