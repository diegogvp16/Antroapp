"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Reservation } from "@/types";

export default function ReservaPublicaPage() {
  const params = useParams<{ codigo: string }>();
  const codigo = decodeURIComponent(params.codigo ?? "");

  const [reserva, setReserva] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchReserva() {
      setLoading(true);
      setNotFound(false);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("reservations")
          .select("*")
          .eq("qr_code", codigo)
          .maybeSingle();

        if (cancelled) {
          return;
        }

        if (error || !data) {
          setNotFound(true);
          setReserva(null);
        } else {
          setReserva(data as Reservation);
        }
      } catch (err) {
        console.error("Error cargando reserva pública:", err);
        if (!cancelled) {
          setNotFound(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (codigo) {
      fetchReserva();
    } else {
      setLoading(false);
      setNotFound(true);
    }

    return () => {
      cancelled = true;
    };
  }, [codigo]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <Card className="w-full max-w-sm">
        {loading ? (
          <CardContent className="px-6 py-10 text-center text-muted-foreground">
            Cargando reserva...
          </CardContent>
        ) : notFound || !reserva ? (
          <CardHeader>
            <CardTitle>Reserva no encontrada</CardTitle>
            <CardDescription>
              Este código no corresponde a ninguna reserva activa.
            </CardDescription>
          </CardHeader>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Tu reserva en Antro Demo</CardTitle>
              <CardDescription>
                Muestra este código al llegar al antro.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-6 px-6 pb-6">
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={reserva.qr_code} size={220} />
              </div>
              <div className="w-full space-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">Nombre:</span>{" "}
                  {reserva.cliente_nombre}
                </p>
                <p>
                  <span className="text-muted-foreground">Fecha:</span>{" "}
                  {reserva.fecha}
                </p>
                <p>
                  <span className="text-muted-foreground">Personas:</span>{" "}
                  {reserva.personas}
                </p>
              </div>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
