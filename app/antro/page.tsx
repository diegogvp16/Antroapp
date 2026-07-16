"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Reservation } from "@/types";

function todayISO() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<Reservation["status"], string> = {
  pendiente: "Pendiente",
  confirmada: "Confirmada",
  usada: "Usada",
};

const STATUS_CLASSES: Record<Reservation["status"], string> = {
  pendiente:
    "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  confirmada:
    "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300",
  usada:
    "border-transparent bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300",
};

const SOURCE_CLASSES: Record<Reservation["source"], string> = {
  organica:
    "border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  rp: "border-transparent bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-300",
};

export default function AntroPage() {
  const [reservas, setReservas] = useState<Reservation[]>([]);
  const [rpNombres, setRpNombres] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReservas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const hoy = todayISO();

      const { data, error: queryError } = await supabase
        .from("reservations")
        .select("*")
        .eq("fecha", hoy)
        .order("created_at", { ascending: false });

      if (queryError) {
        throw queryError;
      }

      const rows = (data ?? []) as Reservation[];
      setReservas(rows);

      const rpIds = Array.from(
        new Set(
          rows
            .filter((r) => r.source === "rp" && r.rp_id)
            .map((r) => r.rp_id as string),
        ),
      );

      if (rpIds.length > 0) {
        const { data: profilesData, error: profilesError } = await supabase
          .from("profiles")
          .select("id, nombre")
          .in("id", rpIds);

        if (profilesError) {
          throw profilesError;
        }

        const map: Record<string, string> = {};
        for (const p of profilesData ?? []) {
          map[p.id] = p.nombre;
        }
        setRpNombres(map);
      } else {
        setRpNombres({});
      }
    } catch (err) {
      console.error("Error cargando reservas:", err);
      setError("No pudimos cargar las reservas. Intenta actualizar de nuevo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReservas();
  }, [fetchReservas]);

  const totalReservas = reservas.length;
  const totalOrganicas = reservas.filter((r) => r.source === "organica").length;
  const totalRp = reservas.filter((r) => r.source === "rp").length;
  const totalPersonas = reservas.reduce((sum, r) => sum + r.personas, 0);

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">
              Panel del Antro
            </h1>
            <p className="text-sm text-muted-foreground">
              Reservas de esta noche · Antro Demo
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={fetchReservas}
            disabled={loading}
          >
            {loading ? "Actualizando..." : "Actualizar"}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              <span className="text-xs text-muted-foreground">Reservas</span>
              <span className="text-2xl font-bold">{totalReservas}</span>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              <span className="text-xs text-muted-foreground">Orgánicas</span>
              <span className="text-2xl font-bold">{totalOrganicas}</span>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              <span className="text-xs text-muted-foreground">Vía RP</span>
              <span className="text-2xl font-bold">{totalRp}</span>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              <span className="text-xs text-muted-foreground">Personas</span>
              <span className="text-2xl font-bold">{totalPersonas}</span>
            </CardContent>
          </Card>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && reservas.length === 0 && (
          <Card>
            <CardContent className="px-6 py-10 text-center text-muted-foreground">
              Sin reservas para esta noche todavía.
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-3">
          {reservas.map((r) => (
            <Card key={r.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>{r.cliente_nombre}</CardTitle>
                    <CardDescription>{r.cliente_telefono}</CardDescription>
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                    <Badge className={STATUS_CLASSES[r.status]}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                    <Badge className={SOURCE_CLASSES[r.source]}>
                      {r.source === "rp" ? "Vía RP" : "Orgánica"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 text-sm text-muted-foreground">
                <span>{r.personas} personas</span>
                {r.source === "rp" && (
                  <span>
                    RP: {r.rp_id && rpNombres[r.rp_id] ? rpNombres[r.rp_id] : "—"}
                  </span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
