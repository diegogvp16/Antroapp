"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { formatearFechaLarga } from "@/lib/fechas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ESTADO_BLOQUEO } from "@/lib/domain/lista-negra";
import { claveTelefono } from "@/lib/domain/whatsapp";
import { FormMotivo } from "@/components/clientes/form-motivo";
import { cn } from "@/lib/utils";

// Lista negra del antro (gerente, dueño). Teléfonos enmascarados; el
// completo solo a pedido y queda registrado. Nada se borra: desbloquear
// cierra el bloqueo con motivo y queda en el historial.

type Bloqueo = {
  id: string;
  telefono_mascara: string;
  nombre: string | null;
  motivo: string;
  con_cuenta: boolean;
  bloqueado_por: string | null;
  bloqueado_en: string;
  vence_en: string | null;
  estado: "activo" | "vencido" | "desbloqueado";
  desbloqueado_por: string | null;
  desbloqueado_en: string | null;
  motivo_desbloqueo: string | null;
};

export function ListaBloqueados({ clubId }: { clubId: string }) {
  const [historial, setHistorial] = useState(false);
  const [filas, setFilas] = useState<Bloqueo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [telefono, setTelefono] = useState("");
  const [nombre, setNombre] = useState("");
  const [desbloqueando, setDesbloqueando] = useState<string | null>(null);
  const [completos, setCompletos] = useState<Record<string, string>>({});

  const cargar = useCallback(async () => {
    setFilas(null);
    setError(null);
    const { data, error: e } = await createClient().rpc("lista_negra_bloqueos", { p_club: clubId, p_historial: historial });
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar la lista. Intenta de nuevo."));
      setFilas([]);
      return;
    }
    setFilas((data ?? []) as Bloqueo[]);
  }, [clubId, historial]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function bloquear(motivo: string, dias: number | null): Promise<string | null> {
    if (!claveTelefono(telefono)) return "Escribe un teléfono de 10 dígitos (o completo, con lada, si no es de México).";
    const { error: e } = await createClient().rpc("lista_negra_bloquear", {
      p_club: clubId,
      p_telefono: telefono,
      p_reserva_id: null,
      p_motivo: motivo,
      p_dias: dias,
      p_nombre: nombre.trim() || null,
    });
    if (e) return mensajeParaUsuario(e, "No se pudo bloquear. Intenta de nuevo.");
    setTelefono("");
    setNombre("");
    setNuevo(false);
    void cargar();
    return null;
  }

  async function desbloquear(id: string, motivo: string): Promise<string | null> {
    const { error: e } = await createClient().rpc("lista_negra_desbloquear", {
      p_club: clubId,
      p_bloqueo_id: id,
      p_reserva_id: null,
      p_motivo: motivo,
    });
    if (e) return mensajeParaUsuario(e, "No se pudo desbloquear. Intenta de nuevo.");
    setDesbloqueando(null);
    void cargar();
    return null;
  }

  async function verTelefono(id: string) {
    const { data, error: e } = await createClient().rpc("lista_negra_ver_telefono", { p_club: clubId, p_bloqueo_id: id });
    if (e) return setError(mensajeParaUsuario(e, "No se pudo mostrar el teléfono."));
    setCompletos((c) => ({ ...c, [id]: String(data) }));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Un cliente bloqueado no puede apartar lugar en este antro (ni solo, ni con RP). Él solo ve «No pudimos apartar tu lugar en este
        antro»: nunca el motivo. Esta lista es solo de este antro; ningún otro antro la ve.
      </p>

      {nuevo ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <h2 className="font-medium">Bloquear un teléfono</h2>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Teléfono</span>
            <Input className="h-10" type="tel" inputMode="tel" autoComplete="off" value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="10 dígitos" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Nombre (opcional)</span>
            <Input className="h-10" maxLength={80} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Para reconocerlo en la lista" />
          </label>
          <FormMotivo accion="Bloquear" conVencimiento onEnviar={bloquear} onCancelar={() => setNuevo(false)} />
        </div>
      ) : (
        <Button type="button" className="h-10 self-start" onClick={() => setNuevo(true)}>
          Bloquear un teléfono
        </Button>
      )}

      <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1" role="tablist" aria-label="Qué ver">
        {[
          { v: false, t: "Activos" },
          { v: true, t: "Historial completo" },
        ].map((x) => (
          <button
            key={x.t}
            type="button"
            role="tab"
            aria-selected={historial === x.v}
            onClick={() => setHistorial(x.v)}
            className={cn("h-10 rounded-md text-sm text-muted-foreground", historial === x.v && "bg-muted font-medium text-foreground ring-1 ring-border")}
          >
            {x.t}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      )}
      {filas === null ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : filas.length === 0 && !error ? (
        <p className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">
          {historial ? "Este antro todavía no ha bloqueado a nadie." : "No hay clientes bloqueados."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {filas.map((b) => (
            <li key={b.id} className="flex flex-col gap-2 px-3 py-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium tabular-nums">
                    {completos[b.id] ?? b.telefono_mascara}
                    {b.nombre ? <span className="font-normal text-muted-foreground"> · {b.nombre}</span> : null}
                  </p>
                  <p className="break-words">{b.motivo}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-xs",
                    b.estado === "activo" ? "text-status-err" : "text-muted-foreground",
                  )}
                >
                  {ESTADO_BLOQUEO[b.estado] ?? b.estado}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {b.bloqueado_por ?? "—"} · {formatearFechaLarga(b.bloqueado_en)}
                {b.vence_en ? ` · vence ${formatearFechaLarga(b.vence_en)}` : " · sin vencimiento"}
                {b.con_cuenta ? " · también por su cuenta" : ""}
              </p>
              {b.desbloqueado_en && (
                <p className="text-xs text-muted-foreground">
                  {b.estado === "vencido" ? "Venció" : `Desbloqueó ${b.desbloqueado_por ?? "—"}`} · {formatearFechaLarga(b.desbloqueado_en)}
                  {b.estado !== "vencido" && b.motivo_desbloqueo ? ` · ${b.motivo_desbloqueo}` : ""}
                </p>
              )}
              {b.estado === "activo" &&
                (desbloqueando === b.id ? (
                  <FormMotivo accion="Desbloquear" onEnviar={(m) => desbloquear(b.id, m)} onCancelar={() => setDesbloqueando(null)} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {!completos[b.id] && (
                      <Button type="button" variant="outline" className="h-10" onClick={() => void verTelefono(b.id)}>
                        Ver teléfono
                      </Button>
                    )}
                    <Button type="button" variant="outline" className="h-10" onClick={() => setDesbloqueando(b.id)}>
                      Desbloquear
                    </Button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Ver el teléfono completo queda registrado en el historial del antro.</p>
    </div>
  );
}
