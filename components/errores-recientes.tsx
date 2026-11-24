"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatearFechaLarga } from "@/lib/fechas";

interface ErrorApp {
  id: number;
  creado_en: string;
  ruta: string | null;
  mensaje: string;
}

const horaMx = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  hour: "2-digit",
  minute: "2-digit",
});

// Últimos errores que reportó la app (app_errores; solo el admin los lee).
export function ErroresRecientes() {
  const [errores, setErrores] = useState<ErrorApp[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);

  async function cargar() {
    setCargando(true);
    setFallo(null);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("app_errores")
      .select("id, creado_en, ruta, mensaje")
      .order("creado_en", { ascending: false })
      .limit(20);
    if (error) setFallo(error.message);
    else setErrores((data ?? []) as ErrorApp[]);
    setCargando(false);
  }

  useEffect(() => {
    void cargar();
  }, []);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Errores recientes</h2>
        <Button type="button" variant="outline" size="sm" onClick={() => void cargar()} disabled={cargando}>
          {cargando ? "Cargando..." : "Actualizar"}
        </Button>
      </div>
      {fallo && <p className="text-sm text-destructive">{fallo}</p>}
      {!cargando && !fallo && errores.length === 0 && (
        <p className="text-sm text-status-ok">Sin errores reportados.</p>
      )}
      {errores.length > 0 && (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border px-5 py-2 text-sm">
            {errores.map((e) => (
              <div key={e.id} className="flex flex-col gap-0.5 py-2">
                <p className="break-words font-medium">{e.mensaje}</p>
                <p className="text-xs text-muted-foreground">
                  {formatearFechaLarga(e.creado_en)}, {horaMx.format(new Date(e.creado_en))}
                  {e.ruta ? ` · ${e.ruta}` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
