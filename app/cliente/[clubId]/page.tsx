"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { GaleriaAntro } from "@/components/galeria-antro";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Club, ClubPhoto } from "@/types";

// Solo devuelve los detalles que el dueño sí llenó: los vacíos no se muestran.
function getDetalles(club: Club) {
  const detalles: { label: string; value: string }[] = [];
  const ambiente = club.ambiente?.trim();
  const musica = club.tipo_musica?.trim();
  const vestimenta = club.codigo_vestimenta?.trim();
  if (ambiente) detalles.push({ label: "Ambiente", value: ambiente });
  if (musica) detalles.push({ label: "Música", value: musica });
  if (vestimenta) detalles.push({ label: "Vestimenta", value: vestimenta });
  if (club.edad_minima !== null && club.edad_minima > 0) {
    detalles.push({ label: "Edad mínima", value: `${club.edad_minima}+ años` });
  }
  return detalles;
}

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

  const detalles = club ? getDetalles(club) : [];

  return (
    <div className="relative flex flex-1 flex-col items-center">
      <BackLink
        href="/cliente"
        className="z-10 rounded-sm bg-noche-bg/70 px-3 py-1.5 text-noche-text backdrop-blur"
      />
      {loading || notFound || !club ? (
      <Card className="mt-24 w-full max-w-sm overflow-hidden p-0">
        {loading ? (
          <CardContent className="px-6 py-10 text-center text-muted-foreground">
            Cargando...
          </CardContent>
        ) : (
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
        )}
      </Card>
      ) : (
        <div className="flex w-full max-w-md flex-1 flex-col">
          {/* Galería a sangre: las fotos son las protagonistas. */}
          {photos.length > 0 ? (
            <GaleriaAntro photos={photos} nombre={club.nombre} />
          ) : (
            <div className="flex h-[26rem] w-full items-center justify-center bg-noche-surface-2 font-display text-[10rem] text-noche-accent/40">
              {club.nombre.charAt(0)}
            </div>
          )}

          <div className="flex flex-1 flex-col gap-6 px-5 pb-8 pt-6">
            <div className="flex flex-col gap-2">
              <h1 className="text-5xl leading-none">{club.nombre}</h1>
              <p className="text-sm text-noche-muted">{club.direccion}</p>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-y border-border py-4 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-noche-muted">Horario</dt>
                <dd className="font-medium">{club.horario}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-noche-muted">Depósito</dt>
                <dd className="text-lg font-semibold text-noche-accent">
                  ${club.deposito_monto}
                </dd>
              </div>
            </dl>

            {detalles.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="text-3xl">Lo que te espera</h2>
                <dl className="flex flex-col border-b border-border">
                  {detalles.map((d) => (
                    <div
                      key={d.label}
                      className="grid grid-cols-[6.5rem_1fr] gap-4 border-t border-border py-3.5 text-sm"
                    >
                      <dt className="text-noche-muted">{d.label}</dt>
                      <dd className="text-base">{d.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <Button
              render={<Link href={`/cliente/reservar?club=${club.id}`} />}
              nativeButton={false}
              size="lg"
              className="mt-auto h-14 w-full text-base font-semibold"
            >
              Reservar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
