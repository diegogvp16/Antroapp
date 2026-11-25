// Cola de caja en el teléfono (IndexedDB) y su envío a la base.
//
// Reglas en lib/domain/caja-cola.ts. Aquí solo:
//  - guardar, leer y borrar movimientos en IndexedDB ("antroapp-caja"),
//    separados por usuario. Si el navegador no deja usar IndexedDB (modo
//    privado, almacenamiento bloqueado) se cae a memoria y la pantalla lo
//    avisa: entonces sí se pierde al cerrar la app;
//  - vaciar la cola: uno a la vez en todo el navegador (Web Locks; si no
//    hay, candado en memoria), en el orden de captura, y parar en el primer
//    error de red;
//  - avisar a las otras pestañas cuando la cola cambia (BroadcastChannel).
//
// Nunca se guardan tokens ni datos de clientes: solo ids, montos, concepto
// y, en un cobro con tarjeta, la referencia que escribió el staff.

import { esErrorDeRed } from "@/lib/errores-base";
import {
  FUNCION_DE,
  clasificar,
  ordenar,
  porEnviar,
  vencido,
  type MovimientoPendiente,
  type RespuestaLlamada,
} from "@/lib/domain/caja-cola";

const DB = "antroapp-caja";
const VERSION_DB = 1;
const ALMACEN = "pendientes";
const CANAL = "antroapp-caja-cola";
const CANDADO = "antroapp-caja-cola";

// ---------------------------------------------------------------------------
// Almacén
// ---------------------------------------------------------------------------

interface Almacen {
  persistente: boolean;
  todos(): Promise<MovimientoPendiente[]>;
  uno(clave: string): Promise<MovimientoPendiente | undefined>;
  poner(xs: MovimientoPendiente[]): Promise<void>;
  quitar(claves: string[]): Promise<void>;
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
      if (!db.objectStoreNames.contains(ALMACEN)) {
        const s = db.createObjectStore(ALMACEN, { keyPath: "clave" });
        s.createIndex("usuarioId", "usuarioId");
      }
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
    r.onblocked = () => mal(new Error("IndexedDB bloqueada"));
  });
}

// El navegador puede cerrar la conexión a IndexedDB con la app en segundo
// plano (iOS lo hace al volver de otra app: "Connection to Indexed Database
// server lost"). Entonces se reabre y se repite la operación una vez, en
// lugar de fallar toda la noche hasta recargar.
function conexionPerdida(e: unknown): boolean {
  const n = e instanceof Error || (typeof DOMException !== "undefined" && e instanceof DOMException) ? e.name : "";
  return n === "InvalidStateError" || n === "UnknownError" || n === "TransactionInactiveError";
}

function almacenIdb(primera: IDBDatabase): Almacen {
  let db: Promise<IDBDatabase> = Promise.resolve(primera);
  function vigilar(d: IDBDatabase) {
    d.onclose = () => void reabrir();
    // Otra pestaña con una versión nueva de la base local: soltar la conexión
    // (la siguiente operación la reabre).
    d.onversionchange = () => d.close();
  }
  function reabrir(): Promise<IDBDatabase> {
    db = abrirDb().then((n) => {
      vigilar(n);
      return n;
    });
    db.catch(() => {}); // si falla, la siguiente operación vuelve a intentar
    return db;
  }
  vigilar(primera);
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
  // Escrituras "strict": el navegador las asienta en disco antes de decir
  // que terminaron. Con "relaxed" (lo normal en Chrome) un apagón por batería
  // justo después de "Guardado en este teléfono" podía perder lo último.
  const escribir = (d: IDBDatabase) => d.transaction(ALMACEN, "readwrite", { durability: "strict" });
  const fin = (t: IDBTransaction) =>
    new Promise<void>((ok, mal) => {
      t.oncomplete = () => ok();
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error ?? new Error("transacción cancelada"));
    });
  return {
    persistente: true,
    todos: () => conDb((d) => promesa(d.transaction(ALMACEN, "readonly").objectStore(ALMACEN).getAll() as IDBRequest<MovimientoPendiente[]>)),
    uno: (clave) =>
      conDb((d) => promesa(d.transaction(ALMACEN, "readonly").objectStore(ALMACEN).get(clave) as IDBRequest<MovimientoPendiente | undefined>)),
    poner: (xs) =>
      conDb(async (d) => {
        const t = escribir(d);
        for (const x of xs) t.objectStore(ALMACEN).put(x);
        await fin(t);
      }),
    quitar: (claves) =>
      conDb(async (d) => {
        const t = escribir(d);
        for (const c of claves) t.objectStore(ALMACEN).delete(c);
        await fin(t);
      }),
  };
}

