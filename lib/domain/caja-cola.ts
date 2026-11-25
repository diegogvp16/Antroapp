// Cola de caja sin señal: reglas puras (sin navegador, sin base, sin "@/").
//
// Lo que el staff captura en la caja (consumos y cobros) se guarda primero en
// el teléfono (IndexedDB, lib/caja-cola.ts) y luego se manda a la base. Si no
// hay señal, se queda en la cola y se manda solo al volver. Es seguro
// reintentar porque cada movimiento lleva su clave de idempotencia (p_clave):
// si la base ya lo tenía, devuelve el mismo y no lo duplica
// (sql/2026-11-21-caja-idempotencia.sql). Los cobros llevan además el saldo
// que vio el staff (p_saldo_esperado): si la mesa cambió mientras tanto, la
// base lo rechaza y aquí se muestra, nunca se reintenta con otro saldo.
//
// Solo se encolan movimientos idempotentes. Abrir mesa, sentar, cerrar,
// cuadrar, anular, reabrir y cerrar la noche siguen necesitando señal:
// dependen del estado fresco de la mesa.
//
// Sin imports con "@/": Node carga este archivo tal cual en las pruebas
// (scripts/dev/probar-caja-cola-dominio.mjs).

export type TipoMovimiento = "consumo" | "consumo_producto" | "pago";
export type EstadoPendiente = "pendiente" | "rechazado";

// Las únicas funciones que la cola puede llamar.
export const FUNCION_DE: Record<TipoMovimiento, string> = {
  consumo: "caja_registrar_consumo",
  consumo_producto: "caja_registrar_consumo_producto",
  pago: "caja_registrar_pago",
};

// Argumentos de la llamada. Solo ids, montos y el concepto: nada de nombres
// ni teléfonos de clientes. La referencia de tarjeta (últimos 4 dígitos o
// folio) solo vive aquí hasta que se envía.
export type ArgsMovimiento = Record<string, string | number | null>;

export interface MovimientoPendiente {
  clave: string; // = p_clave (uuid). Llave del almacén.
  usuarioId: string; // quien lo capturó: solo su sesión lo envía
  clubId: string;
  mesaId: string;
  sesionId: string;
  tipo: TipoMovimiento;
  args: ArgsMovimiento; // incluye p_clave
  montoCentavos: number; // consumo: total del renglón; cobro: monto (sin propina)
  descripcion: string; // "2 × Cerveza", "Efectivo", "Tarjeta"
  capturadoEn: string; // ISO
  orden: number; // FIFO: los consumos de una mesa van antes que su cobro
  intentos: number;
  // Envíos que volvieron con un error dudoso (ver clasificar). Opcional: las
  // filas guardadas antes de este campo no lo traen.
  intentosDudosos?: number;
  estado: EstadoPendiente;
  motivo: string | null; // por qué la base lo rechazó
  rechazadoEn: string | null;
}

// Lo que arma la pantalla al capturar (la cola completa el resto).
export type NuevoMovimiento = Pick<
  MovimientoPendiente,
  "clave" | "clubId" | "mesaId" | "sesionId" | "tipo" | "args" | "montoCentavos" | "descripcion"
>;

// Orden de envío. No se confía en el reloj del teléfono: si se atrasa (el
// staff lo cambió, o se corrigió solo con la red después de estar mal), lo
// capturado después tendría un orden menor y el cobro saldría antes que sus
// consumos (la base lo rechazaría por saldo). Por eso el orden nunca baja: es
// el mayor entre el reloj y lo último que hay en la cola, más uno.
// Milisegundos * 1000 + secuencia: varios renglones del mismo toque
// conservan su orden.
export function ordenDeCaptura(ahoraMs: number, ultimoOrden: number, secuencia: number): number {
  const previo = Number.isFinite(ultimoOrden) ? ultimoOrden + 1 : 0;
  return Math.max(Math.trunc(ahoraMs) * 1000, previo) + (secuencia % 1000);
}

export function crearPendiente(
  n: NuevoMovimiento,
  usuarioId: string,
  ahora: Date,
  secuencia: number,
  ultimoOrden = 0,
): MovimientoPendiente {
  return {
    ...n,
    args: { ...n.args, p_clave: n.clave },
    usuarioId,
    capturadoEn: ahora.toISOString(),
    orden: ordenDeCaptura(ahora.getTime(), ultimoOrden, secuencia),
    intentos: 0,
    estado: "pendiente",
    motivo: null,
    rechazadoEn: null,
  };
}

