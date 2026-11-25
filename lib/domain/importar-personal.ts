// RPs y staff en lote desde un CSV: invitaciones en lote (B1b). Puro: sin
// React ni Supabase y sin imports con "@/" (las pruebas lo cargan con Node).
//
// Una línea por persona: nombre, correo[, teléfono]
//   Ana López, ana@example.com, 55 1234 5678
//   "Pérez, Luis";luis@example.com
// Encabezado opcional; si viene (con «nombre» y «correo» o «email»), las
// columnas se toman por su nombre y pueden ir en cualquier orden.
//
// No se crean cuentas ni contraseñas: cada fila es una invitación de B12
// (sql/post-junta-2/21 y 23). La pantalla revisa con estas reglas, la ruta
// /api/equipo/importar las vuelve a aplicar y la base
// (invitaciones_importar) las aplica otra vez: si una fila no pasa, no se
// guarda ninguna. Todos los de un archivo entran con el MISMO rol.

import { z } from "zod";
import { lineasCsv, quitarAcentos } from "./lector-csv";
import { ROLES_INVITABLES, type RolInvitable } from "./invitaciones";

export const MAX_PERSONAL_CSV = 400;

export interface FilaPersonal {
  // Número de línea en el archivo; solo sirve para el mensaje de error.
  linea: number;
  nombre: string;
  correo: string;
  telefono: string | null;
}

// El mismo patrón que la base (invitaciones.correo).
const PATRON_CORREO = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;
const esCorreo = (c: string) => c.length >= 3 && c.length <= 254 && PATRON_CORREO.test(c) && z.email().safeParse(c).success;

// Espejo de telefono_mx_10() en la base. "" → null (no trae); inválido → undefined.
export function telefonoMx10(texto: string | null | undefined): string | null | undefined {
  const d = (texto ?? "").replace(/[\s().+-]/g, "");
  if (d === "") return null;
  if (/^[0-9]{10}$/.test(d)) return d;
  if (/^52[0-9]{10}$/.test(d)) return d.slice(2);
  if (/^521[0-9]{10}$/.test(d)) return d.slice(3);
  return undefined;
}

const limpiarNombre = (s: string) => s.replace(/\s+/g, " ").trim();

type Columnas = { nombre: number; correo: number; telefono: number | null };

function columnasDeEncabezado(c: string[]): Columnas | null {
  const t = c.map((x) => quitarAcentos(x).trim());
  const nombre = t.findIndex((x) => /^nombre/.test(x));
  const correo = t.findIndex((x) => /^(correo|e-?mail|mail)/.test(x));
  if (nombre === -1 || correo === -1) return null;
  const telefono = t.findIndex((x) => /^(telefono|tel\b|tel\.|celular|cel\b|whatsapp|movil)/.test(x));
  return { nombre, correo, telefono: telefono === -1 ? null : telefono };
}

export function leerPersonalCsv(texto: string): { filas: FilaPersonal[]; errores: string[] } {
  const filas: FilaPersonal[] = [];
  const errores: string[] = [];
  const vistos = new Map<string, number>();
  let col: Columnas = { nombre: 0, correo: 1, telefono: 2 };
  let conEncabezado = false;
  lineasCsv(texto).forEach(({ n, campos }, i) => {
    if (i === 0) {
      const enc = columnasDeEncabezado(campos);
      if (enc) {
        col = enc;
        conEncabezado = true;
        return;
      }
    }
    const usadas = new Set([col.nombre, col.correo, ...(col.telefono === null ? [] : [col.telefono])]);
    if (campos.some((x, j) => x !== "" && !usadas.has(j))) {
      return errores.push(
        conEncabezado ? `Línea ${n}: trae columnas que no están en el encabezado.` : `Línea ${n}: van a lo más tres columnas, «nombre, correo, teléfono».`,
      );
    }
    const nombre = limpiarNombre(campos[col.nombre] ?? "");
    const correo = (campos[col.correo] ?? "").trim().toLowerCase();
    const telCrudo = col.telefono === null ? "" : (campos[col.telefono] ?? "");
    if (!correo.includes("@") && nombre.includes("@")) return errores.push(`Línea ${n}: el correo va en la segunda columna («nombre, correo»).`);
    if (nombre.length < 2 || nombre.length > 120) return errores.push(`Línea ${n}: el nombre va de 2 a 120 letras.`);
    if (!esCorreo(correo)) return errores.push(`Línea ${n}: revisa el correo («${correo || "vacío"}»), no parece válido.`);
    const telefono = telefonoMx10(telCrudo);
    if (telefono === undefined) return errores.push(`Línea ${n}: el teléfono debe tener 10 dígitos («${telCrudo}»).`);
    if (vistos.has(correo)) return errores.push(`Línea ${n}: el correo ${correo} ya viene en la línea ${vistos.get(correo)}.`);
    vistos.set(correo, n);
    filas.push({ linea: n, nombre, correo, telefono });
  });
  if (filas.length > MAX_PERSONAL_CSV) errores.push(`Máximo ${MAX_PERSONAL_CSV} personas por importación (vienen ${filas.length}).`);
  return { filas, errores };
}

