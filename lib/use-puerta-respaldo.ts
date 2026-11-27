"use client";

// Escáner de respaldo en React (bandera `escaner_respaldo`):
//  - useSesionUsuario: quién tiene la sesión en este teléfono (sin red).
//  - useCopiaPuerta: baja y renueva la copia de esta noche mientras hay
//    señal (al abrir el panel, cada 5 min, al volver la red y al volver a la
//    pantalla). Con la bandera apagada borra cualquier copia.
//  - useEntradasPuerta: lo que este teléfono guardó sin señal.
//  - enviarPendientesPuerta: manda lo pendiente con puerta_entrada_diferida,
//    solo con la sesión de quien lo capturó.
// Almacén en lib/puerta-respaldo.ts; reglas en lib/domain/puerta-respaldo.ts.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useEnLinea } from "@/lib/use-en-linea";
import { useFunciones } from "@/lib/funciones";
import { conLimite, LIMITE_LLAMADA_MS } from "@/lib/domain/caja-cola";
import { leerCopia, type CopiaNoche, type EntradaPendiente } from "@/lib/domain/puerta-respaldo";
import {
  borrarCopias,
  enviarEntradas,
  guardarCopia,
  leerCopiaGuardada,
  leerEntradas,
  puertaPersistente,
  suscribirPuerta,
  type ResultadoEnvio,
} from "@/lib/puerta-respaldo";

export const RENOVAR_COPIA_MS = 5 * 60 * 1000;

// ¿El panel usa el escáner de respaldo? La bandera de la base
// (useFunciones). Si no se pudo preguntar (sin señal) y este teléfono tiene
// una copia vigente de la noche de este antro (solo se baja con la bandera
// encendida), se sigue usando: justo sin señal es cuando hace falta.
// `listo`: la base contestó; solo entonces "apagada" es de verdad apagada
// (y se puede borrar la copia).
export function useEscanerRespaldo(clubId: string | null): { activa: boolean; listo: boolean; error: boolean } {
  const funciones = useFunciones(clubId);
  const { usuarioId } = useSesionUsuario();
  const [copiaLocal, setCopiaLocal] = useState(false);
  useEffect(() => {
    let vivo = true;
    if (!funciones.error || !usuarioId || !clubId) {
      setCopiaLocal(false);
      return;
    }
    void leerCopiaGuardada(usuarioId, clubId).then((c) => vivo && setCopiaLocal(Boolean(c)), () => {});
    return () => {
      vivo = false;
    };
  }, [funciones.error, usuarioId, clubId]);
  const encendida = funciones.activa("escaner_respaldo");
  return {
    activa: encendida || (funciones.error && copiaLocal),
    listo: funciones.respondio,
    error: funciones.error,
  };
}
// Se avisa en la pestaña cuando entradas guardadas sin señal llegan a la base
// (el panel recarga su lista de la noche).
export const EVENTO_ENVIADAS = "antroapp-puerta-enviadas";

export function useSesionUsuario(): { usuarioId: string | null; lista: boolean } {
  const [estado, setEstado] = useState<{ usuarioId: string | null; lista: boolean }>({ usuarioId: null, lista: false });
  useEffect(() => {
    const supabase = createClient();
    let vivo = true;
    // getSession no usa la red salvo para renovar el token.
    void conLimite(
      supabase.auth.getSession().then(({ data }) => data.session?.user.id ?? null, () => null),
      3_000,
      null,
    ).then((id) => vivo && setEstado({ usuarioId: id, lista: true }));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((evento, s) => {
      if (!vivo) return;
      // Sesión cerrada: la copia de la noche no se queda en el teléfono.
      if (evento === "SIGNED_OUT") void borrarCopias().catch(() => {});
      setEstado({ usuarioId: s?.user.id ?? null, lista: true });
    });
    return () => {
      vivo = false;
      subscription.unsubscribe();
    };
  }, []);
  return estado;
}

export interface CopiaPuerta {
  copia: CopiaNoche | null;
  descargando: boolean;
  // Último error al bajarla (sin señal no es error: se usa la guardada).
  error: string | null;
  descargar: () => Promise<void>;
}

