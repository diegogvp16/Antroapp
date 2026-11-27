"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { textoCover } from "@/lib/cover";
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
import { VerificacionesPendientes } from "@/components/verificaciones-pendientes";
import { ErroresRecientes } from "@/components/errores-recientes";
import { mensualidadActiva } from "@/lib/mensualidad/bandera";
import type { Club } from "@/types";
import { EnlaceRevisionRps } from "@/components/fraude/enlace-revision-rps";

interface ConsumoBucket {
  rpTotal: number;
  rpConConsumo: number;
  organicaTotal: number;
  organicaConConsumo: number;
}

const DIFERENCIA_ALERTA = 30;

interface DashboardData {
  totalReservas30d: number;
  organica30d: number;
  rp30d: number;
  ranking: [string, number][];
  totalConsumo30d: number;
  reservasConConsumo: number;
  ticketPromedio: number;
  comisionesPorTipo: Record<string, Record<string, number>>;
}

const DASHBOARD_INICIAL: DashboardData = {
  totalReservas30d: 0,
  organica30d: 0,
  rp30d: 0,
  ranking: [],
  totalConsumo30d: 0,
  reservasConConsumo: 0,
  ticketPromedio: 0,
  comisionesPorTipo: {},
};

const TIPO_COMISION_LABEL: Record<string, string> = {
  rp: "RP",
  plataforma: "Plataforma",
};

const STATUS_COMISION_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  validada: "Validada",
  pagada: "Pagada",
};

const SELECT_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

interface CreatedStaff {
  id: string;
  nombre: string;
  role: "staff" | "gerente";
  club_id: string;
}

