"use client";

// La cola de caja en React: qué hay pendiente o rechazado para quien tiene
// la sesión, y cuándo mandarlo (al abrir la caja, al volver la red, al
// volver a la pantalla y con espera creciente si la red sigue fallando).
// Reglas en lib/domain/caja-cola.ts; almacén y envío en lib/caja-cola.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  colaPersistente,
  guardarEnCola,
  leerCola,
  leerMovimiento,
  quitarDeCola,
  suscribirCola,
  vaciarCola,
  type Llamar,
} from "@/lib/caja-cola";
import { crearPendiente, esperaMs, type MovimientoPendiente, type NuevoMovimiento } from "@/lib/domain/caja-cola";

export type ResultadoEnvio =
  | { estado: "aplicado" } // la base lo guardó
  | { estado: "en_cola" } // guardado en el teléfono; se manda solo después
  | { estado: "rechazado"; motivo: string }; // la base dijo que no (ya no está en la cola)

export interface ColaCaja {
  // Del usuario con sesión: pendientes y rechazados, en orden de captura.
  movimientos: MovimientoPendiente[];
  // false si el teléfono no deja guardar (entonces cerrar la app sí pierde).
  persistente: boolean;
  enviando: boolean;
  enviar: (nuevos: NuevoMovimiento[]) => Promise<ResultadoEnvio>;
  descartar: (claves: string[]) => Promise<void>;
  sincronizar: () => void;
}

