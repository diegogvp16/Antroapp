"use client";

// Banderas de funciones por antro y por grupo (sql/post-junta-3/00-funciones-club.sql).
// Cada función nueva de post-junta-3 se muestra SOLO si su bandera está
// encendida para ese antro. Apagadas por defecto; solo el admin las cambia
// (/admin/funciones). La base es la que manda: aunque la pantalla se
// muestre, las funciones de la base revisan funcion_activa() por su cuenta.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export const FUNCIONES = [
  { clave: "pos_ventas", nombre: "Ventas del POS", descripcion: "Importar ventas del punto de venta (CSV o Excel) y ligarlas a mesas y cuentas." },
  { clave: "escaner_respaldo", nombre: "Escáner de respaldo", descripcion: "Capturar el código a mano y guardar escaneos sin señal para mandarlos después." },
  { clave: "antifraude", nombre: "Revisión de RPs", descripcion: "Alertas de posibles abusos de RPs para que el gerente las revise." },
  { clave: "lista_negra", nombre: "Lista negra y no-show", descripcion: "Bloquear clientes y llevar su historial de no-show en este antro." },
  { clave: "whatsapp", nombre: "Mensajes de WhatsApp", descripcion: "Plantillas y enlaces wa.me para confirmar, recordar y avisar de no-show." },
  { clave: "reportes_pdf", nombre: "Reportes PDF", descripcion: "Reporte de la noche y de la semana en PDF para el dueño." },
  { clave: "inventario", nombre: "Inventario", descripcion: "Existencias del catálogo, entradas y mermas (fase 2)." },
  { clave: "propinas", nombre: "Propinas", descripcion: "Registrar y repartir propinas (fase 2)." },
] as const;

export type ClaveFuncion = (typeof FUNCIONES)[number]["clave"];

export const esClaveFuncion = (v: unknown): v is ClaveFuncion =>
  typeof v === "string" && FUNCIONES.some((f) => f.clave === v);

/** Funciones encendidas para un antro. Si la base no tiene las banderas
 *  (SQL sin aplicar) o hay error, todo queda apagado. */
export async function leerFunciones(clubId: string): Promise<Set<ClaveFuncion>> {
  return (await leerFuncionesDetalle(clubId)).activas;
}

/** Igual que leerFunciones, pero distingue "apagada" de "no se pudo
 *  preguntar" (sin señal, error de la base): con `error` las activas vienen
 *  vacías y NO quieren decir que la función esté apagada. */
export async function leerFuncionesDetalle(clubId: string): Promise<{ activas: Set<ClaveFuncion>; error: boolean }> {
  try {
    const { data, error } = await createClient().rpc("mis_funciones", { p_club_id: clubId });
    if (error || !Array.isArray(data)) return { activas: new Set(), error: true };
    return { activas: new Set(data.filter(esClaveFuncion)), error: false };
  } catch {
    return { activas: new Set(), error: true };
  }
}

/** Hook: `cargando` mientras pregunta; luego `activa(clave)`. Sin antro, todo apagado.
 *  `error`: no se pudo preguntar (se reintenta solo, con espera creciente y al
 *  volver la red); mientras tanto `activa()` responde con lo último que se
 *  supo (al principio, nada). Quien borre datos porque una bandera está
 *  apagada debe revisar antes que `error` sea falso. */
// Última respuesta de la base por antro, guardada en el navegador: si al abrir
// no hay señal, la pantalla usa eso en vez de esconder todo (p. ej. el
// catálogo de la caja). No es dato sensible (solo qué funciones están
// encendidas). Nunca cuenta como "la base contestó" (respondio sigue falso).
const CLAVE_CACHE = (clubId: string) => `antroapp:funciones:${clubId}`;
function leerCache(clubId: string): Set<ClaveFuncion> | null {
  try {
    const crudo = window.localStorage.getItem(CLAVE_CACHE(clubId));
    if (!crudo) return null;
    const lista: unknown = JSON.parse(crudo);
    return Array.isArray(lista) ? new Set(lista.filter(esClaveFuncion)) : null;
  } catch {
    return null;
  }
}
function guardarCache(clubId: string, activas: Set<ClaveFuncion>) {
  try {
    window.localStorage.setItem(CLAVE_CACHE(clubId), JSON.stringify([...activas]));
  } catch {
    // Sin almacenamiento (modo privado, cuota): solo se pierde el respaldo.
  }
}

export function useFunciones(clubId: string | null | undefined) {
  const [activas, setActivas] = useState<Set<ClaveFuncion>>(new Set());
  const [cargando, setCargando] = useState(Boolean(clubId));
  const [error, setError] = useState(false);
  // Antro del que la base SÍ contestó (para no tomar "sin antro todavía" o
  // "todavía no pregunta" por "apagada").
  const [respuestaDe, setRespuestaDe] = useState<string | null>(null);
  // Antro cuyas activas vienen del respaldo del navegador (sin confirmar).
  const [cacheDe, setCacheDe] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    let espera: ReturnType<typeof setTimeout> | undefined;
    let fallos = 0;
    if (!clubId) {
      setActivas(new Set());
      setCargando(false);
      setError(false);
      setRespuestaDe(null);
      setCacheDe(null);
      return;
    }
    const enCache = leerCache(clubId);
    if (enCache) {
      setActivas(enCache);
      setCacheDe(clubId);
    }
    setCargando(true);
    const preguntar = () => {
      clearTimeout(espera);
      void leerFuncionesDetalle(clubId).then((r) => {
        if (!vivo) return;
        if (r.error) {
          fallos++;
          setError(true);
          espera = setTimeout(preguntar, Math.min(60_000, 2_000 * 2 ** (fallos - 1)));
        } else {
          fallos = 0;
          setActivas(r.activas);
          setError(false);
          setRespuestaDe(clubId);
          guardarCache(clubId, r.activas);
        }
        setCargando(false);
      });
    };
    const alVolverLaRed = () => {
      if (fallos > 0) preguntar();
    };
    preguntar();
    window.addEventListener("online", alVolverLaRed);
    return () => {
      vivo = false;
      clearTimeout(espera);
      window.removeEventListener("online", alVolverLaRed);
    };
  }, [clubId]);

  // respondio: la base contestó para ESTE antro y la última pregunta no
  // falló; solo entonces `activa(x) === false` quiere decir "apagada de
  // verdad". activa(): lo último que contestó la base para este antro o, si
  // todavía no contesta (sin señal), lo último guardado en este navegador.
  const deEsteAntro = Boolean(clubId) && respuestaDe === clubId;
  const respondio = deEsteAntro && !error;
  const conDatos = deEsteAntro || (Boolean(clubId) && cacheDe === clubId);
  return { cargando, error, respondio, activa: (clave: ClaveFuncion) => conDatos && activas.has(clave) };
}
