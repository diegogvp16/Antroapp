"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { etiquetaNoche, nocheOperativaMexico, sumarDiasISO } from "@/lib/fechas";
import { formatearCentavos } from "@/lib/domain/caja";
import {
  FILTROS_ACTIVIDAD,
  esDeCuidado,
  pasaFiltro,
  tituloActividad,
  type FilaActividad,
  type FiltroActividad,
} from "@/lib/domain/actividad";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const RANGOS = [
  { dias: 1, etiqueta: "Esta noche" },
  { dias: 7, etiqueta: "7 noches" },
  { dias: 30, etiqueta: "30 noches" },
] as const;

const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" });
const ROL: Record<string, string> = { staff: "Staff", gerente: "Gerente", dueno: "Dueño", admin: "Admin" };

// Quién cuadró, anuló, reabrió o cerró, y las bajas de personal. Solo
// gerente, dueño y admin (lo exige actividad_club en la base).
export function RegistroActividad({ clubId }: { clubId: string }) {
  const [dias, setDias] = useState<number>(7);
  const [filtro, setFiltro] = useState<FiltroActividad>("todo");
  const [filas, setFilas] = useState<FilaActividad[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setFilas(null);
    const hasta = nocheOperativaMexico();
    const { data, error: e } = await createClient().rpc("actividad_club", {
      p_club_id: clubId,
      p_desde: sumarDiasISO(hasta, 1 - dias),
      p_hasta: hasta,
    });
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar la actividad."));
      return;
    }
    setError(null);
    setFilas((data ?? []) as FilaActividad[]);
  }, [clubId, dias]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Agrupadas por noche operativa (corte 08:00).
  const porNoche = useMemo(() => {
    const grupos = new Map<string, FilaActividad[]>();
    for (const f of (filas ?? []).filter((x) => pasaFiltro(x.tipo, filtro))) {
      const noche = nocheOperativaMexico(new Date(f.hecho_en));
      grupos.set(noche, [...(grupos.get(noche) ?? []), f]);
    }
    return [...grupos.entries()];
  }, [filas, filtro]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Rango">
        {RANGOS.map((r) => (
          <Button key={r.dias} type="button" className="h-10" variant={dias === r.dias ? "default" : "outline"} aria-pressed={dias === r.dias} onClick={() => setDias(r.dias)}>
            {r.etiqueta}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtro">
        {FILTROS_ACTIVIDAD.map((f) => (
          <Button key={f.valor} type="button" size="sm" className="h-9" variant={filtro === f.valor ? "secondary" : "ghost"} aria-pressed={filtro === f.valor} onClick={() => setFiltro(f.valor)}>
            {f.etiqueta}
          </Button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      )}
      {!error && filas === null && <p className="text-sm text-muted-foreground">Cargando…</p>}
      {!error && filas !== null && porNoche.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Sin movimientos en este rango.</p>
      )}

      {porNoche.map(([noche, lista]) => (
        <section key={noche} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Noche del {etiquetaNoche(noche)}</h3>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
            {lista.map((f, i) => (
              <li key={`${f.hecho_en}-${i}`} className="flex flex-col gap-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-medium">
                    {esDeCuidado(f.tipo) && (
                      <Badge variant="warn" className="mr-2 align-middle">
                        Revisar
                      </Badge>
                    )}
                    {tituloActividad(f)}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{hora.format(new Date(f.hecho_en))}</span>
                </div>
                <span className="text-muted-foreground">
                  {f.quien}
                  {f.quien_rol ? ` (${ROL[f.quien_rol] ?? f.quien_rol})` : ""}
                  {f.monto_centavos != null ? ` · ${formatearCentavos(Number(f.monto_centavos))}` : ""}
                </span>
                {f.motivo && <span className="break-words">Motivo: «{f.motivo}»</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
