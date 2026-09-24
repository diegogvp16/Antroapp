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

// Lo que devuelve la función obtener_reserva_por_qr: solo los campos que el
// boleto necesita mostrar, con el nombre del antro ya resuelto. No es la fila
// completa de `reservations` — deliberadamente no trae teléfono del cliente,
// consumo, cliente_id ni rp_id.
interface ReservaPublica {
  cliente_nombre: string;
  fecha: string;
  personas: number;
  status: Reservation["status"];
  qr_code: string;
  club_nombre: string | null;
}

export default function ReservaPublicaPage() {
  const params = useParams<{ codigo: string }>();
  const codigo = decodeURIComponent(params.codigo ?? "");

  const [reserva, setReserva] = useState<ReservaPublica | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchReserva() {
      setLoading(true);
      setNotFound(false);
      try {
        const supabase = createClient();
        // Vía RPC y no lectura directa de `reservations`: la tabla está
        // cerrada para quien no tiene sesión, y esta función devuelve una
        // sola reserva, la del código exacto, sin permitir listar el resto.
        // El nombre del antro ya viene incluido.
        const { data, error } = await supabase
          .rpc("obtener_reserva_por_qr", { p_qr: codigo })
          .maybeSingle();

        if (cancelled) {
          return;
        }

        if (error || !data) {
          setNotFound(true);
          setReserva(null);
        } else {
          setReserva(data as ReservaPublica);
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
              <CardTitle>
                Tu reserva en {reserva.club_nombre ?? "el antro"}
              </CardTitle>
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
