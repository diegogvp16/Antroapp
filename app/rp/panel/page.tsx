"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { createClient } from "@/lib/supabase/client";
import { cerrarSesionDadoDeBaja } from "@/lib/cuenta-dada-de-baja";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomNav, type RpTab } from "@/components/bottom-nav";
import { ReservasRp } from "@/components/rp/reservas-rp";
import { CuotaDeLaSemana } from "@/components/rp/tarjeta-cuota";
import {
  describirTurno,
  esTurnoFijo,
  type TurnoRow as TurnoScheduleRow,
} from "@/lib/turnos";
import {
  diaSemanaISO,
  etiquetaRango,
  nocheOperativaMexico,
  mesOperativo,
  semanaOperativa,
  type RangoNoches,
} from "@/lib/fechas";
import { formatearPesos } from "@/lib/dinero";
import {
  RESUMEN_VACIO,
  rangoQueCubre,
  resumirPeriodo,
  type GananciaRp,
  type ReservaRp,
  type ResumenPeriodo,
} from "@/lib/rp-rendimiento";
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
import { AVISO_QR, enlaceCompartir, fechaLarga, mensajeReserva } from "@/lib/domain/compartir";
import { mensajeParaUsuario } from "@/lib/errores-base";

interface RpSession {
  id: string;
  nombre: string;
  clubId: string | null;
}

interface ReservaResumen {
  cliente_nombre: string;
  telefono: string;
  fecha: string;
  personas: number;
  qr_code: string;
}

type TurnoRow = TurnoScheduleRow;

interface Periodos {
  semana: RangoNoches;
  anterior: RangoNoches;
  mes: RangoNoches;
}

interface Resumenes {
  semana: ResumenPeriodo;
  anterior: ResumenPeriodo;
  mes: ResumenPeriodo;
}

const RESUMENES_VACIOS: Resumenes = {
  semana: RESUMEN_VACIO,
  anterior: RESUMEN_VACIO,
  mes: RESUMEN_VACIO,
};

interface PagoDiaRow {
  id: string;
  fecha: string;
  posicion: number;
  monto: number;
  status: string;
}

const COMISION_STATUS_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  en_revision: "En revisión",
  validada: "Validada",
  pagada: "Pagada",
  anulada: "Anulada",
};


const DIA_SEMANA_LABEL = [
  "Dom",
  "Lun",
  "Mar",
  "Mié",
  "Jue",
  "Vie",
  "Sáb",
];

function formatFechaConDia(fecha: string) {
  return `${DIA_SEMANA_LABEL[diaSemanaISO(fecha)]} ${fecha}`;
}

// "Pendiente: $1,200 · Pagada: $300"
function desglosePorEstado(porEstado: Record<string, number>) {
  return Object.entries(porEstado)
    .map(
      ([status, monto]) =>
        `${COMISION_STATUS_LABEL[status] ?? status}: ${formatearPesos(monto)}`,
    )
    .join(" · ");
}

