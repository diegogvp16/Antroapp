"use client";

// La cola de caja en React: qué hay pendiente o rechazado para quien tiene
// la sesión, y cuándo mandarlo (al abrir la caja, al volver la red, al
// volver a la pantalla y con espera creciente si la red sigue fallando).
// Reglas en lib/domain/caja-cola.ts; almacén y envío en lib/caja-cola.ts.
//
// Con mala señal en plena noche:
//  - cada envío se corta a los LIMITE_LLAMADA_MS y se reintenta (seguro por
//    la clave); la hoja espera a lo más LIMITE_HOJA_MS y se cierra con
//    "guardado en el teléfono";
//  - la cola sale SIEMPRE con el token de quien la capturó (un cliente con
//    el token fijo), y antes de cada envío se revisa que la sesión del
//    teléfono siga siendo suya: si otra persona entra en otra pestaña, se
//    para;
//  - si la sesión se cerró o venció sin poder renovarse, se dice (no "la
//    señal sigue fallando") y lo pendiente se queda hasta que vuelva a entrar.

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient as clienteSupabase, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { esErrorDeRed } from "@/lib/errores-base";
import {
  colaPersistente,
  contarPendientes,
  guardarEnCola,
  leerCola,
  leerMovimiento,
  quitarDeCola,
  suscribirCola,
  ultimoOrden,
  vaciarCola,
  type Llamar,
} from "@/lib/caja-cola";
import {
  LIMITE_HOJA_MS,
  LIMITE_LLAMADA_MS,
  conLimite,
  crearPendiente,
  esperaMs,
  estadoDeSesion,
  type EstadoSesion,
  type MovimientoPendiente,
  type NuevoMovimiento,
} from "@/lib/domain/caja-cola";

export type ResultadoEnvio =
  | { estado: "aplicado" } // la base lo guardó
  | { estado: "en_cola" } // guardado en el teléfono; se manda solo después
  | { estado: "rechazado"; motivo: string }; // la base dijo que no (ya no está en la cola)

export interface ColaCaja {
  // Del usuario con sesión: pendientes y rechazados, en orden de captura.
  movimientos: MovimientoPendiente[];
  // Pendientes de OTRA cuenta en este teléfono (solo el número).
  deOtraCuenta: number;
  // false si el teléfono no deja guardar (entonces cerrar la app sí pierde).
  persistente: boolean;
  enviando: boolean;
  // La sesión del teléfono frente a la de quien abrió la caja.
  sesion: Exclude<EstadoSesion, "desconocida">;
  enviar: (nuevos: NuevoMovimiento[]) => Promise<ResultadoEnvio>;
  descartar: (claves: string[]) => Promise<void>;
  sincronizar: () => void;
}

export const MOTIVO_OTRA_CUENTA = "Entró otra cuenta en este teléfono. Vuelve a abrir la caja para seguir.";
export const MOTIVO_SESION_VENCIDA = "Tu sesión se cerró. Vuelve a entrar para seguir capturando.";

// Cliente solo para mandar la cola, con el token de quien capturó fijo: si a
// media pasada otra persona inicia sesión en otra pestaña, lo que sigue no
// sale con su sesión. Sin GoTrue propio (accessToken), así que no guarda nada.
let fijo: { token: string; cliente: SupabaseClient } | null = null;
function clienteConToken(token: string): SupabaseClient {
  if (fijo?.token !== token)
    fijo = {
      token,
      cliente: clienteSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        accessToken: async () => token,
      }),
    };
  return fijo.cliente;
}

