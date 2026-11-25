// Boleto del cliente: estado del QR, textos de la puerta y la lista de
// boletos guardados en el teléfono. Funciones puras, sin imports con "@/"
// para que Node las cargue en las pruebas (scripts/dev/probar-boleto-cliente.mjs).
//
// El estado lo calcula la base (obtener_reserva_por_qr, columna
// estado_boleto, sql/post-junta-2/40-boleto-estado.sql). Solo si la base
// todavía tiene la función vieja (sin esa columna) se usa el respaldo de
// aquí, con el status y la fecha.

export type EstadoBoleto = "vigente" | "usado" | "vencido";

export function esEstadoBoleto(valor: unknown): valor is EstadoBoleto {
  return valor === "vigente" || valor === "usado" || valor === "vencido";
}

// Respaldo para la función vieja: "usada" = ya entró; fecha anterior a la
// noche operativa (YYYY-MM-DD, corte 08:00) = vencido. Las fechas ISO se
// comparan como texto.
export function estadoBoletoRespaldo(
  reserva: { status: string | null | undefined; fecha: string },
  nocheOperativa: string,
): EstadoBoleto {
  if (reserva.status === "usada") return "usado";
  if (/^\d{4}-\d{2}-\d{2}$/.test(reserva.fecha) && reserva.fecha < nocheOperativa) return "vencido";
  return "vigente";
}

// Lo que dice el boleto en cada estado. "Lugar apartado" y no "reserva
// confirmada": la reserva nace pendiente y el QR no garantiza la entrada.
export const TEXTO_ESTADO: Record<EstadoBoleto, { etiqueta: string; titulo: string; detalle: string }> = {
  vigente: {
    etiqueta: "Vigente",
    titulo: "Lugar apartado",
    detalle: "Muestra este código en la puerta.",
  },
  usado: {
    etiqueta: "Ya se usó",
    titulo: "Este boleto ya se usó",
    detalle: "Ya se registró la entrada con este código. No sirve para volver a entrar.",
  },
  vencido: {
    etiqueta: "Vencido",
    titulo: "Este boleto ya venció",
    detalle: "Era para una noche que ya pasó. Si quieres ir otra vez, aparta un lugar nuevo.",
  },
};

// Va después de "El QR no garantiza el acceso." (en negritas).
export const AVISO_ACCESO =
  "Aparta tu lugar, pero el antro decide quién entra: derecho de admisión, código de vestimenta y edad mínima.";

export const AVISO_COVER =
  "El cover lo cobra el antro en la puerta, por su cuenta. AntroApp no te cobra nada.";

// "23:30:00" o "23:30" -> "11:30 p. m."; "01:00" -> "1:00 a. m.". Si no es
// una hora válida, null.
export function horaLegible(hora: string | null | undefined): string | null {
  if (!hora) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(hora.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const sufijo = h < 12 ? "a. m." : "p. m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${sufijo}`;
}

// Renglones "En la puerta" del boleto y de la confirmación. El cover llega
// ya como texto (textoCover de lib/cover.ts) para no depender de "@/".
export function renglonesPuerta(datos: {
  cover: string | null;
  tolerancia_hora?: string | null;
  edad_minima?: number | null;
  codigo_vestimenta?: string | null;
}): { etiqueta: string; valor: string }[] {
  const filas: { etiqueta: string; valor: string }[] = [];
  if (datos.cover) {
    // "Cover $350" -> "$350"; "Cover: consultar con el antro" -> "Consultar con el antro".
    const valor = datos.cover.replace(/^Cover:?\s*/, "") || datos.cover;
    filas.push({ etiqueta: "Cover", valor: valor.charAt(0).toUpperCase() + valor.slice(1) });
  }
  const hora = horaLegible(datos.tolerancia_hora);
  if (hora) filas.push({ etiqueta: "Llega antes de", valor: hora });
  if (datos.edad_minima != null && Number(datos.edad_minima) > 0) {
    filas.push({ etiqueta: "Edad mínima", valor: `${Number(datos.edad_minima)} años` });
  }
  const vestimenta = datos.codigo_vestimenta?.trim();
  if (vestimenta) filas.push({ etiqueta: "Vestimenta", valor: vestimenta });
  return filas;
}

// ---------------------------------------------------------------------------
// Boletos guardados en el teléfono (para quien reserva sin cuenta y recarga).
// Solo se guarda lo necesario para volver al boleto: el código, el antro, la
// fecha y las personas. Nunca el teléfono ni el nombre. Se purgan solos
// cuando su noche ya pasó y como máximo hay MAX_BOLETOS.
// ---------------------------------------------------------------------------

export const CLAVE_BOLETOS = "antroapp.boletos.v1";
export const MAX_BOLETOS = 10;

export interface BoletoGuardado {
  qr: string;
  clubId: string;
  clubNombre: string;
  fecha: string; // YYYY-MM-DD, la noche de la reserva
  personas: number;
  guardadoEn: number; // ms desde 1970
}

const RE_QR = /^antro-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function esCodigoQr(valor: unknown): valor is string {
  return typeof valor === "string" && RE_QR.test(valor);
}

function boletoValido(x: unknown): x is BoletoGuardado {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    esCodigoQr(b.qr) &&
    typeof b.clubId === "string" && RE_UUID.test(b.clubId) &&
    typeof b.clubNombre === "string" && b.clubNombre.length > 0 && b.clubNombre.length <= 120 &&
    typeof b.fecha === "string" && RE_FECHA.test(b.fecha) &&
    typeof b.personas === "number" && Number.isInteger(b.personas) && b.personas >= 1 && b.personas <= 20 &&
    typeof b.guardadoEn === "number" && Number.isFinite(b.guardadoEn)
  );
}

// Lee lo guardado sin confiar en ello: lo que no tenga la forma exacta se
// descarta (texto alterado, versión vieja, basura).
export function leerBoletos(crudo: string | null, nocheOperativa: string): BoletoGuardado[] {
  if (!crudo) return [];
  let datos: unknown;
  try {
    datos = JSON.parse(crudo);
  } catch {
    return [];
  }
  if (!Array.isArray(datos)) return [];
  return limpiar(datos.filter(boletoValido), nocheOperativa);
}

function limpiar(lista: BoletoGuardado[], nocheOperativa: string): BoletoGuardado[] {
  const vistos = new Set<string>();
  return lista
    .filter((b) => b.fecha >= nocheOperativa)
    .sort((a, b) => b.guardadoEn - a.guardadoEn)
    .filter((b) => (vistos.has(b.qr) ? false : (vistos.add(b.qr), true)))
    .slice(0, MAX_BOLETOS)
    .map((b) => ({ qr: b.qr, clubId: b.clubId, clubNombre: b.clubNombre, fecha: b.fecha, personas: b.personas, guardadoEn: b.guardadoEn }));
}

export function agregarBoleto(
  lista: BoletoGuardado[],
  nuevo: BoletoGuardado,
  nocheOperativa: string,
): BoletoGuardado[] {
  if (!boletoValido(nuevo)) return limpiar(lista, nocheOperativa);
  return limpiar([nuevo, ...lista.filter((b) => b.qr !== nuevo.qr)], nocheOperativa);
}

// Los de un antro, de la noche más próxima a la más lejana.
export function boletosDelClub(lista: BoletoGuardado[], clubId: string): BoletoGuardado[] {
  return lista.filter((b) => b.clubId === clubId).sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
}
