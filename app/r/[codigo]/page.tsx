"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
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
  const [clubNombre, setClubNombre] = useState<string | null>(null);
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
          const loadedReserva = data as Reservation;
          setReserva(loadedReserva);

          // Nombre real del antro; si no carga, el texto cae a "el antro".
          if (loadedReserva.club_id) {
            const { data: club, error: clubError } = await supabase
              .from("clubs")
              .select("nombre")
              .eq("id", loadedReserva.club_id)
              .maybeSingle();

            if (cancelled) {
              return;
            }
            if (clubError) {
              console.error("Error cargando antro de la reserva:", clubError);
            } else if (club) {
              setClubNombre(club.nombre);
            }
          }
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
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
      <BackLink href="/" label="Volver al inicio" />
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
              <CardTitle>Tu reserva en {clubNombre ?? "el antro"}</CardTitle>
              <CardDescription>
                Muestra este código al llegar al antro.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-6 px-6 pb-6">
              <div className="rounded-md bg-white p-4 shadow-[0_0_0_6px_rgb(242_239_233/0.08)]">
                <QRCodeSVG value={reserva.qr_code} size={220} />
              </div>
              <div className="w-full space-y-1.5 border-t border-dashed border-border pt-5 text-sm">
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

              <div className="w-full border-t border-border pt-6 text-center">
                <p className="text-sm text-muted-foreground">
                  ¿No conoces un RP? Explora los antros disponibles en
                  AntroApp
                </p>
                <Button
                  render={<Link href="/cliente" />}
                  nativeButton={false}
                  variant="outline"
                  className="mt-3 w-full"
                >
                  Ver antros disponibles
                </Button>
              </div>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