export default function RpPanelPage() {
  const router = useRouter();
  const [session, setSession] = useState<RpSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState<RpTab>("reservas");
  const [clubNombre, setClubNombre] = useState<string | null>(null);
  const [misTurnos, setMisTurnos] = useState<TurnoRow[]>([]);
  const [loadingTurnos, setLoadingTurnos] = useState(true);

  // Semana, semana anterior y mes de la noche en curso (corte 08:00).
  const [periodos] = useState<Periodos>(() => ({
    semana: semanaOperativa(),
    anterior: semanaOperativa(new Date(), 1),
    mes: mesOperativo(),
  }));
  const [resumenes, setResumenes] = useState<Resumenes>(RESUMENES_VACIOS);
  const [loadingRendimiento, setLoadingRendimiento] = useState(true);
  // Si falla, no se muestran ceros como si fueran reales.
  const [errorRendimiento, setErrorRendimiento] = useState<string | null>(null);
  // Falla al leer la cuenta (red): se avisa y se reintenta, sin cerrar sesión.
  const [errorSesion, setErrorSesion] = useState<string | null>(null);
  const [pagoRpModo, setPagoRpModo] = useState<"reserva" | "dia">("reserva");
  const [pagosDiaSemana, setPagosDiaSemana] = useState<PagoDiaRow[]>([]);

  const [clienteNombre, setClienteNombre] = useState("");
  const [clienteTelefono, setClienteTelefono] = useState("");
  const [fecha, setFecha] = useState("");
  const [personas, setPersonas] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reserva, setReserva] = useState<ReservaResumen | null>(null);
  const [versionReservas, setVersionReservas] = useState(0);
  const [mostrarNueva, setMostrarNueva] = useState(false);

  const minDate = nocheOperativaMexico(); // noche en curso (corte 08:00)

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
        .select("id, nombre, role, club_id, activo")
        .eq("id", user.id)
        .maybeSingle();

      // Este panel es solo para RPs: sin el check del rol, cualquier sesión
      // (cliente, gerente, dueño) podía abrirlo escribiendo la URL.
      if (profileError) {
        setErrorSesion(mensajeParaUsuario(profileError, "No pudimos cargar tu cuenta. Revisa tu conexión e intenta de nuevo."));
        setCheckingSession(false);
        return;
      }
      if (profile?.activo === false) {
        await cerrarSesionDadoDeBaja(supabase, router);
        return;
      }
      if (!profile || profile.role !== "rp") {
        await supabase.auth.signOut();
        router.replace("/cliente/login");
        return;
      }

      setSession({ id: profile.id, nombre: profile.nombre, clubId: profile.club_id });

      let modoActual: "reserva" | "dia" = "reserva";

      if (profile.club_id) {
        const { data: club, error: clubError } = await supabase
          .from("clubs")
          .select("nombre, pago_rp_modo")
          .eq("id", profile.club_id)
          .maybeSingle();

        if (clubError) {
          console.error("Error cargando antro del RP:", clubError);
        } else if (club) {
          setClubNombre(club.nombre);
          setPagoRpModo(club.pago_rp_modo);
          modoActual = club.pago_rp_modo;
        }

        // El turno fijo vale indefinidamente (su `fecha` puede ser vieja),
        // así que se trae aparte de las fechas sueltas de hoy en adelante.
        const { data: turnosData, error: turnosError } = await supabase
          .from("rp_schedule")
          .select("id, fecha, es_fijo, dias_semana, fecha_inicio")
          .eq("rp_id", profile.id)
          .or(`es_fijo.eq.true,fecha.gte.${nocheOperativaMexico()}`)
          .order("fecha", { ascending: true });

        if (turnosError) {
          console.error("Error cargando turnos del RP:", turnosError);
        } else {
          setMisTurnos((turnosData ?? []) as TurnoRow[]);
        }
        setLoadingTurnos(false);
        // El panel se muestra ya; el rendimiento llega después con su "Cargando…".
        setCheckingSession(false);

        await fetchRendimiento(profile.id, profile.club_id, modoActual);
      }

      setCheckingSession(false);
    }

    async function fetchRendimiento(
      rpId: string,
      clubId: string,
      modo: "reserva" | "dia",
    ) {
      setLoadingRendimiento(true);
      setErrorRendimiento(null);
      try {
        const supabase = createClient();
        // Todo se filtra por la NOCHE (reservations.fecha / rp_pagos_dia.fecha),
        // no por created_at: una reserva creada el lunes para el sábado
        // cuenta en la semana del sábado.
        const cubre = rangoQueCubre(periodos.semana, periodos.anterior, periodos.mes);

        const { data: reservasData, error: reservasError } = await supabase
          .from("reservations")
          .select("id, status, cliente_nombre, fecha")
          .eq("rp_id", rpId)
          .eq("club_id", clubId)
          .gte("fecha", cubre.desde)
          .lte("fecha", cubre.hasta)
          .order("fecha", { ascending: false });

        if (reservasError) throw reservasError;
        const reservas = (reservasData ?? []) as ReservaRp[];

        let ganancias: GananciaRp[] = [];
        if (modo === "dia") {
          const { data: pagosDia, error: pagosDiaError } = await supabase
            .from("rp_pagos_dia")
            .select("id, fecha, posicion, monto, status")
            .eq("rp_id", rpId)
            .gte("fecha", cubre.desde)
            .lte("fecha", cubre.hasta)
            .order("fecha", { ascending: true });

          if (pagosDiaError) throw pagosDiaError;
          const pagos = (pagosDia ?? []) as PagoDiaRow[];
          ganancias = pagos.map((p) => ({
            noche: p.fecha,
            monto: Number(p.monto),
            status: p.status,
          }));
          setPagosDiaSemana(
            pagos.filter(
              (p) =>
                p.fecha >= periodos.semana.desde &&
                p.fecha <= periodos.semana.hasta,
            ),
          );
        } else {
          const { data: comisiones, error: comisionesError } = await supabase
            .from("commissions")
            .select("monto, status, reservations!inner(fecha)")
            .eq("rp_id", rpId)
            .eq("tipo", "rp")
            .gte("reservations.fecha", cubre.desde)
            .lte("reservations.fecha", cubre.hasta);

          if (comisionesError) throw comisionesError;
          // SAFETY: el join !inner con reservations devuelve un solo objeto
          // por comisión (reservation_id es una llave foránea a una fila).
          const filas = (comisiones ?? []) as unknown as {
            monto: number;
            status: string;
            reservations: { fecha: string };
          }[];
          ganancias = filas.map((c) => ({
            noche: c.reservations.fecha,
            monto: Number(c.monto),
            status: c.status,
          }));
        }

        setResumenes({
          semana: resumirPeriodo(reservas, ganancias, periodos.semana),
          anterior: resumirPeriodo(reservas, ganancias, periodos.anterior),
          mes: resumirPeriodo(reservas, ganancias, periodos.mes),
        });
      } catch (err) {
        console.error("Error cargando rendimiento del RP:", err);
        setErrorRendimiento("No pudimos cargar lo que llevas ganado. Revisa tu conexión y vuelve a abrir el panel.");
      } finally {
        setLoadingRendimiento(false);
      }
    }

    loadSession();
  }, [router, periodos]);

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

      setVersionReservas((v) => v + 1);
      setReserva({
        cliente_nombre: clienteNombre.trim(),
        telefono: clienteTelefono.trim(),
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
    return (
      <div className="theme-caja flex flex-1 items-center justify-center px-4 py-10">
        <p className="text-sm text-caja-secundario">Cargando tu panel…</p>
      </div>
    );
  }
  if (errorSesion) {
    return (
      <div className="theme-caja flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <ErrorConReintento mensaje={errorSesion} />
        </div>
      </div>
    );
  }

  // Directo al chat del cliente (con el teléfono que capturó el RP).
  const whatsappHref = reserva
    ? enlaceCompartir(
        mensajeReserva({
          quien: "rp",
          antro: clubNombre ?? "el antro",
          cliente: reserva.cliente_nombre,
          fecha: reserva.fecha,
          personas: reserva.personas,
          enlace: `${window.location.origin}/r/${reserva.qr_code}`,
        }),
        reserva.telefono,
      )
    : "#";

  if (!session?.clubId) {
    return (
      <div className="flex flex-1 flex-col items-center px-6 py-10">
        <div className="flex w-full max-w-sm items-center justify-between pb-6">
          <p className="text-sm text-muted-foreground">Hola, {session?.nombre}</p>
          <Button type="button" variant="outline" size="sm" onClick={handleLogout}>
            Cerrar sesión
          </Button>
        </div>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Cuenta sin antro asignado</CardTitle>
            <CardDescription>
              Tu cuenta no está vinculada a ningún antro. Contacta al antro
              para que te den de alta correctamente.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="theme-caja flex flex-1 flex-col items-center font-sans">
      <main className="mx-auto w-full max-w-md flex-1 px-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {activeTab === "perfil" && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold">Hola, {session.nombre}</h1>
              <p className="text-sm text-muted-foreground">
                RP en{" "}
                <span className="font-medium text-foreground">{clubNombre}</span>
              </p>
            </div>

            <Card className="w-full">
              <CardHeader>
                <CardTitle>
                  {pagoRpModo === "dia" ? "Pago por día" : "Comisiones"}
                </CardTitle>
                <CardDescription>
                  Lo paga {clubNombre ?? "tu antro"} en su nómina.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-6 pb-6">
                {loadingRendimiento ? (
                  <p className="text-sm text-muted-foreground">Cargando...</p>
                ) : errorRendimiento ? (
                  <ErrorConReintento mensaje={errorRendimiento} />
                ) : (
                  <dl className="grid grid-cols-2 gap-3">
                    {(
                      [
                        ["Esta semana", resumenes.semana],
                        ["Este mes", resumenes.mes],
                      ] as const
                    ).map(([titulo, resumen]) => (
                      <div
                        key={titulo}
                        className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2"
                      >
                        <dt className="text-xs text-muted-foreground">{titulo}</dt>
                        <dd className="text-lg font-semibold tabular-nums">
                          {formatearPesos(resumen.ganado)}
                        </dd>
                        <dd className="text-xs text-muted-foreground">
                          {resumen.entraron} de {resumen.reservas} entraron
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </CardContent>
            </Card>

            <Button
              type="button"
              variant="outline"
              className="h-11 w-full"
              onClick={handleLogout}
            >
              Cerrar sesión
            </Button>
          </div>
        )}

        {activeTab === "turnos" && (
          <Card className="w-full">
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
                      <li key={t.id}>
                        {esTurnoFijo(t)
                          ? describirTurno(t)
                          : formatFechaConDia(t.fecha)}
                      </li>
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

        {activeTab === "nomina" && (
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Nómina</CardTitle>
              <CardDescription>
                Cuenta por la noche de cada reserva. Lo paga tu antro.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6 pb-6">
              {loadingRendimiento ? (
                <p className="text-sm text-muted-foreground">Cargando...</p>
              ) : errorRendimiento ? (
                <ErrorConReintento mensaje={errorRendimiento} />
              ) : (
                <>
                  {(
                    [
                      ["Esta semana", periodos.semana, resumenes.semana],
                      ["Semana anterior", periodos.anterior, resumenes.anterior],
                    ] as const
                  ).map(([titulo, rango, resumen], i) => (
                    <div
                      key={titulo}
                      className={
                        i > 0
                          ? "flex flex-col gap-1 border-t border-border pt-3"
                          : "flex flex-col gap-1"
                      }
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-medium">{titulo}</p>
                        <p className="text-xs text-muted-foreground">
                          {etiquetaRango(rango)}
                        </p>
                      </div>
                      <p className="text-lg font-semibold tabular-nums">
                        {formatearPesos(resumen.ganado)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {resumen.registrosGanancia === 0
                          ? pagoRpModo === "dia"
                            ? "Sin días pagados en esta semana."
                            : "Sin comisiones en esta semana."
                          : `${resumen.registrosGanancia} ${pagoRpModo === "dia" ? "días" : "comisiones"} · ${desglosePorEstado(resumen.ganadoPorEstado)}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {resumen.reservas} reservas, {resumen.entraron} entraron
                      </p>
                    </div>
                  ))}

                  {pagoRpModo === "reserva" && <CuotaDeLaSemana />}

                  {pagoRpModo === "dia" && pagosDiaSemana.length > 0 && (
                    <div className="flex flex-col gap-1 border-t border-border pt-3">
                      <p className="text-sm font-medium">Días de esta semana</p>
                      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                        {pagosDiaSemana.map((p) => (
                          <li
                            key={p.id}
                            className="flex items-center justify-between"
                          >
                            <span>
                              {formatFechaConDia(p.fecha)} (día {p.posicion})
                            </span>
                            <span className="tabular-nums">
                              {formatearPesos(Number(p.monto))} ·{" "}
                              {COMISION_STATUS_LABEL[p.status] ?? p.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === "reservas" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-base font-semibold">Mis reservas</h1>
              {!reserva && (
                <button
                  type="button"
                  onClick={() => setMostrarNueva((v) => !v)}
                  aria-expanded={mostrarNueva}
                  className="h-11 rounded-lg border border-caja-borde px-3 text-sm font-medium text-caja-dorado"
                >
                  {mostrarNueva ? "Cerrar" : "+ Nueva reserva"}
                </button>
              )}
            </div>

            {reserva ? (
              <Card className="w-full">
                <CardHeader>
                  <CardTitle>¡Reserva creada!</CardTitle>
                  <CardDescription>
                    Comparte el código con tu cliente.
                  </CardDescription>
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
                      {fechaLarga(reserva.fecha)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Personas:</span>{" "}
                      {reserva.personas}
                    </p>
                  </div>
                  <p className="w-full text-xs text-muted-foreground">{AVISO_QR}</p>
                  <Button
                    render={
                      <a
                        href={whatsappHref}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
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
                    className="h-11 w-full"
                    onClick={resetForm}
                  >
                    Crear otra reserva
                  </Button>
                </CardContent>
              </Card>
            ) : mostrarNueva ? (
              <Card className="w-full">
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
                        className="h-11"
                        value={clienteNombre}
                        onChange={(e) => setClienteNombre(e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cliente_telefono">Teléfono</Label>
                      <Input
                        id="cliente_telefono"
                        className="h-11"
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
                        className="h-11"
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
            ) : null}

            {/* La key cambia al crear una reserva: la lista se vuelve a leer y ya la incluye. */}
            <ReservasRp key={versionReservas} clubNombre={clubNombre} />
          </div>
        )}
      </main>

      <BottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  );
}

// Error con un botón para volver a cargar el panel (44 px).
function ErrorConReintento({ mensaje }: { mensaje: string }) {
  return (
    <div className="flex flex-col gap-3" role="alert">
      <p className="text-sm text-destructive">{mensaje}</p>
      <button type="button" onClick={() => window.location.reload()} className="h-11 w-fit rounded-md border border-border px-4 text-sm font-medium">
        Reintentar
      </button>
    </div>
  );
}
