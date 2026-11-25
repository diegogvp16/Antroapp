"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
import { nocheOperativaMexico } from "@/lib/fechas";
import { textoCover } from "@/lib/cover";
import { enlaceCompartir, fechaLarga, mensajeReserva } from "@/lib/domain/compartir";
import { guardarBoleto } from "@/lib/boletos-guardados";
import { frasePuertaFormulario } from "@/lib/domain/boleto";
import { EnLaPuerta } from "@/components/boleto/en-la-puerta";
import { CompartirBoleto } from "@/components/boleto/compartir-boleto";
import { AvisoBoletoGuardado } from "@/components/boleto/aviso-boleto-guardado";
import { DatosBoleto, QrBoleto } from "@/components/boleto/datos-boleto";
import type { Club } from "@/types";

interface ReservaResumen {
  cliente_nombre: string;
  fecha: string;
  personas: number;
  qr_code: string;
  // Si quedó guardado en este teléfono (localStorage puede fallar).
  guardado: boolean;
}

export default function ReservarPageWrapper() {
  return (
    <Suspense fallback={null}>
      <ReservarPage />
    </Suspense>
  );
}

function ReservarPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const clubId = searchParams.get("club");

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [club, setClub] = useState<Club | null>(null);
  const [loadingClub, setLoadingClub] = useState(true);
  const [clubNotFound, setClubNotFound] = useState(false);
  const [clienteId, setClienteId] = useState<string | null>(null);

  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [fecha, setFecha] = useState("");
  const [personas, setPersonas] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reserva, setReserva] = useState<ReservaResumen | null>(null);

  // Desde la noche en curso (corte 08:00): a la 1:00 a. m. todavía se
  // reserva para la noche que la puerta acepta.
  const minDate = nocheOperativaMexico();
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
        // Solo se reserva en antros publicados (suscripción activa y
        // verificados), igual que el listado y la ficha.
        const { data, error: queryError } = await supabase
          .from("clubs")
          .select("*")
          .eq("id", clubId)
          .eq("suscripcion_activa", true)
          .eq("estado_verificacion", "verificado")
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

  useEffect(() => {
    // Si NO hay sesión, el flujo anónimo sigue exactamente igual que hoy:
    // se desbloquea el formulario de inmediato, sin cliente_id. Si SÍ hay
    // sesión pero el rol no es 'cliente' (RP, staff, etc.), se cierra esta
    // puerta trasera igual que ya hacen /cliente y /cliente/[clubId]:
    // redirige a /cliente/login en vez de dejarlo pasar.
    async function checkClienteSession() {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          setCheckingAccess(false);
          return;
        }

        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("id, nombre, telefono, role")
          .eq("id", user.id)
          .maybeSingle();

        if (profileError || !profile || profile.role !== "cliente") {
          router.replace("/cliente/login");
          return;
        }

        setClienteId(profile.id);
        setNombre((prev) => prev || profile.nombre || "");
        setTelefono((prev) => prev || profile.telefono || "");
        setCheckingAccess(false);
      } catch (err) {
        console.error("Error verificando sesión de cliente:", err);
        setCheckingAccess(false);
      }
    }

    checkClienteSession();
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

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
        cliente_id: clienteId,
        source: "organica",
        fecha,
        personas,
        status: "pendiente",
        qr_code: qrCode,
      });

      if (insertError) {
        // Índice único: una reserva por cliente, antro y noche.
        if (insertError.code === "23505") {
          setError("Ya tienes una reserva en este antro para esa noche.");
          return;
        }
        // Avisos de la base (P0001): topes de reservas sin cuenta, antro que
        // no recibe reservas, nombre o teléfono inválidos. Se muestran tal
        // cual y sin "Intenta de nuevo": reintentar no cambia la respuesta.
        if (insertError.code === "P0001" && insertError.message) {
          setError(insertError.message);
          return;
        }
        console.error("Supabase insert error (reservations):", insertError);
        throw insertError;
      }

      // Solo sin cuenta: en este teléfono, para que quien reservó y recarga
      // no pierda su QR (código, antro y su zona, fecha y personas). Con
      // sesión no se guarda nada aquí: sus boletos están en Mi perfil, y en
      // un teléfono compartido el siguiente no debe ver el boleto de otro.
      const guardado = clienteId
        ? false
        : guardarBoleto({
            qr: qrCode,
            clubId: club.id,
            clubNombre: club.nombre,
            fecha,
            personas,
            zona: club.zona_horaria ?? null,
          });

      setReserva({
        cliente_nombre: nombre.trim(),
        fecha,
        personas,
        qr_code: qrCode,
        guardado,
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

  if (checkingAccess) {
    return null;
  }

  if (!clubId) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
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
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
        <BackLink href={backHref} />
        <p className="text-sm text-muted-foreground">Cargando...</p>
      </div>
    );
  }

  if (clubNotFound || !club) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
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
    // Nace "pendiente": se dice "Lugar apartado", no "reserva confirmada".
    const enlace = `${window.location.origin}/r/${reserva.qr_code}`;
    const cover = textoCover(club);
    const whatsappHref = enlaceCompartir(
      mensajeReserva({
        quien: "cliente",
        antro: club.nombre,
        cliente: reserva.cliente_nombre,
        fecha: reserva.fecha,
        personas: reserva.personas,
        enlace,
        cover: { modo: club.cover_modo, texto: cover },
      }),
    );

    return (
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
        <BackLink href={backHref} />
        <Card className="w-full max-w-sm" data-prueba="confirmacion">
          <CardHeader>
            <CardTitle>Lugar apartado</CardTitle>
            <CardDescription>
              Para el {fechaLarga(reserva.fecha)} en {club.nombre}. Muestra este
              código en la puerta.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6 px-6 pb-6">
            <QrBoleto codigo={reserva.qr_code} tamano={200} />
            <DatosBoleto
              antro={club.nombre}
              direccion={club.direccion}
              fecha={reserva.fecha}
              personas={reserva.personas}
              nombre={reserva.cliente_nombre}
            />
            <EnLaPuerta
              cover={cover}
              coverModo={club.cover_modo}
              toleranciaHora={club.tolerancia_hora}
              edadMinima={club.edad_minima}
              codigoVestimenta={club.codigo_vestimenta}
            />
            <div className="flex w-full flex-col gap-3">
              <Button
                render={<Link href={`/r/${reserva.qr_code}`} />}
                nativeButton={false}
                size="lg"
                className="h-14 w-full text-base font-semibold"
              >
                Ver mi boleto
              </Button>
              <CompartirBoleto
                enlace={enlace}
                titulo={`Mi lugar en ${club.nombre}`}
                mensajeWhatsApp={whatsappHref}
              />
            </div>
            <p className="w-full text-xs leading-relaxed text-muted-foreground" data-prueba="aviso-guardado">
              {clienteId
                ? "También lo encuentras en Mi perfil, en tus reservas."
                : reserva.guardado
                  ? "Tu boleto quedó guardado en este teléfono. Si cambias de teléfono o borras los datos del navegador, solo lo recuperas con el enlace: guárdalo."
                  : "No pudimos guardarlo en este teléfono. Guarda el enlace: sin cuenta, es la única forma de volver a ver tu QR."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
      <BackLink href={backHref} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reservar en {club.nombre}</CardTitle>
          <CardDescription>
            Llena tus datos para apartar lugar. Apartar no tiene costo.
            {frasePuertaFormulario(club.cover_modo, textoCover(club)) &&
              ` ${frasePuertaFormulario(club.cover_modo, textoCover(club))}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-6 pb-6">
          <AvisoBoletoGuardado clubId={club.id} />
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
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-2 h-14 w-full text-base font-semibold"
              disabled={submitting}
            >
              {submitting ? "Apartando..." : "Apartar lugar"}
            </Button>

            {!clienteId && (
              <p className="text-center text-xs text-muted-foreground">
                ¿Ya tienes cuenta?{" "}
                <Link
                  href="/cliente/login"
                  className="inline-flex min-h-10 items-center font-medium underline underline-offset-4"
                >
                  Inicia sesión para ver tu historial
                </Link>
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
