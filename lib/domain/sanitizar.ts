// Quita datos personales de un texto antes de guardarlo (errores de
// pantalla, rutas). Puro, sin dependencias.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function sinDatosPersonales(texto: string): string {
  const limpio = texto
    // Postgres repite la fila completa en las violaciones de restricción
    // ("Failing row contains (…)"): nombre, teléfono, QR. Se quita entera.
    .replace(/(Failing row contains\s*)\([\s\S]*?\)(?=\.|$|\s)/gi, "$1([fila])")
    // El código del boleto (/r/antro-<uuid>) y el QR de asistencia del RP
    // funcionan como llave: quien los tiene abre la reserva o marca asistencia.
    .replace(/\bantro-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "antro-[qr]")
    .replace(/\brp-attendance-[0-9a-f-]{36}\b/gi, "rp-attendance-[qr]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]")
    .replace(/\b(Bearer|bearer)\s+[A-Za-z0-9._-]{10,}/g, "$1 [token]")
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "[llave]")
    .replace(/\bwhsec_[A-Za-z0-9]+/g, "[llave]");
  // Teléfonos: 10 o más dígitos (con espacios o guiones), sin confundir
  // fechas ni los ids (uuid) de antros, mesas o reservas, que no son datos
  // personales y sirven para depurar: se apartan antes y se regresan después.
  const ids: string[] = [];
  return limpio
    .replace(UUID, (m) => `\u0000${ids.push(m) - 1}\u0000`)
    .replace(/\+?\d[\d\s-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 && !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) ? "[número]" : m))
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => ids[Number(i)]);
}

// Ruta sin parámetros de búsqueda (pueden llevar correos o códigos).
export function rutaSinParametros(ruta: string): string {
  return ruta.split(/[?#]/)[0];
}
