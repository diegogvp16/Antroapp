"use client";

// Fase 2 por antro (bloque 8): inventario y propinas se muestran solo si la
// bandera global NEXT_PUBLIC_FASE2 está en "1" Y la bandera del antro
// («inventario» o «propinas», sql/post-junta-3/00-funciones-club.sql) está
// encendida. Sin las dos, la caja se ve y se comporta como antes.
//
// La caja pone el proveedor una vez (con su antro) y sus componentes leen
// useFase2(). Sin proveedor, todo apagado. La base revisa la bandera por su
// cuenta en las funciones nuevas (inventario_*, propinas_*, caja_*_propina).
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { FASE2_ACTIVA } from "@/lib/fase2";
import { useFunciones } from "@/lib/funciones";

export type Fase2 = { inventario: boolean; propinas: boolean; cargando: boolean };

const APAGADA: Fase2 = { inventario: false, propinas: false, cargando: false };
const Contexto = createContext<Fase2>(APAGADA);

/** Banderas de la fase 2 para un antro (para páginas fuera de la caja). */
export function useFase2DeClub(clubId: string | null | undefined): Fase2 {
  const { cargando, activa } = useFunciones(FASE2_ACTIVA ? clubId : null);
  const inventario = FASE2_ACTIVA && activa("inventario");
  const propinas = FASE2_ACTIVA && activa("propinas");
  return useMemo(() => ({ inventario, propinas, cargando: FASE2_ACTIVA && cargando }), [inventario, propinas, cargando]);
}

export function Fase2Provider({ clubId, children }: { clubId: string | null; children: ReactNode }) {
  const valor = useFase2DeClub(clubId);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export const useFase2 = () => useContext(Contexto);
