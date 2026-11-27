// Escáner de respaldo en el teléfono (IndexedDB "antroapp-puerta"):
//  - "copias": la copia mínima de las reservas de esta noche de un antro
//    (puerta_copia_noche), una por usuario y antro. Sin teléfono, sin
//    consumo y sin el código QR (solo su huella SHA-256 y 6 caracteres). Se
//    borra al vencer (08:00), al cerrar sesión y si entra otra cuenta.
//  - "entradas": las entradas confirmadas sin señal, pendientes de enviar con
//    puerta_entrada_diferida, y el resultado de las ya enviadas (24 h).
//
// Reglas en lib/domain/puerta-respaldo.ts. Como la cola de caja
// (lib/caja-cola.ts): si el navegador no deja usar IndexedDB se cae a
// memoria (y entonces sí se pierde al cerrar la app), un solo envío a la vez
// en todo el navegador (Web Locks) y aviso a las otras pestañas.

import { esErrorDeRed } from "@/lib/errores-base";
import {
  clasificarEnvio,
  copiaVencida,
  pendienteVencida,
  planBarrido,
  porEnviar,
  type CopiaNoche,
  type EntradaPendiente,
  type RespuestaEnvio,
} from "@/lib/domain/puerta-respaldo";

const DB = "antroapp-puerta";
const VERSION_DB = 1;
const COPIAS = "copias";
const ENTRADAS = "entradas";
const CANAL = "antroapp-puerta";
const CANDADO = "antroapp-puerta-envio";

type Fila = CopiaNoche | EntradaPendiente;

interface Almacen {
  persistente: boolean;
  todos<T extends Fila>(tabla: string): Promise<T[]>;
  poner(tabla: string, xs: Fila[]): Promise<void>;
  quitar(tabla: string, claves: string[]): Promise<void>;
}

function promesa<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, mal) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
}

function abrirDb(): Promise<IDBDatabase> {
  return new Promise((ok, mal) => {
    const r = indexedDB.open(DB, VERSION_DB);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(COPIAS)) db.createObjectStore(COPIAS, { keyPath: "clave" });
      if (!db.objectStoreNames.contains(ENTRADAS)) db.createObjectStore(ENTRADAS, { keyPath: "clave" });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
    r.onblocked = () => mal(new Error("IndexedDB bloqueada"));
  });
}

function conexionPerdida(e: unknown): boolean {
  const n = e instanceof Error || (typeof DOMException !== "undefined" && e instanceof DOMException) ? e.name : "";
  return n === "InvalidStateError" || n === "UnknownError" || n === "TransactionInactiveError";
}

function almacenIdb(primera: IDBDatabase): Almacen {
  let db: Promise<IDBDatabase> = Promise.resolve(primera);
  const vigilar = (d: IDBDatabase) => {
    d.onclose = () => void reabrir();
    d.onversionchange = () => d.close();
  };
  function reabrir(): Promise<IDBDatabase> {
    db = abrirDb().then((n) => {
      vigilar(n);
      return n;
    });
    db.catch(() => {});
    return db;
  }
  vigilar(primera);
  // iOS cierra la conexión con la app en segundo plano: se reabre una vez.
  async function conDb<T>(f: (d: IDBDatabase) => Promise<T>): Promise<T> {
    let d: IDBDatabase;
    try {
      d = await db;
    } catch {
      d = await reabrir();
    }
    try {
      return await f(d);
    } catch (e) {
      if (!conexionPerdida(e)) throw e;
      return f(await reabrir());
    }
  }
  const fin = (t: IDBTransaction) =>
    new Promise<void>((ok, mal) => {
      t.oncomplete = () => ok();
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error ?? new Error("transacción cancelada"));
    });
  return {
    persistente: true,
    todos: <T extends Fila>(tabla: string) =>
      conDb((d) => promesa(d.transaction(tabla, "readonly").objectStore(tabla).getAll() as IDBRequest<T[]>)),
    // "strict": asentado en disco antes de decir "guardada en este teléfono".
    poner: (tabla, xs) =>
      conDb(async (d) => {
        const t = d.transaction(tabla, "readwrite", { durability: "strict" });
        for (const x of xs) t.objectStore(tabla).put(x);
        await fin(t);
      }),
    quitar: (tabla, claves) =>
      conDb(async (d) => {
        const t = d.transaction(tabla, "readwrite", { durability: "strict" });
        for (const c of claves) t.objectStore(tabla).delete(c);
        await fin(t);
      }),
  };
}