export function ordenar<T extends { orden: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.orden - b.orden);
}

// Qué se manda en esta pasada: lo pendiente de quien tiene la sesión, en el
// orden en que se capturó. Lo de otra persona en el mismo teléfono se queda.
export function porEnviar(xs: MovimientoPendiente[], usuarioId: string): MovimientoPendiente[] {
  return ordenar(xs.filter((x) => x.estado === "pendiente" && x.usuarioId === usuarioId));
}

// ---------------------------------------------------------------------------
// Sesión del teléfono frente a la de quien abrió la caja.
// ---------------------------------------------------------------------------

// ok: la sesión es de quien abrió la caja. vencida: ya no hay sesión (se
// cerró, la revocaron o venció sin poder renovarse). otra_cuenta: entró otra
// persona en este teléfono (en otra pestaña). desconocida: no se pudo saber
// (sin señal, o la renovación no contestó): se sigue como estaba.
export type EstadoSesion = "ok" | "vencida" | "otra_cuenta" | "desconocida";

export function estadoDeSesion(
  usuarioSesion: string | null,
  usuarioCaja: string | null,
  // La lectura de la sesión falló por la red o no contestó a tiempo.
  sinRespuesta: boolean,
): EstadoSesion {
  if (!usuarioCaja) return "desconocida";
  if (usuarioSesion) return usuarioSesion === usuarioCaja ? "ok" : "otra_cuenta";
  return sinRespuesta ? "desconocida" : "vencida";
}

// Tiempos límite con mala señal: una petición que no contesta (el teléfono
// dice "conectado" pero no pasan datos) no debe dejar la hoja girando ni
// frenar la cola. LLAMADA: cada envío a la base se corta y se reintenta (es
// seguro por la clave). HOJA: lo más que espera la hoja antes de cerrarse con
// "guardado en el teléfono" (el envío sigue solo). LECTURA: lo más que espera
// la caja una lectura antes de marcar "sin conexión".
export const LIMITE_LLAMADA_MS = 15_000;
export const LIMITE_HOJA_MS = 8_000;
export const LIMITE_LECTURA_MS = 20_000;

// Una promesa con tiempo límite: si no termina a tiempo, devuelve `alVencer`
// (la original sigue y su resultado se ignora).
export function conLimite<T>(p: Promise<T>, ms: number, alVencer: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((ok) => (t = setTimeout(() => ok(alVencer), ms)))]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// Qué hacer con la respuesta de la base.
// ---------------------------------------------------------------------------

export type Clasificacion =
  | { tipo: "aplicado" }
  | { tipo: "reintentar"; dudoso?: boolean } // red caída o servidor sin responder: se intenta después (dudoso: cuenta para MAX_INTENTOS_DUDOSOS)
  | { tipo: "sin_sesion" } // la sesión venció: se espera a renovarla
  | { tipo: "rechazado"; motivo: string }; // la base dijo que no: se muestra y no se reintenta

export interface RespuestaLlamada {
  error: { message: string; code?: string } | null;
  status?: number;
}

export const MOTIVO_GENERICO = "La base no aceptó este movimiento. Revisa la mesa con tu gerente.";

// Errores pasajeros con código: la base o PostgREST no pudo atender en ese
// momento (justo lo que pasa en una noche cargada). Reintentar es seguro por
// la clave (p_clave): si sí entró, la base devuelve el mismo movimiento.
//  PGRST000-003: PostgREST sin conexión a la base, sin caché del esquema o
//  sin conexión libre en el pool (503/504). 53000/53300: la base sin
//  recursos o sin conexiones. 55P03: candado ocupado. 57014: tiempo agotado.
//  57P01-57P03: la base se reinicia. 40001/40P01: serialización y deadlock.
//  08xxx (abajo): conexión caída entre PostgREST y la base.
const PASAJEROS = new Set([
  "PGRST000",
  "PGRST001",
  "PGRST002",
  "PGRST003",
  "53000",
  "53300",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "40001",
  "40P01",
]);

// Un 5xx con código que no está en la lista (por ejemplo XX000), o la base
// sin la función (PGRST202, pasa unos segundos mientras PostgREST recarga
// el esquema en un pase): se reintenta, pero no para siempre, porque la cola
// se forma detrás y nada más saldría. Con la espera creciente, 10 intentos
// son unos 5 minutos; después se rechaza y se avisa.
export const MAX_INTENTOS_DUDOSOS = 10;

