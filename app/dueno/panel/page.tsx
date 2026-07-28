"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Club, ClubPhoto, ClubTable, Profile } from "@/types";

const SELECT_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

type Personal = Pick<Profile, "id" | "nombre" | "role">;

export default function DuenoPanelPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);

  const [club, setClub] = useState<Club | null>(null);
  const [loadingClub, setLoadingClub] = useState(true);
  const [clubNotFound, setClubNotFound] = useState(false);

  const [clubNombre, setClubNombre] = useState("");
  const [clubDireccion, setClubDireccion] = useState("");
  const [clubHorario, setClubHorario] = useState("");
  const [clubDeposito, setClubDeposito] = useState("");
  const [clubSubmitting, setClubSubmitting] = useState(false);
  const [clubError, setClubError] = useState<string | null>(null);
  const [clubSaved, setClubSaved] = useState(false);

  const [activating, setActivating] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null,
  );

  const [staffNombre, setStaffNombre] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [staffRole, setStaffRole] = useState<"staff" | "gerente">("staff");
  const [staffSubmitting, setStaffSubmitting] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [personal, setPersonal] = useState<Personal[]>([]);

  const [photos, setPhotos] = useState<ClubPhoto[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [tables, setTables] = useState<ClubTable[]>([]);
  const [tableNumero, setTableNumero] = useState("");
  const [tableCapacidad, setTableCapacidad] = useState("");
  const [tableSubmitting, setTableSubmitting] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);

  useEffect(() => {
    async function loadSession() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/dueno/login");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError || !profile || profile.role !== "dueno") {
        router.replace("/dueno/login");
        return;
      }

      setCheckingSession(false);
    }

    loadSession();
  }, [router]);

  async function fetchClub() {
    setLoadingClub(true);
    setClubNotFound(false);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from("clubs")
        .select("*")
        .eq("dueno_id", user.id)
        .maybeSingle();

      if (error || !data) {
        setClubNotFound(true);
        setClub(null);
        return;
      }

      const loadedClub = data as Club;
      setClub(loadedClub);
      setClubNombre(loadedClub.nombre);
      setClubDireccion(loadedClub.direccion);
      setClubHorario(loadedClub.horario);
      setClubDeposito(String(loadedClub.deposito_monto));
      return loadedClub;
    } catch (err) {
      console.error("Error cargando club del dueño:", err);
      setClubNotFound(true);
    } finally {
      setLoadingClub(false);
    }
  }

  async function fetchPersonal(clubId: string) {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, nombre, role")
        .eq("club_id", clubId)
        .in("role", ["staff", "gerente"]);

      if (error) throw error;
      setPersonal((data ?? []) as Personal[]);
    } catch (err) {
      console.error("Error cargando personal:", err);
    }
  }

  async function fetchPhotos(clubId: string) {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("club_photos")
        .select("*")
        .eq("club_id", clubId)
        .order("orden", { ascending: true });

      if (error) throw error;
      setPhotos((data ?? []) as ClubPhoto[]);
    } catch (err) {
      console.error("Error cargando fotos:", err);
    }
  }

  async function fetchTables(clubId: string) {
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

  useEffect(() => {
    if (checkingSession) return;
    fetchClub().then((loadedClub) => {
      if (loadedClub) {
        fetchPersonal(loadedClub.id);
        fetchPhotos(loadedClub.id);
        fetchTables(loadedClub.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingSession]);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/dueno/login");
  }

  async function handleUpdateClub(e: FormEvent) {
    e.preventDefault();
    setClubError(null);
    setClubSaved(false);

    if (!club) return;
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
      const { error: updateError } = await supabase
        .from("clubs")
        .update({
          nombre: clubNombre.trim(),
          direccion: clubDireccion.trim(),
          horario: clubHorario.trim(),
          deposito_monto: depositoNum,
        })
        .eq("id", club.id);

      if (updateError) throw updateError;

      await fetchClub();
      setClubSaved(true);
    } catch (err) {
      console.error("Error actualizando club:", err);
      setClubError("No pudimos guardar los cambios. Intenta de nuevo.");
    } finally {
      setClubSubmitting(false);
    }
  }

  async function handleActivateSubscription() {
    if (!club) return;
    setSubscriptionError(null);
    setActivating(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("clubs")
        .update({
          suscripcion_activa: true,
          suscripcion_activada_en: new Date().toISOString(),
        })
        .eq("id", club.id);

      if (updateError) throw updateError;

      await fetchClub();
    } catch (err) {
      console.error("Error activando suscripción:", err);
      setSubscriptionError("No pudimos activar la suscripción. Intenta de nuevo.");
    } finally {
      setActivating(false);
    }
  }

  async function handleCreateStaff(e: FormEvent) {
    e.preventDefault();
    setStaffError(null);

    if (!club) return;
    if (!staffNombre.trim() || !staffEmail.trim() || !staffPassword) {
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
          club_id: club.id,
        }),
      });
      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.error ?? "No pudimos crear la cuenta.");
      }

      setStaffNombre("");
      setStaffEmail("");
      setStaffPassword("");
      setStaffRole("staff");
      await fetchPersonal(club.id);
    } catch (err) {
      console.error("Error creando staff/gerente:", err);
      setStaffError(
        err instanceof Error ? err.message : "No pudimos crear la cuenta.",
      );
    } finally {
      setStaffSubmitting(false);
    }
  }

  async function handleUploadPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0 || !club) return;

    setPhotoError(null);
    setUploadingPhotos(true);
    try {
      const supabase = createClient();
      let nextOrden =
        photos.length > 0 ? Math.max(...photos.map((p) => p.orden)) + 1 : 0;

      for (const file of Array.from(files)) {
        const storagePath = `${club.id}/${crypto.randomUUID()}-${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from("club-photos")
          .upload(storagePath, file);

        if (uploadError) throw uploadError;

        const {
          data: { publicUrl },
        } = supabase.storage.from("club-photos").getPublicUrl(storagePath);

        const { error: insertError } = await supabase
          .from("club_photos")
          .insert({
            club_id: club.id,
            url: publicUrl,
            storage_path: storagePath,
            orden: nextOrden,
          });

        if (insertError) throw insertError;

        nextOrden += 1;
      }

      await fetchPhotos(club.id);
    } catch (err) {
      console.error("Error subiendo fotos:", err);
      setPhotoError("No pudimos subir una o más fotos. Intenta de nuevo.");
    } finally {
      setUploadingPhotos(false);
      e.target.value = "";
    }
  }

  async function handleDeletePhoto(photo: ClubPhoto) {
    setPhotoError(null);
    setDeletingPhotoId(photo.id);
    try {
      const supabase = createClient();
      const { error: storageError } = await supabase.storage
        .from("club-photos")
        .remove([photo.storage_path]);

      if (storageError) throw storageError;

      const { error: deleteError } = await supabase
        .from("club_photos")
        .delete()
        .eq("id", photo.id);

      if (deleteError) throw deleteError;

      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    } catch (err) {
      console.error("Error borrando foto:", err);
      setPhotoError("No pudimos borrar la foto. Intenta de nuevo.");
    } finally {
      setDeletingPhotoId(null);
    }
  }

  async function handleCreateTable(e: FormEvent) {
    e.preventDefault();
    setTableError(null);

    if (!club) return;
    if (!tableNumero.trim() || !tableCapacidad) {
      setTableError("Completa todos los campos.");
      return;
    }
    const capacidadNum = Number(tableCapacidad);
    if (!Number.isInteger(capacidadNum) || capacidadNum < 1) {
      setTableError("La capacidad debe ser un número entero mayor a 0.");
      return;
    }

    setTableSubmitting(true);
    try {
      const supabase = createClient();
      const { error: insertError } = await supabase.from("club_tables").insert({
        club_id: club.id,
        numero: tableNumero.trim(),
        capacidad: capacidadNum,
      });

      if (insertError) throw insertError;

      setTableNumero("");
      setTableCapacidad("");
      await fetchTables(club.id);
    } catch (err) {
      console.error("Error creando mesa:", err);
      setTableError("No pudimos crear la mesa. Intenta de nuevo.");
    } finally {
      setTableSubmitting(false);
    }
  }

  async function handleDeleteTable(table: ClubTable) {
    setTableError(null);
    setDeletingTableId(table.id);
    try {
      const supabase = createClient();
      const { error: deleteError } = await supabase
        .from("club_tables")
        .delete()
        .eq("id", table.id);

      if (deleteError) throw deleteError;

      setTables((prev) => prev.filter((t) => t.id !== table.id));
    } catch (err) {
      console.error("Error borrando mesa:", err);
      setTableError(
        "No pudimos borrar la mesa. Puede que tenga una reserva asignada.",
      );
    } finally {
      setDeletingTableId(null);
    }
  }

  if (checkingSession || loadingClub) {
    return null;
  }

  if (clubNotFound || !club) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>No encontramos tu antro</CardTitle>
            <CardDescription>
              Algo salió mal al crear tu cuenta. Contacta soporte.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">
            Panel de tu antro
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
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Suscripción</h2>
            {club.suscripcion_activa ? (
              <Badge className="border-transparent bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300">
                Suscripción activa desde{" "}
                {club.suscripcion_activada_en
                  ? new Date(club.suscripcion_activada_en).toLocaleDateString()
                  : ""}
              </Badge>
            ) : (
              <Badge className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                Sin suscripción activa
              </Badge>
            )}
          </div>
          {!club.suscripcion_activa && (
            <Card>
              <CardContent className="flex flex-col gap-3 px-6 py-6">
                <p className="text-sm text-muted-foreground">
                  Tu antro no aparece todavía para los clientes. Actívala
                  para publicarlo (esto es una simulación, no requiere pago
                  real).
                </p>
                {subscriptionError && (
                  <p className="text-sm text-destructive" role="alert">
                    {subscriptionError}
                  </p>
                )}
                <Button
                  type="button"
                  onClick={handleActivateSubscription}
                  disabled={activating}
                >
                  {activating ? "Activando..." : "Activar suscripción"}
                </Button>
              </CardContent>
            </Card>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Datos de tu antro</h2>
          <Card>
            <CardContent className="px-6 py-6">
              <form
                onSubmit={handleUpdateClub}
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
                {clubSaved && !clubError && (
                  <p className="text-sm text-muted-foreground">
                    Cambios guardados.
                  </p>
                )}

                <Button type="submit" disabled={clubSubmitting}>
                  {clubSubmitting ? "Guardando..." : "Guardar cambios"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Mi personal</h2>
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

          {personal.length > 0 && (
            <div className="flex flex-col gap-2">
              {personal.map((p) => (
                <Card key={p.id}>
                  <CardContent className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="font-medium">{p.nombre}</span>
                    <span className="text-muted-foreground">
                      {p.role === "gerente" ? "Gerente" : "Staff"}
                    </span>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Fotos de mi antro</h2>
          <Card>
            <CardContent className="flex flex-col gap-3 px-6 py-6">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="photos">Subir fotos</Label>
                <input
                  id="photos"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleUploadPhotos}
                  disabled={uploadingPhotos}
                  className="text-sm"
                />
              </div>
              {uploadingPhotos && (
                <p className="text-sm text-muted-foreground">Subiendo...</p>
              )}
              {photoError && (
                <p className="text-sm text-destructive" role="alert">
                  {photoError}
                </p>
              )}
            </CardContent>
          </Card>

          {photos.length > 0 && (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {photos.map((photo) => (
                <div
                  key={photo.id}
                  className="relative aspect-square overflow-hidden rounded-lg bg-muted"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => handleDeletePhoto(photo)}
                    disabled={deletingPhotoId === photo.id}
                    aria-label="Eliminar foto"
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-sm text-white hover:bg-black/80 disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Mis mesas</h2>
          <Card>
            <CardContent className="px-6 py-6">
              <form
                onSubmit={handleCreateTable}
                className="flex flex-col gap-4 sm:flex-row sm:items-end"
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="table_numero">Número / nombre de mesa</Label>
                  <Input
                    id="table_numero"
                    value={tableNumero}
                    onChange={(e) => setTableNumero(e.target.value)}
                    placeholder="ej. 5 o VIP 1"
                    required
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="table_capacidad">Capacidad</Label>
                  <Input
                    id="table_capacidad"
                    type="number"
                    min={1}
                    value={tableCapacidad}
                    onChange={(e) => setTableCapacidad(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={tableSubmitting}>
                  {tableSubmitting ? "Creando..." : "Crear mesa"}
                </Button>
              </form>
              {tableError && (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  {tableError}
                </p>
              )}
            </CardContent>
          </Card>

          {tables.length > 0 && (
            <div className="flex flex-col gap-2">
              {tables.map((table) => (
                <Card key={table.id}>
                  <CardContent className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="font-medium">Mesa {table.numero}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        Capacidad: {table.capacidad}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteTable(table)}
                        disabled={deletingTableId === table.id}
                      >
                        {deletingTableId === table.id
                          ? "Borrando..."
                          : "Eliminar"}
                      </Button>
                    </div>
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