export function useColaCaja({
  usuarioId,
  enLinea,
  onCambioEnBase,
}: {
  usuarioId: string | null;
  enLinea: boolean;
  // Se llama cuando algo de la cola llegó a la base (o la base lo rechazó):
  // la caja vuelve a leer la noche ANTES de quitarlo de la vista, para que el
  // saldo no brinque.
  onCambioEnBase?: () => Promise<void>;
}): ColaCaja {
  const [movimientos, setMovimientos] = useState<MovimientoPendiente[]>([]);
  const [persistente, setPersistente] = useState(true);
  const [enviando, setEnviando] = useState(false);
  // Lo que se está mandando desde una hoja abierta: si la base lo rechaza, el
  // error se muestra en la hoja y no en la lista de rechazados.
  const enHoja = useRef(new Set<string>());
  const fallos = useRef(0);
  const temporizador = useRef<number | null>(null);
  const cadena = useRef<Promise<void>>(Promise.resolve());
  // La pasada se reprograma a sí misma (espera creciente) a través de este ref.
  const reintentar = useRef<() => void>(() => {});
  const onCambio = useRef(onCambioEnBase);
  useEffect(() => {
    onCambio.current = onCambioEnBase;
  }, [onCambioEnBase]);

  const refrescar = useCallback(async () => {
    if (!usuarioId) return setMovimientos([]);
    try {
      const lista = await leerCola(usuarioId);
      setMovimientos(lista.filter((x) => !(x.estado === "rechazado" && enHoja.current.has(x.clave))));
    } catch (e) {
      console.error("No se pudo leer la cola de caja:", e);
    }
  }, [usuarioId]);

  const llamar: Llamar = useCallback(async (funcion, args) => {
    const r = await createClient().rpc(funcion, args);
    return { error: r.error ? { message: r.error.message, code: r.error.code } : null, status: r.status };
  }, []);

  // Una pasada completa. Las pasadas se forman (nunca dos a la vez en esta
  // pestaña; entre pestañas lo cuida el candado de lib/caja-cola.ts).
  const pasada = useCallback(async () => {
    if (!usuarioId) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const supabase = createClient();
    // getSession no usa la red: solo se manda con la sesión de quien capturó.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session || session.user.id !== usuarioId) return;
    if ((await leerCola(usuarioId)).every((x) => x.estado !== "pendiente")) {
      fallos.current = 0;
      return;
    }
    setEnviando(true);
    try {
      const r = await vaciarCola(usuarioId, llamar);
      if (r.aplicados.length || r.rechazados.length) await onCambio.current?.().catch(() => {});
      if (r.sinSesion) await supabase.auth.refreshSession().catch(() => {});
      if (r.falloRed || r.sinSesion) {
        fallos.current += 1;
        if (temporizador.current) window.clearTimeout(temporizador.current);
        temporizador.current = window.setTimeout(() => {
          temporizador.current = null;
          reintentar.current();
        }, esperaMs(fallos.current, Math.random()));
      } else {
        fallos.current = 0;
      }
    } catch (e) {
      console.error("Error mandando la cola de caja:", e);
    } finally {
      setEnviando(false);
      await refrescar();
    }
  }, [usuarioId, llamar, refrescar]);

  const sincronizarInterno = useCallback(() => {
    const siguiente = cadena.current.then(pasada, pasada);
    cadena.current = siguiente.catch(() => {});
    return siguiente;
  }, [pasada]);
  useEffect(() => {
    reintentar.current = () => void sincronizarInterno();
  }, [sincronizarInterno]);

  const sincronizar = useCallback(() => {
    fallos.current = 0;
    void sincronizarInterno();
  }, [sincronizarInterno]);

  // Al abrir la caja (o cambiar de usuario): leer y mandar lo que haya.
  useEffect(() => {
    void colaPersistente().then(setPersistente);
    void refrescar().then(() => sincronizarInterno());
  }, [refrescar, sincronizarInterno]);

  // Cambios de la cola en esta pestaña o en otra.
  useEffect(
    () =>
      suscribirCola((origen) => {
        if (origen === "otra") void (onCambio.current?.() ?? Promise.resolve()).catch(() => {}).then(refrescar);
        else void refrescar();
      }),
    [refrescar],
  );

  // Al volver la red o la pantalla: intentar ya, sin esperar el temporizador.
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === "visible") sincronizar();
    };
    window.addEventListener("online", sincronizar);
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      window.removeEventListener("online", sincronizar);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [sincronizar]);
  useEffect(() => {
    if (enLinea) sincronizar();
  }, [enLinea, sincronizar]);
  useEffect(
    () => () => {
      if (temporizador.current) window.clearTimeout(temporizador.current);
    },
    [],
  );

  const enviar = useCallback(
    async (nuevos: NuevoMovimiento[]): Promise<ResultadoEnvio> => {
      if (!usuarioId) return { estado: "rechazado", motivo: "Tu sesión expiró. Vuelve a iniciar sesión." };
      const ahora = new Date();
      const filas = nuevos.map((n, i) => crearPendiente(n, usuarioId, ahora, i));
      // Primero al teléfono: si la app se cierra a medio envío, no se pierde.
      // Si la cola ya tenía la clave (reintento desde la misma hoja), se
      // conserva la fila de antes (mismo orden).
      const nuevas: MovimientoPendiente[] = [];
      for (const f of filas) {
        const previo = await leerMovimiento(f.clave).catch(() => undefined);
        if (!previo) nuevas.push(f);
        else if (previo.estado === "rechazado") nuevas.push({ ...f, orden: previo.orden });
      }
      filas.forEach((f) => enHoja.current.add(f.clave));
      try {
        await guardarEnCola(nuevas);
        if (typeof navigator !== "undefined" && navigator.onLine === false) return { estado: "en_cola" };
        await sincronizarInterno();
        let motivo: string | null = null;
        let quedan = false;
        const rechazadas: string[] = [];
        for (const f of filas) {
          const x = await leerMovimiento(f.clave);
          if (!x) continue; // llegó a la base
          if (x.estado === "rechazado") {
            motivo ??= x.motivo;
            rechazadas.push(x.clave);
          } else quedan = true;
        }
        // Lo rechazado al momento se explica en la hoja abierta: no se queda
        // en la lista de rechazados.
        if (rechazadas.length) await quitarDeCola(rechazadas);
        if (motivo !== null || rechazadas.length) return { estado: "rechazado", motivo: motivo ?? "La base no aceptó este movimiento." };
        return quedan ? { estado: "en_cola" } : { estado: "aplicado" };
      } finally {
        filas.forEach((f) => enHoja.current.delete(f.clave));
        await refrescar();
      }
    },
    [usuarioId, sincronizarInterno, refrescar],
  );

  const descartar = useCallback(async (claves: string[]) => {
    await quitarDeCola(claves).catch((e) => console.error("No se pudo quitar de la cola:", e));
  }, []);

  return { movimientos, persistente, enviando, enviar, descartar, sincronizar };
}
