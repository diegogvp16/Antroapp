"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Club, ClubPhoto } from "@/types";

export default function ClubDetailPage() {
  const params = useParams<{ clubId: string }>();
  const router = useRouter();
  const clubId = params.clubId;

  const [checkingSession, setCheckingSession] = useState(true);
  const [club, setClub] = useState<Club | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [photos, setPhotos] = useState<ClubPhoto[]>([]);

  useEffect(() => {
    async function checkSession() {
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
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError || !profile || profile.role !== "cliente") {
        router.replace("/cliente/login");
        return;
      }

      setCheckingSession(false);
    }

    checkSession();
  }, [router]);

  useEffect(() => {
    if (checkingSession) return;

    async function fetchClub() {
      setLoading(true);
      setNotFound(false);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("clubs")
          .select("*")
          .eq("id", clubId)
          .maybeSingle();

        if (error || !data) {
          setNotFound(true);
          setClub(null);
          return;
        }

        const loadedClub = data as Club;
        setClub(loadedClub);

        const { data: photosData, error: photosError } = await supabase
          .from("club_photos")
          .select("*")
          .eq("club_id", loadedClub.id)
          .order("orden", { ascending: true });

        if (photosError) {
          console.error("Error cargando fotos del club:", photosError);
        } else {
          setPhotos((photosData ?? []) as ClubPhoto[]);
        }
      } catch (err) {
        console.error("Error cargando club:", err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    }

    if (clubId) {
      fetchClub();
    } else {
      setLoading(false);
      setNotFound(true);
    }
  }, [clubId, checkingSession]);

  if (checkingSession) {
    return null;
  }

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <BackLink href="/cliente" />
      <Card className="w-full max-w-sm overflow-hidden p-0">
        {loading ? (
          <CardContent className="px-6 py-10 text-center text-muted-foreground">
            Cargando...
          </CardContent>
        ) : notFound || !club ? (
          <>
            <CardHeader className="px-6 pt-5">
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
                Volver al listado
              </Link>
            </CardContent>
          </>
        ) : (
          <>
            {photos.length > 0 ? (
              <div className="flex h-40 w-full gap-1 overflow-x-auto">
                {photos.map((photo) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={photo.id}
                    src={photo.url}
                    alt=""
                    className="h-40 w-56 flex-shrink-0 object-cover"
                  />
                ))}
              </div>
            ) : (
              <div className="h-40 w-full bg-gradient-to-br from-fuchsia-600 via-purple-600 to-indigo-600" />
            )}
            <CardHeader className="px-6 pt-5">
              <CardTitle className="text-2xl">{club.nombre}</CardTitle>
              <CardDescription>{club.direccion}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6 pb-6">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{club.horario}</span>
                <span className="font-semibold">
                  Depósito: ${club.deposito_monto}
                </span>
              </div>
              <Button
                render={<Link href={`/cliente/reservar?club=${club.id}`} />}
                nativeButton={false}
                size="lg"
                className="h-14 w-full text-base"
              >
                Reservar
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