export function useCopiaPuerta({
  usuarioId,
  clubId,
  activa,
  listo,
}: {
  usuarioId: string | null;
  clubId: string | null;
  activa: boolean;
  listo: boolean; // ya se sabe si la bandera está encendida
}): CopiaPuerta {
  const enLinea = useEnLinea();
  const [copia, setCopia] = useState<CopiaNoche | null>(null);
  const [descargando, setDescargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const releer = useCallback(async () => {
    // Con la bandera apagada no se abre (ni se crea) la base local.
    if (!usuarioId || !clubId || !activa) return setCopia(null);
    setCopia(await leerCopiaGuardada(usuarioId, clubId).catch(() => null));
  }, [usuarioId, clubId, activa]);

  const descargar = useCallback(async () => {
    if (!usuarioId || !clubId || !activa || !navigator.onLine) return;
    setDescargando(true);
    try {
      const supabase = createClient();
      const r = await conLimite(
        Promise.resolve(supabase.rpc("puerta_copia_noche", { p_club_id: clubId })).then(
          ({ data, error: e }) => ({ data: data as unknown, error: e ? { message: e.message, code: e.code } : null }),
        ),
        LIMITE_LLAMADA_MS,
        { data: null as unknown, error: { message: "timeout", code: "" } },
      );
      if (r.error) {
        // La base dice que no (bandera apagada, sin permiso): no se guarda nada.
        if (r.error.code === "P0001") {
          await borrarCopias().catch(() => {});
          setError(r.error.message);
        } else setError("No se pudo actualizar la copia de la noche.");
        return;
      }
      const nueva = leerCopia(r.data, usuarioId);
      if (!nueva) return setError("No se pudo leer la copia de la noche.");
      await guardarCopia(nueva);
      setError(null);
    } catch {
      setError("No se pudo actualizar la copia de la noche.");
    } finally {
      setDescargando(false);
      await releer();
    }
  }, [usuarioId, clubId, activa, releer]);

  // Bandera apagada (ya confirmada): ninguna copia en el teléfono.
  useEffect(() => {
    if (listo && !activa) void borrarCopias().then(() => setCopia(null), () => {});
  }, [listo, activa]);

  useEffect(() => {
    void releer();
    return suscribirPuerta(() => void releer());
  }, [releer]);

  useEffect(() => {
    if (!activa || !enLinea) return;
    void descargar();
    const t = window.setInterval(() => void descargar(), RENOVAR_COPIA_MS);
    const alVolver = () => document.visibilityState === "visible" && void descargar();
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [activa, enLinea, descargar]);

  // La cámara sin señal: el lector (html5-qrcode) se carga aparte; se baja
  // ahora para que esté en memoria cuando se vaya la señal.
  useEffect(() => {
    if (activa && enLinea) void import("html5-qrcode").catch(() => {});
  }, [activa, enLinea]);

  return { copia, descargando, error, descargar };
}

export function useEntradasPuerta(usuarioId: string | null): {
  entradas: EntradaPendiente[];
  pendientes: number;
  persistente: boolean;
} {
  const [entradas, setEntradas] = useState<EntradaPendiente[]>([]);
  const [persistente, setPersistente] = useState(true);
  useEffect(() => {
    if (!usuarioId) {
      setEntradas([]);
      return;
    }
    let vivo = true;
    const releer = () => void leerEntradas(usuarioId).then((xs) => vivo && setEntradas(xs), () => {});
    releer();
    void puertaPersistente().then((p) => vivo && setPersistente(p));
    const quitar = suscribirPuerta(releer);
    return () => {
      vivo = false;
      quitar();
    };
  }, [usuarioId]);
  return { entradas, pendientes: entradas.filter((x) => x.estado === "pendiente").length, persistente };
}

// Manda lo pendiente de usuarioId. No sale nada si la sesión del teléfono es
// de otra persona (lo suyo se queda hasta que vuelva a entrar).
export async function enviarPendientesPuerta(usuarioId: string): Promise<ResultadoEnvio | null> {
  const supabase = createClient();
  const sesion = await conLimite(
    supabase.auth.getSession().then(({ data }) => data.session, () => null),
    3_000,
    null,
  );
  if (!sesion || sesion.user.id !== usuarioId) return null;
  const r = await enviarEntradas(usuarioId, (x) =>
    conLimite(
      Promise.resolve(
        supabase.rpc("puerta_entrada_diferida", {
          p_club_id: x.clubId,
          p_reservation_id: x.reservationId,
          p_clave: x.clave,
          p_escaneado_en: x.escaneadoEn,
        }),
      ).then(({ data, error }) => ({ data, error })),
      LIMITE_LLAMADA_MS,
      { error: { message: "timeout" } },
    ),
  );
  if (r.enviadas || r.duplicadas) window.dispatchEvent(new Event(EVENTO_ENVIADAS));
  return r;
}
