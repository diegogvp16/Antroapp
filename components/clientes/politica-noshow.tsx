"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { formatearFechaLarga } from "@/lib/fechas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { POLITICA_FABRICA, TIPO_EVENTO, validarPolitica, type PoliticaNoShow as Politica } from "@/lib/domain/lista-negra";

// Política de no-show del antro y bitácora de la lista negra (gerente,
// dueño). El bloqueo automático viene apagado.

type Evento = { tipo: string; telefono_mascara: string | null; detalle: Record<string, unknown>; hecho_por: string | null; hecho_en: string };

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" });

function resumenEvento(e: Evento): string {
  const d = e.detalle ?? {};
  if (e.tipo === "politica") {
    const p = d.despues as Politica | undefined;
    if (!p) return "";
    return `Avisar desde ${p.avisar_desde} en ${p.ventana_dias} días · ${p.bloquear_desde ? `bloquear desde ${p.bloquear_desde}` : "sin bloqueo automático"}`;
  }
  const partes = [e.telefono_mascara, typeof d.motivo === "string" ? d.motivo : null].filter(Boolean);
  return partes.join(" · ");
}

export function PoliticaNoShow({ clubId }: { clubId: string }) {
  const [p, setP] = useState<Politica | null>(null);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [eventos, setEventos] = useState<Evento[] | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    const supabase = createClient();
    const [r, h] = await Promise.all([
      supabase.rpc("lista_negra_politica", { p_club: clubId }),
      supabase.rpc("lista_negra_historial", { p_club: clubId, p_limite: 50 }),
    ]);
    if (r.error) {
      setError(mensajeParaUsuario(r.error, "No pudimos cargar la política."));
      return;
    }
    const d = r.data as Politica;
    setP({ avisar_desde: d.avisar_desde, ventana_dias: d.ventana_dias, bloquear_desde: d.bloquear_desde });
    setAuto(d.bloquear_desde !== null);
    setEventos(h.error ? [] : ((h.data ?? []) as Evento[]));
  }, [clubId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar() {
    if (!p) return;
    const valor: Politica = { ...p, bloquear_desde: auto ? (p.bloquear_desde ?? Math.max(p.avisar_desde, 3)) : null };
    const errores = validarPolitica(valor);
    if (errores.length) return setError(errores.join(" "));
    setGuardando(true);
    setError(null);
    setAviso(null);
    const { error: e } = await createClient().rpc("lista_negra_politica_guardar", {
      p_club: clubId,
      p_avisar_desde: valor.avisar_desde,
      p_ventana_dias: valor.ventana_dias,
      p_bloquear_desde: valor.bloquear_desde,
    });
    setGuardando(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo guardar. Intenta de nuevo."));
    setAviso("Política guardada.");
    void cargar();
  }

  const num = (v: string) => (v === "" ? NaN : Number(v));

  return (
    <div className="flex flex-col gap-5">
      {!p && !error && <p className="text-sm text-muted-foreground">Cargando…</p>}
      {p && (
        <section className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <h2 className="font-medium">Política de no-show</h2>
          <p className="text-sm text-muted-foreground">
            No-show: reserva cuya noche ya terminó (después de las 8:00 o con la caja cerrada) sin que el cliente entrara ni consumiera.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Avisar desde</span>
              <Input className="h-10" type="number" inputMode="numeric" min={1} max={20} value={Number.isNaN(p.avisar_desde) ? "" : p.avisar_desde}
                onChange={(e) => setP({ ...p, avisar_desde: num(e.target.value) })} />
              <span className="text-xs text-muted-foreground">no-shows</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">En los últimos</span>
              <Input className="h-10" type="number" inputMode="numeric" min={7} max={365} value={Number.isNaN(p.ventana_dias) ? "" : p.ventana_dias}
                onChange={(e) => setP({ ...p, ventana_dias: num(e.target.value) })} />
              <span className="text-xs text-muted-foreground">días</span>
            </label>
          </div>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" className="size-5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Bloquear automáticamente
          </label>
          {auto && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Bloquear desde</span>
              <Input className="h-10" type="number" inputMode="numeric" min={1} max={50}
                value={p.bloquear_desde === null || Number.isNaN(p.bloquear_desde) ? "" : p.bloquear_desde}
                onChange={(e) => setP({ ...p, bloquear_desde: num(e.target.value) })} />
              <span className="text-xs text-muted-foreground">
                noches sin llegar en la misma ventana, contando solo reservas de clientes con cuenta o hechas por un RP (las reservas sin
                cuenta no cuentan para el bloqueo automático). El cliente ve el mismo mensaje neutro que con un bloqueo a mano; se quita
                desde «No-show».
              </span>
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            De fábrica: avisar desde {POLITICA_FABRICA.avisar_desde} en {POLITICA_FABRICA.ventana_dias} días, sin bloqueo automático.
          </p>
          {error && (
            <p role="alert" className="text-sm text-status-err">
              {error}
            </p>
          )}
          {aviso && (
            <p role="status" className="text-sm text-status-ok">
              {aviso}
            </p>
          )}
          <Button type="button" className="h-10 self-start" disabled={guardando} onClick={() => void guardar()}>
            {guardando ? "Guardando…" : "Guardar política"}
          </Button>
        </section>
      )}
      {!p && error && (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Historial</h2>
        <p className="text-xs text-muted-foreground">Bloqueos, desbloqueos, quién vio un teléfono completo y cambios de política. No se puede borrar.</p>
        {eventos === null ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : eventos.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">Sin movimientos todavía.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {eventos.map((e, i) => (
              <li key={`${e.hecho_en}-${i}`} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="font-medium">{TIPO_EVENTO[e.tipo] ?? e.tipo}</span>
                <span className="break-words text-muted-foreground">{resumenEvento(e)}</span>
                <span className="text-xs text-muted-foreground">
                  {e.hecho_por ?? "—"} · {formatearFechaLarga(e.hecho_en)} {hora.format(new Date(e.hecho_en))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
