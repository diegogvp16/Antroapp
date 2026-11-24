"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarAceptacion } from "@/lib/legal/aceptaciones";
import { Button } from "@/components/ui/button";
import { CasillaAceptacion } from "@/components/legal/casilla-aceptacion";

// Primera entrada de una cuenta de trabajo (RP) con la bandera de legales
// encendida: antes de usar el panel acepta los Términos y el Aviso de
// privacidad. Sin aceptar puede cerrar sesión, pero no seguir.
export function AceptarLegales({ profileId, onListo, onSalir }: { profileId: string; onListo: () => void; onSalir: () => void }) {
  const [marcada, setMarcada] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function aceptar() {
    if (!marcada) return setError("Marca la casilla para continuar.");
    setGuardando(true);
    const r = await registrarAceptacion(createClient(), profileId);
    setGuardando(false);
    if (!r.ok) return setError("No pudimos guardar tu aceptación. Revisa tu conexión e intenta de nuevo.");
    onListo();
  }

  return (
    <div className="theme-caja flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <h1 className="text-lg font-semibold">Antes de empezar</h1>
        <p className="text-sm text-muted-foreground">
          Para usar tu panel de RP necesitamos que aceptes los Términos de uso y el Aviso de privacidad de AntroApp. Ahí se explica qué datos
          tuyos y de tus clientes se guardan y para qué.
        </p>
        <CasillaAceptacion id="acepto-rp" marcada={marcada} onCambio={setMarcada} />
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
        <Button type="button" className="h-11" disabled={guardando} onClick={aceptar}>
          {guardando ? "Guardando…" : "Aceptar y continuar"}
        </Button>
        <Button type="button" variant="ghost" className="h-10" onClick={onSalir}>
          Cerrar sesión
        </Button>
      </div>
    </div>
  );
}