export default function AdminPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [loadingClubs, setLoadingClubs] = useState(true);

  const [staffNombre, setStaffNombre] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [staffRole, setStaffRole] = useState<"staff" | "gerente">("staff");
  const [staffClubId, setStaffClubId] = useState("");
  const [staffSubmitting, setStaffSubmitting] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [createdStaff, setCreatedStaff] = useState<CreatedStaff[]>([]);

  const [alertasData, setAlertasData] = useState<Record<string, ConsumoBucket>>(
    {},
  );
  const [loadingAlertas, setLoadingAlertas] = useState(true);

  const [dashboard, setDashboard] = useState<DashboardData>(DASHBOARD_INICIAL);
  const [loadingDashboard, setLoadingDashboard] = useState(true);

  useEffect(() => {
    async function loadSession() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/admin/login");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError || !profile || profile.role !== "admin") {
        router.replace("/admin/login");
        return;
      }

      setCheckingSession(false);
    }

    loadSession();
  }, [router]);

  async function fetchClubs() {
    setLoadingClubs(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from("clubs").select("*");
      if (error) throw error;
      setClubs((data ?? []) as Club[]);
    } catch (err) {
      console.error("Error cargando clubs:", err);
    } finally {
      setLoadingClubs(false);
    }
  }

  async function fetchAlertas() {
    setLoadingAlertas(true);
    try {
      const supabase = createClient();
      const desde = new Date();
      desde.setDate(desde.getDate() - 30);
      const desdeISO = desde.toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from("reservations")
        .select("club_id, source, consumption_entries(id)")
        .eq("status", "usada")
        .gte("fecha", desdeISO);

      if (error) throw error;

      type Row = {
        club_id: string | null;
        source: "organica" | "rp";
        consumption_entries: { id: string }[] | null;
      };

      const grouped: Record<string, ConsumoBucket> = {};

      for (const row of (data ?? []) as Row[]) {
        if (!row.club_id) continue;
        const bucket = grouped[row.club_id] ?? {
          rpTotal: 0,
          rpConConsumo: 0,
          organicaTotal: 0,
          organicaConConsumo: 0,
        };
        const tieneConsumo = (row.consumption_entries ?? []).length > 0;

        if (row.source === "rp") {
          bucket.rpTotal += 1;
          if (tieneConsumo) bucket.rpConConsumo += 1;
        } else {
          bucket.organicaTotal += 1;
          if (tieneConsumo) bucket.organicaConConsumo += 1;
        }
        grouped[row.club_id] = bucket;
      }

      setAlertasData(grouped);
    } catch (err) {
      console.error("Error cargando alertas de reporte:", err);
    } finally {
      setLoadingAlertas(false);
    }
  }

  async function fetchDashboard() {
    setLoadingDashboard(true);
    try {
      const supabase = createClient();
      const desde = new Date();
      desde.setDate(desde.getDate() - 30);
      const desdeFecha = desde.toISOString().slice(0, 10);
      const desdeTimestamp = desde.toISOString();

      const { data: reservasData, error: reservasError } = await supabase
        .from("reservations")
        .select("id, club_id, source")
        .gte("fecha", desdeFecha);
      if (reservasError) throw reservasError;

      const reservasRows = reservasData ?? [];
      const totalReservas30d = reservasRows.length;
      const organica30d = reservasRows.filter(
        (r) => r.source === "organica",
      ).length;
      const rp30d = reservasRows.filter((r) => r.source === "rp").length;

      const clubCounts: Record<string, number> = {};
      for (const r of reservasRows) {
        if (!r.club_id) continue;
        clubCounts[r.club_id] = (clubCounts[r.club_id] ?? 0) + 1;
      }
      const ranking = Object.entries(clubCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5) as [string, number][];

      const { data: consumoData, error: consumoError } = await supabase
        .from("consumption_entries")
        .select("reservation_id, monto")
        .gte("created_at", desdeTimestamp);
      if (consumoError) throw consumoError;

      const consumoRows = consumoData ?? [];
      const totalConsumo30d = consumoRows.reduce(
        (sum, e) => sum + Number(e.monto),
        0,
      );
      const reservasConConsumo = new Set(
        consumoRows.map((e) => e.reservation_id),
      ).size;
      const ticketPromedio =
        reservasConConsumo > 0 ? totalConsumo30d / reservasConConsumo : 0;

      const { data: comisionesData, error: comisionesError } = await supabase
        .from("commissions")
        .select("tipo, monto, status")
        .gte("created_at", desdeTimestamp);
      if (comisionesError) throw comisionesError;

      const comisionesPorTipo: Record<string, Record<string, number>> = {};
      for (const c of comisionesData ?? []) {
        const tipoBucket = comisionesPorTipo[c.tipo] ?? {};
        tipoBucket[c.status] = (tipoBucket[c.status] ?? 0) + Number(c.monto);
        comisionesPorTipo[c.tipo] = tipoBucket;
      }

      setDashboard({
        totalReservas30d,
        organica30d,
        rp30d,
        ranking,
        totalConsumo30d,
        reservasConConsumo,
        ticketPromedio,
        comisionesPorTipo,
      });
    } catch (err) {
      console.error("Error cargando dashboard general:", err);
    } finally {
      setLoadingDashboard(false);
    }
  }

  useEffect(() => {
    fetchClubs();
    fetchAlertas();
    fetchDashboard();
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/admin/login");
  }

  async function handleCreateStaff(e: FormEvent) {
    e.preventDefault();
    setStaffError(null);

    if (
      !staffNombre.trim() ||
      !staffEmail.trim() ||
      !staffPassword ||
      !staffClubId
    ) {
      setStaffError("Completa todos los campos.");
      return;
    }
    if (staffPassword.length < 6) {
      setStaffError("La contraseña debe tener al menos 6 caracteres.");
      return;
    }

    setStaffSubmitting(true);
    try {
      const res = await fetch("/api/admin/create-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: staffEmail.trim(),
          password: staffPassword,
          nombre: staffNombre.trim(),
          role: staffRole,
          club_id: staffClubId,
        }),
      });
      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.error ?? "No pudimos crear la cuenta.");
      }

      setCreatedStaff((prev) => [result.profile as CreatedStaff, ...prev]);
      setStaffNombre("");
      setStaffEmail("");
      setStaffPassword("");
      setStaffRole("staff");
      setStaffClubId("");
    } catch (err) {
      console.error("Error creando staff/gerente:", err);
      setStaffError(
        err instanceof Error ? err.message : "No pudimos crear la cuenta.",
      );
    } finally {
      setStaffSubmitting(false);
    }
  }

  if (checkingSession) {
    return null;
  }

  // Un antro está publicado (visible al público) si está verificado y con
  // suscripción activa. Los demás (borradores, en revisión, rechazados) se
  // agrupan aparte y colapsados para no mezclarlos con los activos.
  const clubsPublicados = clubs.filter(estaPublicado);
  const clubsNoPublicados = clubs.filter((c) => !estaPublicado(c));

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            Panel Admin
          </h1>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleLogout}
          >
            Cerrar sesión
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-10" render={<Link href="/admin/salud" />} nativeButton={false}>
            Salud de la plataforma
          </Button>
          <Button variant="outline" className="h-10" render={<Link href="/grupo" />} nativeButton={false}>
            Resumen por antro
          </Button>
          <Button variant="outline" className="h-10" render={<Link href="/grupo/noche" />} nativeButton={false}>
            Cierre de la noche
          </Button>
          <Button variant="outline" className="h-10" render={<Link href="/grupo/exportar" />} nativeButton={false}>
            Descargar reportes (CSV)
          </Button>
          {mensualidadActiva() && (
            <Button variant="outline" className="h-10" render={<Link href="/admin/mensualidad" />} nativeButton={false}>
              Mensualidades y planes
            </Button>
          )}
          <Button variant="outline" className="h-10" render={<Link href="/admin/correos" />} nativeButton={false}>
            Bandeja de correos
          </Button>
          <Button variant="outline" className="h-10" render={<Link href="/admin/funciones" />} nativeButton={false}>
            Funciones en prueba
          </Button>
        </div>

        <VerificacionesPendientes onCambio={fetchClubs} />

        <ErroresRecientes />

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Dashboard general</h2>

          {(loadingDashboard || loadingClubs) && (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          )}

          {!loadingDashboard && !loadingClubs && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card size="sm">
                  <CardContent className="flex flex-col gap-1 px-4">
                    <span className="text-xs text-muted-foreground">
                      Antros activos
                    </span>
                    <span className="text-2xl font-bold">
                      {clubs.filter((c) => c.suscripcion_activa).length}
                    </span>
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardContent className="flex flex-col gap-1 px-4">
                    <span className="text-xs text-muted-foreground">
                      Antros inactivos
                    </span>
                    <span className="text-2xl font-bold">
                      {clubs.filter((c) => !c.suscripcion_activa).length}
                    </span>
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardContent className="flex flex-col gap-1 px-4">
                    <span className="text-xs text-muted-foreground">
                      Reservas (30d)
                    </span>
                    <span className="text-2xl font-bold">
                      {dashboard.totalReservas30d}
                    </span>
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardContent className="flex flex-col gap-1 px-4">
                    <span className="text-xs text-muted-foreground">
                      Ticket promedio
                    </span>
                    <span className="text-2xl font-bold">
                      $
                      {dashboard.ticketPromedio.toLocaleString("en-US", {
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="flex flex-col gap-1 px-5 py-4 text-sm">
                  <p className="font-medium">
                    Reservas por fuente (últimos 30 días)
                  </p>
                  <p className="text-muted-foreground">
                    Orgánica: {dashboard.organica30d} · Vía RP:{" "}
                    {dashboard.rp30d}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="flex flex-col gap-1 px-5 py-4 text-sm">
                  <p className="font-medium">
                    Ticket promedio (últimos 30 días)
                  </p>
                  <p className="text-muted-foreground">
                    $
                    {dashboard.totalConsumo30d.toLocaleString("en-US")} de
                    consumo total entre {dashboard.reservasConConsumo}{" "}
                    reservas con consumo registrado
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="flex flex-col gap-1 px-5 py-4 text-sm">
                  <p className="font-medium">
                    Comisiones generadas (últimos 30 días)
                  </p>
                  {Object.keys(dashboard.comisionesPorTipo).length === 0 ? (
                    <p className="text-muted-foreground">
                      Sin comisiones en este periodo.
                    </p>
                  ) : (
                    Object.entries(dashboard.comisionesPorTipo).map(
                      ([tipo, statuses]) => (
                        <p key={tipo} className="text-muted-foreground">
                          {TIPO_COMISION_LABEL[tipo] ?? tipo}:{" "}
                          {Object.entries(statuses)
                            .map(
                              ([status, monto]) =>
                                `${STATUS_COMISION_LABEL[status] ?? status} $${monto.toLocaleString("en-US")}`,
                            )
                            .join(" · ")}
                        </p>
                      ),
                    )
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="flex flex-col gap-2 px-5 py-4 text-sm">
                  <p className="font-medium">
                    Top 5 antros por reservas (últimos 30 días)
                  </p>
                  {dashboard.ranking.length === 0 ? (
                    <p className="text-muted-foreground">
                      Sin datos en este periodo.
                    </p>
                  ) : (
                    <ol className="flex flex-col gap-1 text-muted-foreground">
                      {dashboard.ranking.map(([clubId, count], idx) => (
                        <li key={clubId}>
                          {idx + 1}.{" "}
                          {clubs.find((c) => c.id === clubId)?.nombre ??
                            clubId}{" "}
                          — {count} reservas
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Antros</h2>

          <div className="flex flex-col gap-3">
            {!loadingClubs && clubs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hay antros todavía.
              </p>
            )}
            {clubsPublicados.map((club) => (
              <TarjetaAntro key={club.id} club={club} />
            ))}
            {clubsNoPublicados.length > 0 && (
              <details className="group rounded-lg border border-border">
                <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium">
                  No publicados ({clubsNoPublicados.length})
                  <span className="ml-2 text-xs font-normal text-muted-foreground group-open:hidden">
                    Mostrar
                  </span>
                </summary>
                <div className="flex flex-col gap-3 border-t border-border p-3">
                  {clubsNoPublicados.map((club) => (
                    <TarjetaAntro key={club.id} club={club} />
                  ))}
                </div>
              </details>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dar de alta un antro</CardTitle>
              <CardDescription>
                Asistente en pasos: datos, cover y políticas, mesas, equipo
                (dueño, gerentes, staff y RPs) y grupo. Queda en borrador o
                publicado; si algo falla no se guarda nada. Para partir de
                la configuración de otro antro, usa «Clonar» en su tarjeta.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <Button className="h-10" render={<Link href="/admin/alta-antro" />} nativeButton={false}>
                Empezar el alta
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Alertas de reporte</h2>
          <EnlaceRevisionRps href="/admin/revision" className="self-start sm:w-auto" />
          <p className="text-xs text-muted-foreground">
            Compara, por antro, qué % de las reservas con check-in
            confirmado en los últimos 30 días tuvieron al menos un consumo
            registrado, vía RP contra orgánicas. Una brecha grande es una
            señal de posible sub-reporte de consumo, no una prueba —
            investiga manualmente antes de actuar.
          </p>

          {loadingAlertas && (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          )}

          {!loadingAlertas && clubsPublicados.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hay antros publicados todavía.
            </p>
          )}

          {!loadingAlertas && clubsPublicados.length > 0 && (
            <div className="flex flex-col gap-2">
              {clubsPublicados.map((club) => {
                const bucket = alertasData[club.id];
                const pctRp =
                  bucket && bucket.rpTotal > 0
                    ? Math.round((bucket.rpConConsumo / bucket.rpTotal) * 100)
                    : null;
                const pctOrganica =
                  bucket && bucket.organicaTotal > 0
                    ? Math.round(
                        (bucket.organicaConConsumo / bucket.organicaTotal) *
                          100,
                      )
                    : null;
                const flagged =
                  pctRp !== null &&
                  pctOrganica !== null &&
                  Math.abs(pctRp - pctOrganica) > DIFERENCIA_ALERTA;

                return (
                  <Card
                    key={club.id}
                    className={
                      flagged
                        ? "ring-status-warn/60 bg-status-warn/8"
                        : undefined
                    }
                  >
                    <CardContent className="flex flex-col gap-3 px-5 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 break-words font-medium">{club.nombre}</p>
                        {flagged && (
                          <Badge className="border-transparent bg-status-warn/15 text-status-warn">
                            Posible sub-reporte
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                        <div>
                          <p className="text-muted-foreground">
                            Vía RP con consumo
                          </p>
                          <p className="text-lg font-semibold">
                            {pctRp !== null ? `${pctRp}%` : "—"}
                            {bucket && bucket.rpTotal > 0 && (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({bucket.rpConConsumo}/{bucket.rpTotal})
                              </span>
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">
                            Orgánicas con consumo
                          </p>
                          <p className="text-lg font-semibold">
                            {pctOrganica !== null ? `${pctOrganica}%` : "—"}
                            {bucket && bucket.organicaTotal > 0 && (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({bucket.organicaConConsumo}/
                                {bucket.organicaTotal})
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">
            Crear cuenta de Staff / Gerente
          </h2>

          <Card>
            <CardContent className="px-6 py-6">
              <form
                onSubmit={handleCreateStaff}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="staff_nombre">Nombre</Label>
                  <Input
                    id="staff_nombre"
                    value={staffNombre}
                    onChange={(e) => setStaffNombre(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="staff_email">Email</Label>
                  <Input
                    id="staff_email"
                    type="email"
                    value={staffEmail}
                    onChange={(e) => setStaffEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="staff_password">Password temporal</Label>
                  <Input
                    id="staff_password"
                    type="password"
                    value={staffPassword}
                    onChange={(e) => setStaffPassword(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="staff_role">Rol</Label>
                  <select
                    id="staff_role"
                    className={SELECT_CLASSES}
                    value={staffRole}
                    onChange={(e) =>
                      setStaffRole(e.target.value as "staff" | "gerente")
                    }
                  >
                    <option value="staff">Staff</option>
                    <option value="gerente">Gerente</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="staff_club">Antro</Label>
                  <select
                    id="staff_club"
                    className={SELECT_CLASSES}
                    value={staffClubId}
                    onChange={(e) => setStaffClubId(e.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Selecciona un antro
                    </option>
                    {/* Solo publicados: los antros que crea el admin nacen
                        publicados, y un borrador de dueño da de alta a su
                        propio personal desde su panel. */}
                    {clubsPublicados.map((club) => (
                      <option key={club.id} value={club.id}>
                        {club.nombre}
                      </option>
                    ))}
                  </select>
                </div>

                {staffError && (
                  <p className="text-sm text-destructive" role="alert">
                    {staffError}
                  </p>
                )}

                <Button type="submit" disabled={staffSubmitting}>
                  {staffSubmitting ? "Creando..." : "Crear cuenta"}
                </Button>
              </form>
            </CardContent>
          </Card>

          {createdStaff.length > 0 && (
            <div className="flex flex-col gap-2">
              {createdStaff.map((p) => (
                <Card key={p.id}>
                  <CardContent className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="font-medium">{p.nombre}</span>
                    <span className="text-muted-foreground">
                      {p.role === "gerente" ? "Gerente" : "Staff"} ·{" "}
                      {clubs.find((c) => c.id === p.club_id)?.nombre ??
                        p.club_id}
                    </span>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function estaPublicado(club: Club): boolean {
  return club.estado_verificacion === "verificado" && club.suscripcion_activa;
}

const ESTADO_LABEL: Record<Club["estado_verificacion"], string> = {
  borrador: "Borrador",
  en_revision: "En revisión",
  verificado: "Verificado",
  rechazado: "Rechazado",
};

function TarjetaAntro({ club }: { club: Club }) {
  const cover = textoCover(club);
  const publicado = estaPublicado(club);
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-2 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium">{club.nombre}</p>
          <p className="text-sm text-muted-foreground">{club.direccion}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {!publicado && (
            <Badge variant="outline">
              {club.estado_verificacion === "verificado"
                ? "Sin suscripción"
                : ESTADO_LABEL[club.estado_verificacion]}
            </Badge>
          )}
          {cover && (
            <span className="whitespace-nowrap text-sm font-semibold">
              {cover}
            </span>
          )}
        </div>
        {/* Clon (B2): abre el asistente de alta precargado con la
            configuración de este antro (solo admin; lo exige la base). */}
        <div className="flex w-full justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-10 px-3"
            render={<Link href={`/admin/alta-antro?desde=${club.id}`} />}
            nativeButton={false}
            aria-label={`Clonar ${club.nombre}`}
          >
            Clonar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
