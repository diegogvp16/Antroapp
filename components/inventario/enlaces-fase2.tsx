"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useFase2DeClub } from "@/lib/fase2-contexto";

// Enlaces del panel del gerente a la fase 2 (bloque 8). Cada uno solo con la
// bandera de su antro: «inventario» (catálogo y reporte de inventario) y
// «propinas» (propinas de la noche y su reparto).
export function EnlacesFase2({ clubId }: { clubId: string | null }) {
  const f = useFase2DeClub(clubId);
  if (f.cargando) return null;
  return (
    <>
      {f.inventario && (
        <>
          <Button render={<Link href="/staff/catalogo" />} nativeButton={false} variant="outline" className="w-full">
            Catálogo e inventario
          </Button>
          <Button render={<Link href="/staff/inventario" />} nativeButton={false} variant="outline" className="w-full">
            Reporte de inventario
          </Button>
        </>
      )}
      {f.propinas && (
        <Button render={<Link href="/staff/propinas" />} nativeButton={false} variant="outline" className="w-full">
          Propinas de la noche
        </Button>
      )}
    </>
  );
}