function almacenMemoria(): Almacen {
  const m = new Map<string, Map<string, Fila>>([
    [COPIAS, new Map()],
    [ENTRADAS, new Map()],
  ]);
  return {
    persistente: false,
    todos: async <T extends Fila>(tabla: string) => [...m.get(tabla)!.values()].map((x) => structuredClone(x) as T),
    poner: async (tabla, xs) => void xs.forEach((x) => m.get(tabla)!.set(x.clave, structuredClone(x))),
    quitar: async (tabla, cs) => void cs.forEach((c) => m.get(tabla)!.delete(c)),
  };
}

let almacen: Promise<Almacen> | null = null;
function obtenerAlmacen(): Promise<Almacen> {
  almacen ??= (async () => {
    try {
      if (typeof indexedDB === "undefined") throw new Error("sin IndexedDB");
      const a = almacenIdb(await abrirDb());
      await a.todos(ENTRADAS);
      void navigator.storage?.persist?.().catch(() => false);
      return a;
    } catch (e) {
      console.error("El escáner de respaldo queda solo en memoria:", e);
      return almacenMemoria();
    }
  })();
  return almacen;
}

// ---------------------------------------------------------------------------
// Avisos entre pestañas
// ---------------------------------------------------------------------------

let canal: BroadcastChannel | null | undefined;
function obtenerCanal(): BroadcastChannel | null {
  if (canal === undefined) {
    try {
      canal = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CANAL);
    } catch {
      canal = null;
    }
  }
  return canal;
}
const oyentes = new Set<() => void>();
function avisar() {
  oyentes.forEach((f) => f());
  try {
    obtenerCanal()?.postMessage("cambio");
  } catch {
    // sin canal: la otra pestaña lo verá en su siguiente lectura
  }
}
export function suscribirPuerta(f: () => void): () => void {
  oyentes.add(f);
  const c = obtenerCanal();
  c?.addEventListener("message", f);
  return () => {
    oyentes.delete(f);
    c?.removeEventListener("message", f);
  };
}

// Con la bandera apagada el escáner no crea su base local: leer o borrar
// solo abre la base si ya existe (si el navegador no sabe decirlo, la abre).
async function existeBase(): Promise<boolean> {
  if (almacen) return true;
  try {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return true;
    return (await indexedDB.databases()).some((d) => d.name === DB);
  } catch {
    return true;
  }
}

// ¿Este teléfono tiene la base local del escáner de respaldo? (Para el barrido.)
export const hayDatosPuerta = existeBase;

export async function puertaPersistente(): Promise<boolean> {
  if (!(await existeBase())) return true;
  return (await obtenerAlmacen()).persistente;
}

// ---------------------------------------------------------------------------
// Copia de la noche
// ---------------------------------------------------------------------------

// La copia vigente de este usuario y antro. De paso borra las vencidas y
// las de otras cuentas (un teléfono compartido no conserva la copia de otro).
export async function leerCopiaGuardada(usuarioId: string, clubId: string): Promise<CopiaNoche | null> {
  if (!(await existeBase())) return null;
  const a = await obtenerAlmacen();
  const todas = await a.todos<CopiaNoche>(COPIAS);
  const ahora = new Date();
  const fuera = todas.filter((c) => c.usuarioId !== usuarioId || copiaVencida(c, ahora)).map((c) => c.clave);
  if (fuera.length) await a.quitar(COPIAS, fuera).catch(() => {});
  return todas.find((c) => c.usuarioId === usuarioId && c.clubId === clubId && !fuera.includes(c.clave)) ?? null;
}

