"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useFunciones } from "@/lib/funciones";

// Botón del panel hacia "Clientes y mensajes". Solo aparece si el antro
// tiene encendida 'lista_negra' o 'whatsapp' (apagadas: el panel queda igual).
export function EnlaceClientes({ clubId, href }: { clubId: string | null | undefined; href: string }) {
  const f = useFunciones(clubId);
  if (f.cargando || !(f.activa("lista_negra") || f.activa("whatsapp"))) return null;
  return (
    <Button render={<Link href={href} />} nativeButton={false} variant="outline" className="h-10 w-full">
      Clientes y mensajes
    </Button>
  );
}
