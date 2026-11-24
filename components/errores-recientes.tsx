"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatearFechaLarga } from "@/lib/fechas";

interface ErrorApp {
  id: number;
  creado_en: string;
  ruta: string | null;
  mensaje: string;
}

type Grupo = { clave: string; mensaje: string; ruta: string | null; veces: number; ultimo: string };

const horaMx = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  hour: "2-digit",
  minute: "2-digit",
});
const DIA_MS = 86_400_000;

// Errores que reportó la app en los últimos 7 días (app_errores; solo el
// admin los lee), agrupados por mensaje y ruta: un mismo error repetido sale
// una vez con cuántas veces pasó. Arriba, cuántos hubo en 24 horas.
export function ErroresRecientes() {
  const [errores, setErrores] = useState<ErrorApp[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);

  async function cargar() {
    setCargando(true);
    setFallo(null);
    const { data, error } = await createClient()
      .from("app_errores")
      .select("id, creado_en, ruta, mensaje")
      .gte("creado_en", new Date(Date.now() - 7 * DIA_MS).toISOString())
      .order("creado_en", { ascending: false })
      .limit(500);
    if (error) setFallo(mensajeParaUsuario(error, "No pudimos cargar los errores."));
    else setErrores((data ?? []) as ErrorApp[]);
    setCargando(false);
  }

  useEffect(() => {
    void cargar();
  }, []);

  const { grupos, en24h } = useMemo(() => {
    const mapa = new Map<string, Grupo>();
    let n24 = 0;
    const corte = Date.now() - DIA_MS;
    for (const e of errores) {
      if (Date.parse(e.creado_en) >= corte) n24++;
      const clave = `${e.mensaje}|${e.ruta ?? ""}`;
      const g = mapa.get(clave);
      if (g) g.veces++;
      else mapa.set(clave, { clave, mensaje: e.mensaje, ruta: e.ruta, veces: 1, ultimo: e.creado_en });
    }
    return { grupos: [...mapa.values()].slice(0, 20), en24h: n24 };
  }, [errores]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Errores recientes</h2>
        <Button type="button" variant="outline" size="sm" onClick={() => void cargar()} disabled={cargando}>
          {cargando ? "Cargando..." : "Actualizar"}
        </Button>
      </div>
      {fallo && <p className="text-sm text-destructive">{fallo}</p>}
      {!cargando && !fallo && (
        <p className="text-sm">
          <Badge variant={en24h === 0 ? "ok" : en24h >= 10 ? "err" : "warn"}>
            {en24h} en 24 h
          </Badge>{" "}
          <span className="text-muted-foreground">
            · {errores.length} en 7 días{grupos.length ? `, ${grupos.length} distintos` : ""}
          </span>
        </p>
      )}
      {grupos.length > 0 && (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border px-5 py-2 text-sm">
            {grupos.map((g) => (
              <div key={g.clave} className="flex flex-col gap-0.5 py-2">
                <p className="break-words font-medium">
                  {g.veces > 1 && <span className="mr-1.5 tabular-nums text-status-warn">{g.veces}×</span>}
                  {g.mensaje}
                </p>
                <p className="text-xs text-muted-foreground">
                  Último: {formatearFechaLarga(g.ultimo)}, {horaMx.format(new Date(g.ultimo))}
                  {g.ruta ? ` · ${g.ruta}` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