export async function guardarCopia(copia: CopiaNoche): Promise<void> {
  await (await obtenerAlmacen()).poner(COPIAS, [copia]);
  avisar();
}

// Entrada confirmada con señal: la copia lo sabe sin esperar a renovarse
// (si se va la señal y lo vuelven a escanear, dice "ya entró"). Se quita
// el nombre, como en la copia que manda la base.
export async function marcarEntroEnCopia(usuarioId: string, clubId: string, reservationId: string): Promise<void> {
  const a = await obtenerAlmacen();
  const c = (await a.todos<CopiaNoche>(COPIAS)).find((x) => x.usuarioId === usuarioId && x.clubId === clubId);
  if (!c) return;
  const ahora = new Date().toISOString();
  const reservas = c.reservas.map((r) =>
    r.reservation_id === reservationId ? { ...r, entro: true, entrada_en: r.entrada_en ?? ahora, cliente_nombre: null, rp_nombre: null } : r,
  );
  await a.poner(COPIAS, [{ ...c, reservas }]);
  avisar();
}

// Al cerrar sesión (o con la bandera apagada): no queda ninguna copia.
export async function borrarCopias(): Promise<void> {
  if (!(await existeBase())) return;
  const a = await obtenerAlmacen();
  const todas = await a.todos<CopiaNoche>(COPIAS);
  if (todas.length) {
    await a.quitar(COPIAS, todas.map((c) => c.clave));
    avisar();
  }
}

// Huella del código leído, igual que la de la base:
// encode(sha256(convert_to(qr_code, 'UTF8')), 'hex').
export async function huellaDe(qr: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null; // solo en https o localhost
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(qr.trim()));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entradas sin señal
// ---------------------------------------------------------------------------

// Lo de esta cuenta (pendientes y resueltas). De paso aplica el barrido
// (planBarrido): vence lo que ya no se puede enviar y borra lo viejo.
export async function leerEntradas(usuarioId: string): Promise<EntradaPendiente[]> {
  if (!(await existeBase())) return [];
  const a = await obtenerAlmacen();
  const todas = await a.todos<EntradaPendiente>(ENTRADAS);
  const { entradasBorrar, entradasVencer } = planBarrido([], todas, usuarioId, new Date());
  if (entradasBorrar.length) await a.quitar(ENTRADAS, entradasBorrar).catch(() => {});
  if (entradasVencer.length) await a.poner(ENTRADAS, entradasVencer).catch(() => {});
  const vencidas = new Map(entradasVencer.map((x) => [x.clave, x]));
  return todas
    .filter((x) => x.usuarioId === usuarioId && !entradasBorrar.includes(x.clave))
    .map((x) => vencidas.get(x.clave) ?? x)
    .sort((x, y) => x.escaneadoEn.localeCompare(y.escaneadoEn));
}

// Barrido de privacidad (components/service-worker-register.tsx lo corre en
// todas las pantallas al abrir y cada 10 min). Si el escáner de respaldo
// nunca se usó en este teléfono, no hace nada (no crea la base).
// `actual`: quien tiene la sesión; null si no hay o no se pudo leer.
export async function barrerDatosLocales(actual: string | null): Promise<{ copias: number; entradas: number }> {
  if (!(await existeBase())) return { copias: 0, entradas: 0 };
  const a = await obtenerAlmacen();
  const plan = planBarrido(await a.todos<CopiaNoche>(COPIAS), await a.todos<EntradaPendiente>(ENTRADAS), actual, new Date());
  if (plan.copiasBorrar.length) await a.quitar(COPIAS, plan.copiasBorrar);
  if (plan.entradasBorrar.length) await a.quitar(ENTRADAS, plan.entradasBorrar);
  if (plan.entradasVencer.length) await a.poner(ENTRADAS, plan.entradasVencer);
  const n = { copias: plan.copiasBorrar.length, entradas: plan.entradasBorrar.length + plan.entradasVencer.length };
  if (n.copias || n.entradas) avisar();
  return n;
}