// esRed: lo decide quien llama con esErrorDeRed (lib/errores-base.ts).
// dudososPrevios: cuántas veces ya volvió con un error dudoso (5xx con código
// desconocido o PGRST202). Los fallos de red no cuentan.
export function clasificar(r: RespuestaLlamada, esRed: boolean, dudososPrevios = 0): Clasificacion {
  if (!r.error) return { tipo: "aplicado" };
  const code = r.error.code ?? "";
  const status = r.status;
  // Rechazos de verdad: la base dijo que no (aviso de la función o permiso).
  if (code === "P0001") return { tipo: "rechazado", motivo: motivoRechazo(r.error.message) };
  if (code === "PGRST301" || status === 401) return { tipo: "sin_sesion" };
  if (esRed) return { tipo: "reintentar" };
  if (code === "42501" || status === 403) return { tipo: "rechazado", motivo: "No tienes permiso para hacer esto." };
  // Pasajeros conocidos: siempre se reintentan (como la red).
  if (PASAJEROS.has(code) || code.startsWith("08")) return { tipo: "reintentar" };
  // Sin respuesta del servidor, límite (408, 429) o error del servidor (5xx):
  // la petición pudo no llegar o no atenderse. Sin código, siempre; con un
  // código desconocido, hasta MAX_INTENTOS_DUDOSOS.
  const servidor = status === undefined || status === 0 || status >= 500 || status === 408 || status === 429;
  if (servidor && !code) return { tipo: "reintentar" };
  if (servidor || code === "PGRST202")
    return dudososPrevios + 1 < MAX_INTENTOS_DUDOSOS ? { tipo: "reintentar", dudoso: true } : { tipo: "rechazado", motivo: MOTIVO_GENERICO };
  // Cualquier otro 4xx: la base no lo acepta y no lo va a aceptar.
  return { tipo: "rechazado", motivo: MOTIVO_GENERICO };
}

// Los avisos de la base, en palabras del piso. Sirven igual si se acaba de
// tocar el botón o si se mandó al volver la señal.
export function motivoRechazo(mensaje: string): string {
  const m = mensaje.trim();
  if (/está cuadrada y esta acción/i.test(m)) return "La mesa ya está cuadrada.";
  if (/está cerrada y esta acción/i.test(m)) return "La mesa ya está cerrada (falta cuadrarla).";
  if (/noche ya está cerrada/i.test(m)) return "La noche ya está cerrada.";
  if (/^cuenta no encontrada$/i.test(m)) return "El cliente ya no está en esa mesa.";
  if (/^mesa no encontrada$/i.test(m)) return "La mesa ya no existe.";
  if (/no tienes permiso/i.test(m)) return `${m.replace(/\.$/, "")}: te lo quitaron o tu cuenta fue dada de baja.`;
  return m || MOTIVO_GENERICO;
}

// Espera antes del siguiente intento cuando falla la red: 2 s, 4 s, 8 s…
// hasta 60 s, con ±20 % al azar para que varios teléfonos no peguen juntos
// al volver la señal. azar: número en [0, 1).
export const ESPERA_MIN_MS = 2_000;
export const ESPERA_MAX_MS = 60_000;
export function esperaMs(fallosSeguidos: number, azar = 0.5): number {
  const base = Math.min(ESPERA_MAX_MS, ESPERA_MIN_MS * 2 ** Math.max(0, fallosSeguidos - 1));
  return Math.round(base * (0.8 + 0.4 * azar));
}

// ---------------------------------------------------------------------------
// Pantalla: lo pendiente se ve en la mesa y cuenta en su saldo.
// ---------------------------------------------------------------------------

// Lo que ya está en la base (misma persona y misma clave) no se vuelve a
// sumar: pasa cuando el envío sí llegó pero la respuesta se perdió.
export function sinLoYaGuardado(
  xs: MovimientoPendiente[],
  enBase: { registrado_por: string; clave_cliente?: string | null }[],
): { quedan: MovimientoPendiente[]; yaGuardados: string[] } {
  const claves = new Set(enBase.filter((f) => f.clave_cliente).map((f) => `${f.registrado_por}|${f.clave_cliente}`));
  const yaGuardados: string[] = [];
  const quedan = xs.filter((x) => {
    const esta = claves.has(`${x.usuarioId}|${x.clave}`);
    if (esta) yaGuardados.push(x.clave);
    return !esta;
  });
  return { quedan, yaGuardados };
}

