// Mensajes de WhatsApp por antro (bandera 'whatsapp',
// sql/post-junta-3/60-whatsapp-plantillas.sql). SIN API: solo se arman
// enlaces wa.me con el texto ya escrito. Abrir el enlace no manda nada; la
// persona revisa el mensaje y lo envía desde su propio WhatsApp.
//
// Funciones puras (las prueba scripts/dev/probar-clientes-dominio.mjs).
// Las reglas de validación son las mismas que whatsapp_plantilla_guardar en
// la base; si cambian aquí, cambian allá.

import { AVISO_QR, fechaLarga } from "@/lib/domain/compartir";

export const TIPOS_PLANTILLA = ["confirmacion", "recordatorio", "no_show"] as const;
export type TipoPlantilla = (typeof TIPOS_PLANTILLA)[number];

export const esTipoPlantilla = (v: unknown): v is TipoPlantilla =>
  typeof v === "string" && (TIPOS_PLANTILLA as readonly string[]).includes(v);

export const INFO_PLANTILLA: Record<TipoPlantilla, { nombre: string; uso: string }> = {
  confirmacion: { nombre: "Confirmación", uso: "Cuando se aparta el lugar: lleva el enlace al QR." },
  recordatorio: { nombre: "Recordatorio", uso: "El día de la reserva, antes de abrir." },
  no_show: { nombre: "Aviso de no-show", uso: "Al día siguiente, a quien no llegó." },
};

export const VARIABLES_PLANTILLA = ["nombre", "antro", "fecha", "hora", "personas", "enlace_boleto"] as const;
export type VariablePlantilla = (typeof VARIABLES_PLANTILLA)[number];

export const INFO_VARIABLE: Record<VariablePlantilla, string> = {
  nombre: "Nombre del cliente (solo el primero)",
  antro: "Nombre del antro",
  fecha: "Noche de la reserva («miércoles 25 de noviembre»)",
  hora: "Horario del antro (como está en su perfil)",
  personas: "Personas («4 personas»)",
  enlace_boleto: "Enlace al QR de la reserva",
};

export const MAX_PLANTILLA = 1000;

