"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface RpSession {
  id: string;
  nombre: string;
  clubId: string | null;
}

interface ReservaResumen {
  cliente_nombre: string;
  fecha: string;
  personas: number;
  qr_code: string;
}

interface TurnoRow {
  id: string;
  fecha: string;
}

function todayISO() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

export default function RpPanelPage() {
  const router = useRouter();
  const [session, setSession] = useState<RpSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [clubNombre, setClubNombre] = useState<string | null>(null);
  const [misTurnos, setMisTurnos] = useState<TurnoRow[]>([]);
  const [loadingTurnos, setLoadingTurnos] = useState(true);

  const [clienteNombre, setClienteNombre] = useState("");
  const [clienteTelefono, setClienteTelefono] = useState("");
  const [fecha, setFecha] = useState("");
  const [personas, setPersonas] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reserva, setReserva] = useState<ReservaResumen | null>(null);

  const minDate = todayISO();

  useEffect(() => {
    async function loadSession() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/cliente/login");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, nombre, club_id")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError || !profile) {
        console.error("Error cargando perfil RP:", profileError);
        await supabase.auth.signOut();
        router.replace("/cliente/login");
        return;
      }

      setSession({ id: profile.id, nombre: profile.nombre, clubId: profile.club_id });

      if (profile.club_id) {
        const { data: club, error: clubError } = await supabase
          .from("clubs")
          .select("nombre")
          .eq("id", profile.club_id)
          .maybeSingle();

        if (clubError) {
          console.error("Error cargando antro del RP:", clubError);
        } else if (club) {
          setClubNombre(club.nombre);
        }

        const { data: turnosData, error: turnosError } = await supabase
          .from("rp_schedule")
          .select("id, fecha")
          .eq("rp_id", profile.id)
          .gte("fecha", todayISO())
          .order("fecha", { ascending: true });

        if (turnosError) {
          console.error("Error cargando turnos del RP:", turnosError);
        } else {
          setMisTurnos((turnosData ?? []) as TurnoRow[]);
        }
        setLoadingTurnos(false);
      }

      setCheckingSession(false);
    }

    loadSession();
  }, [router]);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/cliente/login");
  }

  function resetForm() {
    setClienteNombre("");
    setClienteTelefono("");
    setFecha("");
    setPersonas(2);
    setReserva(null);
    setError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!session || !session.clubId) {
      return;
    }
    if (!clienteNombre.trim() || !clienteTelefono.trim() || !fecha) {
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
        cliente_nombre: clienteNombre.trim(),
        cliente_telefono: clienteTelefono.trim(),
        rp_id: session.id,
        club_id: session.clubId,
        source: "rp",
        fecha,
        personas,
        status: "pendiente",
        qr_code: qrCode,
      });

      if (insertError) {
        console.error("Supabase insert error (reservations):", insertError);
        throw insertError;
      }

      setReserva({
        cliente_nombre: clienteNombre.trim(),
        fecha,
        personas,
        qr_code: qrCode,
      });
    } catch (err) {
      console.error(err);
      setError(
        "No pudimos crear la reserva. Intenta de nuevo en unos segundos.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingSession) {
    return null;
  }

  const whatsappHref = reserva
    ? `https://wa.me/?text=${encodeURIComponent(
        `Aquí está tu reservación en ${clubNombre ?? "tu antro"} para ${reserva.cliente_nombre} el ${reserva.fecha} (${reserva.personas} personas). Ábrelo aquí para ver tu código: ${window.location.origin}/r/${reserva.qr_code}`,
      )}`
    : "#";

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-sm items-center justify-between pb-6">
        <p className="text-sm text-muted-foreground">Hola, {session?.nombre}</p>
        <Button type="button" variant="outline" size="sm" onClick={handleLogout}>
          Cerrar sesión
        </Button>
      </div>

      {session?.clubId && (
        <Card className="mb-6 w-full max-w-sm">
          <CardHeader>
            <CardTitle>Mi turno y asistencia</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">Próximos turnos</p>
              {loadingTurnos && (
                <p className="text-sm text-muted-foreground">Cargando...</p>
              )}
              {!loadingTurnos && misTurnos.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No tienes turnos asignados todavía.
                </p>
              )}
              {misTurnos.length > 0 && (
                <ul className="flex flex-col gap-1 text-sm">
                  {misTurnos.map((t) => (
                    <li key={t.id}>{t.fecha}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-col items-center gap-2 border-t border-border pt-4">
              <p className="text-sm font-medium">Tu código de asistencia</p>
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={`rp-attendance-${session.id}`} size={160} />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                Muéstralo al staff de tu antro al llegar.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!session?.clubId ? (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Cuenta sin antro asignado</CardTitle>
            <CardDescription>
              Tu cuenta no está vinculada a ningún antro. Contacta al antro
              para que te den de alta correctamente.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : reserva ? (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>¡Reserva creada!</CardTitle>
            <CardDescription>Comparte el código con tu cliente.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6 px-6 pb-6">
            <div className="rounded-xl bg-white p-4">
              <QRCodeSVG value={reserva.qr_code} size={200} />
            </div>
            <div className="w-full space-y-1 text-sm">
              <p>
                <span className="text-muted-foreground">Cliente:</span>{" "}
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
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={resetForm}
            >
              Crear otra reserva
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Nueva reserva para cliente</CardTitle>
            <CardDescription>
              Crea una reserva a nombre de tu cliente.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cliente_nombre">Nombre del cliente</Label>
                <Input
                  id="cliente_nombre"
                  value={clienteNombre}
                  onChange={(e) => setClienteNombre(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cliente_telefono">Teléfono</Label>
                <Input
                  id="cliente_telefono"
                  type="tel"
                  value={clienteTelefono}
                  onChange={(e) => setClienteTelefono(e.target.value)}
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
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                size="lg"
                className="mt-2 h-14 w-full text-base"
                disabled={submitting}
              >
                {submitting ? "Creando..." : "Crear reserva"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
