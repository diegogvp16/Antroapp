// Formulario de contacto de /para-clubes: las mismas reglas que pone la base
// (para_clubes_contacto_enviar, sql/post-junta-3/50-para-clubes.sql). Aquí
// solo sirven para avisar antes de mandar; la que decide es la base.

export type CampoContacto = "nombre" | "club" | "ciudad" | "correo" | "telefono" | "mensaje";

export interface DatosContacto {
  nombre: string;
  club: string;
  ciudad: string;
  correo: string;
  telefono: string;
  mensaje: string;
}

export const MENSAJE_MAXIMO = 1000;

const limpiar = (s: string) => s.replace(/\s+/g, " ").trim();
const CON_ENLACE = /(https?:|www\.|:\/\/|[<>])/i;
const CORREO = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function erroresContacto(d: DatosContacto): Partial<Record<CampoContacto, string>> {
  const e: Partial<Record<CampoContacto, string>> = {};
  const nombre = limpiar(d.nombre);
  const club = limpiar(d.club);
  const ciudad = limpiar(d.ciudad);
  const correo = d.correo.trim().toLowerCase();
  const tel = d.telefono.replace(/\D/g, "");
  const mensaje = d.mensaje.trim();

  if (nombre.length < 2 || nombre.length > 80) e.nombre = "Escribe tu nombre (de 2 a 80 letras).";
  else if (CON_ENLACE.test(nombre)) e.nombre = "Quita los enlaces y los símbolos < >.";
  if (club.length < 2 || club.length > 80) e.club = "Escribe el nombre de tu antro (de 2 a 80 letras).";
  else if (CON_ENLACE.test(club)) e.club = "Quita los enlaces y los símbolos < >.";
  if (ciudad.length < 2 || ciudad.length > 60) e.ciudad = "Escribe la ciudad (de 2 a 60 letras).";
  else if (CON_ENLACE.test(ciudad)) e.ciudad = "Quita los enlaces y los símbolos < >.";
  if (correo.length > 120 || !CORREO.test(correo)) e.correo = "Revisa tu correo (por ejemplo, nombre@antro.mx).";
  if (tel && (tel.length < 10 || tel.length > 15)) e.telefono = "Escribe un teléfono de 10 dígitos, o déjalo vacío.";
  if (mensaje.length > MENSAJE_MAXIMO) e.mensaje = "El mensaje es muy largo (máximo 1,000 caracteres).";
  else if ((mensaje.match(/(https?:\/\/|www\.)/gi) ?? []).length > 2) e.mensaje = "El mensaje tiene demasiados enlaces.";
  return e;
}
