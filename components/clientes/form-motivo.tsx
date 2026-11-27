"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { VENCIMIENTOS, validarMotivo } from "@/lib/domain/lista-negra";

export const CLASE_TEXTO =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

// Motivo obligatorio (y vencimiento, al bloquear). onEnviar devuelve el
// error a mostrar, o null si salió bien.
export function FormMotivo({
  accion,
  ayuda,
  conVencimiento = false,
  onEnviar,
  onCancelar,
}: {
  accion: string;
  ayuda?: string;
  conVencimiento?: boolean;
  onEnviar: (motivo: string, dias: number | null) => Promise<string | null>;
  onCancelar?: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [dias, setDias] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    const e = validarMotivo(motivo);
    if (e) return setError(e);
    setEnviando(true);
    const r = await onEnviar(motivo.trim(), conVencimiento ? dias : null);
    setEnviando(false);
    setError(r);
    if (!r) setMotivo("");
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Motivo</span>
        <textarea
          className={CLASE_TEXTO}
          rows={2}
          maxLength={300}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Qué pasó, solo lo necesario (lo ven gerentes y dueño)"
        />
      </label>
      {ayuda && <p className="text-xs text-muted-foreground">{ayuda}</p>}
      {conVencimiento && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Vence</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Vencimiento">
            {VENCIMIENTOS.map((v) => (
              <button
                key={String(v.dias)}
                type="button"
                aria-pressed={dias === v.dias}
                onClick={() => setDias(v.dias)}
                className={cn("h-10 rounded-lg border border-border px-3 text-sm", dias === v.dias && "bg-muted font-medium ring-1 ring-ring/40")}
              >
                {v.etiqueta}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="h-10" disabled={enviando} onClick={() => void enviar()}>
          {enviando ? "Guardando…" : accion}
        </Button>
        {onCancelar && (
          <Button type="button" variant="outline" className="h-10" onClick={onCancelar}>
            Cancelar
          </Button>
        )}
      </div>
    </div>
  );
}