function almacenMemoria(): Almacen {
  const m = new Map<string, MovimientoPendiente>();
  return {
    persistente: false,
    todos: async () => [...m.values()].map((x) => ({ ...x })),
    uno: async (c) => (m.has(c) ? { ...m.get(c)! } : undefined),
    poner: async (xs) => void xs.forEach((x) => m.set(x.clave, { ...x })),
    quitar: async (cs) => void cs.forEach((c) => m.delete(c)),
  };
}

let almacen: Promise<Almacen> | null = null;
function obtenerAlmacen(): Promise<Almacen> {
  almacen ??= (async () => {
    try {
      if (typeof indexedDB === "undefined") throw new Error("sin IndexedDB");
      const a = almacenIdb(await abrirDb());
      await a.todos(); // prueba de lectura: en algunos modos privados abre pero falla al leer
      // Pedir que el navegador no borre la base local cuando le falte espacio
      // (la PWA instalada suele tenerlo ya). Si no lo concede, igual funciona.
      void navigator.storage?.persist?.().catch(() => false);
      return a;
    } catch (e) {
      console.error("La cola de caja queda solo en memoria:", e);
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

type Oyente = (origen: "local" | "otra") => void;
const oyentesLocales = new Set<Oyente>();
function avisar() {
  oyentesLocales.forEach((f) => f("local"));
  try {
    obtenerCanal()?.postMessage("cambio");
  } catch {
    // sin canal: las otras pestañas lo verán en su siguiente revisión
  }
}

// f se llama cuando la cola cambia, en esta pestaña ("local") o en otra
// ("otra": pudo mandar movimientos y la caja debe recargarse).
export function suscribirCola(f: Oyente): () => void {
  oyentesLocales.add(f);
  const c = obtenerCanal();
  const alMensaje = () => f("otra");
  c?.addEventListener("message", alMensaje);
  return () => {
    oyentesLocales.delete(f);
    c?.removeEventListener("message", alMensaje);
  };
}

// ---------------------------------------------------------------------------
// Operaciones
// ---------------------------------------------------------------------------

export async function colaPersistente(): Promise<boolean> {
  return (await obtenerAlmacen()).persistente;
}

// Movimientos de una persona (pendientes y rechazados), en orden de captura.
// De paso limpia lo rechazado vencido (más de 72 h).
export async function leerCola(usuarioId: string): Promise<MovimientoPendiente[]> {
  const a = await obtenerAlmacen();
  const todos = await a.todos();
  const ahora = new Date();
  const viejos = todos.filter((x) => vencido(x, ahora)).map((x) => x.clave);
  if (viejos.length) await a.quitar(viejos).catch(() => {});
  return ordenar(todos.filter((x) => x.usuarioId === usuarioId && !viejos.includes(x.clave)));
}

export async function guardarEnCola(xs: MovimientoPendiente[]): Promise<void> {
  if (!xs.length) return;
  await (await obtenerAlmacen()).poner(xs);
  avisar();
}

export async function quitarDeCola(claves: string[]): Promise<void> {
  if (!claves.length) return;
  await (await obtenerAlmacen()).quitar(claves);
  avisar();
}

export async function leerMovimiento(clave: string): Promise<MovimientoPendiente | undefined> {
  return (await obtenerAlmacen()).uno(clave);
}

// El orden más alto en la cola (de cualquier usuario): lo nuevo va después,
// aunque el reloj del teléfono se haya atrasado (ordenDeCaptura).
export async function ultimoOrden(): Promise<number> {
  const todos = await (await obtenerAlmacen()).todos();
  return todos.reduce((m, x) => Math.max(m, Number.isFinite(x.orden) ? x.orden : 0), 0);
}

// Candado: un solo vaciado a la vez en todo el navegador (todas las pestañas).
let ocupadoLocal: Promise<unknown> = Promise.resolve();
async function conCandado<T>(f: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  // El candado en memoria va siempre (dos llamadas de la misma pestaña se
  // forman); Web Locks además forma a las otras pestañas.
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

export type Llamar = (funcion: string, args: Record<string, unknown>) => Promise<RespuestaLlamada>;

export interface ResultadoVaciado {
  aplicados: string[];
  rechazados: string[];
  falloRed: boolean;
  sinSesion: boolean;
  // La sesión del teléfono dejó de ser la de usuarioId a media pasada (otra
  // persona entró en otra pestaña): se paró sin mandar lo demás.
  otraSesion: boolean;
}

// Manda lo pendiente de usuarioId, en orden. Para en el primer fallo de red o
// de sesión (lo que sigue fallaría igual) y deja lo demás para después.
// sigueLaSesion: se revisa antes de cada envío; si la sesión del teléfono ya
// no es la de usuarioId, se para (la cola de uno nunca sale con la sesión de
// otro, aunque cambie a media pasada).
export async function vaciarCola(
  usuarioId: string,
  llamar: Llamar,
  sigueLaSesion: () => Promise<boolean> = async () => true,
): Promise<ResultadoVaciado> {
  return conCandado(async () => {
    const res: ResultadoVaciado = { aplicados: [], rechazados: [], falloRed: false, sinSesion: false, otraSesion: false };
    const a = await obtenerAlmacen();
    // Se lee dentro del candado: otra pestaña pudo mandar algo mientras se esperaba.
    const lista = porEnviar(await a.todos(), usuarioId);
    try {
      for (const x of lista) {
        const funcion = FUNCION_DE[x.tipo];
        if (!funcion) {
          await a.poner([{ ...x, estado: "rechazado", motivo: "Movimiento no reconocido.", rechazadoEn: new Date().toISOString() }]);
          res.rechazados.push(x.clave);
          continue;
        }
        if (!(await sigueLaSesion().catch(() => false))) {
          res.otraSesion = true;
          break;
        }
        let r: RespuestaLlamada;
        try {
          r = await llamar(funcion, x.args);
        } catch (e) {
          r = { error: { message: e instanceof Error ? e.message : "sin respuesta" } };
        }
        const c = clasificar(r, esErrorDeRed(r.error) || (!r.error?.code && r.status === 0));
        if (c.tipo === "aplicado") {
          await a.quitar([x.clave]);
          res.aplicados.push(x.clave);
        } else if (c.tipo === "rechazado") {
          await a.poner([{ ...x, intentos: x.intentos + 1, estado: "rechazado", motivo: c.motivo, rechazadoEn: new Date().toISOString() }]);
          res.rechazados.push(x.clave);
        } else {
          await a.poner([{ ...x, intentos: x.intentos + 1 }]);
          if (c.tipo === "sin_sesion") res.sinSesion = true;
          else res.falloRed = true;
          break;
        }
      }
    } finally {
      if (res.aplicados.length || res.rechazados.length || res.falloRed || res.sinSesion || res.otraSesion) avisar();
    }
    return res;
  });
}

// Para la página sin conexión y el aviso al cerrar sesión: cuántos
// movimientos pendientes hay en este teléfono (de cualquier usuario).
export async function contarPendientes(usuarioId?: string): Promise<number> {
  const todos = await (await obtenerAlmacen()).todos();
  return todos.filter((x) => x.estado === "pendiente" && (!usuarioId || x.usuarioId === usuarioId)).length;
}
