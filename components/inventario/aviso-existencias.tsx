"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { bajoStock } from "@/lib/domain/inventario";
import { useFase2DeClub } from "@/lib/fase2-contexto";

// Alerta de existencias bajas para el gerente (fase 2). Solo con
// NEXT_PUBLIC_FASE2 y la bandera «inventario» del antro. Solo avisa: la caja
// nunca deja de vender por existencias (si el conteo dice 0, queda negativo).
export function AvisoExistencias({ clubId }: { clubId: string }) {
  const { inventario } = useFase2DeClub(clubId);
  const [bajos, setBajos] = useState<{ nombre: string; existencias: number }[]>([]);

  useEffect(() => {
    if (!inventario) return;
    createClient()
      .from("productos")
      .select("nombre, existencias, existencias_minimas")
      .eq("club_id", clubId)
      .eq("activo", true)
      .then(({ data }) => setBajos((data ?? []).filter(bajoStock).sort((a, b) => a.existencias - b.existencias)));
  }, [clubId, inventario]);

  if (!inventario || bajos.length === 0) return null;
  return (
    <Link
      href="/staff/catalogo"
      role="status"
      className="flex flex-col gap-0.5 rounded-lg border border-status-warn/50 bg-status-warn/10 px-4 py-3 text-sm hover:bg-status-warn/15"
    >
      <span className="font-medium text-status-warn">
        {bajos.length} {bajos.length === 1 ? "producto con existencias bajas" : "productos con existencias bajas"}
      </span>
      <span className="truncate text-muted-foreground">
        {bajos
          .slice(0, 3)
          .map((b) => `${b.nombre} (${b.existencias})`)
          .join(" · ")}
        {bajos.length > 3 ? " · …" : ""} — revisa el conteo o haz el pedido.
      </span>
    </Link>
  );
}
