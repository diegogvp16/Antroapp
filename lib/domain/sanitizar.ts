// Quita datos personales de un texto antes de guardarlo (errores de
// pantalla, rutas). Puro, sin dependencias.
export function sinDatosPersonales(texto: string): string {
  return texto
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]")
    .replace(/\b(Bearer|bearer)\s+[A-Za-z0-9._-]{10,}/g, "$1 [token]")
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "[llave]")
    .replace(/\bwhsec_[A-Za-z0-9]+/g, "[llave]")
    // Teléfonos: 10 o más dígitos (con espacios o guiones), sin confundir fechas.
    .replace(/\+?\d[\d\s-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 && !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) ? "[número]" : m));
}

// Ruta sin parámetros de búsqueda (pueden llevar correos o códigos).
export function rutaSinParametros(ruta: string): string {
  return ruta.split(/[?#]/)[0];
}
