"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackLink } from "@/components/back-link";
import {
  PersonasStepper,
  MIN_PERSONAS,
  MAX_PERSONAS,
} from "@/components/personas-stepper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Club } from "@/types";

function todayISO() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

interface ReservaResumen {
  cliente_nombre: string;
  fecha: string;
  personas: number;
  qr_code: string;
}

export default function ReservarPageWrapper() {
  return (
    <Suspense fallback={null}>
      <ReservarPage />
    </Suspense>
  );
}

function ReservarPage() {
  const searchParams = useSearchParams();
  const clubId = searchParams.get("club");

  const [club, setClub] = useState<Club | null>(null);
  const [loadingClub, setLoadingClub] = useState(true);
  const [clubNotFound, setClubNotFound] = useState(false);

  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [fecha, setFecha] = useState("");
  const [personas, setPersonas] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [reserva, setReserva] = useState<ReservaResumen | null>(null);

  const minDate = todayISO();
  const backHref = club ? `/cliente/${club.id}` : "/cliente";

  useEffect(() => {
    if (!clubId) {
      setLoadingClub(false);
      return;
    }

    async function fetchClub() {
      setLoadingClub(true);
      setClubNotFound(false);
      try {
        const supabase = createClient();
        const { data, error: queryError } = await supabase
          .from("clubs")
          .select("*")
          .eq("id", clubId)
          .maybeSingle();

        if (queryError || !data) {
          setClubNotFound(true);
          setClub(null);
        } else {
          setClub(data as Club);
        }
      } catch (err) {
        console.error("Error cargando club:", err);
        setClubNotFound(true);
      } finally {
        setLoadingClub(false);
      }
    }

    fetchClub();
  }, [clubId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDebugError(null);

    if (!club) {
      return;
    }
    if (!nombre.trim() || !telefono.trim() || !fecha) {
      setError("Por favor completa todos los campos.");
      return;
    }
    if (fecha < minDate) {
      setError("La fecha no puede ser en el pasado.");
      return;
    }
    if (personas < MIN_PERSONAS || personas > MAX_PERSONAS) {
      setError(
        `El número de personas debe ser entre ${MIN_PERSONAS} y ${MAX_PERSONAS}.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const qrCode = `antro-${crypto.randomUUID()}`;
      const supabase = createClient();
      const { error: insertError } = await supabase.from("reservations").insert({
        cliente_nombre: nombre.trim(),
        cliente_telefono: telefono.trim(),
        rp_id: null,
        club_id: club.id,
        source: "organica",
        fecha,
        personas,
        status: "pendiente",
        qr_code: qrCode,
      });

      if (insertError) {
        console.error("Supabase insert error (reservations):", insertError);
        // DEBUG TEMPORAL: quitar setDebugError una vez resuelto el bug del insert.
        setDebugError(
          `[${insertError.code ?? "?"}] ${insertError.message}${
            insertError.details ? ` — ${insertError.details}` : ""
          }${insertError.hint ? ` (hint: ${insertError.hint})` : ""}`,
        );
        throw insertError;
      }

      setReserva({
        cliente_nombre: nombre.trim(),
        fecha,
        personas,
        qr_code: qrCode,
      });
    } catch (err) {
      console.error(err);
      setError(
        "No pudimos crear tu reserva. Intenta de nuevo en unos segundos.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!clubId) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <BackLink href={backHref} />
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Selecciona un antro primero</CardTitle>
            <CardDescription>
              Necesitas elegir un antro antes de reservar.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <Link
              href="/cliente"
              className="text-sm font-medium text-foreground underline underline-offset-4"
            >
              Ver antros disponibles
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadingClub) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <BackLink href={backHref} />
        <p className="text-sm text-muted-foreground">Cargando...</p>
      </div>
    );
  }

  if (clubNotFound || !club) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <BackLink href={backHref} />
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Antro no encontrado</CardTitle>
            <CardDescription>
              Este antro no existe o ya no está disponible.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <Link
              href="/cliente"
              className="text-sm font-medium text-foreground underline underline-offset-4"
            >
              Ver antros disponibles
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (reserva) {
    const whatsappHref = `https://wa.me/?text=${encodeURIComponent(
      `Aquí está tu reservación en ${club.nombre} para ${reserva.cliente_nombre} el ${reserva.fecha} (${reserva.personas} personas). Ábrelo aquí para ver tu código: ${window.location.origin}/r/${reserva.qr_code}`,
    )}`;

    return (
      <div className="relative flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <BackLink href={backHref} />
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>¡Reserva confirmada!</CardTitle>
            <CardDescription>
              Muestra este código al llegar al antro.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6 px-6 pb-6">
            <div className="rounded-xl bg-white p-4">
              <QRCodeSVG value={reserva.qr_code} size={200} />
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
            <Button
              render={
                <a href={whatsappHref} target="_blank" rel="noopener noreferrer" />
              }
              nativeButton={false}
              size="lg"
              className="h-14 w-full text-base"
            >
              Compartir por WhatsApp
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <BackLink href={backHref} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reservar en {club.nombre}</CardTitle>
          <CardDescription>
            Llena tus datos para tu reserva. Depósito: ${club.deposito_monto}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nombre">Nombre</Label>
              <Input
                id="nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="telefono">Teléfono</Label>
              <Input
                id="telefono"
                type="tel"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fecha">Fecha</Label>
              <Input
                id="fecha"
                type="date"
                min={minDate}
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                required
              />
            </div>
            <PersonasStepper value={personas} onChange={setPersonas} />

            {error && (
              <div role="alert">
                <p className="text-sm text-destructive">{error}</p>
                {debugError && (
                  <p className="mt-1 text-xs text-destructive/80">
                    DEBUG: {debugError}
                  </p>
                )}
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-2 h-14 w-full text-base"
              disabled={submitting}
            >
              {submitting ? "Reservando..." : "Confirmar reserva"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
