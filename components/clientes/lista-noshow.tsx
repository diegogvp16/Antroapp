"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { etiquetaNoche } from "@/lib/fechas";
import { Button } from "@/components/ui/button";
import { textoNoShows } from "@/lib/domain/lista-negra";
import { FormMotivo } from "@/components/clientes/form-motivo";

// No-shows del antro por teléfono, en la ventana de la política
// (lista_negra_noshows). No-show = reserva cuya noche ya terminó sin que
// entrara ni consumiera (lo mismo que «No llegó» en el panel del RP).

type Fila = {
  ref_reserva: string;
  telefono_mascara: string;
  nombre: string | null;
  no_shows: number;
  cuentan: number;
  ultima_fecha: string;
  aviso: boolean;
  bloqueado_manual: boolean;
  bloqueado_auto: boolean;
};

export function ListaNoShow({ clubId }: { clubId: string }) {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [ventana, setVentana] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<{ ref: string; accion: "bloquear" | "desbloquear" } | null>(null);

  const cargar = useCallback(async () => {
    setFilas(null);
    setError(null);
    const supabase = createClient();
    const [l, p] = await Promise.all([
      supabase.rpc("lista_negra_noshows", { p_club: clubId }),
      supabase.rpc("lista_negra_politica", { p_club: clubId }),
    ]);
    if (l.error || p.error) {
      setError(mensajeParaUsuario(l.error ?? p.error, "No pudimos cargar los no-shows. Intenta de nuevo."));
      setFilas([]);
      return;
    }
    setVentana((p.data as { ventana_dias: number }).ventana_dias);
    setFilas((l.data ?? []) as Fila[]);
  }, [clubId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function bloquear(ref: string, motivo: string, dias: number | null) {
    const { error: e } = await createClient().rpc("lista_negra_bloquear", {
      p_club: clubId,
      p_telefono: null,
      p_reserva_id: ref,
      p_motivo: motivo,
      p_dias: dias,
    });
    if (e) return mensajeParaUsuario(e, "No se pudo bloquear. Intenta de nuevo.");
    setAbierta(null);
    void cargar();
    return null;
  }

  async function desbloquear(ref: string, motivo: string) {
    const { error: e } = await createClient().rpc("lista_negra_desbloquear", {
      p_club: clubId,
      p_bloqueo_id: null,
      p_reserva_id: ref,
      p_motivo: motivo,
    });
    if (e) return mensajeParaUsuario(e, "No se pudo desbloquear. Intenta de nuevo.");
    setAbierta(null);
    void cargar();
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Cuenta las noches (no las reservas) en que el cliente reservó en este antro y no entró ni consumió
        {ventana ? `, en los últimos ${ventana} días` : ""}. Solo de este antro. Para el bloqueo automático solo cuentan las
        reservas de clientes con cuenta o hechas por un RP: las reservas sin cuenta solo dan aviso (cualquiera puede reservar con
        el teléfono de otro).
      </p>
      {error && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
          <p className="text-status-err">{error}</p>
          <Button type="button" variant="outline" className="h-10 self-start" onClick={() => void cargar()}>
            Reintentar
          </Button>
        </div>
      )}
      {filas === null ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : filas.length === 0 && !error ? (
        <p className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">Nadie ha dejado de llegar en este periodo.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {filas.map((f) => {
            const bloqueado = f.bloqueado_manual || f.bloqueado_auto;
            return (
              <li key={f.ref_reserva} className="flex flex-col gap-2 px-3 py-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium tabular-nums">
                      {f.telefono_mascara}
                      {f.nombre ? <span className="font-normal text-muted-foreground"> · {f.nombre}</span> : null}
                    </p>
                    <p className={f.aviso ? "text-status-warn" : "text-muted-foreground"}>
                      {ventana ? textoNoShows(f.no_shows, ventana) : `${f.no_shows} sin llegar`} · última {etiquetaNoche(String(f.ultima_fecha).slice(0, 10))}
                    </p>
                  </div>
                  {bloqueado && (
                    <span className="shrink-0 text-xs text-status-err">{f.bloqueado_manual ? "Bloqueado" : "Bloqueo automático"}</span>
                  )}
                </div>
                {abierta?.ref === f.ref_reserva ? (
                  abierta.accion === "bloquear" ? (
                    <FormMotivo accion="Bloquear" conVencimiento onEnviar={(m, d) => bloquear(f.ref_reserva, m, d)} onCancelar={() => setAbierta(null)} />
                  ) : (
                    <FormMotivo
                      accion={f.bloqueado_manual ? "Desbloquear" : "Quitar bloqueo automático"}
                      ayuda="Sus no-shows anteriores dejan de contar para el bloqueo automático (siguen en el historial)."
                      onEnviar={(m) => desbloquear(f.ref_reserva, m)}
                      onCancelar={() => setAbierta(null)}
                    />
                  )
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {!f.bloqueado_manual && (
                      <Button type="button" variant="outline" className="h-10" onClick={() => setAbierta({ ref: f.ref_reserva, accion: "bloquear" })}>
                        Bloquear
                      </Button>
                    )}
                    {bloqueado && (
                      <Button type="button" variant="outline" className="h-10" onClick={() => setAbierta({ ref: f.ref_reserva, accion: "desbloquear" })}>
                        {f.bloqueado_manual ? "Desbloquear" : "Quitar bloqueo automático"}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