// Textos de fábrica: valen mientras el antro no guarde uno propio.
export const PLANTILLAS_FABRICA: Record<TipoPlantilla, string> = {
  confirmacion: [
    "Hola {nombre}, ya quedó tu lugar en {antro}:",
    "{fecha} · {personas}",
    "",
    "Código QR para la puerta:",
    "{enlace_boleto}",
    "",
    AVISO_QR,
  ].join("\n"),
  recordatorio: [
    "Hola {nombre}, te recordamos tu lugar en {antro} para el {fecha} ({personas}).",
    "Horario: {hora}",
    "",
    "Tu QR para la puerta:",
    "{enlace_boleto}",
    "",
    "Si ya no vienes, avísanos por aquí para liberar el lugar.",
  ].join("\n"),
  no_show: [
    "Hola {nombre}, te esperábamos en {antro} el {fecha} y no te vimos.",
    "Si no puedes venir a una reserva, avísanos antes para liberar el lugar. ¡Te esperamos otra noche!",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Teléfonos
// ---------------------------------------------------------------------------

// 10 dígitos de México SOLO si el número viene en una forma conocida
// (tomando solo los dígitos): 10 dígitos; 52 + 10; 521 + 10; 044/045 + 10;
// 01 + 10. Cualquier otra cosa (un número de otro país, dígitos de más o de
// menos): null. No se recorta a "los últimos 10": eso convertía un
// +1 212 555 1234 en un número de México que no es de nadie.
export function normalizarTelefonoMx(telefono: string | null | undefined): string | null {
  const d = (telefono ?? "").replace(/\D/g, "");
  if (/^\d{10}$/.test(d)) return d;
  if (/^52\d{10}$/.test(d)) return d.slice(2);
  if (/^521\d{10}$/.test(d)) return d.slice(3);
  if (/^04[45]\d{10}$/.test(d)) return d.slice(3);
  if (/^01\d{10}$/.test(d)) return d.slice(2);
  return null;
}

// Clave para la lista negra, igual que lista_negra_tel en la base: los 10
// dígitos si es de México; si no, todos los dígitos (de 8 a 15); si no, null.
export function claveTelefono(telefono: string | null | undefined): string | null {
  const mx = normalizarTelefonoMx(telefono);
  if (mx) return mx;
  const d = (telefono ?? "").replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : null;
}

// Número para wa.me: 52 + 10 dígitos (sin "+" ni el 1 viejo de celulares).
// Solo números de México: con cualquier otro, null (el enlace pasa a ser
// "compartir" sin destinatario y la persona elige a quién).
export function numeroWhatsApp(telefono: string | null | undefined): string | null {
  const diez = normalizarTelefonoMx(telefono);
  return diez ? `52${diez}` : null;
}

// Enlace wa.me con el texto. Sin teléfono válido: wa.me/?text=…, que deja
// elegir a quién mandarlo. `directo` dice cuál de los dos es.
export function enlaceWa(telefono: string | null | undefined, mensaje: string): { href: string; directo: boolean } {
  const numero = numeroWhatsApp(telefono);
  const texto = encodeURIComponent(mensaje);
  return numero ? { href: `https://wa.me/${numero}?text=${texto}`, directo: true } : { href: `https://wa.me/?text=${texto}`, directo: false };
}

// "***1234": para listas. Igual que _lista_negra_mascara en la base.
export function mascaraTelefono(telefono: string | null | undefined): string | null {
  const clave = claveTelefono(telefono);
  return clave ? `***${clave.slice(-4)}` : null;
}

// Primer nombre para {nombre}: cliente_nombre lo escribe cualquiera (también
// una reserva sin cuenta), así que solo se usa si son letras (con acentos) y
// hasta 30; si no (p. ej. un enlace), queda vacío. Así nadie mete un enlace
// o un texto raro en el mensaje que el staff manda desde su WhatsApp.
export function nombreSeguro(clienteNombre: string | null | undefined): string {
  const primero = (clienteNombre ?? "").trim().split(/\s+/)[0] ?? "";
  return /^\p{L}{1,30}$/u.test(primero) ? primero : "";
}

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

const RE_VARIABLE = /\{([^{}]*)\}/g;

export interface ResultadoValidacion {
  ok: boolean;
  errores: string[];
  desconocidas: string[];
  largo: number;
}

export function validarPlantilla(texto: string): ResultadoValidacion {
  const limpio = texto.trim();
  const errores: string[] = [];
  const desconocidas: string[] = [];
  if (limpio.length === 0) errores.push("El mensaje no puede ir vacío.");
  if (limpio.length > MAX_PLANTILLA) errores.push(`El mensaje es muy largo (${limpio.length} de ${MAX_PLANTILLA} caracteres).`);
  for (const m of limpio.matchAll(RE_VARIABLE)) {
    const nombre = m[1];
    if (!(VARIABLES_PLANTILLA as readonly string[]).includes(nombre) && !desconocidas.includes(nombre)) desconocidas.push(nombre);
  }
  if (desconocidas.length) {
    errores.push(`Variable que no existe: ${desconocidas.map((d) => `{${d}}`).join(", ")}.`);
  }
  // Llaves sueltas: lo que queda al quitar (en una sola pasada) todo lo que
  // parece variable. "{{nombre}}" deja "{}": suelta, igual que en la base.
  if (/[{}]/.test(limpio.replace(RE_VARIABLE, ""))) errores.push("Hay una llave { o } suelta.");
  return { ok: errores.length === 0, errores, desconocidas, largo: limpio.length };
}

export type DatosPlantilla = Record<VariablePlantilla, string>;

// Reemplaza las variables conocidas; las que no tienen dato quedan vacías
// (y no dejan un espacio antes de la coma: «Hola , …» → «Hola, …»).
export function renderPlantilla(texto: string, datos: Partial<DatosPlantilla>): string {
  return texto
    .replace(RE_VARIABLE, (todo, nombre: string) =>
      (VARIABLES_PLANTILLA as readonly string[]).includes(nombre) ? (datos[nombre as VariablePlantilla] ?? "").trim() : todo,
    )
    .replace(/ +([,.;:!?])/g, "$1");
}

export function textoPersonas(n: number | null | undefined): string {
  const k = Number.isFinite(n) && (n as number) > 0 ? Math.trunc(n as number) : 0;
  if (k === 0) return "";
  return `${k} ${k === 1 ? "persona" : "personas"}`;
}

// Datos de una reserva para la plantilla.
export function datosDeReserva(r: {
  cliente_nombre: string | null | undefined;
  antro: string | null | undefined;
  fecha: string | null | undefined;
  personas: number | null | undefined;
  horario?: string | null;
  qr_code?: string | null;
  origen: string; // window.location.origin
}): DatosPlantilla {
  return {
    nombre: nombreSeguro(r.cliente_nombre),
    antro: (r.antro ?? "").trim() || "el antro",
    fecha: r.fecha ? fechaLarga(r.fecha) : "",
    hora: (r.horario ?? "").trim(),
    personas: textoPersonas(r.personas),
    enlace_boleto: r.qr_code ? `${r.origen.replace(/\/$/, "")}/r/${r.qr_code}` : "",
  };
}

// Texto efectivo: el propio del antro si lo hay; si no, el de fábrica.
export function plantillaEfectiva(tipo: TipoPlantilla, propias: Partial<Record<TipoPlantilla, string>>): string {
  const propia = propias[tipo];
  return propia && propia.trim() ? propia : PLANTILLAS_FABRICA[tipo];
}

// Qué mensaje tiene sentido según el estado de la reserva (mismos estados
// que rp_mis_reservas): por llegar → confirmación y recordatorio; no llegó
// → aviso de no-show; llegó o consumió → ninguno.
export function tiposParaEstado(estado: string | null | undefined): TipoPlantilla[] {
  if (estado === "por_llegar") return ["confirmacion", "recordatorio"];
  if (estado === "no_llego") return ["no_show"];
  return [];
}

export const AVISO_ENLACE_WA =
  "Abrir WhatsApp no envía nada: se abre el chat con el mensaje ya escrito y tú decides si lo mandas.";

// Datos de ejemplo para la vista previa del editor.
export const DATOS_EJEMPLO: DatosPlantilla = {
  nombre: "Ana",
  antro: "Tu antro",
  fecha: "viernes 4 de diciembre",
  hora: "Jue a sáb, 22:00 a 04:00",
  personas: "4 personas",
  enlace_boleto: "https://antroapp.vercel.app/r/antro-ejemplo",
};
