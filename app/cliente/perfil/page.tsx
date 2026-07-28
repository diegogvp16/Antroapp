"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import type { Profile, Reservation } from "@/types";

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

export default function ClientePerfilPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);

  const [reservas, setReservas] = useState<Reservation[]>([]);
  const [clubNombres, setClubNombres] = useState<Record<string, string>>({});
  const [loadingReservas, setLoadingReservas] = useState(true);

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/cliente/login");
        return;
      }

      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError || !profileData || profileData.role !== "cliente") {
        router.replace("/cliente/login");
        return;
      }

      setEmail(user.email ?? "");
      setProfile(profileData as Profile);
      setCheckingSession(false);

      setLoadingReservas(true);
      const { data: reservasData, error: reservasError } = await supabase
        .from("reservations")
        .select("*")
        .eq("cliente_id", user.id)
        .order("created_at", { ascending: false });

      if (!reservasError && reservasData) {
        const rows = reservasData as Reservation[];
        setReservas(rows);

        const clubIds = Array.from(
          new Set(rows.map((r) => r.club_id).filter(Boolean)),
        ) as string[];

        if (clubIds.length > 0) {
          const { data: clubsData } = await supabase
            .from("clubs")
            .select("id, nombre")
            .in("id", clubIds);

          const map: Record<string, string> = {};
          for (const c of clubsData ?? []) {
            map[c.id] = c.nombre;
          }
          setClubNombres(map);
        }
      }
      setLoadingReservas(false);
    }

    load();
  }, [router]);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/cliente/login");
  }

  if (checkingSession) {
    return null;
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">
            Mi perfil
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

        <Card>
          <CardContent className="flex flex-col gap-1 px-6 py-5 text-sm">
            <p className="text-base font-medium">{profile?.nombre}</p>
            <p className="text-muted-foreground">{email}</p>
            {profile?.telefono && (
              <p className="text-muted-foreground">{profile.telefono}</p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Mis reservas</h2>

          {loadingReservas && (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          )}

          {!loadingReservas && reservas.length === 0 && (
            <Card>
              <CardContent className="px-6 py-10 text-center text-muted-foreground">
                Todavía no tienes reservas.
              </CardContent>
            </Card>
          )}

          {reservas.map((r) => (
            <Card key={r.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>
                      {(r.club_id && clubNombres[r.club_id]) || "Antro"}
                    </CardTitle>
                    <CardDescription>{r.fecha}</CardDescription>
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
              <CardContent className="px-6 pb-4 text-sm text-muted-foreground">
                {r.personas} personas
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
