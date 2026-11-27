"use client";

// Botón "Revisión de RPs" para la navegación del gerente, el dueño y el
// admin. Solo aparece si la bandera 'antifraude' está encendida: con
// `clubId`, la del antro (useFunciones); sin él, si hay algún antro que
// quien llama puede revisar (fraude_mis_antros: dueño de grupo y admin).
import { useEffect, useState } from "react";
import Link from "next/link";
import { useFunciones } from "@/lib/funciones";
import { misAntrosRevision } from "@/lib/fraude";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function EnlaceRevisionRps({ href, clubId, className }: { href: string; clubId?: string | null; className?: string }) {
  const porAntro = useFunciones(clubId ?? null);
  const [hayAntros, setHayAntros] = useState(false);

  useEffect(() => {
    if (clubId) return;
    let vivo = true;
    misAntrosRevision().then((r) => {
      if (vivo) setHayAntros(r.ok && (r.datos ?? []).some((a) => a.activa));
    });
    return () => {
      vivo = false;
    };
  }, [clubId]);

  const visible = clubId ? porAntro.activa("antifraude") : hayAntros;
  if (!visible) return null;
  return (
    <Button render={<Link href={href} />} nativeButton={false} variant="outline" className={cn("h-10 w-full", className)}>
      Revisión de RPs
    </Button>
  );
}
