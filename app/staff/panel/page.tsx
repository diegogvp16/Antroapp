"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
// La librería del escáner (con ZXing, ~365 KB) se carga al abrir la cámara, no con el panel.
import type { Html5Qrcode } from "html5-qrcode";
import { BotonLinterna } from "@/components/boton-linterna";
import { createClient } from "@/lib/supabase/client";
import { cerrarSesionDadoDeBaja } from "@/lib/cuenta-dada-de-baja";
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
import { ReglasPagoRP } from "@/components/reglas-pago-rp";
import { TurnoRecurrenteForm } from "@/components/turno-recurrente-form";
import {
  describirTurno,
  esTurnoFijo,
  turnoAplicaEnFecha,
  type TurnoRow,
} from "@/lib/turnos";
import { nocheOperativaMexico, semanaMexico } from "@/lib/fechas";
import { ordenarMesas } from "@/lib/mesas";
import { FASE2_ACTIVA } from "@/lib/fase2";
import { AvisoExistencias } from "@/components/inventario/aviso-existencias";
import { esErrorDeRed, mensajeParaUsuario, MENSAJE_SIN_CONEXION, type ErrorBase } from "@/lib/errores-base";
import type { Club, ClubTable, Profile, Reservation } from "@/types";

type RPListItem = Pick<Profile, "id" | "nombre" | "activo">;

type ReservaPanel = Reservation;

// Lo que devuelve puerta_escanear: lo que la puerta necesita ver, sin
// teléfono ni consumo.
interface FichaPuerta {
  reservation_id: string;
  cliente_nombre: string;
  personas: number;
  source: Reservation["source"];
  rp_nombre: string | null;
}

function leerFichaPuerta(data: unknown): FichaPuerta | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.reservation_id !== "string" ||
    typeof d.cliente_nombre !== "string" ||
    typeof d.personas !== "number"
  ) {
    return null;
  }
  return {
    reservation_id: d.reservation_id,
    cliente_nombre: d.cliente_nombre,
    personas: d.personas,
    source: d.source === "rp" ? "rp" : "organica",
    rp_nombre: typeof d.rp_nombre === "string" ? d.rp_nombre : null,
  };
}

// Errores de la base: solo los avisos de las funciones (raise exception,
// P0001, en español) se muestran tal cual; lo demás (permisos, JWT, red)
// sale en un mensaje claro sin nombres internos (lib/errores-base.ts).
// PostgrestError no es instancia de Error: se reconoce por su campo code.
function mensajeDeError(err: unknown, porDefecto: string): string {
  if (typeof err === "object" && err !== null && "code" in err) return mensajeParaUsuario(err as ErrorBase, porDefecto);
  if (esErrorDeRed(err)) return MENSAJE_SIN_CONEXION;
  console.error("Error en el panel:", err);
  return porDefecto;
}

const AVISO_PAGO_DIA = "Asistencia guardada, pero no se generó el pago del día. Avisa al gerente para que lo revise.";

function textoPersonas(n: number): string {
  return `${n} ${n === 1 ? "persona" : "personas"}`;
}

type ScheduleRow = TurnoRow;

interface AttendanceRow {
  id: string;
  scanned_at: string;
  metodo: string;
}

const QR_READER_ELEMENT_ID = "qr-reader";
const QR_READER_ATTENDANCE_ELEMENT_ID = "qr-reader-attendance";

const RUTA_CAJA = "/staff/caja";

