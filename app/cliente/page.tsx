"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

// Quita acentos y pasa a minúsculas para que "neon" encuentre "Neón".
function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Acomodo editorial: la portada ocupa todo el ancho y el resto cicla por
// tamaños distintos (ancho, altos escalonados, cuadrado, angosto) sobre una
// rejilla de 6 columnas, en lugar de filas uniformes.
const TILE_COVER = {
  box: "col-span-6 h-96",
  title: "text-5xl",
  detail: true,
};
const TILE_CYCLE = [
  { box: "col-span-6 aspect-[16/9]", title: "text-3xl", detail: true },
  { box: "col-span-3 aspect-[3/4]", title: "text-2xl", detail: false },
  { box: "col-span-3 mt-10 aspect-[3/4]", title: "text-2xl", detail: false },
  { box: "col-span-4 aspect-square", title: "text-3xl", detail: true },
  { box: "col-span-2 aspect-[1/2]", title: "text-xl", detail: false },
];

export default function ClientePage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<Coords | null>(null);
  const [busqueda, setBusqueda] = useState("");

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

  // Búsqueda en memoria sobre lo ya cargado: filtra por nombre y dirección,
  // sin reordenar (el orden por cercanía se conserva tal cual).
  const termino = normalizar(busqueda.trim());
  const hayBusqueda = termino.length > 0;
  const resultados = hayBusqueda
    ? sortedClubs.filter(
        ({ club }) =>
          normalizar(club.nombre).includes(termino) ||
          normalizar(club.direccion).includes(termino),
      )
    : sortedClubs;

  // Solo presentación: los antros con foto van al grid editorial; los que no
  // tienen foto se agrupan al final en lista compacta (una celda grande con
  // solo una inicial se ve vacía). El orden relativo por distancia se conserva.
  const conFoto = resultados.filter(({ club }) => Boolean(thumbnails[club.id]));
  const sinFoto = resultados.filter(({ club }) => !thumbnails[club.id]);

  // Con búsqueda activa todo va en filas uniformes: el grid editorial está
  // pensado para explorar, y con uno o dos resultados la portada gigante se
  // ve desproporcionada. Al buscar se escanea, no se explora.
  const filas = hayBusqueda ? resultados : sinFoto;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-end justify-between gap-3 px-1">
          <h1 className="text-4xl leading-none">
            Esta noche,
            <br />
            <span className="italic text-noche-accent">elige dónde.</span>
          </h1>
          <Link
            href="/cliente/perfil"
            className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Mi perfil
          </Link>
        </div>

        {!loading && !error && clubs.length > 0 && (
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-noche-muted"
            />
            <Input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar antro o zona..."
              aria-label="Buscar antro o zona"
              className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
            />
            {hayBusqueda && (
              <button
                type="button"
                onClick={() => setBusqueda("")}
                aria-label="Limpiar búsqueda"
                className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-noche-muted hover:bg-noche-surface-2 hover:text-noche-text"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        )}

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

        {hayBusqueda && resultados.length === 0 && (
          <Card>
            <CardContent className="flex flex-col gap-1 px-6 py-10 text-center">
              <p className="font-display text-2xl">Sin coincidencias</p>
              <p className="text-sm text-noche-muted">
                No encontramos antros que coincidan con tu búsqueda.
              </p>
            </CardContent>
          </Card>
        )}

        {!hayBusqueda && conFoto.length > 0 && (
          <div className="grid grid-cols-6 items-start gap-3">
            {conFoto.map(({ club, distanceKm }, index) => {
              const isCover = index === 0;
              const tile = isCover
                ? TILE_COVER
                : TILE_CYCLE[(index - 1) % TILE_CYCLE.length];
              // "El más cercano" solo si la portada es de verdad el primero
              // del orden por distancia (podría haber uno sin foto más cerca).
              const esElMasCercano =
                isCover &&
                userLocation !== null &&
                distanceKm !== null &&
                sortedClubs[0]?.club.id === club.id;
              return (
                <Link
                  key={club.id}
                  href={`/cliente/${club.id}`}
                  className={`group relative block overflow-hidden rounded-md bg-noche-surface ${tile.box}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumbnails[club.id]}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-noche-bg via-noche-bg/75 to-transparent px-3.5 pb-3.5 pt-16">
                    {isCover && (
                      <div className="flex items-center gap-2">
                        {esElMasCercano && (
                          <span className="rounded-sm bg-noche-vino px-2 py-0.5 text-xs text-noche-text">
                            El más cercano
                          </span>
                        )}
                        <Badge variant="vip">
                          Depósito ${club.deposito_monto}
                        </Badge>
                      </div>
                    )}
                    <h2 className={`leading-none ${tile.title}`}>
                      {club.nombre}
                    </h2>
                    {tile.detail && (
                      <p className="text-xs text-noche-muted">
                        {club.horario}
                        {distanceKm !== null &&
                          ` · ${formatDistance(distanceKm)}`}
                      </p>
                    )}
                    {!isCover && (
                      <p className="text-xs font-medium text-noche-accent">
                        ${club.deposito_monto}
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {filas.length > 0 && (
          <div className="flex flex-col">
            {hayBusqueda ? (
              <p className="mb-2 px-1 text-sm text-noche-muted">
                {resultados.length}{" "}
                {resultados.length === 1 ? "antro" : "antros"} para “
                {busqueda.trim()}”
              </p>
            ) : (
              conFoto.length > 0 && (
                <h2 className="mb-2 px-1 text-2xl">También esta noche</h2>
              )
            )}
            <ul className="flex flex-col divide-y divide-border border-y border-border">
              {filas.map(({ club, distanceKm }) => (
                <li key={club.id}>
                  <Link
                    href={`/cliente/${club.id}`}
                    className="flex items-center gap-3 px-1 py-3 transition-colors hover:bg-noche-surface"
                  >
                    {thumbnails[club.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbnails[club.id]}
                        alt=""
                        className="size-10 flex-shrink-0 rounded-sm object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex size-10 flex-shrink-0 items-center justify-center rounded-sm bg-noche-surface-2 font-display text-2xl text-noche-accent/70"
                      >
                        {club.nombre.charAt(0)}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-display text-xl leading-tight">
                        {club.nombre}
                      </span>
                      <span className="truncate text-xs text-noche-muted">
                        {club.horario}
                        {distanceKm !== null &&
                          ` · ${formatDistance(distanceKm)}`}
                      </span>
                    </span>
                    <span className="flex-shrink-0 text-sm font-medium text-noche-accent">
                      ${club.deposito_monto}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
