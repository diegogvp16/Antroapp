"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Salud = { estado: "ok" | "sin_base"; base: { ok: boolean; ms: number }; version: string; entorno: string };

// Lo mismo que ve un monitor externo en GET /api/salud: si la app responde,
// si la base contesta y cuánto tardó. Sin datos.
export function EstadoServicio() {
  const [salud, setSalud] = useState<Salud | null>(null);
  const [fallo, setFallo] = useState(false);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(false);
    try {
      const r = await fetch("/api/salud", { cache: "no-store" });
      setSalud((await r.json()) as Salud);
    } catch {
      setFallo(true);
      setSalud(null);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const lenta = salud?.base.ok && salud.base.ms > 1000;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Servicio</h2>
        <Button type="button" variant="outline" className="h-10" onClick={() => void cargar()} disabled={cargando}>
          {cargando ? "Revisando…" : "Revisar"}
        </Button>
      </div>
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 text-sm">
          {cargando && !salud ? (
            <span className="text-muted-foreground">Revisando…</span>
          ) : fallo || !salud ? (
            <Badge variant="err">La app no respondió</Badge>
          ) : (
            <>
              <Badge variant={salud.base.ok ? (lenta ? "warn" : "ok") : "err"}>
                {salud.base.ok ? (lenta ? "Base lenta" : "Base en línea") : "Base sin respuesta"}
              </Badge>
              <span className="tabular-nums text-muted-foreground">{salud.base.ms} ms</span>
              <span className="text-muted-foreground">
                Versión {salud.version} · {salud.entorno}
              </span>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