function formatHora(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

type ScanState =
  | { status: "scanning" }
  | { status: "camera-error"; message: string }
  // Error de puerta_escanear, tal cual lo manda la base ("Reserva no
  // encontrada en tu antro", "Esta reserva ya entró", ...).
  | { status: "error"; message: string }
  | { status: "ready"; ficha: FichaPuerta; error?: string }
  | { status: "success"; ficha: FichaPuerta };

type AttendanceScanState =
  | { status: "scanning" }
  | { status: "camera-error"; message: string }
  | { status: "not-found" }
  | { status: "wrong-club" }
  | { status: "no-turno"; rp: { id: string; nombre: string } }
  | { status: "already-marked"; rp: { id: string; nombre: string }; scannedAt: string }
  | { status: "success"; nombre: string; scannedAt: string; avisoPago: string | null }
  | { status: "lookup-error" };

const STATUS_LABEL: Record<Reservation["status"], string> = {
  pendiente: "Pendiente",
  confirmada: "Confirmada",
  usada: "Usada",
};

const STATUS_CLASSES: Record<Reservation["status"], string> = {
  pendiente:
    "border-transparent bg-status-warn/12 text-status-warn",
  confirmada:
    "border-transparent bg-muted text-foreground",
  usada:
    "border-transparent bg-status-ok/12 text-status-ok",
};

const SOURCE_CLASSES: Record<Reservation["source"], string> = {
  organica:
    "border-transparent bg-muted text-muted-foreground",
  rp: "border-border bg-transparent text-foreground",
};

export default function StaffPanelPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [clubId, setClubId] = useState<string | null>(null);
  const [staffRole, setStaffRole] = useState<"staff" | "gerente" | null>(
    null,
  );
  const [clubNombre, setClubNombre] = useState("");
  const [club, setClub] = useState<Club | null>(null);

  const [reservas, setReservas] = useState<ReservaPanel[]>([]);
  const [rpNombres, setRpNombres] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanState, setScanState] = useState<ScanState>({ status: "scanning" });
  const [checkingIn, setCheckingIn] = useState(false);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const [camaraLista, setCamaraLista] = useState(false);
  const scanLockRef = useRef(false);

  // Solo para mostrar el número de la mesa donde la caja sentó a alguien.
  const [tables, setTables] = useState<ClubTable[]>([]);

  // Confirmar entrada sin cámara (si la cámara falla): mismas funciones de
  // la base que el escáner.
  const [entradaManualId, setEntradaManualId] = useState<string | null>(null);
  const [entradaManualError, setEntradaManualError] = useState<
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
  const [toggleError, setToggleError] = useState<Record<string, string>>({});
  const [quitarTurnoError, setQuitarTurnoError] = useState<{ id: string; mensaje: string } | null>(null);

  const [rpSchedules, setRpSchedules] = useState<Record<string, ScheduleRow[]>>(
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
  const [camaraAsistenciaLista, setCamaraAsistenciaLista] = useState(false);
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
        .select("role, club_id, activo")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.activo === false) {
        await cerrarSesionDadoDeBaja(supabase, router);
        return;
      }

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
      setStaffRole(profile.role as "staff" | "gerente");
      setCheckingSession(false);
    }

    loadSession();
  }, [router]);

  const fetchReservas = useCallback(async (targetClubId: string) => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      // Noche operativa (corte 08:00): después de medianoche se siguen
      // viendo las reservas de la noche en curso, igual que en la puerta.
      const noche = nocheOperativaMexico();

      const { data, error: queryError } = await supabase
        .from("reservations")
        .select("*")
        .eq("fecha", noche)
        .eq("club_id", targetClubId)
        .order("created_at", { ascending: false });

      if (queryError) {
        throw queryError;
      }

      const rows = (data ?? []) as ReservaPanel[];
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
        setTables(ordenarMesas((data ?? []) as ClubTable[]));
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
      const hoy = nocheOperativaMexico();
      // Se traen los turnos fijos (valen indefinidamente, su `fecha` puede
      // ser vieja) junto con las fechas sueltas de hoy en adelante.
      const { data, error } = await supabase
        .from("rp_schedule")
        .select("id, rp_id, fecha, es_fijo, dias_semana, fecha_inicio")
        .eq("club_id", targetClubId)
        .or(`es_fijo.eq.true,fecha.gte.${hoy}`)
        .order("fecha", { ascending: true });

      if (error) throw error;

      const filas = (data ?? []) as (ScheduleRow & { rp_id: string })[];

      const grouped: Record<string, ScheduleRow[]> = {};
      for (const row of filas) {
        const list = grouped[row.rp_id] ?? [];
        list.push({
          id: row.id,
          fecha: row.fecha,
          es_fijo: row.es_fijo,
          dias_semana: row.dias_semana,
          fecha_inicio: row.fecha_inicio,
        });
        grouped[row.rp_id] = list;
      }
      setRpSchedules(grouped);
      setTodaySchedules(
        filas
          .filter((row) => turnoAplicaEnFecha(row, hoy))
          .map((row) => ({ id: row.id, rp_id: row.rp_id, fecha: hoy })),
      );
    } catch (err) {
      console.error("Error cargando turnos de RPs:", err);
    }
  }

  async function fetchAsistenciaHoy(targetClubId: string) {
    setLoadingAsistencia(true);
    try {
      const supabase = createClient();
      const hoy = nocheOperativaMexico();
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
      setQuitarTurnoError(null);
      await fetchRpSchedules(clubId);
    } catch (err) {
      setQuitarTurnoError({ id: scheduleId, mensaje: mensajeDeError(err, "No pudimos quitar el turno. Intenta de nuevo.") });
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
      const fecha = nocheOperativaMexico();

      const { data: attendanceRow, error } = await supabase
        .from("rp_attendance")
        .insert({
          rp_id: rpId,
          club_id: clubId,
          fecha,
          scanned_at: new Date().toISOString(),
          metodo: "manual",
          marcado_por: user?.id ?? null,
        })
        .select("id")
        .single();

      if (error) throw error;

      if (club?.pago_rp_modo === "dia" && !(await createPagoDiaParaAsistencia(attendanceRow.id, rpId, clubId, fecha))) {
        setManualError((prev) => ({ ...prev, [rpId]: AVISO_PAGO_DIA }));
      }

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
      // Los textos del servidor ya vienen en español (create-staff); si falló
      // la red, el de "sin conexión".
      setRpError(
        esErrorDeRed(err) ? MENSAJE_SIN_CONEXION : err instanceof Error ? err.message : "No pudimos crear la cuenta.",
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
      setToggleError((prev) => ({ ...prev, [rp.id]: "" }));
      await fetchMisRPs(clubId);
    } catch (err) {
      setToggleError((prev) => ({
        ...prev,
        [rp.id]: mensajeDeError(err, rp.activo ? "No pudimos dar de baja al RP. Intenta de nuevo." : "No pudimos reactivar al RP. Intenta de nuevo."),
      }));
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
      // La base valida que el QR sea de este antro y de la noche operativa
      // en curso, y lo marca "en puerta". No se lee la tabla directo.
      const supabase = createClient();
      const { data, error: escanearError } = await supabase.rpc(
        "puerta_escanear",
        { p_qr: decodedText.trim() },
      );

      if (escanearError) {
        setScanState({ status: "error", message: mensajeDeError(escanearError, "No pudimos leer el código. Intenta de nuevo.") });
        return;
      }

      const ficha = leerFichaPuerta(data);
      if (!ficha) {
        setScanState({
          status: "error",
          message: "No pudimos leer la reserva. Intenta de nuevo.",
        });
        return;
      }

      setScanState({ status: "ready", ficha });
    } catch (err) {
      console.error("Error escaneando reserva:", err);
      setScanState({
        status: "error",
        message: "Ocurrió un error. Intenta de nuevo.",
      });
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

  // "Confirmar entrada": único camino al check-in (status = 'usada'). Si el
  // antro no deja pasar a alguien, simplemente no se llama.
  async function handleConfirmarEntrada(ficha: FichaPuerta) {
    setCheckingIn(true);
    try {
      const supabase = createClient();
      const { error: confirmarError } = await supabase.rpc(
        "puerta_confirmar_entrada",
        { p_reservation_id: ficha.reservation_id },
      );

      if (confirmarError) {
        setScanState({ status: "ready", ficha, error: mensajeDeError(confirmarError, "No pudimos confirmar la entrada. Intenta de nuevo.") });
        return;
      }

      setScanState({ status: "success", ficha });
      if (clubId) {
        await fetchReservas(clubId);
      }
    } catch (err) {
      console.error("Error confirmando entrada:", err);
      setScanState({
        status: "ready",
        ficha,
        error: "Ocurrió un error. Intenta de nuevo.",
      });
    } finally {
      setCheckingIn(false);
    }
  }

  // Crea la fila en "rp_pagos_dia" para UNA asistencia ya insertada,
  // vía RPC "security definer": el cálculo vive en la base (no aquí)
  // porque STAFF puede registrar
  // asistencia sin tener permiso de leer club_dia_tarifas (son datos de
  // sueldo); si se calculara con el cliente de STAFF, RLS le devolvería
  // 0 tarifas y el monto quedaría siempre en $0. La función en la base
  // aplica la misma regla de autorización que ya tiene la política de
  // INSERT de rp_pagos_dia, solo que además puede leer las tarifas.
  async function createPagoDiaParaAsistencia(
    rpAttendanceId: string,
    rpId: string,
    targetClubId: string,
    fecha: string,
  ): Promise<boolean> {
    try {
      const supabase = createClient();
      const { inicio, fin } = semanaMexico();

      const { error } = await supabase.rpc("registrar_pago_dia", {
        p_rp_attendance_id: rpAttendanceId,
        p_rp_id: rpId,
        p_club_id: targetClubId,
        p_fecha: fecha,
        p_week_start: inicio.toISOString(),
        p_week_end: fin.toISOString(),
      });

      if (error) throw error;
      return true;
    } catch (err) {
      // La asistencia ya quedó; el pago del día no. Quien llama avisa en
      // pantalla para que el gerente lo revise (no se pierde en silencio).
      console.error("Error creando pago por día:", err);
      return false;
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
      const fecha = nocheOperativaMexico();

      const { data: attendanceRow, error } = await supabase
        .from("rp_attendance")
        .insert({
          rp_id: rp.id,
          club_id: clubId,
          fecha,
          scanned_at: nowIso,
          metodo: "qr",
          marcado_por: user?.id ?? null,
        })
        .select("id")
        .single();

      if (error) throw error;

      const pagoOk =
        club?.pago_rp_modo !== "dia" || (await createPagoDiaParaAsistencia(attendanceRow.id, rp.id, clubId, fecha));

      setAttendanceScanState({ status: "success", nombre: rp.nombre, scannedAt: nowIso, avisoPago: pagoOk ? null : AVISO_PAGO_DIA });
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

      const hoy = nocheOperativaMexico();
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

      // Tiene turno hoy si hay una fecha suelta de hoy o un turno fijo que
      // cubra el día de la semana de hoy.
      const { data: schedules } = await supabase
        .from("rp_schedule")
        .select("id, fecha, es_fijo, dias_semana, fecha_inicio")
        .eq("rp_id", rpId)
        .eq("club_id", clubId)
        .or(`es_fijo.eq.true,fecha.eq.${hoy}`);

      const schedule = (schedules ?? []).find((s) =>
        turnoAplicaEnFecha(s as ScheduleRow, hoy),
      );

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

  // Solo marca la reserva; los consumos viven en la caja. La base solo lo
  // permite para quien entró (trigger reservations_candado_puerta).
  // Sin cámara: escanea por el QR de la reserva y confirma la entrada. La
  // base valida antro y noche igual que con el escáner.
  async function handleEntradaManual(reserva: ReservaPanel) {
    setEntradaManualId(reserva.id);
    setEntradaManualError((prev) => ({ ...prev, [reserva.id]: "" }));
    try {
      const supabase = createClient();
      const { error: escanearError } = await supabase.rpc("puerta_escanear", {
        p_qr: reserva.qr_code,
      });
      // Si ya estaba "en puerta", escanear de nuevo no falla; si ya entró, sí.
      if (escanearError) throw escanearError;
      const { error: confirmarError } = await supabase.rpc(
        "puerta_confirmar_entrada",
        { p_reservation_id: reserva.id },
      );
      if (confirmarError) throw confirmarError;
      if (clubId) await fetchReservas(clubId);
    } catch (err) {
      setEntradaManualError((prev) => ({
        ...prev,
        [reserva.id]: mensajeDeError(err, "No pudimos confirmar la entrada."),
      }));
    } finally {
      setEntradaManualId(null);
    }
  }

  async function handleMarkSinConsumo(reserva: ReservaPanel) {
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
        [reserva.id]: mensajeDeError(
          err,
          "No pudimos guardar. Intenta de nuevo.",
        ),
      }));
    } finally {
      setMarkingSinConsumoId(null);
    }
  }

  useEffect(() => {
    if (!scannerOpen) return;

    let cancelled = false;
    let lector: Html5Qrcode | null = null;

    void import("html5-qrcode")
      .then(({ Html5Qrcode: Lector }) => {
        if (cancelled) return;
        const html5QrCode = new Lector(QR_READER_ELEMENT_ID);
        lector = html5QrCode;
        html5QrCodeRef.current = html5QrCode;
        return html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 250 },
          (decodedText) => {
            handleDecodedText(decodedText);
          },
          undefined,
        );
      })
      .then(() => {
        if (!cancelled && lector) setCamaraLista(true);
      })
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
      const activo = lector;
      if (activo) {
        activo
          .stop()
          .then(() => activo.clear())
          .catch(() => {});
      }
      html5QrCodeRef.current = null;
      setCamaraLista(false);
    };
  }, [scannerOpen]);

  useEffect(() => {
    if (!attendanceScannerOpen) return;

    let cancelled = false;
    let lector: Html5Qrcode | null = null;

    void import("html5-qrcode")
      .then(({ Html5Qrcode: Lector }) => {
        if (cancelled) return;
        const html5QrCode = new Lector(QR_READER_ATTENDANCE_ELEMENT_ID);
        lector = html5QrCode;
        html5QrCodeAttendanceRef.current = html5QrCode;
        return html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 250 },
          (decodedText) => {
            handleAttendanceDecodedText(decodedText);
          },
          undefined,
        );
      })
      .then(() => {
        if (!cancelled && lector) setCamaraAsistenciaLista(true);
      })
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
      const activo = lector;
      if (activo) {
        activo
          .stop()
          .then(() => activo.clear())
          .catch(() => {});
      }
      html5QrCodeAttendanceRef.current = null;
      setCamaraAsistenciaLista(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendanceScannerOpen]);

  if (checkingSession) {
    return <p className="p-6 text-sm text-muted-foreground">Cargando…</p>;
  }

  const totalReservas = reservas.length;
  const totalOrganicas = reservas.filter((r) => r.source === "organica").length;
  const totalRp = reservas.filter((r) => r.source === "rp").length;
  const totalPersonas = reservas.reduce((sum, r) => sum + r.personas, 0);
  const totalEntraron = reservas.filter((r) => r.status === "usada").length;
  const totalSinConsumo = reservas.filter(
    (r) => r.se_retiro_sin_consumir === true,
  ).length;

  if (scannerOpen) {
    return (
      <div className="flex flex-1 flex-col items-center px-6 py-10">
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
                <>
                  <div
                    id={QR_READER_ELEMENT_ID}
                    className="w-full overflow-hidden rounded-lg"
                  />
                  <BotonLinterna escaner={html5QrCodeRef} listo={camaraLista} />
                </>
              )}

              {scanState.status === "camera-error" && (
                <p className="text-sm text-destructive" role="alert">
                  {scanState.message}
                </p>
              )}

              {scanState.status === "error" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    {scanState.message}
                  </p>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {scanState.status === "ready" && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1 text-sm">
                    <p className="break-words text-base font-medium">
                      {scanState.ficha.cliente_nombre}
                    </p>
                    <p className="text-muted-foreground">
                      {textoPersonas(scanState.ficha.personas)}
                    </p>
                    <p className="break-words text-muted-foreground">
                      {scanState.ficha.source === "rp"
                        ? `RP: ${scanState.ficha.rp_nombre ?? "—"}`
                        : "Orgánica"}
                    </p>
                  </div>
                  {scanState.error && (
                    <p className="text-sm text-destructive" role="alert">
                      {scanState.error}
                    </p>
                  )}
                  <Button
                    type="button"
                    size="lg"
                    className="h-12 w-full text-base"
                    onClick={() => handleConfirmarEntrada(scanState.ficha)}
                    disabled={checkingIn}
                  >
                    {checkingIn ? "Confirmando..." : "Confirmar entrada"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resumeScanning}
                    disabled={checkingIn}
                  >
                    Escanear siguiente
                  </Button>
                </div>
              )}

              {scanState.status === "success" && (
                <div className="flex flex-col gap-3">
                  <p className="break-words text-sm text-status-ok">
                    ¡Entrada confirmada! {scanState.ficha.cliente_nombre} ·{" "}
                    {textoPersonas(scanState.ficha.personas)}
                  </p>
                  <Button type="button" onClick={resumeScanning}>
                    Escanear siguiente
                  </Button>
                  <Button
                    render={<Link href={RUTA_CAJA} />}
                    nativeButton={false}
                    variant="outline"
                  >
                    Sentar en mesa
                  </Button>
                </div>
              )}

              <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                El QR no garantiza la entrada.
              </p>

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
      <div className="flex flex-1 flex-col items-center px-6 py-10">
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
                <>
                  <div
                    id={QR_READER_ATTENDANCE_ELEMENT_ID}
                    className="w-full overflow-hidden rounded-lg"
                  />
                  <BotonLinterna escaner={html5QrCodeAttendanceRef} listo={camaraAsistenciaLista} />
                </>
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
                    className="text-sm text-status-warn"
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
                    className="text-sm text-status-warn"
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
                  <p className="text-sm text-status-ok">
                    ¡Asistencia registrada! {attendanceScanState.nombre} —{" "}
                    {formatHora(attendanceScanState.scannedAt)}
                  </p>
                  {attendanceScanState.avisoPago && (
                    <p className="text-sm text-status-warn" role="alert">
                      {attendanceScanState.avisoPago}
                    </p>
                  )}
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
    <div className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight">
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

        <Button
          render={<Link href={RUTA_CAJA} />}
          nativeButton={false}
          variant="outline"
          size="lg"
          className="h-12 w-full text-base"
        >
          Caja y mesas de la noche
        </Button>

        {/* Solo el gerente: el staff no ve sueldos ni consumos del antro. */}
        {staffRole === "gerente" && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Button
              render={<Link href="/staff/equipo" />}
              nativeButton={false}
              variant="outline"
              className="w-full"
            >
              Equipo e invitaciones
            </Button>
            <Button
              render={<Link href="/staff/nomina" />}
              nativeButton={false}
              variant="outline"
              className="w-full"
            >
              Nómina
            </Button>
            <Button
              render={<Link href="/grupo" />}
              nativeButton={false}
              variant="outline"
              className="w-full"
            >
              Resumen de mi antro
            </Button>
            <Button
              render={<Link href="/staff/exportar" />}
              nativeButton={false}
              variant="outline"
              className="w-full"
            >
              Descargar reportes
            </Button>
            {FASE2_ACTIVA && (
              <Button
                render={<Link href="/staff/catalogo" />}
                nativeButton={false}
                variant="outline"
                className="w-full"
              >
                Catálogo e inventario
              </Button>
            )}
          </div>
        )}
        {staffRole === "gerente" && clubId && <AvisoExistencias clubId={clubId} />}

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
              <span className="text-xs text-muted-foreground">Entraron</span>
              <span className="text-2xl font-bold">{totalEntraron}</span>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex flex-col gap-1 px-4">
              {/* Solo cuenta a quien el staff marcó "se retiró sin consumir";
                  el consumo real de cada mesa está en la caja. */}
              <span className="text-xs text-muted-foreground">
                Se fueron sin consumir
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
                  // Es la cuenta de OTRA persona: que el navegador no ponga
                  // el correo ni la contraseña de quien está creando el RP.
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={rpEmail}
                  onChange={(e) => setRpEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_password">Password temporal</Label>
                <Input
                  id="rp_password"
                  type="password"
                  autoComplete="new-password"
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
                            ? "border-transparent bg-status-ok/12 text-status-ok"
                            : "border-transparent bg-muted text-muted-foreground"
                        }
                      >
                        {rp.activo ? "Activo" : "Inactivo"}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11"
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
                  {toggleError[rp.id] && (
                    <p className="px-5 pb-3 text-sm text-destructive" role="alert">
                      {toggleError[rp.id]}
                    </p>
                  )}

                  <CardContent className="flex flex-col gap-2 border-t border-border px-5 py-3">
                    {clubId && (
                      <TurnoRecurrenteForm
                        rpId={rp.id}
                        clubId={clubId}
                        existingFechas={(rpSchedules[rp.id] ?? [])
                          .filter((s) => !esTurnoFijo(s))
                          .map((s) => s.fecha)}
                        tieneTurnoFijo={(rpSchedules[rp.id] ?? []).some(
                          esTurnoFijo,
                        )}
                        onAssigned={() => fetchRpSchedules(clubId)}
                      />
                    )}

                    {(rpSchedules[rp.id] ?? []).length > 0 && (
                      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {/* El turno fijo primero: es la regla, no un día suelto. */}
                        {[...(rpSchedules[rp.id] ?? [])]
                          .sort(
                            (a, b) =>
                              Number(esTurnoFijo(b)) - Number(esTurnoFijo(a)),
                          )
                          .map((s) => (
                          <li
                            key={s.id}
                            className="flex flex-wrap items-center justify-between"
                          >
                            <span
                              className={
                                esTurnoFijo(s)
                                  ? "font-medium text-foreground"
                                  : undefined
                              }
                            >
                              {describirTurno(s)}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveSchedule(s.id)}
                              disabled={removingScheduleId === s.id}
                              className="-mr-2 inline-flex h-11 items-center px-2 font-medium text-destructive underline underline-offset-2 disabled:opacity-50"
                            >
                              {removingScheduleId === s.id
                                ? "Quitando..."
                                : "Quitar"}
                            </button>
                            {quitarTurnoError?.id === s.id && (
                              <span className="basis-full text-destructive" role="alert">
                                {quitarTurnoError.mensaje}
                              </span>
                            )}
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

        {staffRole === "gerente" && club && (
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Reglas de pago de RPs</h2>
            <p className="text-xs text-muted-foreground">
              Solo gerentes pueden ver y editar cómo se les paga a los RPs de
              este antro. Staff no tiene acceso a esta sección.
            </p>
            <ReglasPagoRP
              club={club}
              onUpdate={async () => {
                if (clubId) {
                  const supabase = createClient();
                  const { data } = await supabase
                    .from("clubs")
                    .select("*")
                    .eq("id", clubId)
                    .maybeSingle();
                  if (data) setClub(data as Club);
                }
              }}
            />
          </section>
        )}

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
                        <Badge className="border-transparent bg-status-ok/12 text-status-ok">
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
                  <div className="min-w-0">
                    <CardTitle className="break-words">
                      {r.cliente_nombre}
                    </CardTitle>
                    <CardDescription>{r.cliente_telefono}</CardDescription>
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                    <Badge className={STATUS_CLASSES[r.status]}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                    {/* Escaneada pero sin "Confirmar entrada" todavía. */}
                    {r.status !== "usada" && r.puerta_estado === "en_puerta" && (
                      <Badge className="border-transparent bg-status-warn/12 text-status-warn">
                        En puerta
                      </Badge>
                    )}
                    <Badge className={SOURCE_CLASSES[r.source]}>
                      {r.source === "rp" ? "Vía RP" : "Orgánica"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 text-sm text-muted-foreground">
                <span>{textoPersonas(r.personas)}</span>
                {r.source === "rp" && (
                  <span>
                    RP: {r.rp_id && rpNombres[r.rp_id] ? rpNombres[r.rp_id] : "—"}
                  </span>
                )}
              </CardContent>

              {/* Sin entrada todavía: confirmar a mano si la cámara falla.
                  El QR no garantiza la entrada: si no pasa, no se confirma. */}
              {r.status !== "usada" && (
                <CardContent className="flex flex-col gap-2 border-t border-border px-6 py-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => handleEntradaManual(r)}
                    disabled={entradaManualId === r.id}
                  >
                    {entradaManualId === r.id
                      ? "Confirmando..."
                      : "Confirmar entrada sin cámara"}
                  </Button>
                  {entradaManualError[r.id] && (
                    <p className="text-sm text-destructive" role="alert">
                      {entradaManualError[r.id]}
                    </p>
                  )}
                </CardContent>
              )}

              {/* Con entrada confirmada: la mesa y el consumo se llevan en la
                  caja. Aquí solo se manda a sentar o se marca que se fue. */}
              {r.status === "usada" && (
                <CardContent className="flex flex-col gap-3 border-t border-border px-6 py-4">
                  {r.mesa_id && (
                    <p className="text-sm text-muted-foreground">
                      Mesa: {tables.find((t) => t.id === r.mesa_id)?.numero ?? "—"}
                    </p>
                  )}

                  {r.se_retiro_sin_consumir === true ? (
                    <Badge className="w-fit border-transparent bg-muted text-muted-foreground">
                      Se retiró sin consumir
                    </Badge>
                  ) : (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button
                        render={<Link href={RUTA_CAJA} />}
                        nativeButton={false}
                        size="sm"
                        className="w-full sm:w-auto"
                      >
                        {r.mesa_id ? "Ver en caja" : "Sentar en mesa"}
                      </Button>
                      {!r.mesa_id && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() => handleMarkSinConsumo(r)}
                          disabled={markingSinConsumoId === r.id}
                        >
                          {markingSinConsumoId === r.id
                            ? "Guardando..."
                            : "Cliente se retiró sin consumir"}
                        </Button>
                      )}
                    </div>
                  )}

                  {sinConsumoError[r.id] && (
                    <p className="text-sm text-destructive" role="alert">
                      {sinConsumoError[r.id]}
                    </p>
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