export async function guardarEntrada(x: EntradaPendiente): Promise<void> {
  await (await obtenerAlmacen()).poner(ENTRADAS, [x]);
  avisar();
}

export async function quitarEntradas(claves: string[]): Promise<void> {
  if (!claves.length) return;
  await (await obtenerAlmacen()).quitar(ENTRADAS, claves);
  avisar();
}

// Para el aviso al cerrar sesión y la página sin conexión.
export async function contarEntradasPendientes(usuarioId?: string): Promise<number> {
  if (!(await existeBase())) return 0;
  const todas = await (await obtenerAlmacen()).todos<EntradaPendiente>(ENTRADAS);
  const ahora = new Date();
  return todas.filter((x) => x.estado === "pendiente" && !pendienteVencida(x, ahora) && (!usuarioId || x.usuarioId === usuarioId)).length;
}

let ocupadoLocal: Promise<unknown> = Promise.resolve();
async function conCandado<T>(f: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  const previo = ocupadoLocal;
  let soltar!: () => void;
  ocupadoLocal = new Promise<void>((r) => (soltar = r));
  try {
    await previo.catch(() => {});
    if (locks?.request) return (await locks.request(CANDADO, f)) as T;
    return await f();
  } finally {
    soltar();
  }
}

export type LlamarEnvio = (x: EntradaPendiente) => Promise<RespuestaEnvio>;

export interface ResultadoEnvio {
  enviadas: number;
  duplicadas: number;
  rechazadas: number;
  falloRed: boolean;
}

// Manda lo pendiente de usuarioId, en orden de captura. Para en el primer
// fallo de red (lo demás fallaría igual).
export async function enviarEntradas(
  usuarioId: string,
  llamar: LlamarEnvio,
): Promise<ResultadoEnvio> {
  return conCandado(async () => {
    const res: ResultadoEnvio = { enviadas: 0, duplicadas: 0, rechazadas: 0, falloRed: false };
    const a = await obtenerAlmacen();
    const lista = porEnviar(await a.todos<EntradaPendiente>(ENTRADAS), usuarioId);
    try {
      for (const x of lista) {
        let r: RespuestaEnvio;
        try {
          r = await llamar(x);
        } catch (e) {
          r = { error: { message: e instanceof Error ? e.message : "sin respuesta" } };
        }
        const c = clasificarEnvio(r, esErrorDeRed(r.error));
        const ahora = new Date().toISOString();
        if (c.tipo === "reintentar") {
          await a.poner(ENTRADAS, [{ ...x, intentos: x.intentos + 1 }]);
          res.falloRed = true;
          break;
        }
        if (c.tipo === "enviada") {
          await a.poner(ENTRADAS, [{ ...x, intentos: x.intentos + 1, estado: "enviada", entradaEn: c.entradaEn, resueltoEn: ahora }]);
          res.enviadas++;
        } else if (c.tipo === "duplicada") {
          await a.poner(ENTRADAS, [
            { ...x, intentos: x.intentos + 1, estado: "duplicada", motivo: c.motivo, entradaEn: c.entradaEn, resueltoEn: ahora },
          ]);
          res.duplicadas++;
        } else {
          await a.poner(ENTRADAS, [{ ...x, intentos: x.intentos + 1, estado: "rechazada", motivo: c.motivo, resueltoEn: ahora }]);
          res.rechazadas++;
        }
      }
    } finally {
      if (res.enviadas || res.duplicadas || res.rechazadas || res.falloRed) avisar();
    }
    return res;
  });
}
