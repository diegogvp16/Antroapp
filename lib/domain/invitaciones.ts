// Invitaciones de personal por correo (B12).
//
// Reglas puras, sin React ni Supabase: las usan la pantalla de Equipo, las
// rutas /api/equipo/invitar e /api/invitacion y las pruebas con Node
// (scripts/dev/probar-invitaciones.mjs). Quién puede invitar a quién lo
// decide la BASE (invitacion_puede, sql/post-junta-2/21-invitaciones.sql);
// rolesQuePuedeInvitar es solo su espejo para no mostrar opciones inútiles.
//
// Este archivo no importa nada con "@/".

import { z } from "zod";

export const ROLES_INVITABLES = ["gerente", "staff", "rp"] as const;
export type RolInvitable = (typeof ROLES_INVITABLES)[number];
export type EstadoInvitacion = "pendiente" | "aceptada" | "vencida" | "revocada";

export const HORAS_VIGENCIA = 72;
export const MIN_CONTRASENA = 8;
// Intentos por IP por hora en la página pública.
export const CONSULTAS_POR_IP_HORA = 30;
export const ACEPTACIONES_POR_IP_HORA = 10;

export const ETIQUETA_ROL_INVITADO: Record<RolInvitable, string> = {
  gerente: "Gerente",
  staff: "Staff",
  rp: "RP",
};

export const ETIQUETA_ESTADO: Record<EstadoInvitacion, string> = {
  pendiente: "Pendiente",
  aceptada: "Aceptada",
  vencida: "Vencida",
  revocada: "Revocada",
};

// Espejo de invitacion_puede (sin el club, que lo revisa la base).
export function rolesQuePuedeInvitar(rol: string | null | undefined): readonly RolInvitable[] {
  if (rol === "admin" || rol === "dueno") return ROLES_INVITABLES;
  if (rol === "gerente" || rol === "staff") return ["rp"];
  return [];
}

export interface FilaInvitacion {
  aceptada_en: string | null;
  revocada_en: string | null;
  expira_en: string;
}

// Mismo cálculo que invitacion_estado() en la base.
export function estadoInvitacion(f: FilaInvitacion, ahora: Date = new Date()): EstadoInvitacion {
  if (f.aceptada_en) return "aceptada";
  if (f.revocada_en) return "revocada";
  return Date.parse(f.expira_en) <= ahora.getTime() ? "vencida" : "pendiente";
}

// Reenviar y revocar solo tienen sentido mientras no se aceptó ni revocó.
export function accionesDe(estado: EstadoInvitacion): { reenviar: boolean; revocar: boolean } {
  const abierta = estado === "pendiente" || estado === "vencida";
  return { reenviar: abierta, revocar: abierta };
}

export const TOKEN_INVITACION = /^[0-9a-f]{64}$/;
export const esTokenValido = (t: unknown): t is string => typeof t === "string" && TOKEN_INVITACION.test(t);

const correo = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Revisa el correo: no parece válido.")
  .pipe(z.email("Revisa el correo: no parece válido."));
const nombre = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(2, "Escribe el nombre (de 2 a 120 letras).").max(120, "Escribe el nombre (de 2 a 120 letras)."));

// Cuerpo de POST /api/equipo/invitar. El club solo dice A DÓNDE se invita;
// si quien llama puede hacerlo ahí, lo decide la base.
export const esquemaInvitar = z.discriminatedUnion("accion", [
  z.object({
    accion: z.literal("crear"),
    club_id: z.uuid("Falta el antro."),
    rol: z.enum(ROLES_INVITABLES, "Elige gerente, staff o RP."),
    correo,
    nombre,
  }),
  z.object({ accion: z.literal("reenviar"), id: z.uuid("Falta la invitación.") }),
]);
export type CuerpoInvitar = z.infer<typeof esquemaInvitar>;

// Cuerpo de POST /api/invitacion (página pública). Lo demás que llegue
// (rol, club, correo…) se ignora: todo sale de la invitación.
export const esquemaAceptar = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("consultar"), token: z.string().regex(TOKEN_INVITACION, "El enlace no es válido.") }),
  z.object({
    accion: z.literal("aceptar"),
    token: z.string().regex(TOKEN_INVITACION, "El enlace no es válido."),
    password: z
      .string()
      .min(MIN_CONTRASENA, `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres.`)
      .max(200, "La contraseña es demasiado larga."),
  }),
]);

// Dirección pública con la que se arma el enlace. Nunca del encabezado Host
// de la petición en Vercel: primero la variable explícita, luego la de
// producción del proyecto, luego la del despliegue; el origen de la petición
// solo en local.
export function urlPublica(env: Record<string, string | undefined>, origenPeticion: string): string {
  const limpia = (u: string) => u.trim().replace(/\/+$/, "");
  const conEsquema = (h: string) => (/^https?:\/\//.test(h) ? h : `https://${h}`);
  if (env.URL_PUBLICA?.trim()) return limpia(conEsquema(env.URL_PUBLICA));
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) return limpia(conEsquema(env.VERCEL_PROJECT_PRODUCTION_URL));
  if (env.VERCEL_URL?.trim()) return limpia(conEsquema(env.VERCEL_URL));
  return limpia(origenPeticion);
}

export const enlaceInvitacion = (base: string, token: string) => `${base.replace(/\/+$/, "")}/invitacion/${token}`;

const FECHA_MX = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "numeric",
  minute: "2-digit",
});

export function textoCorreoInvitacion(d: {
  nombre: string;
  rol: RolInvitable;
  club: string;
  invita: string | null;
  enlace: string;
  expiraEn: string;
}): { asunto: string; texto: string } {
  const rol = ETIQUETA_ROL_INVITADO[d.rol];
  const vence = FECHA_MX.format(new Date(d.expiraEn));
  const quien = d.invita ? `${d.invita} te invitó` : "Te invitaron";
  return {
    asunto: `Te invitaron a ${d.club} en AntroApp (${rol})`,
    texto: [
      `Hola, ${d.nombre}:`,
      "",
      `${quien} a unirte al equipo de ${d.club} en AntroApp como ${rol}.`,
      "",
      "Para aceptar, abre este enlace y elige tu contraseña:",
      d.enlace,
      "",
      `El enlace sirve una sola vez y vence el ${vence} (hora del centro de México).`,
      "Si no esperabas esta invitación, ignora este correo: sin el enlace no se crea ninguna cuenta.",
      "",
      "— AntroApp",
    ].join("\n"),
  };
}

// Mensaje para quien invita según lo que pasó con el correo.
export function avisoEnvio(estado: string, reenvio = false): string {
  const hecha = reenvio ? "Invitación reenviada (el enlace anterior ya no sirve)" : "Invitación creada";
  if (estado === "enviado") return reenvio ? "Invitación reenviada por correo. El enlace anterior ya no sirve." : "Invitación enviada por correo.";
  if (estado === "archivado") return `${hecha}. Por ahora los correos no salen: quedó en la bandeja y el admin le hará llegar el enlace.`;
  if (estado === "apagado") return `${hecha}, pero el envío de correos está apagado: pide al admin que la reenvíe cuando se encienda.`;
  return `${hecha}, pero el correo no se pudo mandar. Intenta reenviarla en unos minutos.`;
}