// Cuerpo de POST /api/equipo/importar. El club solo dice A DÓNDE; si quien
// llama puede invitar ese rol ahí, lo decide la base.
export const esquemaImportarPersonal = z.object({
  club_id: z.uuid("Falta el antro."),
  rol: z.enum(ROLES_INVITABLES, "Elige gerente, staff o RP."),
  // Clave de idempotencia: una por lista revisada. Si se reintenta, la base
  // no duplica.
  lote_id: z.uuid("Falta la clave de la importación."),
  filas: z
    .array(
      z.object({
        linea: z.number().int().min(1).max(999_999),
        nombre: z.string().max(200),
        correo: z.string().max(254),
        telefono: z.string().max(40).nullable(),
      }),
    )
    .min(1, "No viene ninguna persona.")
    .max(MAX_PERSONAL_CSV, `Máximo ${MAX_PERSONAL_CSV} personas por importación.`),
});
export type CuerpoImportarPersonal = z.infer<typeof esquemaImportarPersonal>;

// Cuerpo de POST /api/equipo/importar/reemitir: solo la clave del lote. El
// antro y el rol se leen del lote en la base, nunca del navegador.
export const esquemaReemitirLote = z.object({ lote_id: z.uuid("Falta la clave de la importación.") });

// Revisa en el servidor lo que mandó el navegador con las MISMAS reglas que
// el CSV (sin volver a partir texto). Devuelve el primer error o las filas
// ya limpias.
export function revisarFilasPersonal(filas: CuerpoImportarPersonal["filas"]): { filas: FilaPersonal[] } | { error: string } {
  const vistos = new Map<string, number>();
  const salida: FilaPersonal[] = [];
  for (const f of filas) {
    const nombre = limpiarNombre(f.nombre);
    const correo = f.correo.trim().toLowerCase();
    if (nombre.length < 2 || nombre.length > 120) return { error: `Línea ${f.linea}: el nombre va de 2 a 120 letras.` };
    if (!esCorreo(correo)) return { error: `Línea ${f.linea}: revisa el correo, no parece válido.` };
    const telefono = telefonoMx10(f.telefono);
    if (telefono === undefined) return { error: `Línea ${f.linea}: el teléfono debe tener 10 dígitos.` };
    if (vistos.has(correo)) return { error: `Línea ${f.linea}: el correo ${correo} ya viene en la línea ${vistos.get(correo)}.` };
    vistos.set(correo, f.linea);
    salida.push({ linea: f.linea, nombre, correo, telefono });
  }
  return { filas: salida };
}

// Lo que devuelve la ruta por cada persona cuyo correo NO salió (modo
// archivo, apagado o falla): su enlace, para entregarlo a mano. Los que sí
// salieron por correo no vienen (su enlace solo lo tiene esa persona).
export interface EnlacePendiente {
  nombre: string;
  correo: string;
  telefono: string | null;
  enlace: string;
}

export interface ResultadoImportarPersonal {
  ok: true;
  // Clave del lote: con ella se piden otra vez los enlaces
  // (POST /api/equipo/importar/reemitir).
  lote_id: string;
  creadas: number;
  repetido: boolean;
  // true cuando la respuesta viene de «Volver a sacar los enlaces».
  reemitido?: boolean;
  correos: { enviados: number; archivados: number; fallidos: number; sinIntentar: number };
  enlaces: EnlacePendiente[];
}

// Mensaje de WhatsApp (o para copiar) con el enlace de una persona.
export function mensajeInvitacion(d: { nombre: string; club: string; rol: RolInvitable; enlace: string }): string {
  const rol = d.rol === "rp" ? "RP" : d.rol === "staff" ? "staff" : "gerente";
  return `Hola, ${d.nombre}: te invitaron a ${d.club} en AntroApp como ${rol}. Abre este enlace para elegir tu contraseña (sirve una sola vez y vence en 72 horas): ${d.enlace}`;
}

// Una celda para pegar en una hoja de cálculo: sin tabuladores ni saltos de
// línea (romperían las columnas) y, si empieza con = + - @, con un apóstrofo
// al principio para que Excel o Sheets no la ejecuten como fórmula (la misma
// regla que campoCsv de lib/domain/nomina.ts). El nombre viene del CSV que
// subió quien importa: puede traer «=HYPERLINK(…)».
export function celdaSegura(valor: string): string {
  const plano = valor.replace(/[\t\r\n]+/g, " ");
  return /^[=+\-@]/.test(plano) ? `'${plano}` : plano;
}

// "Copiar todo": una línea por persona, lista para pegar en una hoja o en un chat.
export function textoEnlaces(enlaces: readonly EnlacePendiente[]): string {
  return enlaces.map((e) => [e.nombre, e.correo, e.telefono ?? "", e.enlace].map(celdaSegura).join("\t")).join("\n");
}
