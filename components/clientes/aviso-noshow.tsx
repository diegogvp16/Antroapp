"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { textoNoShows } from "@/lib/domain/lista-negra";
import { cn } from "@/lib/utils";

// Aviso de no-shows previos de UNA reserva (lista_negra_aviso): para el RP
// en sus reservas y al crear una. Sin motivo y solo de este antro. Con la
// bandera apagada o sin permiso la base responde {activa: false} y aquí no
// se muestra nada.
type Aviso = { activa: boolean; no_shows?: number; ventana_dias?: number; aviso?: boolean; bloqueado?: boolean | null };

export function AvisoNoShow({ reservaId, qr, className }: { reservaId?: string | null; qr?: string | null; className?: string }) {
  const [a, setA] = useState<Aviso | null>(null);

  useEffect(() => {
    let vivo = true;
    if (!reservaId && !qr) return;
    createClient()
      .rpc("lista_negra_aviso", { p_reserva_id: reservaId ?? null, p_qr: reservaId ? null : (qr ?? null) })
      .then(({ data, error }) => {
        if (vivo && !error && data) setA(data as Aviso);
      });
    return () => {
      vivo = false;
    };
  }, [reservaId, qr]);

  if (!a?.activa || !(a.aviso || a.bloqueado)) return null;
  return (
    <div role="status" className={cn("rounded-lg border border-status-warn/40 px-3 py-2 text-sm text-status-warn", className)}>
      {a.bloqueado ? (
        <p>Este cliente está bloqueado en este antro: habla con el gerente antes de recibirlo.</p>
      ) : (
        <p>
          Ojo: este teléfono lleva {textoNoShows(a.no_shows ?? 0, a.ventana_dias ?? 90)} en este antro. Confírmale antes de la noche.
        </p>
      )}
    </div>
  );
}
