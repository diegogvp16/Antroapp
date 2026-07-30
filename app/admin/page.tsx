"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
import type { Club } from "@/types";

interface ConsumoBucket {
  rpTotal: number;
  rpConConsumo: number;
  organicaTotal: number;
  organicaConConsumo: number;
}

const DIFERENCIA_ALERTA = 30;

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

  const [clubNombre, setClubNombre] = useState("");
  const [clubDireccion, setClubDireccion] = useState("");
  const [clubHorario, setClubHorario] = useState("");
  const [clubDeposito, setClubDeposito] = useState("");
  const [clubSubmitting, setClubSubmitting] = useState(false);
  const [clubError, setClubError] = useState<string | null>(null);

  const [staffNombre, setStaffNombre] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [staffRole, setStaffRole] = useState<"staff" | "gerente">("staff");
  const [staffClubId, setStaffClubId] = useState("");
  const [staffSubmitting, setStaffSubmitting] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [createdStaff, setCreatedStaff] = useState<CreatedStaff[]>([]);

  const [editingBonoClubId, setEditingBonoClubId] = useState<string | null>(
    null,
  );
  const [bonoTipoEdit, setBonoTipoEdit] = useState<
    Record<string, "fijo" | "porcentaje">
  >({});
  const [bonoMontoEdit, setBonoMontoEdit] = useState<Record<string, string>>(
    {},
  );
  const [bonoSubmittingId, setBonoSubmittingId] = useState<string | null>(
    null,
  );
  const [bonoError, setBonoError] = useState<Record<string, string>>({});

  const [alertasData, setAlertasData] = useState<Record<string, ConsumoBucket>>(
    {},
  );
  const [loadingAlertas, setLoadingAlertas] = useState(true);

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

  useEffect(() => {
    fetchClubs();
    fetchAlertas();
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/admin/login");
  }

  async function handleCreateClub(e: FormEvent) {
    e.preventDefault();
    setClubError(null);

    if (
      !clubNombre.trim() ||
      !clubDireccion.trim() ||
      !clubHorario.trim() ||
      !clubDeposito
    ) {
      setClubError("Completa todos los campos.");
      return;
    }
    const depositoNum = Number(clubDeposito);
    if (!Number.isFinite(depositoNum) || depositoNum < 0) {
      setClubError("El depósito debe ser un número válido.");
      return;
    }

    setClubSubmitting(true);
    try {
      const supabase = createClient();
      const { error: insertError } = await supabase.from("clubs").insert({
        nombre: clubNombre.trim(),
        direccion: clubDireccion.trim(),
        horario: clubHorario.trim(),
        deposito_monto: depositoNum,
        suscripcion_activa: true,
      });

      if (insertError) throw insertError;

      setClubNombre("");
      setClubDireccion("");
      setClubHorario("");
      setClubDeposito("");
      await fetchClubs();
    } catch (err) {
      console.error("Error creando club:", err);
      setClubError("No pudimos crear el antro. Intenta de nuevo.");
    } finally {
      setClubSubmitting(false);
    }
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

  function handleToggleEditBono(club: Club) {
    if (editingBonoClubId === club.id) {
      setEditingBonoClubId(null);
      return;
    }
    setBonoTipoEdit((prev) => ({ ...prev, [club.id]: club.bono_organica_tipo }));
    setBonoMontoEdit((prev) => ({
      ...prev,
      [club.id]: String(club.bono_organica_monto),
    }));
    setBonoError((prev) => ({ ...prev, [club.id]: "" }));
    setEditingBonoClubId(club.id);
  }

  async function handleSaveBono(club: Club) {
    const tipo = bonoTipoEdit[club.id] ?? "fijo";
    const montoStr = bonoMontoEdit[club.id] ?? "";
    setBonoError((prev) => ({ ...prev, [club.id]: "" }));

    if (!montoStr) {
      setBonoError((prev) => ({ ...prev, [club.id]: "Ingresa un monto." }));
      return;
    }
    const montoNum = Number(montoStr);
    if (!Number.isFinite(montoNum) || montoNum < 0) {
      setBonoError((prev) => ({
        ...prev,
        [club.id]: "El monto debe ser un número válido.",
      }));
      return;
    }
    if (tipo === "porcentaje" && montoNum > 100) {
      setBonoError((prev) => ({
        ...prev,
        [club.id]: "El porcentaje no puede ser mayor a 100.",
      }));
      return;
    }

    setBonoSubmittingId(club.id);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("clubs")
        .update({ bono_organica_tipo: tipo, bono_organica_monto: montoNum })
        .eq("id", club.id);

      if (updateError) throw updateError;

      await fetchClubs();
      setEditingBonoClubId(null);
    } catch (err) {
      console.error("Error actualizando bono:", err);
      setBonoError((prev) => ({
        ...prev,
        [club.id]: "No pudimos guardar. Intenta de nuevo.",
      }));
    } finally {
      setBonoSubmittingId(null);
    }
  }

  if (checkingSession) {
    return null;
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">
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

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Antros</h2>

          <div className="flex flex-col gap-3">
            {!loadingClubs && clubs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hay antros todavía.
              </p>
            )}
            {clubs.map((club) => (
              <Card key={club.id}>
                <CardContent className="flex items-center justify-between px-5 py-4">
                  <div>
                    <p className="font-medium">{club.nombre}</p>
                    <p className="text-sm text-muted-foreground">
                      {club.direccion}
                    </p>
                  </div>
                  <span className="text-sm font-semibold">
                    Depósito: ${club.deposito_monto}
                  </span>
                </CardContent>
                <CardContent className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
                  <span className="text-muted-foreground">
                    Bono plataforma:{" "}
                    {club.bono_organica_tipo === "fijo"
                      ? `$${club.bono_organica_monto} fijo`
                      : `${club.bono_organica_monto}% del consumo`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggleEditBono(club)}
                  >
                    {editingBonoClubId === club.id
                      ? "Cancelar"
                      : "Editar bono de plataforma"}
                  </Button>
                </CardContent>
                {editingBonoClubId === club.id && (
                  <CardContent className="flex flex-col gap-3 border-t border-border px-5 py-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`bono_tipo_${club.id}`}>
                        Tipo de bono
                      </Label>
                      <select
                        id={`bono_tipo_${club.id}`}
                        className={SELECT_CLASSES}
                        value={bonoTipoEdit[club.id] ?? "fijo"}
                        onChange={(e) =>
                          setBonoTipoEdit((prev) => ({
                            ...prev,
                            [club.id]: e.target.value as "fijo" | "porcentaje",
                          }))
                        }
                      >
                        <option value="fijo">Fijo</option>
                        <option value="porcentaje">
                          Porcentaje del consumo
                        </option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`bono_monto_${club.id}`}>
                        {(bonoTipoEdit[club.id] ?? "fijo") === "fijo"
                          ? "Monto ($)"
                          : "Porcentaje (%)"}
                      </Label>
                      <Input
                        id={`bono_monto_${club.id}`}
                        type="number"
                        min={0}
                        max={
                          (bonoTipoEdit[club.id] ?? "fijo") === "porcentaje"
                            ? 100
                            : undefined
                        }
                        value={bonoMontoEdit[club.id] ?? ""}
                        onChange={(e) =>
                          setBonoMontoEdit((prev) => ({
                            ...prev,
                            [club.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                    {bonoError[club.id] && (
                      <p className="text-sm text-destructive" role="alert">
                        {bonoError[club.id]}
                      </p>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleSaveBono(club)}
                      disabled={bonoSubmittingId === club.id}
                    >
                      {bonoSubmittingId === club.id
                        ? "Guardando..."
                        : "Guardar bono"}
                    </Button>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Crear antro</CardTitle>
              <CardDescription>Agrega un nuevo antro a la plataforma.</CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <form
                onSubmit={handleCreateClub}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_nombre">Nombre</Label>
                  <Input
                    id="club_nombre"
                    value={clubNombre}
                    onChange={(e) => setClubNombre(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_direccion">Dirección</Label>
                  <Input
                    id="club_direccion"
                    value={clubDireccion}
                    onChange={(e) => setClubDireccion(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_horario">Horario</Label>
                  <Input
                    id="club_horario"
                    value={clubHorario}
                    onChange={(e) => setClubHorario(e.target.value)}
                    placeholder="ej. 10pm - 4am"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_deposito">Depósito ($)</Label>
                  <Input
                    id="club_deposito"
                    type="number"
                    min={0}
                    value={clubDeposito}
                    onChange={(e) => setClubDeposito(e.target.value)}
                    required
                  />
                </div>

                {clubError && (
                  <p className="text-sm text-destructive" role="alert">
                    {clubError}
                  </p>
                )}

                <Button type="submit" disabled={clubSubmitting}>
                  {clubSubmitting ? "Creando..." : "Crear antro"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Alertas de reporte</h2>
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

          {!loadingAlertas && clubs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hay antros todavía.
            </p>
          )}

          {!loadingAlertas && clubs.length > 0 && (
            <div className="flex flex-col gap-2">
              {clubs.map((club) => {
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
                        ? "border-amber-400 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10"
                        : undefined
                    }
                  >
                    <CardContent className="flex flex-col gap-3 px-5 py-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{club.nombre}</p>
                        {flagged && (
                          <Badge className="border-transparent bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-200">
                            Posible sub-reporte
                          </Badge>
                        )}
                      </div>
                      <div className="flex gap-8 text-sm">
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
                    {clubs.map((club) => (
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
