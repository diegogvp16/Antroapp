"use client";

import Link from "next/link";
import { useFunciones } from "@/lib/funciones";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Botón a «Ventas del POS». Solo aparece si la bandera pos_ventas está
// encendida para ese antro (y la base lo vuelve a exigir en cada función).
export function EnlacePos({ clubId, href, className }: { clubId: string | null | undefined; href: string; className?: string }) {
  const { cargando, activa } = useFunciones(clubId);
  if (cargando || !activa("pos_ventas")) return null;
  return (
    <Button render={<Link href={href} />} nativeButton={false} variant="outline" className={cn("h-10 w-full", className)}>
      Ventas del POS
    </Button>
  );
}
