"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  Club,
  ClubTable,
  ConsumptionEntry,
  Profile,
  Reservation,
} from "@/types";

type RPListItem = Pick<Profile, "id" | "nombre" | "activo">;

interface ScheduleRow {
  id: string;
  fecha: string;
}

interface AttendanceRow {
  id: string;
  scanned_at: string;
  metodo: string;
}

const QR_READER_ELEMENT_ID = "qr-reader";
const QR_READER_ATTENDANCE_ELEMENT_ID = "qr-reader-attendance";

const SELECT_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

function formatHora(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

type ScanState =
  | { status: "scanning" }
  | { status: "camera-error"; message: string }
  | { status: "not-found" }
  | { status: "wrong-club" }
  | { status: "already-checked-in"; reserva: Reservation }
  | { status: "ready"; reserva: Reservation }
  | { status: "success" }
  | { status: "lookup-error" };

type AttendanceScanState =
  | { status: "scanning" }
  | { status: "camera-error"; message: string }
  | { status: "not-found" }
  | { status: "wrong-club" }
  | { status: "no-turno"; rp: { id: string; nombre: string } }
  | { status: "already-marked"; rp: { id: string; nombre: string }; scannedAt: string }
  | { status: "success"; nombre: string; scannedAt: string }
  | { status: "lookup-error" };

function todayISO() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

// Semana lunes-domingo en hora LOCAL del dispositivo (mismo criterio que
// todayISO() usa para "hoy"). getDay(): 0=domingo, 1=lunes ... 6=sábado.
// Si hoy es domingo (0), el lunes de esa semana quedó 6 días atrás;
// cualquier otro día, retrocedemos (day - 1) días para llegar al lunes.
function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { start: monday, end: sunday };
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
  const [club, setClub] = useState<Club | null>(null);

  const [reservas, setReservas] = useState<Reservation[]>([]);
  const [rpNombres, setRpNombres] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanState, setScanState] = useState<ScanState>({ status: "scanning" });
  const [checkingIn, setCheckingIn] = useState(false);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const scanLockRef = useRef(false);

  const [tables, setTables] = useState<ClubTable[]>([]);
  const [mesaSelections, setMesaSelections] = useState<Record<string, string>>(
    {},
  );
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<Record<string, string>>({});

  const [consumptionEntries, setConsumptionEntries] = useState<
    Record<string, ConsumptionEntry[]>
  >({});
  const [consumptionInputs, setConsumptionInputs] = useState<
    Record<string, string>
  >({});
  const [addingConsumptionId, setAddingConsumptionId] = useState<
    string | null
  >(null);
  const [consumptionError, setConsumptionError] = useState<
    Record<string, string>
  >({});

  const [markingSinConsumoId, setMarkingSinConsumoId] = useState<
    string | null
  >(null);
  const [sinConsumoError, setSinConsumoError] = useState<
    Record<string, string>
  >({});

  const [misRPs, setMisRPs] = useState<RPListItem[]>([]);
  const [loadingRPs, setLoadingRPs] = useState(true);
  const [rpNombre, setRpNombre] = useState("");
  const [rpEmail, setRpEmail] = useState("");
  const [rpPassword, setRpPassword] = useState("");
  const [rpSubmitting, setRpSubmitting] = useState(false);
  const [rpError, setRpError] = useState<string | null>(null);
  const [togglingRpId, setTogglingRpId] = useState<string | null>(null);

  const [rpSchedules, setRpSchedules] = useState<Record<string, ScheduleRow[]>>(
    {},
  );
  const [scheduleDateInputs, setScheduleDateInputs] = useState<
    Record<string, string>
  >({});
  const [addingScheduleId, setAddingScheduleId] = useState<string | null>(
    null,
  );
  const [scheduleError, setScheduleError] = useState<Record<string, string>>(
    {},
  );
  const [removingScheduleId, setRemovingScheduleId] = useState<string | null>(
    null,
  );

  const [todaySchedules, setTodaySchedules] = useState<
    { id: string; rp_id: string; fecha: string }[]
  >([]);
  const [todayAttendance, setTodayAttendance] = useState<
    Record<string, AttendanceRow>
  >({});
  const [loadingAsistencia, setLoadingAsistencia] = useState(true);
  const [markingManualId, setMarkingManualId] = useState<string | null>(null);
  const [manualError, setManualError] = useState<Record<string, string>>({});

  const [attendanceScannerOpen, setAttendanceScannerOpen] = useState(false);
  const [attendanceScanState, setAttendanceScanState] =
    useState<AttendanceScanState>({ status: "scanning" });
  const html5QrCodeAttendanceRef = useRef<Html5Qrcode | null>(null);
  const attendanceScanLockRef = useRef(false);

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
        .select("role, club_id")
        .eq("id", user.id)
        .maybeSingle();

      if (
        profileError ||
        !profile ||
        (profile.role !== "staff" && profile.role !== "gerente") ||
        !profile.club_id
      ) {
        router.replace("/cliente/login");
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

      const reservationIdsWithMesa = rows
        .filter((r) => r.mesa_id)
        .map((r) => r.id);

      if (reservationIdsWithMesa.length > 0) {
        const { data: entriesData, error: entriesError } = await supabase
          .from("consumption_entries")
          .select("*")
          .in("reservation_id", reservationIdsWithMesa)
          .order("created_at", { ascending: true });

        if (entriesError) {
          console.error("Error cargando consumo:", entriesError);
        } else {
          const grouped: Record<string, ConsumptionEntry[]> = {};
          for (const entry of (entriesData ?? []) as ConsumptionEntry[]) {
            const list = grouped[entry.reservation_id] ?? [];
            list.push(entry);
            grouped[entry.reservation_id] = list;
          }
          setConsumptionEntries(grouped);
        }
      } else {
        setConsumptionEntries({});
      }

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
        .select("*")
        .eq("id", clubId)
        .maybeSingle();
      if (data) {
        setClubNombre(data.nombre);
        setClub(data as Club);
      }
    }

    async function fetchTables() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("club_tables")
          .select("*")
          .eq("club_id", clubId)
          .order("numero", { ascending: true });

        if (error) throw error;
        setTables((data ?? []) as ClubTable[]);
      } catch (err) {
        console.error("Error cargando mesas:", err);
      }
    }

    fetchClubNombre();
    fetchTables();
    fetchReservas(clubId);
    fetchMisRPs(clubId);
    fetchRpSchedules(clubId);
    fetchAsistenciaHoy(clubId);
  }, [clubId, fetchReservas]);

  async function fetchRpSchedules(targetClubId: string) {
    try {
      const supabase = createClient();
      const hoy = todayISO();
      const { data, error } = await supabase
        .from("rp_schedule")
        .select("id, rp_id, fecha")
        .eq("club_id", targetClubId)
        .gte("fecha", hoy)
        .order("fecha", { ascending: true });

      if (error) throw error;

      const grouped: Record<string, ScheduleRow[]> = {};
      for (const row of data ?? []) {
        const list = grouped[row.rp_id] ?? [];
        list.push({ id: row.id, fecha: row.fecha });
        grouped[row.rp_id] = list;
      }
      setRpSchedules(grouped);
      setTodaySchedules(
        (data ?? [])
          .filter((row) => row.fecha === hoy)
          .map((row) => ({ id: row.id, rp_id: row.rp_id, fecha: row.fecha })),
      );
    } catch (err) {
      console.error("Error cargando turnos de RPs:", err);
    }
  }

  async function fetchAsistenciaHoy(targetClubId: string) {
    setLoadingAsistencia(true);
    try {
      const supabase = createClient();
      const hoy = todayISO();
      const { data, error } = await supabase
        .from("rp_attendance")
        .select("id, rp_id, scanned_at, metodo")
        .eq("club_id", targetClubId)
        .eq("fecha", hoy);

      if (error) throw error;

      const map: Record<string, AttendanceRow> = {};
      for (const row of data ?? []) {
        map[row.rp_id] = { id: row.id, scanned_at: row.scanned_at, metodo: row.metodo };
      }
      setTodayAttendance(map);
    } catch (err) {
      console.error("Error cargando asistencia de hoy:", err);
    } finally {
      setLoadingAsistencia(false);
    }
  }

  async function handleAddSchedule(rp: RPListItem) {
    const fecha = scheduleDateInputs[rp.id] ?? "";
    setScheduleError((prev) => ({ ...prev, [rp.id]: "" }));

    if (!fecha) {
      setScheduleError((prev) => ({ ...prev, [rp.id]: "Selecciona una fecha." }));
      return;
    }
    if (fecha < todayISO()) {
      setScheduleError((prev) => ({
        ...prev,
        [rp.id]: "La fecha no puede ser en el pasado.",
      }));
      return;
    }
    if (!clubId) return;

    setAddingScheduleId(rp.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("rp_schedule")
        .insert({ rp_id: rp.id, club_id: clubId, fecha });

      if (error) throw error;

      setScheduleDateInputs((prev) => ({ ...prev, [rp.id]: "" }));
      await fetchRpSchedules(clubId);
    } catch (err) {
      console.error("Error asignando turno:", err);
      setScheduleError((prev) => ({
        ...prev,
        [rp.id]: "No pudimos asignar el turno. Intenta de nuevo.",
      }));
    } finally {
      setAddingScheduleId(null);
    }
  }

  async function handleRemoveSchedule(scheduleId: string) {
    if (!clubId) return;
    setRemovingScheduleId(scheduleId);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("rp_schedule")
        .delete()
        .eq("id", scheduleId);

      if (error) throw error;
      await fetchRpSchedules(clubId);
    } catch (err) {
      console.error("Error quitando turno:", err);
    } finally {
      setRemovingScheduleId(null);
    }
  }

  async function handleMarkManual(rpId: string) {
    if (!clubId) return;
    setManualError((prev) => ({ ...prev, [rpId]: "" }));
    setMarkingManualId(rpId);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { error } = await supabase.from("rp_attendance").insert({
        rp_id: rpId,
        club_id: clubId,
        fecha: todayISO(),
        scanned_at: new Date().toISOString(),
        metodo: "manual",
        marcado_por: user?.id ?? null,
      });

      if (error) throw error;
      await fetchAsistenciaHoy(clubId);
    } catch (err) {
      console.error("Error registrando llegada manual:", err);
      setManualError((prev) => ({
        ...prev,
        [rpId]: "No pudimos registrar la llegada. Intenta de nuevo.",
      }));
    } finally {
      setMarkingManualId(null);
    }
  }

  async function fetchMisRPs(targetClubId: string) {
    setLoadingRPs(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, nombre, activo")
        .eq("club_id", targetClubId)
        .eq("role", "rp")
        .order("nombre", { ascending: true });

      if (error) throw error;
      setMisRPs((data ?? []) as RPListItem[]);
    } catch (err) {
      console.error("Error cargando RPs:", err);
    } finally {
      setLoadingRPs(false);
    }
  }

  async function handleCreateRP() {
    setRpError(null);
    if (!clubId) return;

    if (!rpNombre.trim() || !rpEmail.trim() || !rpPassword) {
      setRpError("Completa todos los campos.");
      return;
    }
    if (rpPassword.length < 6) {
      setRpError("La contraseña debe tener al menos 6 caracteres.");
      return;
    }

    setRpSubmitting(true);
    try {
      const res = await fetch("/api/admin/create-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: rpEmail.trim(),
          password: rpPassword,
          nombre: rpNombre.trim(),
          role: "rp",
          club_id: clubId,
        }),
      });
      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.error ?? "No pudimos crear la cuenta.");
      }

      setRpNombre("");
      setRpEmail("");
      setRpPassword("");
      await fetchMisRPs(clubId);
    } catch (err) {
      console.error("Error creando RP:", err);
      setRpError(
        err instanceof Error ? err.message : "No pudimos crear la cuenta.",
      );
    } finally {
      setRpSubmitting(false);
    }
  }

  async function handleToggleRPActivo(rp: RPListItem) {
    if (!clubId) return;
    setTogglingRpId(rp.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("profiles")
        .update({ activo: !rp.activo })
        .eq("id", rp.id);

      if (error) throw error;
      await fetchMisRPs(clubId);
    } catch (err) {
      console.error("Error actualizando estado del RP:", err);
    } finally {
      setTogglingRpId(null);
    }
  }

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/cliente/login");
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

  async function registerAttendance(rp: { id: string; nombre: string }) {
    if (!clubId) return;
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const nowIso = new Date().toISOString();

      const { error } = await supabase.from("rp_attendance").insert({
        rp_id: rp.id,
        club_id: clubId,
        fecha: todayISO(),
        scanned_at: nowIso,
        metodo: "qr",
        marcado_por: user?.id ?? null,
      });

      if (error) throw error;

      setAttendanceScanState({ status: "success", nombre: rp.nombre, scannedAt: nowIso });
      await fetchAsistenciaHoy(clubId);
    } catch (err) {
      console.error("Error registrando asistencia:", err);
      setAttendanceScanState({ status: "lookup-error" });
    }
  }

  async function handleAttendanceDecodedText(decodedText: string) {
    if (attendanceScanLockRef.current) return;
    attendanceScanLockRef.current = true;
    html5QrCodeAttendanceRef.current?.pause(true);

    const match = decodedText.trim().match(/^rp-attendance-(.+)$/);
    if (!match) {
      setAttendanceScanState({ status: "not-found" });
      return;
    }
    const rpId = match[1];

    try {
      const supabase = createClient();
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, nombre, role, club_id")
        .eq("id", rpId)
        .maybeSingle();

      if (profileError || !profile || profile.role !== "rp") {
        setAttendanceScanState({ status: "not-found" });
        return;
      }

      if (profile.club_id !== clubId) {
        setAttendanceScanState({ status: "wrong-club" });
        return;
      }

      const hoy = todayISO();
      const { data: existingAttendance } = await supabase
        .from("rp_attendance")
        .select("id, scanned_at")
        .eq("rp_id", rpId)
        .eq("fecha", hoy)
        .maybeSingle();

      if (existingAttendance) {
        setAttendanceScanState({
          status: "already-marked",
          rp: { id: profile.id, nombre: profile.nombre },
          scannedAt: existingAttendance.scanned_at,
        });
        return;
      }

      const { data: schedule } = await supabase
        .from("rp_schedule")
        .select("id")
        .eq("rp_id", rpId)
        .eq("club_id", clubId)
        .eq("fecha", hoy)
        .maybeSingle();

      if (!schedule) {
        setAttendanceScanState({
          status: "no-turno",
          rp: { id: profile.id, nombre: profile.nombre },
        });
        return;
      }

      await registerAttendance({ id: profile.id, nombre: profile.nombre });
    } catch (err) {
      console.error("Error verificando asistencia:", err);
      setAttendanceScanState({ status: "lookup-error" });
    }
  }

  function openAttendanceScanner() {
    attendanceScanLockRef.current = false;
    setAttendanceScanState({ status: "scanning" });
    setAttendanceScannerOpen(true);
  }

  function closeAttendanceScanner() {
    setAttendanceScannerOpen(false);
  }

  function resumeAttendanceScanning() {
    attendanceScanLockRef.current = false;
    setAttendanceScanState({ status: "scanning" });
    html5QrCodeAttendanceRef.current?.resume();
  }

  async function handleAssignTable(reserva: Reservation) {
    const mesaId = mesaSelections[reserva.id] ?? "";
    setAssignError((prev) => ({ ...prev, [reserva.id]: "" }));

    if (!mesaId) {
      setAssignError((prev) => ({
        ...prev,
        [reserva.id]: "Selecciona una mesa.",
      }));
      return;
    }

    setAssigningId(reserva.id);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("reservations")
        .update({ mesa_id: mesaId })
        .eq("id", reserva.id);

      if (updateError) throw updateError;

      if (clubId) {
        await fetchReservas(clubId);
      }
    } catch (err) {
      console.error("Error asignando mesa:", err);
      setAssignError((prev) => ({
        ...prev,
        [reserva.id]: "No pudimos guardar. Intenta de nuevo.",
      }));
    } finally {
      setAssigningId(null);
    }
  }

  async function fetchConsumptionEntriesForReservation(reservationId: string) {
    try {
      const supabase = createClient();
      const { data, error: entriesError } = await supabase
        .from("consumption_entries")
        .select("*")
        .eq("reservation_id", reservationId)
        .order("created_at", { ascending: true });

      if (entriesError) throw entriesError;

      setConsumptionEntries((prev) => ({
        ...prev,
        [reservationId]: (data ?? []) as ConsumptionEntry[],
      }));
    } catch (err) {
      console.error("Error cargando consumo:", err);
    }
  }

  // Calcula y crea la fila en "commissions" para el PRIMER consumo de una
  // reserva. No se recalcula si se agregan más cargos después — es una
  // simplificación consciente: la comisión queda fija con el consumo
  // registrado al momento del primer cargo.
  async function createCommissionForReservation(
    reserva: Reservation,
    consumoMonto: number,
  ) {
    if (!club) return;
    try {
      const supabase = createClient();

      if (reserva.source === "rp" && reserva.rp_id) {
        const { start, end } = getWeekRange();

        const { data: weekCommissions, error: weekError } = await supabase
          .from("commissions")
          .select("id, reservations!inner(club_id)")
          .eq("rp_id", reserva.rp_id)
          .eq("reservations.club_id", club.id)
          .gte("created_at", start.toISOString())
          .lte("created_at", end.toISOString());

        if (weekError) throw weekError;

        const countEstaSemana = weekCommissions?.length ?? 0;
        const desbloqueado =
          countEstaSemana + 1 >= club.comision_desbloqueo_reservas;

        const montoComision = !desbloqueado
          ? 0
          : club.comision_tipo === "fijo"
            ? club.comision_monto
            : (club.comision_monto / 100) * consumoMonto;

        const { error: insertCommissionError } = await supabase
          .from("commissions")
          .insert({
            reservation_id: reserva.id,
            rp_id: reserva.rp_id,
            tipo: "rp",
            monto: montoComision,
            status: "pendiente",
          });

        if (insertCommissionError) throw insertCommissionError;
      } else if (reserva.source === "organica") {
        const montoBono =
          club.bono_organica_tipo === "fijo"
            ? club.bono_organica_monto
            : (club.bono_organica_monto / 100) * consumoMonto;

        const { error: insertCommissionError } = await supabase
          .from("commissions")
          .insert({
            reservation_id: reserva.id,
            rp_id: null,
            tipo: "plataforma",
            monto: montoBono,
            status: "pendiente",
          });

        if (insertCommissionError) throw insertCommissionError;
      }
    } catch (err) {
      // No bloqueamos la UI del consumo por esto: el consumo ya se guardó
      // exitosamente, la comisión es un efecto secundario. Se loguea para
      // poder diagnosticar si algo falla.
      console.error("Error creando comisión:", err);
    }
  }

  async function handleAddConsumption(reserva: Reservation) {
    const monto = consumptionInputs[reserva.id] ?? "";
    setConsumptionError((prev) => ({ ...prev, [reserva.id]: "" }));

    const montoNum = Number(monto);
    if (!monto || !Number.isFinite(montoNum) || montoNum <= 0) {
      setConsumptionError((prev) => ({
        ...prev,
        [reserva.id]: "Ingresa un monto válido.",
      }));
      return;
    }

    setAddingConsumptionId(reserva.id);
    try {
      const supabase = createClient();

      const { count: existingEntriesCount, error: countError } =
        await supabase
          .from("consumption_entries")
          .select("id", { count: "exact", head: true })
          .eq("reservation_id", reserva.id);

      if (countError) throw countError;

      const isFirstEntry = (existingEntriesCount ?? 0) === 0;

      const { error: insertError } = await supabase
        .from("consumption_entries")
        .insert({ reservation_id: reserva.id, monto: montoNum });

      if (insertError) throw insertError;

      if (isFirstEntry) {
        await createCommissionForReservation(reserva, montoNum);
      }

      setConsumptionInputs((prev) => ({ ...prev, [reserva.id]: "" }));
      await fetchConsumptionEntriesForReservation(reserva.id);
    } catch (err) {
      console.error("Error agregando consumo:", err);
      setConsumptionError((prev) => ({
        ...prev,
        [reserva.id]: "No pudimos agregar el consumo. Intenta de nuevo.",
      }));
    } finally {
      setAddingConsumptionId(null);
    }
  }

  async function handleMarkSinConsumo(reserva: Reservation) {
    setSinConsumoError((prev) => ({ ...prev, [reserva.id]: "" }));
    setMarkingSinConsumoId(reserva.id);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("reservations")
        .update({ se_retiro_sin_consumir: true })
        .eq("id", reserva.id);

      if (updateError) throw updateError;

      if (clubId) {
        await fetchReservas(clubId);
      }
    } catch (err) {
      console.error("Error marcando sin consumo:", err);
      setSinConsumoError((prev) => ({
        ...prev,
        [reserva.id]: "No pudimos guardar. Intenta de nuevo.",
      }));
    } finally {
      setMarkingSinConsumoId(null);
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

  useEffect(() => {
    if (!attendanceScannerOpen) return;

    const html5QrCode = new Html5Qrcode(QR_READER_ATTENDANCE_ELEMENT_ID);
    html5QrCodeAttendanceRef.current = html5QrCode;
    let cancelled = false;

    html5QrCode
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (decodedText) => {
          handleAttendanceDecodedText(decodedText);
        },
        undefined,
      )
      .catch((err) => {
        console.error("Error iniciando la cámara:", err);
        if (!cancelled) {
          setAttendanceScanState({
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
      html5QrCodeAttendanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendanceScannerOpen]);

  if (checkingSession) {
    return null;
  }

  const totalReservas = reservas.length;
  const totalOrganicas = reservas.filter((r) => r.source === "organica").length;
  const totalRp = reservas.filter((r) => r.source === "rp").length;
  const totalPersonas = reservas.reduce((sum, r) => sum + r.personas, 0);
  const totalConsumo = Object.values(consumptionEntries)
    .flat()
    .reduce((sum, entry) => sum + Number(entry.monto), 0);
  const totalSinConsumo = reservas.filter(
    (r) => r.se_retiro_sin_consumir === true,
  ).length;

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

  if (attendanceScannerOpen) {
    return (
      <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Escanear asistencia de RP</CardTitle>
              <CardDescription>
                Apunta la cámara al código QR personal del RP.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6 pb-6">
              {attendanceScanState.status === "scanning" && (
                <div
                  id={QR_READER_ATTENDANCE_ELEMENT_ID}
                  className="w-full overflow-hidden rounded-lg"
                />
              )}

              {attendanceScanState.status === "camera-error" && (
                <p className="text-sm text-destructive" role="alert">
                  {attendanceScanState.message}
                </p>
              )}

              {attendanceScanState.status === "not-found" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Código no válido o no encontrado.
                  </p>
                  <Button type="button" onClick={resumeAttendanceScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {attendanceScanState.status === "wrong-club" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Este RP no pertenece a este antro.
                  </p>
                  <Button type="button" onClick={resumeAttendanceScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {attendanceScanState.status === "no-turno" && (
                <div className="flex flex-col gap-3">
                  <p
                    className="text-sm text-amber-600 dark:text-amber-400"
                    role="alert"
                  >
                    {attendanceScanState.rp.nombre} no tiene turno asignado
                    para hoy.
                  </p>
                  <Button
                    type="button"
                    onClick={() => registerAttendance(attendanceScanState.rp)}
                  >
                    Registrar asistencia de todos modos
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resumeAttendanceScanning}
                  >
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {attendanceScanState.status === "already-marked" && (
                <div className="flex flex-col gap-3">
                  <p
                    className="text-sm text-amber-600 dark:text-amber-400"
                    role="alert"
                  >
                    {attendanceScanState.rp.nombre} ya registró su llegada a
                    las {formatHora(attendanceScanState.scannedAt)}.
                  </p>
                  <Button type="button" onClick={resumeAttendanceScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {attendanceScanState.status === "success" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-green-600 dark:text-green-400">
                    ¡Asistencia registrada! {attendanceScanState.nombre} —{" "}
                    {formatHora(attendanceScanState.scannedAt)}
                  </p>
                  <Button type="button" onClick={resumeAttendanceScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {attendanceScanState.status === "lookup-error" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Ocurrió un error. Intenta de nuevo.
                  </p>
                  <Button type="button" onClick={resumeAttendanceScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                onClick={closeAttendanceScanner}
              >
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

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
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
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              <span className="text-xs text-muted-foreground">
                Consumo total
              </span>
              <span className="text-2xl font-bold">
                ${totalConsumo.toLocaleString("en-US")}
              </span>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              <span className="text-xs text-muted-foreground">
                Sin consumo
              </span>
              <span className="text-2xl font-bold">{totalSinConsumo}</span>
            </CardContent>
          </Card>
        </div>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Mis RPs</h2>
          <Card>
            <CardContent className="flex flex-col gap-4 px-6 py-6">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_nombre">Nombre</Label>
                <Input
                  id="rp_nombre"
                  value={rpNombre}
                  onChange={(e) => setRpNombre(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_email">Email</Label>
                <Input
                  id="rp_email"
                  type="email"
                  value={rpEmail}
                  onChange={(e) => setRpEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_password">Password temporal</Label>
                <Input
                  id="rp_password"
                  type="password"
                  value={rpPassword}
                  onChange={(e) => setRpPassword(e.target.value)}
                />
              </div>

              {rpError && (
                <p className="text-sm text-destructive" role="alert">
                  {rpError}
                </p>
              )}

              <Button
                type="button"
                onClick={handleCreateRP}
                disabled={rpSubmitting}
              >
                {rpSubmitting ? "Creando..." : "Crear RP"}
              </Button>
            </CardContent>
          </Card>

          {loadingRPs && (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          )}
          {!loadingRPs && misRPs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Todavía no tienes RPs registrados.
            </p>
          )}
          {misRPs.length > 0 && (
            <div className="flex flex-col gap-2">
              {misRPs.map((rp) => (
                <Card key={rp.id}>
                  <CardContent className="flex items-center justify-between px-5 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{rp.nombre}</span>
                      <Badge
                        className={
                          rp.activo
                            ? "border-transparent bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
                            : "border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        }
                      >
                        {rp.activo ? "Activo" : "Inactivo"}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggleRPActivo(rp)}
                      disabled={togglingRpId === rp.id}
                    >
                      {togglingRpId === rp.id
                        ? "Guardando..."
                        : rp.activo
                          ? "Dar de baja"
                          : "Reactivar"}
                    </Button>
                  </CardContent>

                  <CardContent className="flex flex-col gap-2 border-t border-border px-5 py-3">
                    <div className="flex items-end gap-2">
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Label htmlFor={`turno-${rp.id}`}>
                          Asignar turno
                        </Label>
                        <Input
                          id={`turno-${rp.id}`}
                          type="date"
                          min={todayISO()}
                          value={scheduleDateInputs[rp.id] ?? ""}
                          onChange={(e) =>
                            setScheduleDateInputs((prev) => ({
                              ...prev,
                              [rp.id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleAddSchedule(rp)}
                        disabled={addingScheduleId === rp.id}
                      >
                        {addingScheduleId === rp.id
                          ? "Guardando..."
                          : "Asignar"}
                      </Button>
                    </div>
                    {scheduleError[rp.id] && (
                      <p className="text-sm text-destructive" role="alert">
                        {scheduleError[rp.id]}
                      </p>
                    )}

                    {(rpSchedules[rp.id] ?? []).length > 0 && (
                      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {(rpSchedules[rp.id] ?? []).map((s) => (
                          <li
                            key={s.id}
                            className="flex items-center justify-between"
                          >
                            <span>{s.fecha}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveSchedule(s.id)}
                              disabled={removingScheduleId === s.id}
                              className="font-medium text-destructive underline underline-offset-2 disabled:opacity-50"
                            >
                              {removingScheduleId === s.id
                                ? "Quitando..."
                                : "Quitar"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Asistencia de RPs</h2>

          <Button
            type="button"
            size="lg"
            className="h-14 w-full text-base"
            onClick={openAttendanceScanner}
          >
            Escanear asistencia de RP
          </Button>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              RPs con turno hoy
            </h3>

            {loadingAsistencia && (
              <p className="text-sm text-muted-foreground">Cargando...</p>
            )}

            {!loadingAsistencia && todaySchedules.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nadie tiene turno asignado para hoy.
              </p>
            )}

            {todaySchedules.map((s) => {
              const rp = misRPs.find((r) => r.id === s.rp_id);
              const attendance = todayAttendance[s.rp_id];
              return (
                <Card key={s.id}>
                  <CardContent className="flex flex-col gap-2 px-5 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {rp?.nombre ?? "RP"}
                      </span>
                      {attendance ? (
                        <Badge className="border-transparent bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300">
                          Llegó a las {formatHora(attendance.scanned_at)} (
                          {attendance.metodo})
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleMarkManual(s.rp_id)}
                          disabled={markingManualId === s.rp_id}
                        >
                          {markingManualId === s.rp_id
                            ? "Guardando..."
                            : "Marcar llegada manual"}
                        </Button>
                      )}
                    </div>
                    {manualError[s.rp_id] && (
                      <p className="text-sm text-destructive" role="alert">
                        {manualError[s.rp_id]}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

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

              {r.status === "usada" && !r.mesa_id && (
                <CardContent className="flex flex-col gap-3 border-t border-border px-6 py-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`mesa-${r.id}`}>Mesa</Label>
                    <select
                      id={`mesa-${r.id}`}
                      className={SELECT_CLASSES}
                      value={mesaSelections[r.id] ?? ""}
                      onChange={(e) =>
                        setMesaSelections((prev) => ({
                          ...prev,
                          [r.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="" disabled>
                        Selecciona una mesa
                      </option>
                      {tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          Mesa {t.numero} (cap. {t.capacidad})
                        </option>
                      ))}
                    </select>
                  </div>
                  {assignError[r.id] && (
                    <p className="text-sm text-destructive" role="alert">
                      {assignError[r.id]}
                    </p>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleAssignTable(r)}
                    disabled={assigningId === r.id}
                  >
                    {assigningId === r.id ? "Guardando..." : "Asignar mesa"}
                  </Button>
                </CardContent>
              )}

              {r.mesa_id && r.se_retiro_sin_consumir === true && (
                <CardContent className="flex flex-col gap-2 border-t border-border px-6 py-4">
                  <p className="text-sm text-muted-foreground">
                    Mesa: {tables.find((t) => t.id === r.mesa_id)?.numero ?? "—"}
                  </p>
                  <Badge className="w-fit border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    Se retiró sin consumir
                  </Badge>
                </CardContent>
              )}

              {r.mesa_id && r.se_retiro_sin_consumir !== true && (
                <CardContent className="flex flex-col gap-3 border-t border-border px-6 py-4">
                  <p className="text-sm text-muted-foreground">
                    Mesa: {tables.find((t) => t.id === r.mesa_id)?.numero ?? "—"}
                  </p>

                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      Consumo total: $
                      {(consumptionEntries[r.id] ?? []).reduce(
                        (sum, e) => sum + Number(e.monto),
                        0,
                      )}
                    </span>
                  </div>

                  {(consumptionEntries[r.id] ?? []).length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {(consumptionEntries[r.id] ?? []).map((entry) => (
                        <li key={entry.id}>
                          {formatHora(entry.created_at)} — ${entry.monto}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex items-end gap-2">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor={`consumo-${r.id}`}>
                        Agregar consumo ($)
                      </Label>
                      <Input
                        id={`consumo-${r.id}`}
                        type="number"
                        min={0}
                        value={consumptionInputs[r.id] ?? ""}
                        onChange={(e) =>
                          setConsumptionInputs((prev) => ({
                            ...prev,
                            [r.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleAddConsumption(r)}
                      disabled={addingConsumptionId === r.id}
                    >
                      {addingConsumptionId === r.id
                        ? "Agregando..."
                        : "+ Agregar consumo"}
                    </Button>
                  </div>
                  {consumptionError[r.id] && (
                    <p className="text-sm text-destructive" role="alert">
                      {consumptionError[r.id]}
                    </p>
                  )}

                  {(consumptionEntries[r.id] ?? []).length === 0 && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleMarkSinConsumo(r)}
                        disabled={markingSinConsumoId === r.id}
                      >
                        {markingSinConsumoId === r.id
                          ? "Guardando..."
                          : "Cliente se retiró sin consumir"}
                      </Button>
                      {sinConsumoError[r.id] && (
                        <p className="text-sm text-destructive" role="alert">
                          {sinConsumoError[r.id]}
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