// Señal que se corta sola (AbortSignal.timeout no está en Safari viejos).
function señalConLimite(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

interface LecturaSesion {
  usuario: string | null;
  token: string | null;
  sinRespuesta: boolean;
}
// getSession no usa la red salvo que el token haya vencido (entonces lo
// renueva, y con mala señal eso puede tardar): se le pone límite.
function leerSesion(ms: number = LIMITE_LLAMADA_MS): Promise<LecturaSesion> {
  const lectura = createClient()
    .auth.getSession()
    .then(({ data, error }) => ({
      usuario: data.session?.user.id ?? null,
      token: data.session?.access_token ?? null,
      sinRespuesta:
        !!error &&
        (error.name === "AuthRetryableFetchError" ||
          esErrorDeRed(error) ||
          (typeof navigator !== "undefined" && navigator.onLine === false)),
    }))
    .catch(() => ({ usuario: null, token: null, sinRespuesta: true }));
  return conLimite(lectura, ms, { usuario: null, token: null, sinRespuesta: true });
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
  const [deOtraCuenta, setDeOtraCuenta] = useState(0);
  const [persistente, setPersistente] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [sesion, setSesionEstado] = useState<Exclude<EstadoSesion, "desconocida">>("ok");
  const sesionRef = useRef(sesion);
  const setSesion = useCallback((e: EstadoSesion) => {
    if (e === "desconocida") return; // sin señal no se sabe: se queda como estaba
    sesionRef.current = e;
    setSesionEstado(e);
  }, []);
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
    if (!usuarioId) {
      setMovimientos([]);
      setDeOtraCuenta(0);
      return;
    }
    try {
      const [lista, todos] = await Promise.all([leerCola(usuarioId), contarPendientes()]);
      setMovimientos(lista.filter((x) => !(x.estado === "rechazado" && enHoja.current.has(x.clave))));
      setDeOtraCuenta(Math.max(0, todos - lista.filter((x) => x.estado === "pendiente").length));
    } catch (e) {
      console.error("No se pudo leer la cola de caja:", e);
    }
  }, [usuarioId]);

  const programarReintento = useCallback(() => {
    fallos.current += 1;
    if (temporizador.current) window.clearTimeout(temporizador.current);
    temporizador.current = window.setTimeout(() => {
      temporizador.current = null;
      reintentar.current();
    }, esperaMs(fallos.current, Math.random()));
  }, []);

  // Una pasada completa. Las pasadas se forman (nunca dos a la vez en esta
  // pestaña; entre pestañas lo cuida el candado de lib/caja-cola.ts).
  const pasada = useCallback(async () => {
    if (!usuarioId) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    // Solo se manda con la sesión de quien capturó.
    const s = await leerSesion();
    const estado = estadoDeSesion(s.usuario, usuarioId, s.sinRespuesta);
    setSesion(estado);
    const hayPendientes = (await leerCola(usuarioId)).some((x) => x.estado === "pendiente");
    if (!hayPendientes) {
      fallos.current = 0;
      return;
    }
    if (estado === "desconocida") return programarReintento();
    if (estado !== "ok" || !s.token) return; // vencida u otra cuenta: hasta que vuelva a entrar
    setEnviando(true);
    try {
      const cliente = clienteConToken(s.token);
      const llamar: Llamar = async (funcion, args) => {
        const r = await cliente.rpc(funcion, args).abortSignal(señalConLimite(LIMITE_LLAMADA_MS));
        return { error: r.error ? { message: r.error.message, code: r.error.code } : null, status: r.status };
      };
      // Antes de cada envío: ¿la sesión del teléfono sigue siendo suya? Sin
      // respuesta (señal mala) se sigue: el token fijo es el suyo.
      const sigue = async () => {
        const e = estadoDeSesion((await leerSesion(3_000)).usuario, usuarioId, true);
        return e === "ok" || e === "desconocida";
      };
      const r = await vaciarCola(usuarioId, llamar, sigue);
      if (r.aplicados.length || r.rechazados.length) await onCambio.current?.().catch(() => {});
      if (r.otraSesion) {
        const d = await leerSesion();
        setSesion(estadoDeSesion(d.usuario, usuarioId, d.sinRespuesta));
        return;
      }
      if (r.sinSesion) {
        // El token venció (o la base no lo aceptó): renovarlo. Si ya no se
        // puede (sesión revocada), GoTrue la borra y queda "vencida".
        await conLimite(
          createClient().auth.refreshSession().then(() => undefined, () => undefined),
          LIMITE_LLAMADA_MS,
          undefined,
        );
        const d = await leerSesion();
        setSesion(estadoDeSesion(d.usuario, usuarioId, d.sinRespuesta));
      }
      if (r.falloRed || r.sinSesion) programarReintento();
      else fallos.current = 0;
    } catch (e) {
      console.error("Error mandando la cola de caja:", e);
    } finally {
      setEnviando(false);
      await refrescar();
    }
  }, [usuarioId, refrescar, programarReintento, setSesion]);

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

  // Cambios de sesión que GoTrue avisa (cerrar sesión, renovar el token,
  // otra cuenta). Fuera del aviso (setTimeout): GoTrue pide no llamar a
  // auth dentro de su propio aviso.
  useEffect(() => {
    if (!usuarioId) return;
    const {
      data: { subscription },
    } = createClient().auth.onAuthStateChange((evento, s) => {
      if (evento === "INITIAL_SESSION") return;
      const e = estadoDeSesion(s?.user.id ?? null, usuarioId, false);
      setSesion(e);
      if (e === "ok" && (evento === "SIGNED_IN" || evento === "TOKEN_REFRESHED")) window.setTimeout(sincronizar, 0);
    });
    return () => subscription.unsubscribe();
  }, [usuarioId, setSesion, sincronizar]);

  // Al volver la red o la pantalla: intentar ya, sin esperar el temporizador
  // (y de paso revisar que la sesión siga siendo la misma).
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
      if (!usuarioId) return { estado: "rechazado", motivo: MOTIVO_SESION_VENCIDA };
      // Revisión rápida (sin red si el token sigue vigente): si en otra
      // pestaña entró otra persona, lo que se capture aquí no se guarda a
      // nombre de quien abrió la caja.
      const s = await leerSesion(1_500);
      const e = estadoDeSesion(s.usuario, usuarioId, s.sinRespuesta);
      setSesion(e);
      if (e === "otra_cuenta" || (e === "desconocida" && sesionRef.current === "otra_cuenta"))
        return { estado: "rechazado", motivo: MOTIVO_OTRA_CUENTA };
      if (e === "vencida" || (e === "desconocida" && sesionRef.current === "vencida"))
        return { estado: "rechazado", motivo: MOTIVO_SESION_VENCIDA };
      const ahora = new Date();
      const ultimo = await ultimoOrden().catch(() => 0);
      const filas = nuevos.map((n, i) => crearPendiente(n, usuarioId, ahora, i, ultimo));
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
        // Con señal mala la hoja no se queda girando: pasado el límite se
        // cierra con "guardado en el teléfono" y el envío sigue solo.
        await conLimite(sincronizarInterno(), LIMITE_HOJA_MS, undefined);
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
    [usuarioId, sincronizarInterno, refrescar, setSesion],
  );

  const descartar = useCallback(async (claves: string[]) => {
    await quitarDeCola(claves).catch((e) => console.error("No se pudo quitar de la cola:", e));
  }, []);

  return { movimientos, deOtraCuenta, persistente, enviando, sesion, enviar, descartar, sincronizar };
}
