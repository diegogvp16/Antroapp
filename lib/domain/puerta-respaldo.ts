// Reglas puras del escáner de respaldo (bandera `escaner_respaldo`):
// código corto del boleto, copia de la noche para validar sin señal y
// clasificación de lo que contesta la base al enviar una entrada guardada.
// Sin React, sin IndexedDB y sin Supabase: se prueban con
// scripts/dev/probar-puerta-respaldo-dominio.mjs.
//
// Base: sql/post-junta-3/20-escaner-respaldo.sql.

// ---------------------------------------------------------------------------
// Código del boleto
// ---------------------------------------------------------------------------

// El QR guarda "antro-<uuid>". El código corto son los 6 últimos caracteres
// (hexadecimales, al azar en un uuid v4), en mayúsculas y en dos grupos.
export const LARGO_CODIGO = 6;
export const LARGO_CODIGO_MAX = 12;

const RE_QR = /^antro-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sufijoDe(qr: string): string {
  return qr.trim().slice(-LARGO_CODIGO).toUpperCase();
}

// "A3F9C2" -> "A3F 9C2" (como se muestra en el boleto y se dicta en voz alta).
export function formatearCodigo(codigo: string): string {
  const c = codigo.toUpperCase();
  return c.length === LARGO_CODIGO ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

export type CodigoEscrito =
  | { tipo: "completo"; qr: string } // pegaron el código entero (o el enlace del boleto)
  | { tipo: "corto"; codigo: string } // 6 a 12 caracteres del final, en minúsculas
  | { tipo: "invalido"; motivo: string };

// Lo que escribió (o pegó) el staff. Acepta el enlace del boleto
// (…/r/antro-<uuid>), el código completo, el uuid solo o el código corto con
// espacios o guiones.
export function leerCodigoEscrito(texto: string): CodigoEscrito {
  let t = (texto ?? "").trim().toLowerCase();
  if (!t) return { tipo: "invalido", motivo: "Escribe el código del boleto." };
  const enlace = t.match(/\/r\/(antro-[0-9a-f-]{36})(?:[/?#].*)?$/);
  if (enlace) t = enlace[1];
  try {
    t = decodeURIComponent(t);
  } catch {
    // se queda como venía
  }
  if (RE_QR.test(t)) return { tipo: "completo", qr: t };
  if (RE_UUID.test(t)) return { tipo: "completo", qr: `antro-${t}` };
  const limpio = t.replace(/[\s-]/g, "");
  if (!/^[0-9a-f]+$/.test(limpio)) return { tipo: "invalido", motivo: "El código solo lleva números y letras de la A a la F." };
  if (limpio.length < LARGO_CODIGO) return { tipo: "invalido", motivo: `Escribe los ${LARGO_CODIGO} caracteres del código del boleto.` };
  if (limpio.length > LARGO_CODIGO_MAX)
    return { tipo: "invalido", motivo: "El código es más largo que el del boleto. Escribe solo el código o escanea el QR." };
  return { tipo: "corto", codigo: limpio };
}

// ---------------------------------------------------------------------------
// Copia de la noche (lo que devuelve puerta_copia_noche)
// ---------------------------------------------------------------------------

export interface ReservaCopia {
  reservation_id: string;
  qr_sha256: string;
  sufijo: string;
  entro: boolean;
  entrada_en: string | null;
  cliente_nombre: string | null; // null si ya entró (no se guarda)
  personas: number;
  source: "organica" | "rp";
  rp_nombre: string | null;
}

export interface CopiaNoche {
  clave: string; // `${usuarioId}:${clubId}`
  usuarioId: string;
  clubId: string;
  noche: string; // YYYY-MM-DD (noche operativa del antro, según la base)
  generadaEn: string; // hora del servidor
  venceEn: string; // 08:00 del día siguiente, hora del antro (según la base)
  // La noche tiene más reservas de las que caben (3,000): faltan algunas
  // (primero se quedan fuera las que ya entraron).
  truncada: boolean;
  total: number;
  reservas: ReservaCopia[];
}

function esTexto(v: unknown): v is string {
  return typeof v === "string";
}

// Lee la respuesta de la base; si algo no cuadra, null (no se guarda nada).
export function leerCopia(data: unknown, usuarioId: string): CopiaNoche | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!esTexto(d.club_id) || !esTexto(d.noche) || !esTexto(d.generada_en) || !esTexto(d.vence_en) || !Array.isArray(d.reservas))
    return null;
  const reservas: ReservaCopia[] = [];
  for (const x of d.reservas as unknown[]) {
    if (typeof x !== "object" || x === null) return null;
    const r = x as Record<string, unknown>;
    if (!esTexto(r.reservation_id) || !esTexto(r.qr_sha256) || !esTexto(r.sufijo) || typeof r.personas !== "number") return null;
    reservas.push({
      reservation_id: r.reservation_id,
      qr_sha256: r.qr_sha256,
      sufijo: r.sufijo.toUpperCase(),
      entro: r.entro === true,
      entrada_en: esTexto(r.entrada_en) ? r.entrada_en : null,
      cliente_nombre: esTexto(r.cliente_nombre) ? r.cliente_nombre : null,
      personas: r.personas,
      source: r.source === "rp" ? "rp" : "organica",
      rp_nombre: esTexto(r.rp_nombre) ? r.rp_nombre : null,
    });
  }
  return {
    clave: `${usuarioId}:${d.club_id}`,
    usuarioId,
    clubId: d.club_id,
    noche: d.noche,
    generadaEn: d.generada_en,
    venceEn: d.vence_en,
    truncada: d.truncada === true,
    total: typeof d.total === "number" ? d.total : reservas.length,
    reservas,
  };
}

// La copia ya no sirve: pasó la hora de vencimiento (según el reloj del
// teléfono; si el reloj está mal, la base igual revisa la noche al enviar).
export function copiaVencida(copia: Pick<CopiaNoche, "venceEn">, ahora: Date): boolean {
  const v = Date.parse(copia.venceEn);
  return !Number.isFinite(v) || ahora.getTime() >= v;
}

// Una copia vieja (más de 30 min sin poder renovarse) se usa, pero se avisa.
export const COPIA_VIEJA_MS = 30 * 60 * 1000;
export function copiaVieja(copia: Pick<CopiaNoche, "generadaEn">, ahora: Date): boolean {
  const g = Date.parse(copia.generadaEn);
  return !Number.isFinite(g) || ahora.getTime() - g > COPIA_VIEJA_MS;
}

export type BusquedaLocal =
  | { tipo: "encontrada"; reserva: ReservaCopia }
  | { tipo: "varias"; reservas: ReservaCopia[] }
  | { tipo: "no_encontrada" };

export function buscarPorHuella(copia: CopiaNoche, huella: string): BusquedaLocal {
  const r = copia.reservas.find((x) => x.qr_sha256 === huella.toLowerCase());
  return r ? { tipo: "encontrada", reserva: r } : { tipo: "no_encontrada" };
}

// Sin señal, el código corto se compara con los 6 caracteres de la copia
// (con más de 6, se usan los últimos 6: la copia no guarda más).
export function buscarPorCodigo(copia: CopiaNoche, codigo: string): BusquedaLocal {
  const c = codigo.toUpperCase().slice(-LARGO_CODIGO);
  const xs = copia.reservas.filter((x) => x.sufijo === c);
  if (xs.length === 0) return { tipo: "no_encontrada" };
  if (xs.length === 1) return { tipo: "encontrada", reserva: xs[0] };
  return { tipo: "varias", reservas: xs };
}

// ---------------------------------------------------------------------------
// Entradas guardadas sin señal
// ---------------------------------------------------------------------------

export type EstadoEntrada = "pendiente" | "enviada" | "duplicada" | "rechazada";

export interface EntradaPendiente {
  clave: string; // uuid: clave de idempotencia (puerta_entrada_diferida)
  usuarioId: string;
  clubId: string;
  reservationId: string;
  clienteNombre: string; // para la lista "pendiente de enviar" de este teléfono
  personas: number;
  origen: "camara" | "codigo";
  escaneadoEn: string; // reloj del teléfono
  // Después de esta hora la base ya no la aceptaría (la noche cerró): deja
  // de estar pendiente y se avisa. Vence de la copia + MARGEN_ENTRADA_MS.
  venceEn: string;
  estado: EstadoEntrada;
  intentos: number;
  motivo?: string;
  entradaEn?: string | null; // hora de la entrada que quedó en la base
  resueltoEn?: string;
}

// Las 08:00 del día siguiente (vence la copia) más 2 h de margen para que
// alcance a salir lo que se capturó al final de la noche.
export const MARGEN_ENTRADA_MS = 2 * 3600 * 1000;
// Sin copia (se fue la señal justo al confirmar con red): 12 h.
export const VIGENCIA_SIN_COPIA_MS = 12 * 3600 * 1000;

export function crearEntrada(
  datos: Pick<EntradaPendiente, "usuarioId" | "clubId" | "reservationId" | "clienteNombre" | "personas" | "origen">,
  clave: string,
  ahora: Date,
  venceCopia: string | null,
): EntradaPendiente {
  const v = venceCopia ? Date.parse(venceCopia) : NaN;
  const venceEn = new Date(Number.isFinite(v) ? v + MARGEN_ENTRADA_MS : ahora.getTime() + VIGENCIA_SIN_COPIA_MS).toISOString();
  return { ...datos, clave, escaneadoEn: ahora.toISOString(), venceEn, estado: "pendiente", intentos: 0 };
}

export const MOTIVO_ENTRADA_VENCIDA =
  "No se envió a tiempo: la noche ya cerró y la base ya no la aceptaría. Si sí entró, avisa al gerente.";

// Pendiente que ya no se va a poder enviar (pasó su hora). Una sin venceEn
// (versión anterior) vence a las 12 h de capturada.
export function pendienteVencida(x: EntradaPendiente, ahora: Date): boolean {
  if (x.estado !== "pendiente") return false;
  const v = Date.parse(x.venceEn ?? "");
  const limite = Number.isFinite(v) ? v : Date.parse(x.escaneadoEn) + VIGENCIA_SIN_COPIA_MS;
  return !Number.isFinite(limite) || ahora.getTime() >= limite;
}

export function porEnviar(xs: EntradaPendiente[], usuarioId: string, ahora = new Date()): EntradaPendiente[] {
  return xs
    .filter((x) => x.usuarioId === usuarioId && x.estado === "pendiente" && !pendienteVencida(x, ahora))
    .sort((a, b) => a.escaneadoEn.localeCompare(b.escaneadoEn));
}

export type RespuestaEnvio = { data?: unknown; error?: { message: string; code?: string } | null };

export type Clasificacion =
  | { tipo: "enviada"; entradaEn: string | null }
  | { tipo: "duplicada"; motivo: string; entradaEn: string | null }
  | { tipo: "rechazada"; motivo: string }
  | { tipo: "reintentar" }; // red, sesión o error sin código: se queda pendiente

export const MOTIVO_RECHAZO_GENERICO = "La base no aceptó esta entrada. Confírmala desde la lista de la noche o avisa al gerente.";

// hora_local: la hora de la entrada en la zona del antro (la da la base).
export function clasificarEnvio(r: RespuestaEnvio, esRed: boolean): Clasificacion {
  if (esRed) return { tipo: "reintentar" };
  if (r.error) {
    // Avisos de la base (P0001): la base dijo que no; no se reintenta.
    if (r.error.code === "P0001" && r.error.message) return { tipo: "rechazada", motivo: r.error.message };
    // Sesión vencida, permisos de la API, 5xx: se reintenta después.
    return { tipo: "reintentar" };
  }
  const d = (typeof r.data === "object" && r.data !== null ? r.data : {}) as Record<string, unknown>;
  const entradaEn = esTexto(d.entrada_en) ? d.entrada_en : null;
  const cuando = esTexto(d.hora_local) ? ` a las ${d.hora_local}` : "";
  if (d.resultado === "entro" || d.resultado === "ya_enviada") return { tipo: "enviada", entradaEn };
  if (d.resultado === "ya_entro") {
    const motivo =
      d.por_ti === true
        ? `Ya estaba registrada con tu cuenta${cuando} (desde otro teléfono o la lista). No se contó dos veces.`
        : `Ya había entrado${cuando}: la registró otro teléfono u otra persona. No se contó dos veces.`;
    return { tipo: "duplicada", motivo, entradaEn };
  }
  return { tipo: "rechazada", motivo: MOTIVO_RECHAZO_GENERICO };
}

// Resueltas (enviadas, duplicadas o rechazadas) se guardan 24 h para que la
// pantalla las muestre; luego se borran. Las pendientes vencen con la noche
// (pendienteVencida).
export const VIGENCIA_RESUELTA_MS = 24 * 3600 * 1000;
export function resueltaVencida(x: EntradaPendiente, ahora: Date): boolean {
  if (x.estado === "pendiente") return false;
  const t = Date.parse(x.resueltoEn ?? x.escaneadoEn);
  return !Number.isFinite(t) || ahora.getTime() - t > VIGENCIA_RESUELTA_MS;
}

// Barrido de lo que el teléfono guarda (corre en CUALQUIER pantalla, con o
// sin sesión, y cada 10 min): `actual` es quien tiene la sesión; null = no se
// sabe o no hay nadie (sin red la sesión puede no leerse): entonces solo se
// borra lo vencido.
//  - copias: se borran al vencer y las de cualquier otra cuenta;
//  - pendientes vencidas: las de quien tiene la sesión pasan a rechazadas con
//    su motivo (para que las vea); las de otra cuenta se borran;
//  - resueltas: se borran a las 24 h y, si son de otra cuenta, de inmediato;
//  - pendientes vigentes de otra cuenta se quedan (se envían cuando vuelva).
export function planBarrido(
  copias: Pick<CopiaNoche, "clave" | "usuarioId" | "venceEn">[],
  entradas: EntradaPendiente[],
  actual: string | null,
  ahora: Date,
): { copiasBorrar: string[]; entradasBorrar: string[]; entradasVencer: EntradaPendiente[] } {
  const ajena = (u: string) => actual !== null && u !== actual;
  const copiasBorrar = copias.filter((c) => ajena(c.usuarioId) || copiaVencida(c, ahora)).map((c) => c.clave);
  const entradasBorrar: string[] = [];
  const entradasVencer: EntradaPendiente[] = [];
  for (const x of entradas) {
    const mia = actual !== null && x.usuarioId === actual;
    if (x.estado === "pendiente") {
      if (!pendienteVencida(x, ahora)) continue;
      if (mia)
        entradasVencer.push({ ...x, estado: "rechazada", motivo: MOTIVO_ENTRADA_VENCIDA, resueltoEn: ahora.toISOString() });
      else entradasBorrar.push(x.clave);
    } else if (ajena(x.usuarioId) || resueltaVencida(x, ahora)) entradasBorrar.push(x.clave);
  }
  return { copiasBorrar, entradasBorrar, entradasVencer };
}

export function textoPendientes(n: number): string {
  return n === 1 ? "1 entrada pendiente de enviar" : `${n} entradas pendientes de enviar`;
}
