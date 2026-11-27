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
  const { data, error } = await createClient().rpc("mis_funciones", { p_club_id: clubId });
  if (error || !Array.isArray(data)) return new Set();
  return new Set(data.filter(esClaveFuncion));
}

/** Hook: `cargando` mientras pregunta; luego `activa(clave)`. Sin antro, todo apagado. */
export function useFunciones(clubId: string | null | undefined) {
  const [activas, setActivas] = useState<Set<ClaveFuncion>>(new Set());
  const [cargando, setCargando] = useState(Boolean(clubId));

  useEffect(() => {
    let vivo = true;
    if (!clubId) {
      setActivas(new Set());
      setCargando(false);
      return;
    }
    setCargando(true);
    leerFunciones(clubId).then((s) => {
      if (vivo) {
        setActivas(s);
        setCargando(false);
      }
    });
    return () => {
      vivo = false;
    };
  }, [clubId]);

  return { cargando, activa: (clave: ClaveFuncion) => activas.has(clave) };
}
