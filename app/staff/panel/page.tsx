"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
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

const QR_READER_ELEMENT_ID = "qr-reader";

type ScanState =
  | { status: "scanning" }
  | { status: "camera-error"; message: string }
  | { status: "not-found" }
  | { status: "wrong-club" }
  | { status: "already-checked-in"; reserva: Reservation }
  | { status: "ready"; reserva: Reservation }
  | { status: "success" }
  | { status: "lookup-error" };

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

export default function StaffPanelPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [clubId, setClubId] = useState<string | null>(null);
  const [clubNombre, setClubNombre] = useState("");

  const [reservas, setReservas] = useState<Reservation[]>([]);
  const [rpNombres, setRpNombres] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanState, setScanState] = useState<ScanState>({ status: "scanning" });
  const [checkingIn, setCheckingIn] = useState(false);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const scanLockRef = useRef(false);

  useEffect(() => {
    async function loadSession() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/staff/login");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role, club_id")
        .eq("id", user.id)
        .maybeSingle();

      if (
        profileError ||
        !profile ||
        (profile.role !== "staff" && profile.role !== "gerente") ||
        !profile.club_id
      ) {
        router.replace("/staff/login");
        return;
      }

      setClubId(profile.club_id);
      setCheckingSession(false);
    }

    loadSession();
  }, [router]);

  const fetchReservas = useCallback(async (targetClubId: string) => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const hoy = todayISO();

      const { data, error: queryError } = await supabase
        .from("reservations")
        .select("*")
        .eq("fecha", hoy)
        .eq("club_id", targetClubId)
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
    if (!clubId) return;

    async function fetchClubNombre() {
      const supabase = createClient();
      const { data } = await supabase
        .from("clubs")
        .select("nombre")
        .eq("id", clubId)
        .maybeSingle();
      if (data) setClubNombre(data.nombre);
    }

    fetchClubNombre();
    fetchReservas(clubId);
  }, [clubId, fetchReservas]);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/staff/login");
  }

  async function handleDecodedText(decodedText: string) {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    html5QrCodeRef.current?.pause(true);

    try {
      const supabase = createClient();
      const { data, error: lookupError } = await supabase
        .from("reservations")
        .select("*")
        .eq("qr_code", decodedText.trim())
        .maybeSingle();

      if (lookupError || !data) {
        setScanState({ status: "not-found" });
        return;
      }

      const reserva = data as Reservation;

      if (reserva.club_id !== clubId) {
        setScanState({ status: "wrong-club" });
        return;
      }

      if (reserva.status === "usada") {
        setScanState({ status: "already-checked-in", reserva });
        return;
      }

      setScanState({ status: "ready", reserva });
    } catch (err) {
      console.error("Error buscando reserva escaneada:", err);
      setScanState({ status: "lookup-error" });
    }
  }

  function openScanner() {
    scanLockRef.current = false;
    setScanState({ status: "scanning" });
    setScannerOpen(true);
  }

  function closeScanner() {
    setScannerOpen(false);
  }

  function resumeScanning() {
    scanLockRef.current = false;
    setScanState({ status: "scanning" });
    html5QrCodeRef.current?.resume();
  }

  async function handleConfirmCheckIn(reserva: Reservation) {
    setCheckingIn(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("reservations")
        .update({ status: "usada" })
        .eq("id", reserva.id);

      if (updateError) throw updateError;

      setScanState({ status: "success" });
      if (clubId) {
        await fetchReservas(clubId);
      }
    } catch (err) {
      console.error("Error confirmando check-in:", err);
      setScanState({ status: "lookup-error" });
    } finally {
      setCheckingIn(false);
    }
  }

  useEffect(() => {
    if (!scannerOpen) return;

    const html5QrCode = new Html5Qrcode(QR_READER_ELEMENT_ID);
    html5QrCodeRef.current = html5QrCode;
    let cancelled = false;

    html5QrCode
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (decodedText) => {
          handleDecodedText(decodedText);
        },
        undefined,
      )
      .catch((err) => {
        console.error("Error iniciando la cámara:", err);
        if (!cancelled) {
          setScanState({
            status: "camera-error",
            message:
              "No pudimos acceder a la cámara. Revisa los permisos del navegador.",
          });
        }
      });

    return () => {
      cancelled = true;
      html5QrCode
        .stop()
        .then(() => html5QrCode.clear())
        .catch(() => {});
      html5QrCodeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannerOpen]);

  if (checkingSession) {
    return null;
  }

  const totalReservas = reservas.length;
  const totalOrganicas = reservas.filter((r) => r.source === "organica").length;
  const totalRp = reservas.filter((r) => r.source === "rp").length;
  const totalPersonas = reservas.reduce((sum, r) => sum + r.personas, 0);

  if (scannerOpen) {
    return (
      <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Escanear QR</CardTitle>
              <CardDescription>
                Apunta la cámara al código QR de la reserva.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6 pb-6">
              {scanState.status === "scanning" && (
                <div
                  id={QR_READER_ELEMENT_ID}
                  className="w-full overflow-hidden rounded-lg"
                />
              )}

              {scanState.status === "camera-error" && (
                <p className="text-sm text-destructive" role="alert">
                  {scanState.message}
                </p>
              )}

              {scanState.status === "not-found" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Código no válido o no encontrado.
                  </p>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {scanState.status === "wrong-club" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Este código no pertenece a este antro.
                  </p>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {scanState.status === "already-checked-in" && (
                <div className="flex flex-col gap-3">
                  <p
                    className="text-sm text-amber-600 dark:text-amber-400"
                    role="alert"
                  >
                    Esta reserva ya hizo check-in.
                  </p>
                  <div className="text-sm">
                    <p className="font-medium">
                      {scanState.reserva.cliente_nombre}
                    </p>
                    <p className="text-muted-foreground">
                      {scanState.reserva.personas} personas ·{" "}
                      {scanState.reserva.fecha}
                    </p>
                  </div>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {scanState.status === "ready" && (
                <div className="flex flex-col gap-3">
                  <div className="text-sm">
                    <p className="font-medium">
                      {scanState.reserva.cliente_nombre}
                    </p>
                    <p className="text-muted-foreground">
                      {scanState.reserva.personas} personas ·{" "}
                      {scanState.reserva.fecha}
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() => handleConfirmCheckIn(scanState.reserva)}
                    disabled={checkingIn}
                  >
                    {checkingIn ? "Confirmando..." : "Confirmar llegada"}
                  </Button>
                </div>
              )}

              {scanState.status === "success" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-green-600 dark:text-green-400">
                    ¡Check-in confirmado!
                  </p>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {scanState.status === "lookup-error" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Ocurrió un error. Intenta de nuevo.
                  </p>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              <Button type="button" variant="outline" onClick={closeScanner}>
                Cerrar escáner
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">
              Panel de {clubNombre || "tu antro"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Reservas de esta noche
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => clubId && fetchReservas(clubId)}
              disabled={loading}
            >
              {loading ? "Actualizando..." : "Actualizar"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleLogout}
            >
              Cerrar sesión
            </Button>
          </div>
        </div>

        <Button
          type="button"
          size="lg"
          className="h-14 w-full text-base"
          onClick={openScanner}
        >
          Escanear QR
        </Button>

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