export interface MontosMesa {
  consumo: number;
  cobrado: number;
  saldo: number;
}

// Suma lo pendiente (no lo rechazado) de una sesión a sus montos.
export function conPendientes<T extends MontosMesa>(
  r: T,
  sesionId: string | null,
  xs: MovimientoPendiente[],
): T & { porEnviar: number } {
  if (!sesionId) return { ...r, porEnviar: 0 };
  let consumo = r.consumo;
  let cobrado = r.cobrado;
  let n = 0;
  for (const x of xs) {
    if (x.sesionId !== sesionId || x.estado !== "pendiente") continue;
    n++;
    if (x.tipo === "pago") cobrado += x.montoCentavos;
    else consumo += x.montoCentavos;
  }
  return { ...r, consumo, cobrado, saldo: consumo - cobrado, porEnviar: n };
}

// Conteo por mesa (para marcar el mapa).
export function conteoPorMesa(xs: MovimientoPendiente[]): Record<string, { pendientes: number; rechazados: number }> {
  const out: Record<string, { pendientes: number; rechazados: number }> = {};
  for (const x of xs) {
    const c = (out[x.mesaId] ??= { pendientes: 0, rechazados: 0 });
    if (x.estado === "pendiente") c.pendientes++;
    else c.rechazados++;
  }
  return out;
}

export function textoPorEnviar(n: number): string {
  return n === 1 ? "1 movimiento por enviar" : `${n} movimientos por enviar`;
}

// Lo que dejó otra cuenta en este teléfono: solo el número, sin detalle.
export function textoDeOtraCuenta(n: number): string {
  return n === 1
    ? "Hay 1 movimiento de caja de otra cuenta guardado en este teléfono. Se envía cuando esa persona vuelva a entrar aquí."
    : `Hay ${n} movimientos de caja de otra cuenta guardados en este teléfono. Se envían cuando esa persona vuelva a entrar aquí.`;
}

// Lo rechazado se queda a la vista hasta que alguien toque "Entendido".
// Pasadas 72 h ya no sirve de nada (la noche cerró) y se limpia. Lo pendiente
// NUNCA se borra solo: a lo más pasa a rechazado (con su motivo) en los dos
// casos de abajo, y desde ahí corre su propia vigencia de 72 h.
export const VIGENCIA_RECHAZADO_MS = 72 * 3600 * 1000;
export function vencido(x: MovimientoPendiente, ahora: Date): boolean {
  if (x.estado !== "rechazado") return false;
  const t = Date.parse(x.rechazadoEn ?? x.capturadoEn);
  return Number.isFinite(t) && ahora.getTime() - t > VIGENCIA_RECHAZADO_MS;
}

// Pendientes de OTRA cuenta que nadie va a mandar: quien los capturó no ha
// vuelto a entrar en este teléfono en 72 h (para entonces la noche ya
// cerró). Pasan a rechazado con este motivo: dejan de anunciarse a la
// persona de ahora como "se envían cuando esa persona vuelva a entrar", y si
// quien los capturó vuelve en las 72 h siguientes, los ve con el motivo.
export const VIGENCIA_PENDIENTE_AJENO_MS = 72 * 3600 * 1000;
export const MOTIVO_AJENO_VENCIDO = "No se envió: pasaron más de 72 horas sin que volvieras a entrar en este teléfono.";
// Cuenta dada de baja: la base ya no le acepta nada (lib/cuenta-dada-de-baja.ts).
export const MOTIVO_CUENTA_BAJA = "No se envió: tu cuenta fue dada de baja.";

export function pendienteAjenoVencido(x: MovimientoPendiente, usuarioActual: string, ahora: Date): boolean {
  if (x.estado !== "pendiente" || x.usuarioId === usuarioActual) return false;
  const t = Date.parse(x.capturadoEn);
  return Number.isFinite(t) && ahora.getTime() - t > VIGENCIA_PENDIENTE_AJENO_MS;
}

export function comoRechazado(x: MovimientoPendiente, motivo: string, ahora: Date): MovimientoPendiente {
  return { ...x, estado: "rechazado", motivo, rechazadoEn: ahora.toISOString() };
}
