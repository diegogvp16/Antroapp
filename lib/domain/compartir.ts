// Mensaje para compartir una reserva por WhatsApp (RP a su cliente, o el
// cliente a quien quiera). Corto, con la fecha legible, el enlace al QR y el
// aviso de que el QR no garantiza la entrada (CLAUDE.md, reglas de negocio).
// Funciones puras.

import { enlaceWhatsApp } from "@/lib/domain/rp-reservas";

const formatoFechaLarga = new Intl.DateTimeFormat("es-MX", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

// "2026-11-25" -> "miércoles 25 de noviembre". Si no es una fecha válida, la
// devuelve tal cual.
export function fechaLarga(fechaISO: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaISO);
  if (!m) return fechaISO;
  const partes: Record<string, string> = {};
  for (const p of formatoFechaLarga.formatToParts(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))))) {
    partes[p.type] = p.value;
  }
  return `${partes.weekday} ${partes.day} de ${partes.month}`;
}

export const AVISO_QR =
  "El QR aparta tu lugar, pero no garantiza la entrada: el antro decide el acceso (código de vestimenta, edad mínima y derecho de admisión).";

export function mensajeReserva({
  quien,
  antro,
  cliente,
  fecha,
  personas,
  enlace,
}: {
  // "rp": el RP se lo manda a su cliente; "cliente": el cliente lo comparte.
  quien: "rp" | "cliente";
  antro: string;
  cliente: string;
  fecha: string;
  personas: number;
  enlace: string;
}): string {
  const nombre = cliente.trim().split(/\s+/)[0] || cliente.trim();
  const inicio =
    quien === "rp" ? `Hola ${nombre}, ya quedó tu reserva en ${antro}:` : `Reserva en ${antro} a nombre de ${cliente.trim()}:`;
  return [
    inicio,
    `${fechaLarga(fecha)} · ${personas} ${personas === 1 ? "persona" : "personas"}`,
    "",
    "Código QR para la puerta:",
    enlace,
    "",
    AVISO_QR,
  ].join("\n");
}

// Al teléfono del cliente si lo hay (10 dígitos de México); si no, WhatsApp
// pregunta a quién mandarlo.
export function enlaceCompartir(mensaje: string, telefono: string | null = null): string {
  return enlaceWhatsApp(telefono, mensaje) ?? `https://wa.me/?text=${encodeURIComponent(mensaje)}`;
}
