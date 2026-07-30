"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Club } from "@/types";

interface Coords {
  lat: number;
  lng: number;
}

// Formula de Haversine: distancia entre dos puntos sobre la superficie de
// la Tierra a partir de su latitud/longitud, en kilometros.
function haversineDistanceKm(a: Coords, b: Coords) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinDLng *
      sinDLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function formatDistance(km: number) {
  return `${km.toFixed(1)} km`;
}

export default function ClientePage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<Coords | null>(null);

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

    async function fetchClubs() {
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        const { data, error: queryError } = await supabase
          .from("clubs")
          .select("*")
          .eq("suscripcion_activa", true);

        if (queryError) {
          throw queryError;
        }

        const loadedClubs = (data ?? []) as Club[];
        setClubs(loadedClubs);

        const clubIds = loadedClubs.map((c) => c.id);
        if (clubIds.length > 0) {
          const { data: photosData, error: photosError } = await supabase
            .from("club_photos")
            .select("club_id, url, orden")
            .in("club_id", clubIds)
            .order("orden", { ascending: true });

          if (!photosError && photosData) {
            const map: Record<string, string> = {};
            for (const photo of photosData) {
              if (!(photo.club_id in map)) {
                map[photo.club_id] = photo.url;
              }
            }
            setThumbnails(map);
          }
        }
      } catch (err) {
        console.error("Error cargando clubs:", err);
        setError("No pudimos cargar los antros. Intenta de nuevo.");
      } finally {
        setLoading(false);
      }
    }

    fetchClubs();
  }, [checkingSession]);

  useEffect(() => {
    if (checkingSession) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => {
        // Permiso denegado o error obteniendo ubicación: no hacemos nada,
        // el listado se queda en su orden normal sin distancias.
      },
      { timeout: 8000 },
    );
  }, [checkingSession]);

  if (checkingSession) {
    return null;
  }

  const clubsWithDistance = clubs.map((club) => ({
    club,
    distanceKm:
      userLocation && club.lat !== null && club.lng !== null
        ? haversineDistanceKm(userLocation, { lat: club.lat, lng: club.lng })
        : null,
  }));

  const sortedClubs = userLocation
    ? [...clubsWithDistance].sort((a, b) => {
        if (a.distanceKm === null && b.distanceKm === null) return 0;
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      })
    : clubsWithDistance;

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-zinc-950 dark:text-zinc-50">
              Elige un antro
            </h1>
            <p className="text-sm text-muted-foreground">
              Reserva tu lugar en segundos.
            </p>
          </div>
          <Link
            href="/cliente/perfil"
            className="whitespace-nowrap pt-1 text-sm font-medium text-foreground underline underline-offset-4"
          >
            Mi perfil
          </Link>
        </div>

        {loading && (
          <p className="text-sm text-muted-foreground">Cargando antros...</p>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && clubs.length === 0 && (
          <Card>
            <CardContent className="px-6 py-10 text-center text-muted-foreground">
              No hay antros disponibles todavía.
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-3">
          {sortedClubs.map(({ club, distanceKm }) => (
            <Link key={club.id} href={`/cliente/${club.id}`}>
              <Card className="overflow-hidden p-0 transition-colors hover:bg-muted/50">
                {thumbnails[club.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbnails[club.id]}
                    alt=""
                    className="h-28 w-full object-cover"
                  />
                ) : (
                  <div className="h-28 w-full bg-gradient-to-br from-fuchsia-600 via-purple-600 to-indigo-600" />
                )}
                <CardHeader className="px-5 pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-lg">{club.nombre}</CardTitle>
                    {distanceKm !== null && (
                      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
                        {formatDistance(distanceKm)}
                      </span>
                    )}
                  </div>
                  <CardDescription>{club.direccion}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between px-5 pb-4 text-sm">
                  <span className="text-muted-foreground">{club.horario}</span>
                  <span className="font-semibold">
                    Depósito: ${club.deposito_monto}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
